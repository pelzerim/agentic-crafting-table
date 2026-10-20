# Live activity summaries

Enable **Settings → AI features → Activity summaries → Summarize agent and terminal activity**
to generate short map labels through the installed Claude CLI. The same setting is
available through MCP's revisioned `workspace_settings` operation. It is off by
default: enabling it sends recent, redacted terminal output to your configured
Claude account. The model defaults to Haiku and can be changed.

The helper reads at most the supervisor's bounded live tail, strips terminal
escapes and known credential patterns, then sends its last 6,000 characters.
Redaction is best effort: arbitrary private text can remain. Full recordings stay
local. The helper's cache contains a hash, short label and attempt metadata, never
its terminal evidence. It uses a private empty working directory, no project/user
settings, no tools, no MCP servers, no hooks, and no saved conversation.

Each response is limited to 64 output tokens, 3–6 words and 48 characters.
Requests disable thinking and retries, use one turn, a 20-second timeout and a
$0.02 CLI budget. That budget is a provider-side stop condition, not a guaranteed
billing ceiling. Actual usage depends on the configured account/model.

Default limits are one attempt per item per 60 seconds, 12 per rolling hour and
100 per rolling day across the table. Settings can change those limits. SQLite
reserves allowance before dispatch, so failed/uncertain calls and restarts cannot
reset it. Unchanged evidence is not retried automatically. One helper runs at a
time, cycling through visible, non-archived sessions. Output waits for two seconds
of quiet or ten seconds of continuous changes before becoming eligible.

Native hooks and runtime events remain the authority for activity, attention and
completion. Generated text changes only the label. An edited label, status change,
archive, settings change or shutdown cancels/discards a pending response. Helper
failures leave a factual status label; they never block terminal input. Stopping a
session restores its factual stopped status and keeps its recording.

## Note titles

Text-first notes save immediately with a short label from their first line. An
independent backend coordinator uses the same isolated Claude adapter with **Haiku**
to produce a 2–6 word title (at most 48 characters). Only the first 6,000 characters
of the note are eligible; known secrets are redacted before dispatch. This is best
effort redaction, not a guarantee that arbitrary private text is removed. Notes
stay local and usable when Claude is missing, offline or returns an invalid title.

The note form discloses automatic title generation. It is separate from the
opt-in terminal activity switch and never reads terminal output. Both helpers
share the configured rolling hourly/daily request allowance. Notes allow one
attempt per resource per two seconds after body changes; each unchanged
fingerprint is attempted once, including failed/uncertain requests and restarts.
One title helper runs at a time, without tools, hooks, MCP or saved conversations;
the same 64-token, 20-second and $0.02 native turn limits apply. A title arriving
cannot replace newer data or an explicit title edit. Archive/delete/close abort
pending work. A matching generated/local title causes no repeated writes.

Deterministic service and hidden native-SDK fixture checks cover this path. A real
Haiku call for note titles remains pending human supervision; the activity-summary
smoke below is historical evidence for its own prompt, not note-title acceptance.

## Agent titles

**Settings → AI features → Auto-title agents** (on by default) names Claude and Codex
items after what they are working on: 2–5 words, at most 32 characters, such as
“Fix thumbnail refresh loop”. It uses the same isolated tool-free Claude adapter with
**Haiku**, 64 output tokens, a 20-second timeout and the $0.02 native turn budget.
The request contains the redacted last 6,000 characters of the session's live
tail, up to five titles of connected on-map items, the working directory's name,
its git branch and the current title when automation owns it. Plain terminals are
not titled: a shell rarely has one goal and its title is usually the user's.

An item is considered after a finished turn (working → idle/waiting) or after a
minute of continuous work. It is sent only when the evidence fingerprint changed,
at most once per 10 minutes per item, and within the shared hourly/daily allowance
(reserved durably before dispatch). The model can return KEEP; an equivalent title
causes no write. Automation owns a title only while it is the creation default or
the last generated title. Any other title — typed at creation, from a resumed
conversation, or a later rename from settings, inline editing or MCP — stops it.
**Auto-name from activity** in the item menu hands the title back and runs once at
the next two-second tick, ignoring the item interval but not the allowance.
Renames, archive, Undermap and turning the setting off cancel a pending request;
the graph refuses a generated title whose starting title changed.

With Haiku 4.5 ($1 input / $5 output per million tokens), one request is about
200 tokens of instructions plus at most ~2,000 tokens of evidence and under 16
output tokens: about $0.002–0.003, plus any fixed overhead the CLI adds, and never
more than the $0.02 native turn limit. Shared limits (12/hour, 100/day by default)
cap the table at about $0.25 per day. A real Haiku call
for agent titles remains pending human supervision (AGENT-AUTO-TITLE-LIVE).

## Verification

Deterministic tests cover opt-in/no dispatch, redaction, output validation,
debounce, single-flight behavior, stale results, explicit edits, cancellation,
fallback, retained cache, restart-safe hourly/daily allowances and v6→v7 migration.
A background Electron journey starts a real shell and a scripted native summary
CLI, verifies the SDK's tool-free flags, observes the generated map label, restarts
the service, checks the persisted allowance and stops the original shell. This
journey makes no model calls.

The separately enabled native gate is:

```sh
ACT_LIVE_SUMMARIES=1 node scripts/smoke-summaries.mjs
```

It makes four paid requests using synthetic output, without reading user terminal
history. A run with Claude Code 2.1.282 / SDK 0.3.282 and Haiku returned:

| Authoritative status | Generated label |
| --- | --- |
| Working | Running billing plan selector regression tests |
| Waiting | Awaiting downgrades billing cycle decision |
| Idle terminal | All billing regression tests passed |
| Complete | Plan selector change completed |

All four met the length limits and reflected their supplied task/state, in about
2.0–3.5 seconds each. This is a bounded capability check, not a guarantee of model
accuracy for arbitrary output. Ordinary CI never runs this paid gate.
