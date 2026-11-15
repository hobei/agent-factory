'use strict';
// Factory defaults + per-project overrides.
//
// Defaults live in agent/config.json and agent/prompts/ in this repo. A project can
// override them from its own default branch, in PROJECT_AGENT_DIR (normally
// <project>/.github/agent):
//
//   config.json                 deep-merged over the defaults (objects merge, arrays and
//                               scalars replace)
//   prompts/<role>.md           replaces the factory prompt for that role
//   prompts/<role>.append.md    appended to the (factory or replaced) prompt
//
// A factory prompt is agent/prompts/<role>.md followed by agent/prompts/_style.md
// (the writing style all roles share). A project's replacement prompt is used as is.
//
// Strings in the config and prompts may use {{build}}, {{test}}, {{designDir}} and
// {{specFile}}; prompts may also use {{developerForbiddenPaths}}. They are filled in
// from the merged config.

const fs = require('fs');
const path = require('path');

const FACTORY_DIR = path.resolve(__dirname, '..');
const ROLES = ['designer', 'developer', 'reviewer', 'judge'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function fill(text, vars) {
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function fillAll(value, vars) {
  if (typeof value === 'string') return fill(value, vars);
  if (Array.isArray(value)) return value.map((v) => fillAll(v, vars));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillAll(v, vars)]));
  return value;
}

const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function projectDir(dir) {
  return dir !== undefined ? dir : process.env.PROJECT_AGENT_DIR || '';
}

function templateVars(cfg) {
  const vars = { build: cfg.commands.build, test: cfg.commands.test, designDir: cfg.design.dir, specFile: cfg.design.specFile };
  // e.g. "`docs/**`, `.github/**` or `CLAUDE.md`", from the paths publish actually enforces
  const paths = ((cfg.roles && cfg.roles.developer && cfg.roles.developer.forbiddenPaths) || []).map((p) => `\`${fill(p, vars)}\``);
  vars.developerForbiddenPaths = paths.length > 1 ? `${paths.slice(0, -1).join(', ')} or ${paths[paths.length - 1]}` : paths[0] || '(nothing)';
  return vars;
}

function loadConfig(dir) {
  const base = JSON.parse(fs.readFileSync(path.join(FACTORY_DIR, 'config.json'), 'utf8'));
  const pdir = projectDir(dir);
  const own = pdir ? readIf(path.join(pdir, 'config.json')) : null;
  let over = {};
  if (own) {
    try {
      over = JSON.parse(own);
    } catch (e) {
      throw new Error(`Project agent config ${path.join(pdir, 'config.json')} is not valid JSON: ${e.message}`);
    }
  }
  const merged = deepMerge(base, over);
  return fillAll(merged, templateVars(merged));
}

function loadPrompt(role, cfg, dir) {
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
  const pdir = projectDir(dir);
  const own = pdir ? readIf(path.join(pdir, 'prompts', `${role}.md`)) : null;
  const extra = pdir ? readIf(path.join(pdir, 'prompts', `${role}.append.md`)) : null;
  const factory = () => {
    const read = (name) => fs.readFileSync(path.join(FACTORY_DIR, 'prompts', name), 'utf8').trimEnd();
    return `${read(`${role}.md`)}\n\n${read('_style.md')}\n`;
  };
  const base = own !== null ? own : factory();
  const text = extra ? `${base.trimEnd()}\n\n## Project-specific instructions\n\n${extra.trim()}\n` : base;
  return fill(text, templateVars(cfg));
}

module.exports = { FACTORY_DIR, ROLES, deepMerge, fill, loadConfig, loadPrompt };
