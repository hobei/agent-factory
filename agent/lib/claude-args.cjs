'use strict';
// Print the CLI settings for one role, one per line (consumed by run-claude/action.yml):
// cli version, model, effort, schema path, then each allowed tool.
const path = require('path');
const { loadConfig } = require('./config.cjs');

const SCHEMA = { designer: 'designer', developer: 'developer', reviewer: 'reviewer', judge: 'judge' };

const role = process.argv[2];
if (!SCHEMA[role]) {
  console.error(`unknown role ${role}`);
  process.exit(1);
}
const dir = path.resolve(__dirname, '..');
const cfg = loadConfig(); // factory defaults + PROJECT_AGENT_DIR overrides
const r = cfg.roles[role];
const model = process.env.AGENT_MODEL || r.model || cfg.model;
console.log([cfg.cliVersion, model, r.effort || '', path.join(dir, 'schemas', `${SCHEMA[role]}.json`), ...r.allowedTools].join('\n'));
