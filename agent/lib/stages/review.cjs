'use strict';
// The workflow builds and tests the PR head itself (deterministic CI, posted as the
// `agent/ci` commit status), then the reviewer agent (prompts/reviewer.md,
// schemas/reviewer.json) checks the diff against the frozen design. Read-only.
//   prepare  record what is being reviewed, output the build/test commands
//   (CI)     the workflow runs build + test, saves runtime/ci.log
//   prompt   post agent/ci, write the reviewer prompt
//   publish  post the review, then hand off:
//              approve            → judge
//              blocking findings  → develop (until maxDeveloperAttempts, then a human)
//              queued feedback    → develop, whatever the verdict

const fs = require('fs');
const path = require('path');
const comments = require('../comments.cjs');
const S = require('./shared.cjs');
const { CFG, lib } = S;

const ciPassed = () => S.env('CI_OUTCOME') === 'success';

async function prepare({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const prNumber = S.routed().pr;
  const { pr, state } = await S.prAndState(gh, prNumber);
  await gh.updatePr(prNumber, { state: { phase: 'review' } });
  actions.setOutput('build', CFG.commands.build);
  actions.setOutput('test', CFG.commands.test);
  S.writeJson('meta.json', {
    startedAt: new Date().toISOString(),
    // = when the developer run started: its report and anything posted since are new.
    feedbackFrom: state.feedbackFrom,
    issue: state.issue,
    pr: prNumber,
    base: pr.base.ref,
    headSha: pr.head.sha,
    attempt: state.attempt || 1,
    approvedDesignSha: state.approvedDesignSha,
    approvedDesignCommentId: state.approvedDesignCommentId,
  });
  actions.setOutput('ref', pr.head.sha);
}

async function prompt({ github, context }) {
  const gh = S.newGh(github, context);
  const meta = S.readJson('meta.json');
  await gh.setCiStatus(meta.headSha, ciPassed(), ciPassed() ? 'Build and tests passed' : 'Build or tests failed');
  let log = '(no log)';
  try {
    log = fs.readFileSync(path.join(S.RUNTIME(), 'ci.log'), 'utf8');
  } catch {
    /* keep placeholder */
  }
  const { issue, entries } = await gh.conversation(meta.issue, meta.pr);
  const diff = (args) => S.git(['diff', ...args]);
  S.writePrompt('reviewer', [
    ['Assignment', `Review PR #${meta.pr} (issue #${meta.issue}) at ${meta.headSha}. Developer attempt ${meta.attempt} of ${CFG.maxDeveloperAttempts}.`],
    ['Issue', S.issueSection(issue)],
    ['Approved design (the design goals, frozen at approval)', S.untrusted(await S.approvedDesign(gh, meta))],
    [`Approved design spec (${CFG.design.specFile} at approval)`, '```markdown\n' + lib.truncate(S.showAt(meta.approvedDesignSha, CFG.design.specFile), 40000) + '\n```'],
    ['Doc edits made after design approval (should be none)', '```diff\n' + (diff([`${meta.approvedDesignSha}..HEAD`, '--', CFG.design.dir]) || '(none)') + '\n```'],
    ['PR diff (code)', '```diff\n' + lib.truncate(diff([`origin/${meta.base}...HEAD`, '--', '.', `:(exclude)${CFG.design.dir}`]), 150000) + '\n```'],
    ['CI (deterministic build + tests)', `Result: **${ciPassed() ? 'PASSED' : 'FAILED'}**\n\n\`\`\`\n${lib.truncate(log.slice(-20000), 20000)}\n\`\`\``],
    ['Developer and designer reports for this round', S.untrusted(S.formatConversation(lib.entriesAfter(entries, meta.feedbackFrom)))],
  ]);
}

async function publish({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const meta = S.readJson('meta.json');
  const result = S.readResult('reviewer');
  S.assertUnchanged('Reviewer');
  if (await S.stoppedMeanwhile(gh, meta.pr, actions)) return;

  const findings = [...(result.findings || [])];
  if (!ciPassed()) findings.unshift({ severity: 'blocking', path: '', line: 0, body: 'CI (build and tests) failed on this commit. See the workflow run log.' });

  const files = await gh.files(meta.pr);
  const commentable = new Map(files.map((f) => [f.filename, lib.commentableLines(f.patch)]));
  const { body, inline } = comments.review(result, { findings, commentable, headSha: meta.headSha, ciPassed: ciPassed(), runUrl: gh.runUrl });
  const reviewArgs = { ...context.repo, pull_number: meta.pr, commit_id: meta.headSha, event: 'COMMENT' };
  try {
    await github.rest.pulls.createReview({ ...reviewArgs, body, comments: inline });
  } catch (e) {
    if (e.status !== 422) throw e; // a finding's line was not in the diff after all
    await github.rest.pulls.createReview({ ...reviewArgs, body: comments.reviewWithInlineInBody(body, inline) });
  }

  const t = lib.reviewTransition({ verdict: result.verdict, findings, ciPassed: ciPassed(), attempt: meta.attempt, maxAttempts: CFG.maxDeveloperAttempts });
  // Queued feedback may date from the developer's run, so it looks back that far.
  const went = await S.handOff(gh, meta.pr, t.next, {
    startedAt: meta.startedAt,
    queuedFrom: meta.feedbackFrom,
    reason: t.reason,
    state: t.next === 'judge' ? { reviewedSha: meta.headSha } : {},
    actions,
  });
  if (went === 'human') await gh.comment(meta.pr, 'reviewer', comments.reviewerGaveUp(t.reason));
}

module.exports = { prepare, prompt, publish };
