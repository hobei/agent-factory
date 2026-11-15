'use strict';
// Designer agent (prompts/designer.md, schemas/designer.json). Three modes:
//   new     issue → ask questions on the issue, or open a draft PR with the design
//   revise  feedback on the design PR → revise it (design is not approved yet)
//   amend   a human asked to change an approved design → amend it, freeze the new
//           version on the issue, and hand straight to the developer
// The designer may only edit the design dir (checked again in publish).

const comments = require('../comments.cjs');
const S = require('./shared.cjs');
const { CFG, LABELS, lib } = S;

async function prepare({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const r = S.routed();
  const issueNumber = r.issue;
  const prNumber = r.pr || null;
  let ref;
  let branch;
  let feedbackFrom = null;
  let amend = false;
  let approved = null;
  if (prNumber) {
    const { pr, state } = await S.prAndState(gh, prNumber);
    ref = pr.head.sha;
    branch = pr.head.ref;
    feedbackFrom = state.feedbackFrom;
    // Amend = change a design that was already approved. Sticky (state.amend) across
    // clarification rounds and /agent retry until the amendment is published.
    amend = Boolean(r.amend) || Boolean(state.amend);
    if (amend) {
      approved = await S.approvedDesign(gh, state);
      await gh.removeLabel(prNumber, LABELS.needsHuman);
    }
    await gh.updatePr(prNumber, { state: { phase: 'design', ...(amend ? { amend: true, reason: null } : {}) } });
  } else {
    ref = await gh.defaultBranch();
    branch = `${lib.BRANCH_PREFIX}${issueNumber}`;
  }
  const { issue, entries } = await gh.conversation(issueNumber, prNumber);
  const mode = amend ? 'amend' : prNumber ? 'revise' : 'new';
  const assignment = {
    new: `Mode: **new**. Issue #${issueNumber}.`,
    revise: `Mode: **revise**. Issue #${issueNumber}. You are revising design PR #${prNumber}; address every item marked NEW.`,
    amend:
      `Mode: **amend**. Issue #${issueNumber}, PR #${prNumber}. The design below was approved and implemented. ` +
      'A human has asked for a design change (items marked NEW). Amend the design to cover it; the developer then updates the code to match.',
  }[mode];
  const fresh = lib.entriesAfter(entries, feedbackFrom);
  S.writePrompt('designer', [
    ['Assignment', assignment],
    ['Currently approved design (the one you are amending)', approved ? S.untrusted(approved) : ''],
    ['Issue', S.issueSection(issue)],
    ['Conversation', S.untrusted(S.formatConversation(entries, feedbackFrom))],
  ]);
  S.writeJson('meta.json', {
    startedAt: new Date().toISOString(),
    feedbackFrom,
    issue: issueNumber,
    pr: prNumber,
    branch,
    mode,
    threads: prNumber ? lib.threadTargets(fresh.filter((e) => !e.bot)) : {},
  });
  actions.setOutput('ref', ref);
}

async function publish({ github, context, core: actions }) {
  const gh = S.newGh(github, context);
  const meta = S.readJson('meta.json');
  const result = S.readResult('designer');
  const issue = await gh.issue(meta.issue);
  const reply = async () => comments.lostReplies(await S.postThreadReplies(gh, meta.pr, 'designer', result.thread_replies, meta.threads, actions));

  if (result.status === 'needs_clarification') {
    const msg = comments.designerQuestions(result);
    if (meta.pr) {
      const lost = await reply();
      await gh.updatePr(meta.pr, { state: { feedbackFrom: meta.startedAt } });
      await gh.comment(meta.pr, 'designer', msg + lost);
    } else {
      await gh.addLabel(meta.issue, LABELS.needsInfo);
      await gh.comment(meta.issue, 'designer', msg);
    }
    return;
  }

  const changed = S.stagedPaths();
  const bad = lib.pathViolations(changed, { allowed: CFG.roles.designer.writablePaths });
  if (bad.length) throw new Error(`Designer edited files outside ${CFG.design.dir}/: ${bad.join(', ')}`);

  if (meta.mode === 'amend') {
    if (changed.length) {
      S.commit(`Amend design #${meta.issue}: ${result.title}`);
      S.push(context, meta.branch);
    }
    // The amended design becomes the new contract, frozen like an approval.
    const sha = S.git(['rev-parse', 'HEAD']).trim();
    const frozen = await gh.comment(meta.issue, 'designer', comments.frozenDesign({ pr: meta.pr, sha, description: result.summary, amended: true }));
    const lost = await reply();
    await gh.updatePr(meta.pr, { description: result.summary });
    await gh.comment(meta.pr, 'designer', `${result.reply}${lost}\n\nDesign amended; the developer is updating the code.`);
    // The developer must also see the human feedback that asked for the amendment,
    // which was posted before this run: keep the old feedbackFrom.
    await S.handOff(gh, meta.pr, 'develop', {
      startedAt: meta.feedbackFrom,
      state: { amend: false, attempt: 0, approvedDesignSha: sha, approvedDesignCommentId: frozen.id },
      actions,
    });
    return;
  }

  // A new design PR needs a commit even when the spec needs no change (e.g. test-only work).
  if (changed.length || !meta.pr) {
    S.commit(`Design #${meta.issue}: ${result.title}`, { allowEmpty: !changed.length });
    S.push(context, meta.branch, { force: !meta.pr });
  }

  if (meta.pr) {
    const lost = await reply();
    await gh.updatePr(meta.pr, { description: result.summary, state: { phase: 'design', feedbackFrom: meta.startedAt } });
    await gh.comment(meta.pr, 'designer', `${result.reply}${lost}${changed.length ? '' : '\n\n_No document changes were needed._'}`);
    return;
  }

  const state = { issue: meta.issue, phase: 'design', attempt: 0, maxAttempts: CFG.maxDeveloperAttempts, feedbackFrom: meta.startedAt, runUrl: gh.runUrl };
  const { data: pr } = await github.rest.pulls.create({
    ...context.repo,
    title: `#${meta.issue}: ${result.title}`,
    head: meta.branch,
    base: await gh.defaultBranch(),
    draft: true,
    body: lib.renderBody(result.summary, state),
  });
  await gh.removeLabel(meta.issue, LABELS.needsInfo);
  await gh.requestReview(pr.number, issue.user.login);
  await gh.comment(meta.issue, 'designer', `I've proposed a design in #${pr.number}. Please review it there: **Approve** to start development, or comment / request changes and I'll revise.`);
}

module.exports = { prepare, publish };
