# Direct PR reviews

Status: local orchestration and scripted native-process tests implemented.
Real model/review-result acceptance remains pending. Write integration tests require
human supervision.

The PR view offers Codex and Claude review actions with model selectors. The latest Sol model and
Opus are preferred when available; an unavailable choice fails before capture or
launch. A native CLI capability probe checks required read-only controls in the
installed `codex exec --help` and `claude --help`; recognizing flags is not evidence
of successful model execution.

Each action freezes the PR head, base tip and complete merge-base comparison in a
private local checkout. Its independent compact review item links to the PR and
opens the actual native process terminal, with provider/model/revision labels.
Preparation errors remain visible on the PR. A repeated active request reuses the
run across aliases; a later intentional review gets a new item. Missing models,
incomplete captures and changed account/source bindings cannot silently launch a
different review. These actions do not post comments, approve or merge PRs.

The one-off terminal accepts no interactive input. Read-only CLI controls exclude
repository customizations and table MCP actions. Completion and failure come from
the managed process. Output remains readable after exit, stop and service restart.
If closing interrupts a review, startup restarts analysis of its saved comparison
on the same item and retains the earlier recording as its predecessor. This is an
analysis restart, not a resumed native conversation.

Deterministic evidence:

- Domain tests cover native arguments, launch-plan replay,
  model validation/fallback, exact revisions, active alias deduplication, request
  replay, cancelled capture recovery and retained predecessor sessions.
- The hidden Electron journey runs scripted local executables through the real
  PTY/supervisor/service/SQLite path, selects both models, verifies linked items,
  rejects terminal input, closes/recovers active analysis, and reads completed
  recordings after restart. The script is not a model or GitHub write adapter.
- The PR action-row screenshot is reviewed and compared with fixed tolerances.

Source binding: two-PR navigation and reverse-order completion pass for both native
providers. Three guards reject mismatches before creating/launching a review: the
clicked resource assertion, the captured comparison identity and source binding
revalidation after a revision conflict. Older requests without the optional resource
assertion still replay.

`scripts/smoke-native-reviews.mjs` is an opt-in, potentially paid gate against a
synthetic local repository. It is excluded from ordinary tests. `scripts/smoke-review-comparison.mjs` is a separate
opt-in read-only GitHub/Git capture check; it does not post or run a model. Neither
script substitutes for human-supervised verification of remote write workflows.

## Structured findings

Both launches ask for the findings schema (`src/pull-requests/review-findings.ts`,
strict-mode compatible: closed objects, every property required, optional values
nullable). Flags come from the installed CLIs' help:
`claude --help` (2.1.285 or later) lists `--json-schema <schema>` ("JSON Schema for
structured output validation") and `--output-format … "json" (single result)`;
`codex exec --help` (0.155.1 or later) lists `--output-schema <FILE>` ("Path to a JSON
Schema file describing the model's final response shape") next to
`-o, --output-last-message <FILE>`. The probe enables them only when listed;
otherwise the request asks for one fenced json block. The parser accepts a Claude
result object (`structured_output`, or JSON/fenced JSON in `result`), a Codex last
message, or fenced JSON after earlier terminal lines. Whether a real Claude or Codex
run returns output that validates needs a supervised live review of each provider.

Sending findings pastes one bracketed prompt into the chosen agent's terminal,
like comment fixes and rollout validation, and never writes to GitHub. Queue
state lives in `review_sends` and `review_finding_events` (schema migration 11).
