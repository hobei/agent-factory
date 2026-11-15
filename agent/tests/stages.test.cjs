'use strict';
// Stage publish steps against a fake GitHub API: where the PR goes next (handOff),
// what state is stored, and what is posted. No network, no Claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-'));
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
execFileSync('git', ['init', '-q'], { cwd: work });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: work });
Object.assign(process.env, { WORK_DIR: work, RUNTIME_DIR: runtime, PROJECT_AGENT_DIR: '' });

const lib = require('../lib/core.cjs');
const stages = require('../lib/stages/index.cjs');

const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 1 };
const actions = { notice() {}, warning() {}, info() {}, setOutput() {} };

// A fake octokit holding one PR (#22, issue #2). Records what the stage does.
function fakeGitHub({ phase = 'review', labels = [], feedbackFrom = 'T0' } = {}) {
  let body = lib.renderBody('design', { issue: 2, phase, attempt: 1, maxAttempts: 3, feedbackFrom });
  const log = { dispatched: [], comments: [], reviews: [], merged: false, labels: [...labels] };
  const ok = async () => ({ data: {} });
  const github = {
    paginate: async () => [],
    graphql: ok,
    rest: {
      issues: {
        get: async ({ issue_number }) => ({ data: { number: issue_number, labels: log.labels.map((name) => ({ name })), user: { login: 'hobei' }, state: 'open' } }),
        createComment: async ({ body: b }) => (log.comments.push(b), { data: { id: 1 } }),
        addLabels: async ({ labels: l }) => (log.labels.push(...l), { data: {} }),
        removeLabel: async ({ name }) => ((log.labels = log.labels.filter((x) => x !== name)), { data: {} }),
        createLabel: ok,
        update: ok,
      },
      pulls: {
        get: async () => ({ data: { number: 22, body, head: { sha: 'head123', ref: 'agent/issue-2' }, base: { ref: 'main' }, title: '#2: x', draft: false, mergeable: true, mergeable_state: 'clean' } }),
        update: async ({ body: b }) => ((body = b), { data: {} }),
        createReview: async ({ body: b }) => (log.reviews.push(b), { data: {} }),
        listFiles: ok,
        merge: async () => ((log.merged = true), { data: {} }),
        requestReviewers: ok,
      },
      actions: { createWorkflowDispatch: async ({ inputs }) => (log.dispatched.push(inputs.stage), { data: {} }) },
      repos: { get: async () => ({ data: { default_branch: 'main' } }) },
    },
  };
  return { github, log, state: () => lib.parseState(body) };
}

function runtimeFiles(meta, results) {
  fs.writeFileSync(path.join(runtime, 'meta.json'), JSON.stringify(meta));
  for (const [role, r] of Object.entries(results)) fs.writeFileSync(path.join(runtime, `${role}-result.json`), JSON.stringify(r));
}

const reviewMeta = { pr: 22, issue: 2, headSha: 'head123', feedbackFrom: 'T-dev', startedAt: 'T-review', attempt: 1 };
const approve = { verdict: 'approve', summary: 'Fine.', goals: [], findings: [] };

test('review approve → judge, remembering the reviewed commit', async () => {
  const gh = fakeGitHub();
  runtimeFiles(reviewMeta, { reviewer: approve });
  process.env.CI_OUTCOME = 'success';
  await stages.review.publish({ github: gh.github, context, core: actions });
  assert.deepEqual(gh.log.dispatched, ['judge']);
  assert.equal(gh.state().phase, 'judge');
  assert.equal(gh.state().reviewedSha, 'head123');
  assert.equal(gh.state().feedbackFrom, 'T-review');
  assert.equal(gh.log.reviews.length, 1);
});

test('review with queued human feedback → develop, looking back to the developer run', async () => {
  const gh = fakeGitHub({ labels: ['agent:feedback-queued'] });
  runtimeFiles(reviewMeta, { reviewer: approve });
  process.env.CI_OUTCOME = 'success';
  await stages.review.publish({ github: gh.github, context, core: actions });
  assert.deepEqual(gh.log.dispatched, ['develop']);
  assert.equal(gh.state().phase, 'develop');
  assert.equal(gh.state().feedbackFrom, 'T-dev');
});

test('review out of attempts → human, with one reviewer comment', async () => {
  const gh = fakeGitHub();
  runtimeFiles({ ...reviewMeta, attempt: 3 }, { reviewer: { ...approve, verdict: 'request_changes', findings: [{ severity: 'blocking', path: '', line: 0, body: 'x' }] } });
  process.env.CI_OUTCOME = 'success';
  await stages.review.publish({ github: gh.github, context, core: actions });
  assert.deepEqual(gh.log.dispatched, []);
  assert.equal(gh.state().phase, 'human');
  assert.ok(gh.log.labels.includes('agent:needs-human'));
  assert.equal(gh.log.comments.filter((b) => /could not converge/.test(b)).length, 1);
});

const judgeMeta = { pr: 22, issue: 2, headSha: 'head123', base: 'main', feedbackFrom: 'T-review', startedAt: 'T-judge', violations: [] };
const autoMerge = { decision: 'auto_merge', risk: 'low', reasons: [], summary: 'Small.' };

test('judge auto-merges a clean low-risk PR and closes the issue', async () => {
  const gh = fakeGitHub({ phase: 'judge' });
  runtimeFiles(judgeMeta, { judge: autoMerge });
  await stages.judge.publish({ github: gh.github, context, core: actions });
  assert.equal(gh.log.merged, true);
  assert.equal(gh.state().phase, 'merged');
  assert.ok(gh.log.comments.some((b) => /✅ \*\*Merged\*\*/.test(b)));
});

test('judge never merges over queued feedback; it goes to the developer', async () => {
  const gh = fakeGitHub({ phase: 'judge', labels: ['agent:feedback-queued'] });
  runtimeFiles(judgeMeta, { judge: autoMerge });
  await stages.judge.publish({ github: gh.github, context, core: actions });
  assert.equal(gh.log.merged, false);
  assert.deepEqual(gh.log.dispatched, ['develop']);
  assert.equal(gh.state().feedbackFrom, 'T-review');
  assert.equal(gh.log.comments.length, 0);
});

test('judge hands to a human with the reasons shown once', async () => {
  const gh = fakeGitHub({ phase: 'judge' });
  runtimeFiles({ ...judgeMeta, violations: ['12 files changed (limit 8)'] }, { judge: { ...autoMerge, decision: 'human_review', reasons: ['Changes Load'] } });
  await stages.judge.publish({ github: gh.github, context, core: actions });
  assert.equal(gh.state().phase, 'human');
  assert.equal(gh.state().reason, 'Changes Load');
  const [comment] = gh.log.comments;
  assert.match(comment, /- Changes Load\n- Policy: 12 files changed/);
  assert.doesNotMatch(comment, /Needs you:/);
});

test('control queue labels the PR for the developer', async () => {
  const gh = fakeGitHub({ phase: 'develop' });
  process.env.ROUTE = JSON.stringify({ stage: 'control', op: 'queue', pr: 22, issue: 2 });
  await stages.control({ github: gh.github, context, core: actions });
  assert.ok(gh.log.labels.includes('agent:feedback-queued'));
});
