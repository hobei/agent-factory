'use strict';
// Entry point for actions/stages: `call: develop.prepare` → stages.develop.prepare({github, context, core}).
//
// A stage (design, develop, review, judge) is three steps in one workflow job:
//
//   prepare   read the issue, PR, conversation and state from GitHub; update the PR
//             state; write the agent's prompt and runtime/meta.json
//   (Claude)  actions/run-claude runs the agent in WORK_DIR, writes <role>-result.json
//   publish   read the result, enforce the rules (allowed paths, …), commit and push,
//             post comments and replies, then handOff() to the next stage
//
// review and judge also have a `prompt` step between prepare and Claude, because
// their prompt needs the CI result or the checked-out diff; develop has `between`,
// which commits Claude's work before the publish step gets the push token.
//
// Files in RUNTIME_DIR (passing data between the steps of one job):
//   <role>-prompt.md    the full prompt Claude reads on stdin
//   <role>-result.json  Claude's structured answer (shape: agent/schemas/<role>.json)
//   meta.json           what prepare knew (issue, PR, startedAt, thread ids, …)
//   ci.log              build + test output (review only)
//
// Environment (set by .github/workflows/agent.yml): ROUTE (the route job's decision as
// JSON), WORK_DIR (PR checkout Claude edits), RUNTIME_DIR, PROJECT_AGENT_DIR (project
// overrides), PUSH_TOKEN (publish only), CI_OUTCOME (review), STAGE (failure).
//
// PR state lives in a hidden JSON block in the PR description (core.parseState /
// renderBody); gh.updatePr() read-modify-writes it. Claude never sees a GitHub token.

const { route } = require('./route.cjs');
const { control, failure } = require('./control.cjs');

module.exports = {
  route,
  control,
  failure,
  design: require('./design.cjs'),
  develop: require('./develop.cjs'),
  review: require('./review.cjs'),
  judge: require('./judge.cjs'),
};
