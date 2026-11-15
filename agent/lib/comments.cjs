'use strict';
// The text of everything the agents post on GitHub, as pure functions of the agent's
// result (agent/schemas/<role>.json). Kept apart from the stage code so the format can
// be read in one place and unit tested (agent/tests/comments.test.cjs).
//
// Style: lead with the outcome, say each thing once, fold detail away when nothing
// needs attention. gh.comment() adds the role header ("### 🛠️ Developer") and a run link.

const { ROLE_ICON } = require('./core.cjs');

const oneLine = (text, max = 200) => String(text || '').replace(/\s*\n\s*/g, ' ').trim().slice(0, max);

function bullet(items) {
  return items && items.length ? items.map((x) => `- ${x}`).join('\n') : '- none';
}

// ---------------------------------------------------------------- designer

function designerQuestions(result) {
  const qs = (result.questions || []).map((q, k) => `${k + 1}. ${q}`).join('\n');
  return `${result.reply ? `${result.reply}\n\n` : ''}**Questions**\n\n${qs}\n\nReply in a comment and I'll pick it up automatically.`;
}

// The design as frozen on the issue: the contract the developer and reviewer work to.
function frozenDesign({ pr, sha, description, amended }) {
  const head = amended
    ? `📌 **Approved design, amended** (PR #${pr}, commit ${sha.slice(0, 12)}). Replaces the earlier approved design at a human's request.`
    : `📌 **Approved design** (PR #${pr}, commit ${sha.slice(0, 12)}). This is the contract the developer implements and the reviewer checks against.`;
  return `${head}\n\n---\n\n${description}`;
}

// ---------------------------------------------------------------- developer

function developerReport(dev, { attempt, maxAttempts }) {
  const checks = (dev.tests || []).map((t) => `${t.passed ? '✅' : '❌'} \`${t.command}\`${t.detail ? ` ${oneLine(t.detail, 80)}` : ''}`).join(' · ');
  const declined = dev.declined || [];
  return (
    (attempt > 1 ? `**Attempt ${attempt}/${maxAttempts}**\n\n` : '') +
    String(dev.summary || '').trim() +
    (checks ? `\n\n${checks}` : '') +
    (dev.addressed && dev.addressed.length ? `\n\n**Feedback addressed**\n${bullet(dev.addressed)}` : '') +
    (declined.length ? `\n\n**Not done: needs a design change** (\`/agent redesign\`)\n${bullet(declined)}` : '')
  );
}

function developerBlocked(dev) {
  return `${String(dev.summary || 'I could not implement the approved design.').trim()}\n\n**Blocked:** ${dev.blocked_reason}`;
}

// Replies that could not be posted in their thread, appended to the main comment.
function lostReplies(bodies) {
  return bodies.length ? `\n\n**Replies to inline comments**\n${bullet(bodies.map((b) => oneLine(b, 1000)))}` : '';
}

// ---------------------------------------------------------------- reviewer

const findingTag = (f) => (f.severity === 'blocking' ? '🔴 **Blocking**' : '🟡 Suggestion');

/*
 * The reviewer's GitHub review. Findings on a line GitHub accepts comments on become
 * inline comments; the rest are listed in the body.
 *   commentable: Map(path → Set(line)) from core.commentableLines
 * Returns { body, inline: [{path, line, side, body}] }.
 */
function review(result, { findings, commentable, headSha, ciPassed, runUrl }) {
  const inline = [];
  const general = [];
  for (const f of findings) {
    const lines = f.path && f.line > 0 && commentable.get(f.path);
    if (lines && lines.has(f.line)) {
      inline.push({ path: f.path, line: f.line, side: 'RIGHT', body: `${findingTag(f)}: ${f.body}` });
    } else {
      general.push(`- ${findingTag(f)}${f.path ? ` \`${f.path}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.body}`);
    }
  }

  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const approved = result.verdict === 'approve' && blocking === 0;
  const verdict = approved ? '✅ **Approved**' : `❌ **Changes requested** (${blocking} blocking)`;

  // All criteria met: one folded line. Otherwise the table is the point, so show it.
  const goals = result.goals || [];
  const unmet = goals.filter((g) => !g.met).length;
  const table = `| | Criterion | Evidence |\n|---|---|---|\n${goals.map((g) => `| ${g.met ? '✅' : '❌'} | ${g.criterion} | ${oneLine(g.evidence, 500)} |`).join('\n')}`;
  const goalsBlock = !goals.length
    ? ''
    : unmet
      ? `**Acceptance criteria: ${unmet} of ${goals.length} not met**\n\n${table}\n\n`
      : `<details><summary>All ${goals.length} acceptance criteria met</summary>\n\n${table}\n\n</details>\n\n`;

  const body =
    `### ${ROLE_ICON.reviewer}\n\n${verdict}: ${String(result.summary || '').trim()}\n\n` +
    goalsBlock +
    (general.length ? `${general.join('\n')}\n\n` : '') +
    `<sub>${headSha.slice(0, 7)} · CI ${ciPassed ? 'passed' : 'failed'} · [run](${runUrl})</sub>`;
  return { body, inline };
}

// When GitHub rejects the inline comments (422), they go in the body instead.
function reviewWithInlineInBody(body, inline) {
  return `${body}\n\n**Inline findings**\n${inline.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join('\n')}`;
}

function reviewerGaveUp(reason) {
  return `The developer and reviewer could not converge.\n\n**Needs you:** ${reason}`;
}

// ---------------------------------------------------------------- judge

// `reasons` = the judge's reasons plus the failed policy checks, shown once.
function judge(result, { merged, base, reasons }) {
  const head = merged ? `✅ **Merged** into \`${base}\`` : '🧑 **Needs you**';
  return `${head} · risk ${result.risk}\n\n${String(result.summary || '').trim()}` + (!merged && reasons.length ? `\n\n${bullet(reasons)}` : '');
}

// ---------------------------------------------------------------- workflow

function notMerged(problems) {
  return `Approved, but not merged:\n${bullet(problems)}\n\nMerge it yourself, or comment to send it back to the developer.`;
}

function stageFailed(stage, runUrl) {
  return `❌ The **${stage}** stage failed. Check the [run log](${runUrl}).\n\nFix the cause if needed, then comment \`/agent retry\` to run it again.`;
}

module.exports = {
  bullet,
  designerQuestions,
  frozenDesign,
  developerReport,
  developerBlocked,
  lostReplies,
  review,
  reviewWithInlineInBody,
  reviewerGaveUp,
  judge,
  notMerged,
  stageFailed,
};
