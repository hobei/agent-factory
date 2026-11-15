'use strict';
// Pure logic for the agent workflow: PR state, event routing, judge policy and
// parsing helpers. No GitHub or filesystem access here so it can be unit tested.

const BRANCH_PREFIX = 'agent/issue-';
const STATE_RE = /<!--\s*agent-state\s*(\{[\s\S]*?\})\s*-->/;
const DESC_START = '<!-- agent-description -->';
const DESC_END = '<!-- /agent-description -->';

// Phase -> the stage that does the work in that phase.
const PHASE_STAGE = { design: 'design', implement: 'develop', review: 'review', judge: 'judge' };
const STAGES = ['design', 'develop', 'review', 'judge'];

const ROLE_ICON = { designer: '🧭 Designer', developer: '🛠️ Developer', reviewer: '🔍 Reviewer', judge: '⚖️ Judge', workflow: '🤖 Workflow' };

// ---------------------------------------------------------------- PR body/state

function parseState(body) {
  const m = (body || '').match(STATE_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function parseDescription(body) {
  const text = body || '';
  const s = text.indexOf(DESC_START);
  const e = text.indexOf(DESC_END);
  if (s < 0 || e < s) return '';
  return text.slice(s + DESC_START.length, e).trim();
}

function phaseHint(state) {
  const max = state.maxAttempts || 3;
  switch (state.phase) {
    case 'design':
      if (state.amend) return 'Designer is amending the approved design at your request. Development continues automatically once it is done.';
      return 'Waiting for **human design review**. Submit an **Approve** review to start development, or comment / request changes and the designer will revise.';
    case 'implement':
      return `Developer agent is implementing (attempt ${state.attempt || 1} of ${max}).`;
    case 'review':
      return 'Reviewer agent is checking the implementation against the approved design.';
    case 'judge':
      return 'Merge judge is deciding whether this can land automatically.';
    case 'human':
      return `**Needs human review**${state.reason ? `: ${state.reason}` : ''}. Approve and merge, or request changes / comment to send it back to the developer. Comment on the design docs (or \`/agent redesign\`) to change the design first.`;
    case 'merged':
      return 'Merged automatically by the judge.';
    case 'stopped':
      return 'Agents stopped. Comment `/agent retry` to resume.';
    default:
      return '';
  }
}

function renderBody(description, state) {
  const safe = JSON.stringify(state).replace(/-->/g, '--\\u003e');
  const lines = [
    DESC_START,
    (description || '').trim() || '_Design in progress._',
    DESC_END,
    '',
    `Closes #${state.issue}`,
    '',
    '---',
    '#### 🤖 Agent status',
    '',
    `**Phase:** \`${state.phase}\`${state.attempt ? ` · **Developer attempt:** ${state.attempt}/${state.maxAttempts || 3}` : ''}${state.runUrl ? ` · [last run](${state.runUrl})` : ''}`,
    '',
    phaseHint(state),
    '',
    '<sub>Commands: `/agent retry` re-runs the current stage · `/agent stop` pauses the agents · `/agent redesign` (once handed to a human) sends your feedback to the designer.</sub>',
    '',
    `<!-- agent-state ${safe} -->`,
  ];
  return lines.join('\n');
}

function issueFromBranch(branch) {
  const m = (branch || '').match(/^agent\/issue-(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- access

function isAllowed(login, owner, allowList) {
  if (!login) return false;
  const users = (allowList || '')
    .split(/[\s,]+/)
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  if (users.length === 0) return login.toLowerCase() === (owner || '').toLowerCase();
  return users.includes(login.toLowerCase());
}

function parseCommand(body) {
  const m = (body || '').trim().match(/^\/agent\s+([a-z-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------- routing
/*
 * Decide which stage (if any) an event should start.
 *
 * input = {
 *   name, action,                     // GitHub event name and action
 *   sender: {login, type}, allowed,   // whether sender may drive agents
 *   issue:  {number, state, labels[]} // the issue (issues / issue_comment on an issue)
 *   openPr: number|null               // open agent PR for that issue
 *   pr:     {number, state, headSha}  // agent PR (PR comment / review / dispatch)
 *   prState: parsed agent state | null
 *   comment: {body}, review: {state, commitId, touchesDesign}
 *   dispatch: {stage}
 * }
 * returns { stage: 'none'|'design'|'develop'|'review'|'judge'|'control', ...flags, note }
 */
function route(i) {
  const none = (note) => ({ stage: 'none', note });

  if (i.name === 'workflow_dispatch') {
    const want = i.dispatch && i.dispatch.stage;
    if (!STAGES.includes(want)) return none(`unknown stage "${want}"`);
    if (i.pr) {
      if (!i.prState) return none(`PR #${i.pr.number} is not managed by the agents`);
      if (i.pr.state !== 'open') return none(`PR #${i.pr.number} is closed`);
      if (PHASE_STAGE[i.prState.phase] !== want) {
        return none(`stale handoff: asked for ${want} but PR #${i.pr.number} is in phase "${i.prState.phase}"`);
      }
      return { stage: want, pr: i.pr.number, issue: i.prState.issue, note: `dispatch → ${want}` };
    }
    if (!i.issue) return none('no issue or PR found');
    if (want !== 'design') return none(`${want} needs a PR number`);
    if (i.issue.state !== 'open') return none(`issue #${i.issue.number} is closed`);
    if (i.openPr) return none(`issue #${i.issue.number} already has agent PR #${i.openPr}`);
    return { stage: 'design', issue: i.issue.number, note: 'dispatch → design' };
  }

  if (i.sender && i.sender.type === 'Bot') return none('ignoring bot event');
  // A human merged an agent PR: close the issue (closing keywords are unreliable for bot PRs).
  if (i.name === 'pull_request') {
    if (i.action === 'closed' && i.merged && i.pr && i.prState) {
      return { stage: 'control', op: 'merged', pr: i.pr.number, issue: i.prState.issue, note: 'PR merged → close issue' };
    }
    return none(`ignoring pull_request.${i.action}`);
  }

  if (!i.allowed) return none(`@${i.sender && i.sender.login} is not allowed to drive the agents (see AGENT_USERS)`);

  // ---- plain issues
  if (i.name === 'issues' || (i.name === 'issue_comment' && !i.pr)) {
    const issue = i.issue;
    if (!issue || issue.state !== 'open') return none('issue is not open');
    if ((issue.labels || []).includes('agent:ignore')) return none('issue is labelled agent:ignore');
    if (i.openPr) return none(`issue already has agent PR #${i.openPr}; give feedback there`);
    if (i.name === 'issues') {
      if (!['opened', 'edited', 'reopened'].includes(i.action)) return none(`ignoring issues.${i.action}`);
      return { stage: 'design', issue: issue.number, note: `issue ${i.action} → design` };
    }
    const cmd = parseCommand(i.comment && i.comment.body);
    if (cmd === 'start' || cmd === 'retry') return { stage: 'design', issue: issue.number, note: `/agent ${cmd} → design` };
    if ((issue.labels || []).includes('agent:needs-info')) {
      return { stage: 'design', issue: issue.number, note: 'clarification answered → design' };
    }
    return none('comment on an issue that is not waiting for clarification');
  }

  // ---- agent PRs
  const pr = i.pr;
  const st = i.prState;
  if (!pr || !st) return none('not an agent-managed PR');
  if (pr.state !== 'open') return none('PR is closed');
  const base = { pr: pr.number, issue: st.issue };

  if (i.name === 'issue_comment') {
    const cmd = parseCommand(i.comment && i.comment.body);
    if (cmd === 'stop') return { ...base, stage: 'control', op: 'stop', note: '/agent stop' };
    if (cmd === 'retry') {
      const phase = st.phase === 'stopped' ? st.previousPhase : st.phase;
      const stage = PHASE_STAGE[phase];
      if (!stage) return none(`nothing to retry in phase "${st.phase}"`);
      return { ...base, stage, retry: true, resume: st.phase === 'stopped', note: `/agent retry → ${stage}` };
    }
    if (cmd === 'redesign') {
      if (st.phase !== 'human') return none(`/agent redesign only works once the PR is handed to a human (phase "${st.phase}")`);
      return { ...base, stage: 'design', amend: true, note: '/agent redesign → designer amends the approved design' };
    }
    if (cmd) return none(`unknown command /agent ${cmd}`);
    if (st.phase === 'design') return { ...base, stage: 'design', note: 'design feedback → designer' };
    if (st.phase === 'human') return { ...base, stage: 'develop', reset: true, note: 'human feedback → developer' };
    return none(`agents are busy (phase "${st.phase}"); comment again once the PR needs you`);
  }

  if (i.name === 'pull_request_review') {
    const state = (i.review && i.review.state || '').toLowerCase();
    if (st.phase === 'design') {
      if (state === 'approved') {
        if (i.review.commitId !== pr.headSha) {
          return none('approval is for an older commit; approve the latest design revision');
        }
        return { ...base, stage: 'develop', reset: true, approvedSha: pr.headSha, note: 'design approved → developer' };
      }
      return { ...base, stage: 'design', note: 'design review feedback → designer' };
    }
    if (st.phase === 'human') {
      if (state === 'approved') return none('implementation approved by a human; merge when ready');
      if (i.review.touchesDesign) return { ...base, stage: 'design', amend: true, note: 'design feedback after approval → designer amends the design' };
      return { ...base, stage: 'develop', reset: true, note: 'human review feedback → developer' };
    }
    return none(`review ignored while agents are busy (phase "${st.phase}")`);
  }

  return none(`unhandled event ${i.name}`);
}

// ---------------------------------------------------------------- inline threads

// Inline review comments the agent may answer in-thread: comment id -> id of the
// thread's root comment (GitHub only accepts replies to the root).
function threadTargets(entries) {
  const out = {};
  for (const e of entries || []) {
    if (e.kind === 'inline comment' && e.id) out[String(e.id)] = e.root || e.id;
  }
  return out;
}

// ---------------------------------------------------------------- review outcome

function reviewTransition({ verdict, findings, ciPassed, attempt, maxAttempts }) {
  const blocking = (findings || []).filter((f) => f.severity === 'blocking');
  const accepted = verdict === 'approve' && blocking.length === 0 && ciPassed;
  if (accepted) return { phase: 'judge', next: 'judge' };
  if ((attempt || 0) >= maxAttempts) {
    return { phase: 'human', next: null, reason: `reviewer still has blocking findings after ${attempt} developer attempts` };
  }
  return { phase: 'implement', next: 'develop' };
}

// ---------------------------------------------------------------- judge policy

function globToRegExp(glob) {
  let re = '';
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k];
    if (c === '*' && glob[k + 1] === '*') {
      re += '.*';
      k++;
      if (glob[k + 1] === '/') k++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(path));
}

/*
 * files: [{filename, additions, deletions, changes, patch?, status}]
 * facts: {ciPassed, headMatchesReview, mergeable}
 * returns array of human-readable violations (empty = policy allows auto-merge)
 */
function judgePolicy(files, cfg, facts) {
  const v = [];
  if (!facts.headMatchesReview) v.push('the PR head changed after the reviewer accepted it');
  if (!facts.ciPassed) v.push('CI has not passed on the reviewed commit');
  if (!facts.mergeable) v.push('GitHub does not report the PR as cleanly mergeable');
  if (files.length > cfg.maxFiles) v.push(`${files.length} files changed (limit ${cfg.maxFiles})`);
  const lines = files.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
  if (lines > cfg.maxChangedLines) v.push(`${lines} lines changed (limit ${cfg.maxChangedLines})`);
  for (const f of files) {
    if (matchesAny(f.filename, cfg.protectedPaths)) v.push(`changes protected path \`${f.filename}\``);
    if (!f.patch && (f.changes || 0) > 0) v.push(`\`${f.filename}\` has no inspectable text diff`);
  }
  const src = files.some((f) => matchesAny(f.filename, cfg.sourcePaths));
  const tests = files.some((f) => matchesAny(f.filename, cfg.testPaths));
  if (src && !tests) v.push('source changed without any test changes');
  return v;
}

function pathViolations(paths, { allowed, forbidden }) {
  return paths.filter((p) => (allowed ? !matchesAny(p, allowed) : false) || (forbidden ? matchesAny(p, forbidden) : false));
}

// ---------------------------------------------------------------- diff helpers

// Lines on the RIGHT side of a unified diff patch that GitHub accepts review comments on.
function commentableLines(patch) {
  const lines = new Set();
  let right = 0;
  for (const raw of (patch || '').split('\n')) {
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      right = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+')) lines.add(right++);
    else if (raw.startsWith(' ')) lines.add(right++);
    // '-' and '\ No newline' do not advance the right side
  }
  return lines;
}

// ---------------------------------------------------------------- Claude output

function parseClaudeOutput(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Claude CLI did not return JSON output');
  }
  if (Array.isArray(raw)) raw = raw.filter((m) => m && m.type === 'result').pop() || {};
  if (raw.is_error || (raw.subtype && raw.subtype !== 'success')) {
    throw new Error(`Claude run failed (${raw.subtype || 'error'}): ${String(raw.result || '').slice(0, 500)}`);
  }
  if (raw.structured_output && typeof raw.structured_output === 'object') return raw.structured_output;
  const result = String(raw.result || '').trim();
  const fenced = [...result.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].pop();
  for (const candidate of [result, fenced && fenced[1]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error('Claude did not return a structured result');
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

module.exports = {
  BRANCH_PREFIX,
  PHASE_STAGE,
  ROLE_ICON,
  parseState,
  parseDescription,
  renderBody,
  issueFromBranch,
  isAllowed,
  parseCommand,
  route,
  reviewTransition,
  globToRegExp,
  matchesAny,
  judgePolicy,
  pathViolations,
  commentableLines,
  threadTargets,
  parseClaudeOutput,
  truncate,
};
