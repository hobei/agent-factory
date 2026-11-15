'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib/core.cjs');

const owner = 'hobei';
const human = { login: owner, type: 'User' };

// ---------------------------------------------------------------- state

test('renderBody / parseState / parseDescription round-trip', () => {
  const state = { issue: 7, phase: 'design', attempt: 0, note: 'tricky --> text' };
  const body = lib.renderBody('## Summary\nHello', state);
  assert.deepEqual(lib.parseState(body), state);
  assert.equal(lib.parseDescription(body), '## Summary\nHello');
  assert.match(body, /Closes #7/);
  assert.equal(lib.parseState('no marker'), null);
  assert.equal(lib.parseState('<!-- agent-state {broken -->'), null);
});

test('issueFromBranch only accepts agent branches', () => {
  assert.equal(lib.issueFromBranch('agent/issue-12'), 12);
  assert.equal(lib.issueFromBranch('feature/issue-12'), null);
  assert.equal(lib.issueFromBranch('agent/issue-12-x'), null);
});

test('isAllowed defaults to the repo owner, else uses the list', () => {
  assert.equal(lib.isAllowed('hobei', 'hobei', ''), true);
  assert.equal(lib.isAllowed('stranger', 'hobei', ''), false);
  assert.equal(lib.isAllowed('Alice', 'hobei', 'alice, bob'), true);
  assert.equal(lib.isAllowed('hobei', 'hobei', 'alice'), false);
});

// ---------------------------------------------------------------- routing: issues

const openIssue = { number: 5, state: 'open', labels: [] };

test('new issue by allowed user starts the designer', () => {
  const d = lib.route({ name: 'issues', action: 'opened', sender: human, allowed: true, issue: openIssue, openPr: null });
  assert.equal(d.stage, 'design');
  assert.equal(d.issue, 5);
});

test('issue events are ignored for strangers, bots, closed issues, existing PRs and agent:ignore', () => {
  const base = { name: 'issues', action: 'opened', sender: human, allowed: true, issue: openIssue, openPr: null };
  assert.equal(lib.route({ ...base, allowed: false }).stage, 'none');
  assert.equal(lib.route({ ...base, sender: { login: 'x[bot]', type: 'Bot' } }).stage, 'none');
  assert.equal(lib.route({ ...base, issue: { ...openIssue, state: 'closed' } }).stage, 'none');
  assert.equal(lib.route({ ...base, openPr: 9 }).stage, 'none');
  assert.equal(lib.route({ ...base, issue: { ...openIssue, labels: ['agent:ignore'] } }).stage, 'none');
});

test('issue comments only restart the designer when clarification is pending or on /agent start', () => {
  const base = { name: 'issue_comment', sender: human, allowed: true, openPr: null, comment: { body: 'thanks' } };
  assert.equal(lib.route({ ...base, issue: openIssue }).stage, 'none');
  assert.equal(lib.route({ ...base, issue: { ...openIssue, labels: ['agent:needs-info'] } }).stage, 'design');
  assert.equal(lib.route({ ...base, issue: openIssue, comment: { body: '/agent start' } }).stage, 'design');
});

// ---------------------------------------------------------------- routing: PRs

const pr = { number: 9, state: 'open', headSha: 'abc' };
const prEvent = (phase, extra = {}) => ({ sender: human, allowed: true, pr, prState: { issue: 5, phase, previousPhase: extra.previousPhase }, ...extra });

test('design approval on the current head starts the developer', () => {
  const d = lib.route({ ...prEvent('design'), name: 'pull_request_review', review: { state: 'approved', commitId: 'abc' } });
  assert.equal(d.stage, 'develop');
  assert.equal(d.approvedSha, 'abc');
  assert.equal(d.reset, true);
});

test('approval of a stale design commit is ignored', () => {
  const d = lib.route({ ...prEvent('design'), name: 'pull_request_review', review: { state: 'approved', commitId: 'old' } });
  assert.equal(d.stage, 'none');
});

test('design feedback (review or comment) goes back to the designer', () => {
  assert.equal(lib.route({ ...prEvent('design'), name: 'pull_request_review', review: { state: 'changes_requested' } }).stage, 'design');
  assert.equal(lib.route({ ...prEvent('design'), name: 'pull_request_review', review: { state: 'commented' } }).stage, 'design');
  assert.equal(lib.route({ ...prEvent('design'), name: 'issue_comment', comment: { body: 'use snake_case' } }).stage, 'design');
});

test('human feedback after hand-over goes to the developer with a fresh attempt budget', () => {
  const d = lib.route({ ...prEvent('human'), name: 'pull_request_review', review: { state: 'changes_requested' } });
  assert.equal(d.stage, 'develop');
  assert.equal(d.reset, true);
  assert.equal(lib.route({ ...prEvent('human'), name: 'pull_request_review', review: { state: 'approved' } }).stage, 'none');
  assert.equal(lib.route({ ...prEvent('human'), name: 'issue_comment', comment: { body: 'also handle null' } }).stage, 'develop');
});

test('after hand-over, review comments on design files send the PR back to the designer (amend)', () => {
  const review = (state, touchesDesign) => lib.route({ ...prEvent('human'), name: 'pull_request_review', review: { state, touchesDesign } });
  for (const state of ['commented', 'changes_requested']) {
    const d = review(state, true);
    assert.deepEqual([d.stage, d.amend], ['design', true]);
  }
  assert.equal(review('changes_requested', false).stage, 'develop');
  assert.equal(review('approved', true).stage, 'none');
  // During the design phase it is ordinary design feedback, not an amendment.
  const d = lib.route({ ...prEvent('design'), name: 'pull_request_review', review: { state: 'commented', touchesDesign: true } });
  assert.deepEqual([d.stage, d.amend], ['design', undefined]);
});

test('/agent redesign only works once the PR is with a human', () => {
  const d = lib.route({ ...prEvent('human'), name: 'issue_comment', comment: { body: '/agent redesign rename Rep' } });
  assert.deepEqual([d.stage, d.amend, d.pr, d.issue], ['design', true, 9, 5]);
  for (const phase of ['design', 'implement', 'review', 'judge']) {
    assert.equal(lib.route({ ...prEvent(phase), name: 'issue_comment', comment: { body: '/agent redesign' } }).stage, 'none');
  }
});

test('threadTargets maps inline comments to their thread root', () => {
  const entries = [
    { kind: 'comment', id: 1 },
    { kind: 'inline comment', id: 10, root: 10 },
    { kind: 'inline comment', id: 11, root: 10 },
    { kind: 'review (COMMENTED)', body: 'x' },
  ];
  assert.deepEqual(lib.threadTargets(entries), { 10: 10, 11: 10 });
  assert.deepEqual(lib.threadTargets(undefined), {});
});

test('comments while agents are busy are ignored', () => {
  for (const phase of ['implement', 'review', 'judge']) {
    assert.equal(lib.route({ ...prEvent(phase), name: 'issue_comment', comment: { body: 'hi' } }).stage, 'none');
  }
});

test('/agent stop and /agent retry', () => {
  const stop = lib.route({ ...prEvent('review'), name: 'issue_comment', comment: { body: '/agent stop' } });
  assert.deepEqual([stop.stage, stop.op], ['control', 'stop']);
  const retry = lib.route({ ...prEvent('implement'), name: 'issue_comment', comment: { body: '/agent retry' } });
  assert.deepEqual([retry.stage, retry.retry], ['develop', true]);
  const resume = lib.route({ ...prEvent('stopped', { previousPhase: 'review' }), name: 'issue_comment', comment: { body: '/agent retry' } });
  assert.equal(resume.stage, 'review');
  assert.equal(lib.route({ ...prEvent('human'), name: 'issue_comment', comment: { body: '/agent retry' } }).stage, 'none');
});

test('a human merging an agent PR closes the issue; unmerged closes are ignored', () => {
  const merged = lib.route({ ...prEvent('human'), name: 'pull_request', action: 'closed', merged: true, pr: { ...pr, state: 'closed' } });
  assert.deepEqual([merged.stage, merged.op, merged.issue], ['control', 'merged', 5]);
  assert.equal(lib.route({ ...prEvent('human'), name: 'pull_request', action: 'closed', merged: false }).stage, 'none');
  assert.equal(lib.route({ ...prEvent('human'), prState: null, name: 'pull_request', action: 'closed', merged: true }).stage, 'none');
});

test('non-agent PRs and closed PRs are ignored', () => {
  assert.equal(lib.route({ ...prEvent('design'), prState: null, name: 'issue_comment', comment: { body: 'x' } }).stage, 'none');
  assert.equal(lib.route({ ...prEvent('design'), pr: { ...pr, state: 'closed' }, name: 'issue_comment', comment: { body: 'x' } }).stage, 'none');
});

// ---------------------------------------------------------------- routing: dispatch handoffs

test('dispatch handoffs must match the PR phase', () => {
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const d = (stage, phase) => lib.route({ name: 'workflow_dispatch', sender: bot, allowed: false, dispatch: { stage }, pr, prState: { issue: 5, phase } });
  assert.equal(d('review', 'review').stage, 'review');
  assert.equal(d('develop', 'implement').stage, 'develop');
  assert.equal(d('judge', 'judge').stage, 'judge');
  assert.equal(d('review', 'implement').stage, 'none');
  assert.equal(d('judge', 'stopped').stage, 'none');
});

test('dispatch design on an issue', () => {
  const r = lib.route({ name: 'workflow_dispatch', sender: human, allowed: true, dispatch: { stage: 'design' }, issue: openIssue, openPr: null });
  assert.equal(r.stage, 'design');
  assert.equal(lib.route({ name: 'workflow_dispatch', sender: human, dispatch: { stage: 'develop' }, issue: openIssue }).stage, 'none');
});

// ---------------------------------------------------------------- review loop

test('reviewTransition: approve → judge, findings → develop, budget exhausted → human', () => {
  const ok = { verdict: 'approve', findings: [], ciPassed: true, attempt: 1, maxAttempts: 3 };
  assert.equal(lib.reviewTransition(ok).next, 'judge');
  assert.equal(lib.reviewTransition({ ...ok, ciPassed: false }).next, 'develop');
  assert.equal(lib.reviewTransition({ ...ok, findings: [{ severity: 'blocking' }] }).next, 'develop');
  assert.equal(lib.reviewTransition({ ...ok, findings: [{ severity: 'suggestion' }] }).next, 'judge');
  assert.equal(lib.reviewTransition({ ...ok, verdict: 'request_changes', attempt: 3 }).phase, 'human');
});

// ---------------------------------------------------------------- judge policy

const cfg = { maxFiles: 3, maxChangedLines: 50, protectedPaths: ['.github/**', 'CMakeLists.txt'], sourcePaths: ['src/**', 'include/**'], testPaths: ['tests/**'] };
const facts = { ciPassed: true, headMatchesReview: true, mergeable: true };
const file = (filename, n = 5) => ({ filename, additions: n, deletions: 0, changes: n, patch: '@@ -1 +1 @@\n+x' });

test('judgePolicy passes a small tested change', () => {
  assert.deepEqual(lib.judgePolicy([file('src/String.cpp'), file('tests/StringTest.cpp')], cfg, facts), []);
});

test('judgePolicy flags each hard rule', () => {
  const v = (files, f = facts) => lib.judgePolicy(files, cfg, f).join(' | ');
  assert.match(v([file('src/a.cpp')]), /without any test/);
  assert.match(v([file('src/a.cpp', 40), file('tests/t.cpp', 40)]), /80 lines/);
  assert.match(v([file('a'), file('b'), file('c'), file('d')]), /4 files/);
  assert.match(v([file('.github/workflows/x.yml')]), /protected path/);
  assert.match(v([file('CMakeLists.txt')]), /protected path/);
  assert.match(v([{ filename: 'img.png', additions: 0, deletions: 0, changes: 1 }]), /no inspectable/);
  assert.match(v([file('tests/t.cpp')], { ...facts, ciPassed: false }), /CI/);
  assert.match(v([file('tests/t.cpp')], { ...facts, headMatchesReview: false }), /head changed/);
  assert.match(v([file('tests/t.cpp')], { ...facts, mergeable: false }), /mergeable/);
});

test('glob matching', () => {
  assert.equal(lib.matchesAny('docs/changes/issue-1.md', ['docs/**']), true);
  assert.equal(lib.matchesAny('docsx/a.md', ['docs/**']), false);
  assert.equal(lib.matchesAny('src/a.cpp', ['src/*.cpp']), true);
  assert.equal(lib.matchesAny('src/x/a.cpp', ['src/*.cpp']), false);
  assert.deepEqual(lib.pathViolations(['docs/a.md', 'src/b.cpp'], { allowed: ['docs/**'] }), ['src/b.cpp']);
  assert.deepEqual(lib.pathViolations(['docs/a.md', 'src/b.cpp'], { forbidden: ['docs/**'] }), ['docs/a.md']);
});

// ---------------------------------------------------------------- diff + output parsing

test('commentableLines follows hunk headers', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10,2 +11,2 @@', ' x', '+y'].join('\n');
  assert.deepEqual([...lib.commentableLines(patch)], [1, 2, 3, 4, 11, 12]);
  assert.equal(lib.commentableLines(undefined).size, 0);
});

test('parseClaudeOutput prefers structured_output and falls back to result text', () => {
  assert.deepEqual(lib.parseClaudeOutput(JSON.stringify({ subtype: 'success', structured_output: { a: 1 } })), { a: 1 });
  assert.deepEqual(lib.parseClaudeOutput(JSON.stringify({ subtype: 'success', result: '{"b":2}' })), { b: 2 });
  assert.deepEqual(lib.parseClaudeOutput(JSON.stringify({ subtype: 'success', result: 'here:\n```json\n{"c":3}\n```' })), { c: 3 });
  assert.throws(() => lib.parseClaudeOutput(JSON.stringify({ subtype: 'error_max_turns', is_error: true })), /failed/);
  assert.throws(() => lib.parseClaudeOutput('nope'), /JSON/);
  assert.throws(() => lib.parseClaudeOutput(JSON.stringify({ subtype: 'success', result: 'no json' })), /structured/);
});
