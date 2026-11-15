'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deepMerge, fill, loadConfig, loadPrompt } = require('../lib/config.cjs');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-project-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('deepMerge merges objects and replaces arrays and scalars', () => {
  const out = deepMerge({ a: { x: 1, y: [1, 2] }, b: 1 }, { a: { y: [3] }, c: 2 });
  assert.deepEqual(out, { a: { x: 1, y: [3] }, b: 1, c: 2 });
});

test('fill replaces known placeholders and leaves unknown ones', () => {
  assert.equal(fill('run {{build}} then {{ test }}; {{nope}}', { build: 'make', test: 'make test' }), 'run make then make test; {{nope}}');
});

test('defaults load without a project directory', () => {
  const cfg = loadConfig('');
  assert.equal(cfg.commands.build, './scripts/build.sh');
  assert.ok(cfg.roles.developer.allowedTools.includes('Bash(./scripts/build.sh)'));
  assert.deepEqual(cfg.roles.designer.writablePaths, ['docs/**']);
});

test('project config overrides defaults and placeholders follow it', () => {
  const dir = project({ 'config.json': JSON.stringify({ commands: { build: 'npm run build', test: 'npm test' }, design: { dir: 'spec', specFile: 'spec/README.md' }, judge: { maxChangedLines: 50 } }) });
  const cfg = loadConfig(dir);
  assert.ok(cfg.roles.developer.allowedTools.includes('Bash(npm run build)'));
  assert.ok(cfg.roles.reviewer.allowedTools.includes('Bash(npm test)'));
  assert.deepEqual(cfg.roles.designer.writablePaths, ['spec/**']);
  assert.ok(cfg.roles.developer.forbiddenPaths.includes('spec/**'));
  assert.equal(cfg.judge.maxChangedLines, 50);
  assert.equal(cfg.judge.maxFiles, 8); // untouched default
});

test('invalid project config is reported clearly', () => {
  assert.throws(() => loadConfig(project({ 'config.json': '{ nope' })), /not valid JSON/);
});

test('prompts: factory default, project replacement, project append', () => {
  const cfg = loadConfig('');
  const base = loadPrompt('reviewer', cfg, '');
  assert.match(base, /reviewer agent/);
  assert.match(base, /\.\/scripts\/build\.sh/); // placeholder filled
  assert.doesNotMatch(base, /\{\{/);

  const appended = loadPrompt('reviewer', cfg, project({ 'prompts/reviewer.append.md': 'Check RAII.' }));
  assert.ok(appended.startsWith(base.trimEnd()));
  assert.match(appended, /## Project-specific instructions\n\nCheck RAII\./);

  const replaced = loadPrompt('reviewer', cfg, project({ 'prompts/reviewer.md': 'Custom {{test}}', 'prompts/reviewer.append.md': 'Extra.' }));
  assert.equal(replaced, 'Custom ./scripts/test.sh\n\n## Project-specific instructions\n\nExtra.\n');

  assert.throws(() => loadPrompt('hacker', cfg, ''), /unknown role/);
});

test('factory prompts end with the shared writing style; replacements do not get it', () => {
  const cfg = loadConfig('');
  for (const role of ['designer', 'developer', 'reviewer', 'judge']) {
    const p = loadPrompt(role, cfg, '');
    assert.equal(p.match(/## Writing style/g).length, 1, role);
  }
  const replaced = loadPrompt('judge', cfg, project({ 'prompts/judge.md': 'Mine.' }));
  assert.doesNotMatch(replaced, /Writing style/);
});

test('the developer prompt lists the forbidden paths publish enforces', () => {
  const dir = project({ 'config.json': JSON.stringify({ design: { dir: 'spec', specFile: 'spec/README.md' } }) });
  const cfg = loadConfig(dir);
  const p = loadPrompt('developer', cfg, dir);
  assert.match(p, /Do not edit `spec\/\*\*`, `\.github\/\*\*` or `CLAUDE\.md`/);
  assert.doesNotMatch(p, /\{\{/);
});
