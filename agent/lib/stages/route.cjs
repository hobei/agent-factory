'use strict';
// First job of every run. Gathers the facts core.route() needs (the event, the PR's
// agent state, whether the sender may drive the agents) and publishes its decision:
//
//   outputs.stage  which job runs next (design | develop | review | judge | control | none)
//   outputs.issue  the issue number, for the per-issue concurrency group
//   outputs.route  the whole decision as JSON ({stage, issue, pr, op, reset, retry,
//                  amend, approvedSha, note}); every job gets it as the ROUTE env var
//
// stage and issue are separate outputs only because the workflow YAML needs them in
// `if:` and `concurrency:`; the code reads everything from ROUTE.

const { CFG, lib, env, newGh } = require('./shared.cjs');

async function route({ github, context, core: actions }) {
  const gh = newGh(github, context);
  const ev = context.payload;
  const name = context.eventName;
  const input = {
    name,
    action: ev.action,
    sender: { login: ev.sender && ev.sender.login, type: ev.sender && ev.sender.type },
    allowed: lib.isAllowed(ev.sender && ev.sender.login, context.repo.owner, env('AGENT_USERS')),
    mergeOnApproval: CFG.mergeOnHumanApproval !== false,
  };
  let number;
  if (name === 'workflow_dispatch') {
    input.dispatch = { stage: ev.inputs.stage };
    number = Number(ev.inputs.number);
  } else if (name === 'pull_request_review') {
    number = ev.pull_request.number;
    input.review = { state: ev.review.state, commitId: ev.review.commit_id, touchesDesign: false };
    try {
      const comments = await github.paginate(github.rest.pulls.listCommentsForReview, { ...context.repo, pull_number: number, review_id: ev.review.id, per_page: 100 });
      input.review.touchesDesign = comments.some((c) => lib.matchesAny(c.path, CFG.roles.designer.writablePaths));
    } catch (e) {
      actions.warning(`Could not list the review's comments: ${e.message}`);
    }
  } else if (name === 'pull_request') {
    number = ev.pull_request.number;
    input.merged = Boolean(ev.pull_request.merged);
  } else {
    number = ev.issue.number;
    if (name === 'issue_comment') input.comment = { body: ev.comment.body };
  }

  if (number) {
    const issue = await gh.issue(number);
    if (issue.pull_request) {
      const pr = await gh.pr(number);
      let state = lib.parseState(pr.body);
      if (state && lib.issueFromBranch(pr.head.ref) !== state.issue) state = null; // only our branches
      input.pr = { number, state: pr.state, headSha: pr.head.sha };
      input.prState = state;
    } else {
      input.issue = { number, state: issue.state, labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)) };
      const open = await gh.findAgentPr(number);
      input.openPr = open ? open.number : null;
    }
  }

  const d = lib.route(input);
  actions.notice(`Route: ${d.stage} — ${d.note}`);
  actions.setOutput('stage', d.stage);
  actions.setOutput('issue', d.issue ? String(d.issue) : '');
  actions.setOutput('route', JSON.stringify(d));
}

module.exports = { route };
