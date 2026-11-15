# Agent result schemas

Each agent ends its run by returning **one JSON object**, not prose. These files
define that object for each role. They are the contract between Claude and the
trusted workflow code that acts on its answer.

## How they are used

1. [`run-claude`](../../actions/run-claude/action.yml) passes the role's schema to
   `claude -p --json-schema <schema>`. Claude Code then has to finish with a
   result that matches it (`structured_output` in the CLI's JSON output).
2. [`claude-extract.cjs`](../lib/claude-extract.cjs) checks that a result came
   back and saves it as `runtime/<role>-result.json`. No result fails the step.
3. The stage's `publish` step in [`stages/`](../lib/stages/index.cjs) reads that
   file and does everything that touches GitHub.

So Claude never posts, pushes or merges itself. It only fills in fields, and the
code decides what each field may cause. The `description` of each field is part of
what Claude reads, so it is also where length and style limits live.

## Where each field ends up

| Schema | Field | Used for |
|---|---|---|
| `designer` | `status` | `needs_clarification` → questions posted; `ready` → design committed / PR opened |
| | `questions`, `reply` | the designer's comment on the issue or PR |
| | `title` | PR title and design commit message |
| | `summary` | the design proposal: PR description, frozen on the issue at approval |
| | `thread_replies` | one reply in each inline review thread |
| `developer` | `status` | `blocked` → handed to a human with `blocked_reason` |
| | `summary`, `tests`, `addressed`, `declined` | the developer's PR comment |
| | `commit_title` | the commit message title |
| | `thread_replies` | one reply per human inline thread |
| `reviewer` | `verdict`, `findings` | approve → judge; blocking findings → developer. Findings with a valid `path`/`line` become inline review comments |
| | `summary`, `goals` | the review body and the acceptance-criteria table |
| `judge` | `decision`, `risk` | auto-merge only if `auto_merge` **and** `low` **and** the code policy passes |
| | `summary`, `reasons` | the judge's PR comment; `reasons[0]` is shown in the PR status |

Changing a schema means changing the `publish` code that reads it, so schemas are
not overridable per project.
