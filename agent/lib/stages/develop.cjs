'use strict';
// Developer agent (prompts/developer.md, schemas/developer.json). Implements the
// approved design, frozen as an issue comment at approval. On a repair round it also
// gets the feedback since the last stage: reviewer findings and human comments.
//   prepare  freezes the design on approval, counts the attempt, writes the prompt
//   between  runs right after Claude, without a GitHub token: checks paths, commits
//   publish  pushes, replies in threads, dismisses addressed reviews, comments,
//            then hands off to review

const comments = require('../comments.cjs');
const S = require('./shared.cjs');
const { CFG, LABELS, lib } = S;

// Feedback for the developer: humans' comments and reviews, plus the reviewer agent's
// review and inline findings. Not other agents' status comments.
const isFeedback = (e) => (e.body || '').trim() && (!e.bot || e.kind.startsWith('review') || e.kind === 'inline comment');

async function prepare({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const startedAt = new Date().toISOString();
  const r = S.routed();
  const prNumber = r.pr;
  const { pr, state } = await S.prAndState(gh, prNumber);

  // Queued human feedback counts like feedback in the `human` phase: fresh attempt budget.
  const queued = await gh.hasLabel(prNumber, LABELS.feedback);
  if (queued) await gh.removeLabel(prNumber, LABELS.feedback);
  const reset = Boolean(r.reset) || queued;
  let attempt = (reset ? 0 : state.attempt || 0) + (r.retry ? 0 : 1);
  if (attempt < 1) attempt = 1;
  const approvedDesignSha = r.approvedSha || state.approvedDesignSha;
  if (!approvedDesignSha) throw new Error('No approved design revision recorded on this PR');

  // On design approval, freeze the approved design (PR description) as an issue comment.
  let approvedDesignCommentId = state.approvedDesignCommentId;
  if (r.approvedSha) {
    const frozen = await gh.comment(state.issue, 'designer', comments.frozenDesign({ pr: prNumber, sha: approvedDesignSha, description: lib.parseDescription(pr.body) }));
    approvedDesignCommentId = frozen.id;
  }
  if (!approvedDesignCommentId) throw new Error('No frozen approved design recorded on this PR');

  await gh.updatePr(prNumber, {
    state: { phase: 'develop', attempt, approvedDesignSha, approvedDesignCommentId, maxAttempts: CFG.maxDeveloperAttempts, reason: null },
  });
  if (reset) await gh.removeLabel(prNumber, LABELS.needsHuman);

  const { issue, entries } = await gh.conversation(state.issue, prNumber);
  const feedback = state.feedbackFrom ? lib.entriesAfter(entries, state.feedbackFrom).filter(isFeedback) : [];
  const repair = feedback.length > 0;
  S.writePrompt('developer', [
    [
      'Assignment',
      `Implement issue #${state.issue} on PR #${prNumber} (design approved at ${approvedDesignSha.slice(0, 12)}). ` +
        `Developer attempt ${attempt} of ${CFG.maxDeveloperAttempts}. ` +
        (repair ? 'Mode: **repair** — address the feedback below.' : 'Mode: **first implementation**.'),
    ],
    ['Approved design (your contract)', S.untrusted(await S.approvedDesign(gh, { approvedDesignCommentId }))],
    ['Issue', S.issueSection(issue)],
    ['Feedback to address (new since the last stage)', repair ? S.untrusted(S.formatConversation(feedback)) : 'None.'],
  ]);
  S.writeJson('meta.json', {
    startedAt,
    issue: state.issue,
    pr: prNumber,
    branch: pr.head.ref,
    attempt,
    humanFeedback: feedback.some((e) => !e.bot),
    // Reply only in threads with human comments; reviewer findings are answered in the summary.
    threads: lib.threadTargets(feedback.filter((e) => !e.bot)),
  });
  actions.setOutput('ref', pr.head.sha);
}

// Runs right after the developer. Validates and commits locally; no GitHub token.
async function between() {
  const meta = S.readJson('meta.json');
  const result = S.readResult('developer');
  if (result.status === 'blocked') return;
  const changed = S.stagedPaths();
  const bad = lib.pathViolations(changed, { forbidden: CFG.roles.developer.forbiddenPaths });
  if (bad.length) throw new Error(`Developer edited forbidden paths: ${bad.join(', ')}`);
  if (!changed.length) throw new Error('Developer reported "implemented" but changed no files');
  const title = lib.commitTitle(result.commit_title, `Implement #${meta.issue}`);
  S.commit(`${title}\n\nIssue #${meta.issue}, developer attempt ${meta.attempt}.`);
}

async function publish({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const meta = S.readJson('meta.json');
  const dev = S.readResult('developer');
  if (await S.stoppedMeanwhile(gh, meta.pr, actions)) return;

  if (dev.status === 'blocked') {
    await gh.comment(meta.pr, 'developer', comments.developerBlocked(dev));
    await S.handOff(gh, meta.pr, 'human', { startedAt: meta.startedAt, reason: `developer is blocked: ${dev.blocked_reason}`, actions });
    return;
  }

  S.push(context, meta.branch);
  const sha = S.git(['rev-parse', 'HEAD']).trim();
  const lost = await S.postThreadReplies(gh, meta.pr, 'developer', dev.thread_replies, meta.threads, actions);

  // Human change requests this run addressed no longer block; the agents re-review the result.
  if (meta.humanFeedback && !(dev.declined || []).length) {
    await gh.dismissAddressedReviews(meta.pr, meta.startedAt, sha, (m) => actions.warning(m));
  }

  await gh.comment(meta.pr, 'developer', comments.developerReport(dev, { attempt: meta.attempt, maxAttempts: CFG.maxDeveloperAttempts }) + comments.lostReplies(lost));
  await S.handOff(gh, meta.pr, 'review', { startedAt: meta.startedAt, actions });
}

module.exports = { prepare, between, publish };
