'use strict';
// Decides auto-merge vs. human review. Two gates, both must pass to merge:
//   1. hard policy in code (core.judgePolicy): size limits, protected paths, tests
//      with source changes, CI green on the reviewed commit, mergeable, design docs
//      unchanged since approval
//   2. the judge agent (prompts/judge.md, schemas/judge.json): decision auto_merge
//      AND risk low
// Queued human feedback beats both: the PR goes back to the developer.

const comments = require('../comments.cjs');
const S = require('./shared.cjs');
const { CFG, lib } = S;

async function prepare({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const prNumber = S.routed().pr;
  const { state } = await S.prAndState(gh, prNumber);
  await gh.updatePr(prNumber, { state: { phase: 'judge' } });
  await gh.markReady(await gh.pr(prNumber)); // drafts are never "mergeable"
  const { pr, mergeable } = await gh.waitForMergeable(prNumber, { log: (m) => actions.info(m) });
  const facts = {
    headMatchesReview: pr.head.sha === state.reviewedSha,
    ciPassed: await gh.ciPassed(pr.head.sha),
    mergeable,
  };
  const violations = lib.judgePolicy(await gh.files(prNumber), CFG.judge, facts);
  S.writeJson('meta.json', {
    startedAt: new Date().toISOString(),
    // = when the reviewer run started; feedback queued since then is unseen.
    feedbackFrom: state.feedbackFrom,
    issue: state.issue,
    pr: prNumber,
    base: pr.base.ref,
    headSha: pr.head.sha,
    approvedDesignSha: state.approvedDesignSha,
    approvedDesignCommentId: state.approvedDesignCommentId,
    violations,
  });
  actions.setOutput('ref', pr.head.sha);
}

// Needs the checkout, for the design-docs check and the diff.
async function prompt({ github, context }) {
  const gh = S.newGh(github, context);
  const meta = S.readJson('meta.json');
  const { issue, entries } = await gh.conversation(meta.issue, meta.pr);
  // Human comments plus inline-thread replies, so the judge can see whether requests were resolved.
  const humans = entries.filter((e) => !e.bot || e.kind === 'inline comment');
  const lastReview = [...entries].reverse().find((e) => e.bot && e.kind.startsWith('review'));
  // The design is frozen at approval; any later doc edit needs a human.
  const docsAfter = S.git(['diff', '--name-only', `${meta.approvedDesignSha}..HEAD`, '--', CFG.design.dir]).split('\n').filter(Boolean);
  if (docsAfter.length) {
    meta.violations.push(`design docs changed after approval: ${docsAfter.join(', ')}`);
    S.writeJson('meta.json', meta);
  }
  S.writePrompt('judge', [
    ['Assignment', `Judge PR #${meta.pr} (issue #${meta.issue}) at ${meta.headSha}.`],
    ['Hard policy violations found by the workflow', comments.bullet(meta.violations)],
    ['Issue', S.issueSection(issue)],
    ['Approved design (frozen at approval)', S.untrusted(await S.approvedDesign(gh, meta))],
    ['Full PR diff', '```diff\n' + lib.truncate(S.git(['diff', `origin/${meta.base}...HEAD`]), 150000) + '\n```'],
    ['Reviewer acceptance', S.untrusted(lastReview ? lastReview.body : '(not found)')],
    ['Human comments and inline threads on the issue and PR', S.untrusted(S.formatConversation(humans))],
  ]);
}

async function publish({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const meta = S.readJson('meta.json');
  const result = S.readResult('judge');
  S.assertUnchanged('Judge');
  if (await S.stoppedMeanwhile(gh, meta.pr, actions)) return;

  const pr = await gh.pr(meta.pr);
  const violations = [...meta.violations];
  if (pr.head.sha !== meta.headSha) violations.push('the PR head changed while the judge was running');
  const reasons = [...(result.reasons || []), ...violations.map((v) => `Policy: ${v}`)];
  const handOffArgs = { startedAt: meta.startedAt, queuedFrom: meta.feedbackFrom, actions };

  const auto = violations.length === 0 && result.decision === 'auto_merge' && result.risk === 'low';
  // Queued feedback is checked before merging: never auto-merge over a human's comment.
  if (auto && !(await gh.hasLabel(meta.pr, S.LABELS.feedback))) {
    try {
      await gh.squashMerge(pr, meta.headSha);
      await gh.updatePr(meta.pr, { state: { phase: 'merged', reason: null } });
      await gh.comment(meta.pr, 'judge', comments.judge(result, { merged: true, base: pr.base.ref, reasons }));
      await gh.closeIssue(meta.issue, meta.pr);
      return;
    } catch (e) {
      reasons.push(`Policy: GitHub refused the merge: ${e.message}`);
    }
  }
  const reason = (result.reasons && result.reasons[0]) || violations[0] || reasons[0] || 'judge recommends human review';
  const went = await S.handOff(gh, meta.pr, 'human', { ...handOffArgs, reason });
  if (went === 'human') await gh.comment(meta.pr, 'judge', comments.judge(result, { merged: false, base: pr.base.ref, reasons }));
}

module.exports = { prepare, prompt, publish };
