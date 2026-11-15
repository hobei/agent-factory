'use strict';
// Quick bookkeeping without Claude (the `control` job), plus the failure notice that
// every stage job runs when a step fails.
//
// control: ROUTE.op is one of
//   queue   human feedback while agents are busy → label it; the running stage's
//           handOff() sends it to the developer when the stage finishes
//   merge   a maintainer approved the head commit → squash-merge if agent/ci is green
//   merged  a human merged the PR → close the issue
//   stop    /agent stop → pause the agents

const comments = require('../comments.cjs');
const { LABELS, env, newGh, routed, prAndState } = require('./shared.cjs');

async function control({ github, context }) {
  const gh = newGh(github, context);
  const { op, pr: prNumber, approvedSha } = routed();
  const { state } = await prAndState(gh, prNumber);

  if (op === 'queue') {
    await gh.addLabel(prNumber, LABELS.feedback);
    return;
  }

  if (op === 'merge') {
    // `agent/ci` is only set by the review stage, so green means the agents built and
    // tested exactly this commit.
    const { pr, mergeable } = await gh.waitForMergeable(prNumber);
    const problems = [];
    if (pr.head.sha !== approvedSha) problems.push('new commits were pushed after your approval');
    if (!(await gh.ciPassed(pr.head.sha))) problems.push('`agent/ci` is not green on the head commit (the agents have not built and tested it)');
    if (!mergeable) problems.push('GitHub does not report the PR as cleanly mergeable');
    if (!problems.length) {
      try {
        await gh.squashMerge(pr, pr.head.sha);
      } catch (e) {
        problems.push(`GitHub refused the merge: ${e.message}`);
      }
    }
    if (problems.length) {
      await gh.comment(prNumber, 'workflow', comments.notMerged(problems));
      return;
    }
    await finishMerged(gh, prNumber, state);
    return;
  }

  if (op === 'merged') {
    await finishMerged(gh, prNumber, state);
    return;
  }

  if (op === 'stop' && state.phase !== 'stopped') {
    await gh.updatePr(prNumber, { state: { phase: 'stopped', previousPhase: state.phase } });
    await gh.comment(prNumber, 'workflow', `Agents stopped (was in phase \`${state.phase}\`). Comment \`/agent retry\` to resume.`);
  }
}

async function finishMerged(gh, prNumber, state) {
  await gh.updatePr(prNumber, { state: { phase: 'merged', reason: null } });
  await gh.removeLabel(prNumber, LABELS.needsHuman);
  await gh.closeIssue(state.issue, prNumber);
}

async function failure({ github, context }) {
  const gh = newGh(github, context);
  const r = routed();
  const target = r.pr || r.issue;
  if (!target) return;
  await gh.comment(target, 'workflow', comments.stageFailed(env('STAGE') || r.stage, gh.runUrl));
}

module.exports = { control, failure };
