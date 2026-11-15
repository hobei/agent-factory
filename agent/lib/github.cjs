'use strict';
// Thin wrappers around the GitHub API (octokit from actions/github-script), so the
// stage code reads as "comment / add label / dispatch" instead of raw REST calls.
// Every write the factory makes to GitHub goes through here, using the job's
// GITHUB_TOKEN. Comments get a role header (e.g. "### 🛠️ Developer") and a link to
// the workflow run.

const core = require('./core.cjs');
const { loadConfig } = require('./config.cjs');

const LABELS = {
  needsInfo: { name: 'agent:needs-info', color: 'fbca04', description: 'Designer agent is waiting for clarification' },
  needsHuman: { name: 'agent:needs-human', color: 'd93f0b', description: 'Agents are done; a human must review and merge' },
  feedback: { name: 'agent:feedback-queued', color: '1d76db', description: 'Human feedback arrived while agents were busy; the developer picks it up next' },
};

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const STATUS_CONTEXT = 'agent/ci';

class Gh {
  constructor(github, context) {
    this.github = github;
    this.context = context;
    this.repo = context.repo; // {owner, repo}
  }

  get runUrl() {
    const c = this.context;
    return `${c.serverUrl}/${c.repo.owner}/${c.repo.repo}/actions/runs/${c.runId}`;
  }

  async defaultBranch() {
    if (!this._defaultBranch) {
      const { data } = await this.github.rest.repos.get(this.repo);
      this._defaultBranch = data.default_branch;
    }
    return this._defaultBranch;
  }

  async issue(number) {
    const { data } = await this.github.rest.issues.get({ ...this.repo, issue_number: number });
    return data;
  }

  async pr(number) {
    const { data } = await this.github.rest.pulls.get({ ...this.repo, pull_number: number });
    return data;
  }

  async findAgentPr(issueNumber) {
    const { data } = await this.github.rest.pulls.list({
      ...this.repo,
      state: 'open',
      head: `${this.repo.owner}:${core.BRANCH_PREFIX}${issueNumber}`,
    });
    return data[0] || null;
  }

  async comment(number, role, body) {
    const header = core.ROLE_ICON[role] ? `### ${core.ROLE_ICON[role]}\n\n` : '';
    const footer = `\n\n<sub>[workflow run](${this.runUrl})</sub>`;
    const { data } = await this.github.rest.issues.createComment({ ...this.repo, issue_number: number, body: core.truncate(header + body, 60000) + footer });
    return data;
  }

  // Reply inside an inline review-comment thread. commentId must be the thread's root comment.
  async replyInThread(prNumber, commentId, role, body) {
    const who = core.ROLE_ICON[role] ? `**${core.ROLE_ICON[role]}:** ` : '';
    await this.github.rest.pulls.createReplyForReviewComment({ ...this.repo, pull_number: prNumber, comment_id: commentId, body: core.truncate(who + body, 60000) });
  }

  async addLabel(number, label) {
    try {
      await this.github.rest.issues.createLabel({ ...this.repo, ...label });
    } catch (e) {
      if (e.status !== 422) throw e;
    }
    await this.github.rest.issues.addLabels({ ...this.repo, issue_number: number, labels: [label.name] });
  }

  async closeIssue(issueNumber, prNumber) {
    const issue = await this.issue(issueNumber);
    if (issue.state === 'closed') return;
    await this.comment(issueNumber, 'workflow', `Implemented in #${prNumber}, which has been merged. Closing.`);
    await this.github.rest.issues.update({ ...this.repo, issue_number: issueNumber, state: 'closed', state_reason: 'completed' });
  }

  async removeLabel(number, label) {
    try {
      await this.github.rest.issues.removeLabel({ ...this.repo, issue_number: number, name: label.name });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  // Read-modify-write the agent state stored in the PR body.
  async updatePr(number, { state: patch, description, title } = {}) {
    const pr = await this.pr(number);
    const state = { ...(core.parseState(pr.body) || {}), ...(patch || {}), runUrl: this.runUrl, updatedAt: new Date().toISOString() };
    const desc = description !== undefined ? description : core.parseDescription(pr.body);
    const update = { ...this.repo, pull_number: number, body: core.renderBody(desc, state) };
    if (title) update.title = title;
    await this.github.rest.pulls.update(update);
    return state;
  }

  async dispatch(stage, number) {
    await this.github.rest.actions.createWorkflowDispatch({
      ...this.repo,
      workflow_id: loadConfig().workflowFile, // the project's caller workflow
      ref: await this.defaultBranch(),
      inputs: { stage, number: String(number) },
    });
  }

  async setCiStatus(sha, passed, description) {
    await this.github.rest.repos.createCommitStatus({
      ...this.repo,
      sha,
      state: passed ? 'success' : 'failure',
      context: STATUS_CONTEXT,
      description: core.truncate(description, 130),
      target_url: this.runUrl,
    });
  }

  async ciPassed(sha) {
    const { data } = await this.github.rest.repos.getCombinedStatusForRef({ ...this.repo, ref: sha });
    const s = data.statuses.find((x) => x.context === STATUS_CONTEXT);
    return Boolean(s && s.state === 'success');
  }

  async markReady(pr) {
    if (!pr.draft) return;
    await this.github.graphql(
      'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
      { id: pr.node_id },
    );
  }

  async requestReview(prNumber, login) {
    try {
      await this.github.rest.pulls.requestReviewers({ ...this.repo, pull_number: prNumber, reviewers: [login] });
    } catch (e) {
      // Best effort: fails if the user is the PR author or lacks access.
    }
  }

  async waitForMergeable(prNumber, { attempts = 6, delayMs = 10000, log = () => {} } = {}) {
    let pr;
    for (let k = 0; k < attempts; k++) {
      pr = await this.pr(prNumber);
      log(`mergeable=${pr.mergeable} mergeable_state=${pr.mergeable_state}`);
      if (pr.mergeable === true && ['clean', 'unstable', 'has_hooks'].includes(pr.mergeable_state)) return { pr, mergeable: true };
      if (pr.mergeable === false) break;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return { pr, mergeable: false };
  }

  async hasLabel(number, label) {
    const issue = await this.issue(number);
    return issue.labels.some((l) => (typeof l === 'string' ? l : l.name) === label.name);
  }

  // Dismiss humans' CHANGES_REQUESTED reviews submitted before `before` (ISO time):
  // the developer has addressed them, and the agents re-review the result.
  async dismissAddressedReviews(prNumber, before, sha, log = () => {}) {
    const reviews = await this.github.paginate(this.github.rest.pulls.listReviews, { ...this.repo, pull_number: prNumber, per_page: 100 });
    const stale = reviews.filter((r) => r.state === 'CHANGES_REQUESTED' && r.user && r.user.type !== 'Bot' && String(r.submitted_at) < String(before));
    for (const r of stale) {
      try {
        await this.github.rest.pulls.dismissReview({
          ...this.repo,
          pull_number: prNumber,
          review_id: r.id,
          message: `Addressed in ${sha.slice(0, 7)}. The agents re-review it; approve or request changes again if needed.`,
        });
      } catch (e) {
        log(`Could not dismiss review ${r.id} by @${r.user.login}: ${e.message}`);
      }
    }
    return stale.length;
  }

  async squashMerge(pr, sha) {
    await this.github.rest.pulls.merge({ ...this.repo, pull_number: pr.number, sha, merge_method: 'squash', commit_title: `${pr.title} (#${pr.number})` });
  }

  async files(prNumber) {
    return this.github.paginate(this.github.rest.pulls.listFiles, { ...this.repo, pull_number: prNumber, per_page: 100 });
  }

  // Issue + PR conversation as a flat, time-ordered list.
  async conversation(issueNumber, prNumber) {
    const p = (fn, args) => this.github.paginate(fn, { ...this.repo, per_page: 100, ...args });
    const out = [];
    const isBot = (u) => !u || u.type === 'Bot';
    // Maintainers = the users allowed to drive the agents. Their requests carry authority.
    const allowed = (u) => !isBot(u) && core.isAllowed(u.login, this.repo.owner, process.env.AGENT_USERS);
    const issue = await this.issue(issueNumber);
    for (const c of await p(this.github.rest.issues.listComments, { issue_number: issueNumber })) {
      out.push({ at: c.created_at, author: c.user.login, bot: isBot(c.user), maintainer: allowed(c.user), where: `issue #${issueNumber}`, kind: 'comment', body: c.body });
    }
    if (prNumber) {
      for (const c of await p(this.github.rest.issues.listComments, { issue_number: prNumber })) {
        out.push({ at: c.created_at, author: c.user.login, bot: isBot(c.user), maintainer: allowed(c.user), where: `PR #${prNumber}`, kind: 'comment', body: c.body });
      }
      for (const r of await p(this.github.rest.pulls.listReviews, { pull_number: prNumber })) {
        if (!r.body && r.state === 'COMMENTED') continue; // container for inline comments only
        out.push({ at: r.submitted_at, author: r.user.login, bot: isBot(r.user), maintainer: allowed(r.user), where: `PR #${prNumber}`, kind: `review (${r.state})`, body: r.body || '' });
      }
      for (const c of await p(this.github.rest.pulls.listReviewComments, { pull_number: prNumber })) {
        out.push({
          at: c.created_at,
          author: c.user.login,
          bot: isBot(c.user),
          maintainer: allowed(c.user),
          where: `${c.path}:${c.line || c.original_line || '?'}`,
          kind: 'inline comment',
          id: c.id,
          root: c.in_reply_to_id || c.id,
          body: c.body,
        });
      }
    }
    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return { issue, entries: out };
  }
}

module.exports = { Gh, LABELS, BOT_NAME, BOT_EMAIL, STATUS_CONTEXT };
