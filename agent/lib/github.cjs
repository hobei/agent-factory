'use strict';
// Thin wrappers around the GitHub API (octokit from actions/github-script).

const core = require('./core.cjs');
const { loadConfig } = require('./config.cjs');

const LABELS = {
  needsInfo: { name: 'agent:needs-info', color: 'fbca04', description: 'Designer agent is waiting for clarification' },
  needsHuman: { name: 'agent:needs-human', color: 'd93f0b', description: 'Agents are done; a human must review and merge' },
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

  async files(prNumber) {
    return this.github.paginate(this.github.rest.pulls.listFiles, { ...this.repo, pull_number: prNumber, per_page: 100 });
  }

  // Issue + PR conversation as a flat, time-ordered list.
  async conversation(issueNumber, prNumber) {
    const p = (fn, args) => this.github.paginate(fn, { ...this.repo, per_page: 100, ...args });
    const out = [];
    const isBot = (u) => !u || u.type === 'Bot';
    const issue = await this.issue(issueNumber);
    for (const c of await p(this.github.rest.issues.listComments, { issue_number: issueNumber })) {
      out.push({ at: c.created_at, author: c.user.login, bot: isBot(c.user), where: `issue #${issueNumber}`, kind: 'comment', body: c.body });
    }
    if (prNumber) {
      for (const c of await p(this.github.rest.issues.listComments, { issue_number: prNumber })) {
        out.push({ at: c.created_at, author: c.user.login, bot: isBot(c.user), where: `PR #${prNumber}`, kind: 'comment', body: c.body });
      }
      for (const r of await p(this.github.rest.pulls.listReviews, { pull_number: prNumber })) {
        if (!r.body && r.state === 'COMMENTED') continue; // container for inline comments only
        out.push({ at: r.submitted_at, author: r.user.login, bot: isBot(r.user), where: `PR #${prNumber}`, kind: `review (${r.state})`, body: r.body || '' });
      }
      for (const c of await p(this.github.rest.pulls.listReviewComments, { pull_number: prNumber })) {
        out.push({
          at: c.created_at,
          author: c.user.login,
          bot: isBot(c.user),
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
