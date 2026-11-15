'use strict';
// Validate Claude CLI JSON output, save the structured result, and log a summary.
const fs = require('fs');
const { parseClaudeOutput } = require('./core.cjs');

const [raw, out, role, exitCode] = process.argv.slice(2);
const text = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : '';
let meta = {};
try {
  meta = JSON.parse(text);
} catch {
  /* reported below */
}
const summary =
  `Claude ${role}: exit ${exitCode}, ${meta.num_turns ?? '?'} turns, ${meta.duration_ms ? Math.round(meta.duration_ms / 1000) : '?'}s` +
  (meta.total_cost_usd != null ? `, ~$${Number(meta.total_cost_usd).toFixed(2)} API-equivalent` : '');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${summary}\n`);
try {
  const result = parseClaudeOutput(text);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.log(`::error::${e.message}`);
  console.log(text.slice(-4000));
  process.exit(1);
}
