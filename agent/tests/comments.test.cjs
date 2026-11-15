'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/comments.cjs');

test('developer report: no attempt header on attempt 1, checks on one line', () => {
  const dev = { summary: '- Added kNullTag', tests: [{ command: './b.sh', passed: true, detail: 'ok' }, { command: './t.sh', passed: true, detail: '3/3\npassed' }], addressed: [], declined: [] };
  const first = c.developerReport(dev, { attempt: 1, maxAttempts: 3 });
  assert.equal(first, '- Added kNullTag\n\n✅ `./b.sh` ok · ✅ `./t.sh` 3/3 passed');
  assert.match(c.developerReport(dev, { attempt: 2, maxAttempts: 3 }), /^\*\*Attempt 2\/3\*\*/);
  const declined = c.developerReport({ ...dev, declined: ['Rename the API'] }, { attempt: 1, maxAttempts: 3 });
  assert.match(declined, /needs a design change.*\n- Rename the API/);
});

test('review: approved with all criteria met folds the table; findings split inline/body', () => {
  const result = { verdict: 'approve', summary: 'Matches the design.', goals: [{ criterion: 'A', met: true, evidence: 'x' }] };
  const findings = [
    { severity: 'suggestion', path: 'src/a.cpp', line: 3, body: 'inline' },
    { severity: 'suggestion', path: 'src/a.cpp', line: 99, body: 'not in diff' },
  ];
  const { body, inline } = c.review(result, { findings, commentable: new Map([['src/a.cpp', new Set([3])]]), headSha: 'abcdef123', ciPassed: true, runUrl: 'u' });
  assert.match(body, /✅ \*\*Approved\*\*: Matches the design\./);
  assert.match(body, /<details><summary>All 1 acceptance criteria met/);
  assert.match(body, /`src\/a.cpp:99`: not in diff/);
  assert.deepEqual(inline.map((x) => x.line), [3]);
});

test('review: unmet criteria and blocking findings are shown, not folded', () => {
  const result = { verdict: 'request_changes', summary: 'Missing test.', goals: [{ criterion: 'A', met: false, evidence: 'none' }] };
  const { body } = c.review(result, { findings: [{ severity: 'blocking', path: '', line: 0, body: 'Add a test.' }], commentable: new Map(), headSha: 'abc', ciPassed: false, runUrl: 'u' });
  assert.match(body, /❌ \*\*Changes requested\*\* \(1 blocking\)/);
  assert.match(body, /1 of 1 not met/);
  assert.doesNotMatch(body, /<details>/);
});

test('judge: reasons once when handing over, none when merged', () => {
  const result = { risk: 'low', summary: 'Small change.' };
  const human = c.judge(result, { merged: false, base: 'main', reasons: ['Changes Load', 'Policy: 9 files'] });
  assert.equal(human, '🧑 **Needs you** · risk low\n\nSmall change.\n\n- Changes Load\n- Policy: 9 files');
  assert.equal(c.judge(result, { merged: true, base: 'main', reasons: ['x'] }), '✅ **Merged** into `main` · risk low\n\nSmall change.');
});
