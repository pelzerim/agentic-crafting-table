# Native Claude support

Agentic Crafting Table starts the installed Claude Code executable in a real PTY.
The focus view renders its bytes with xterm: native permission prompts, shell tools,
keyboard handling, account configuration and conversation behavior belong to Claude.
There is no replacement chat interface. Ordinary Terminal items use the same
supervisor and renderer without an AI provider.

## Slow or incomplete output

Use Settings → Data & diagnostics → Performance diagnostics to distinguish slow
terminal reads/writes/frames from a caught-up display. Delivery counters also show
recorded chunks awaiting consumption and detected sequence gaps. These cannot
measure the model's API stream; a spinning CLI may still be waiting on its provider.
Compare the retained terminal recording with the native Claude conversation before
claiming that xterm discarded a response. If both end at the same words, the app
cannot recover text that Claude never delivered. Capture only numeric diagnostics
in shareable reports; keep conversations and raw terminal output private.

Claude documents incomplete streaming responses and continuation behavior in its
[error reference](https://code.claude.com/docs/en/errors#the-response-above-may-be-incomplete).
Its CLI owns retries and interrupted turns. The host must not resend a prompt or
run tools automatically in response to silence. A provider interruption still needs
native error/debug evidence to distinguish network, server, CLI or cancellation;
terminal fixture success alone cannot diagnose it.

GUI launches now give sessions a UTF-8 LANG default when none is configured. This
keeps box-drawing tables, dashes, accents and emoji intact when a CLI-owned mouse
selection writes to macOS's clipboard tools. Explicit locale preferences remain
unchanged. Existing processes need to stop/resume (or be restored after an app
update) to inherit the corrected environment; simply reopening their view retains
the old process. Ordinary xterm selection uses the browser's Unicode copy handler.

## Launch and context

Install and sign in to Claude Code before creating an Agent session. Select a local
working directory and model. Projects can supply an optional default directory;
new agents copy it into an editable field. Later project changes do not move existing
sessions. Opus is the picker default; Fable, Sonnet and Haiku are available. The native CLI resolves these aliases using its configured account.
The host probes the installed executable and required flags before accepting a launch.
Missing tools and unsupported versions produce an actionable creation error.

New agents open as general-purpose interactive sessions. The creation form has
no task or brief-override fields. The current project brief and hierarchical item
context are supplied through native hooks: project → items → connected subitems,
including PRs and linked reviews. The initial prompt asks for a brief **What next**
list with relevant items and reasons, then waits for your choice. It may read
context/results and acknowledge receipt, but does not authorize executing those
suggestions. Sparse context produces fewer suggestions or a useful clarification.
Explicit host workflows can still supply prompts through the launch adapter. The trusted synchronization guide is supplied separately via
`--append-system-prompt`. It binds the existing project, node and execution workspace;
caller-provided system instructions cannot replace it. Native resume uses the saved
conversation ID and working directory, without replaying the original task.

A private per-launch `--mcp-config` connects Claude to the same workspace service
as the desktop. A per-session `--plugin-dir` adds status and context hooks without
rewriting user/project settings. `--system-prompt-snapshot off` lets an updated
host guide take effect on resume. The adapter retains normal native permission
behavior and never enables permission bypass.

**Settings → Items → Claude → Auto mode** defaults on and launches with
`--permission-mode auto`. Off explicitly uses manual approval (`default`). Claude's
own checks and account/organization policy still apply. An older CLI without auto
support shows an update-or-disable error. Existing custom permission-mode arguments
retain precedence and appear next to the toggle; changing the toggle replaces that
override while preserving unrelated arguments. Settings apply to the next new or
resumed process, not an already-running session or a frozen launch retry. Restricted
PR review sessions keep their separate read-only permissions. See Claude's
[permission-mode reference](https://code.claude.com/docs/en/permission-modes).

Context is offered at SessionStart/UserPromptSubmit and through `agent.context`.
The agent acknowledges a delivery only after reading it. Direct incoming context
sources are identified separately from the broader project/connected hierarchy.
Reference links can supply background; they do not authorize actions. Removing a
source invalidates an unacknowledged offer. Text already read by a model cannot be
erased from its conversation; subsequent deliveries identify the current sources.
If another agent changes state before acknowledgement, the guide instructs Claude
to reread the current offer and retry, without claiming the stale receipt succeeded.
Aliases/cycles are deduplicated, archived items omitted, and done/activity states
retained. Provider reads share a three-second deadline with six in flight, up to
700 characters per source and 32,000 source characters total. The inventory has a
200-item cap with an explicit omission count; the agent can use MCP for remaining
details. Summary-only reviews expose their source/revisions and can be inspected
with `workspace_run session.read`; their terminal output is not copied by the hook.
Launch retries reuse their frozen opening prompt; resume and live attachment never
replay What next. Explicit tasks, skills and review sessions retain their own task.

Hook ordering is stored separately from the graph revision. Repeated PreToolUse /
PostToolUse observations do not invalidate an MCP read→write sequence. Real status
transitions still publish map updates. Summaries here are short status fallbacks;
fast-model summaries are a separate feature ([activity-summaries.md](activity-summaries.md)).

### Background subagents, shells and watchers (AGENT-07b)

Documented signals (Claude Code [hooks reference](https://code.claude.com/docs/en/hooks),
[subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)):

- `Stop` and `SubagentStop` input carries `background_tasks`, the parent session's
  in-flight tasks (`id`, `type` such as `shell`, `subagent`, `monitor`,
  `workflow`, `teammate`, `cloud session`, `MCP task`, and `status`). It is
  absent on versions without a reachable task registry. Only `id`, `type` and
  `status` are forwarded; commands and descriptions stay out of the table.
- `PostToolUse` on `Agent` returns `tool_response.status: "async_launched"` and
  `agentId` for a background subagent (`"completed"` for foreground).
- `SubagentStop` fires when a subagent finishes, with `agent_id`; it also fires
  for Claude's internal agents (prompt suggestions, `/btw`). Other hooks with
  `agent_id` are a subagent's own turns and remain ignored, except `PostToolUse`:
  it is forwarded as `SubagentToolUse` carrying only the `agent_id` (no tool name,
  input, response, launch or artifact). It never marks the item working and never
  touches the background count. No extra registration is needed: `PostToolUse` is
  registered for all tools and fires inside subagents too.
- A background subagent's result reaches the main thread as a completion
  notification in a later turn, which ends with its own `Stop`. Background shells
  and monitors have no dedicated completion hook; their notifications likewise
  wake a main turn.
- `session_crons` (scheduled wakeups) are not counted.

The session plugin registers `SubagentStop` in addition to the previous events.
The latest `background_tasks` snapshot replaces the count; a background `Agent`
launch adds a subagent and `SubagentStop` removes it, which keeps subagents
tracked on versions that send no snapshot (background shells then go untracked).
Stopped IDs are remembered so a duplicate or reordered hook cannot revive them,
and an older snapshot never overrides a newer one. State lives in the
`agent_background` SQLite table keyed by process session; a resumed process starts
empty and SessionEnd deletes the row. If a stop signal is lost (for example a task
killed from `/tasks` while the main thread stays idle), the count stops keeping the
item working after two hours without any hook from that process; then the quiet
terminal rule marks it idle.

**Teammates.** A team teammate (`in_process_teammate`, reported as `teammate`)
keeps `status: "running"` for the life of the session; its idle flag is not in
the hook payload, and it sends no `SubagentStop` for its task id (`t…`). Read
from the Claude Code 2.1.292 bundle, not observed live: `TeammateIdle` fires at
the end of a teammate's turn with `teammate_name`, the teammate's `agent_id` and
the session's `session_id`. The plugin registers `TeammateIdle`; it is forwarded
with the name and agent id only. `PreToolUse` with an `agent_id` is forwarded as
`SubagentToolStart` (agent id only), next to `SubagentToolUse`. A teammate entry
of the snapshot keeps its `description` as `name` only when it is one bare token.
The service keeps one signal per agent in the `agent_background` body
(`team.signals`: `idle`, `tool`, `quiet`), keyed by `teammate_name`, else by the
name in an agent id shaped `a<name>-<16 hex>`, else by the agent id; `team.at` is
when the teammates were first listed or last messaged. Tool signals are recorded
only while a teammate task is known and never for an id listed as another kind;
`SubagentStop` drops that agent's signal unless it is an idle mark. A signal is
matched to the task of the same name. Signals and tasks without a match are
counted: unmatched teammates minus unmatched idle marks while `team.at` is within
the quiet window (5 minutes), and never fewer than the unmatched agents with a
tool in flight or one finished within the window. The 5 s quiet pass applies the
window. Limits: a message to one teammate makes all of them count for one window;
a teammate that only generates for more than five minutes reads idle until its
next tool; a lost `PostToolUse` keeps a tool in flight for up to two hours.

### A permission prompt after the turn ended (AGENT-07c)

A slash command or other work outside the main thread can show a permission
dialog after the main turn's `Stop`. Claude sends `Notification`
`permission_prompt`, the item needs input, and no main-thread hook follows the
answer (no `UserPromptSubmit`, `PostToolUse`, `Stop` or `idle_prompt`). Without
more evidence, a setup slash command run after a finished turn would leave the item at
“Agent needs permission” for good, so rollout validation and queued findings
could not be sent. Two independent kinds of evidence end that state:

- **Subagent work.** `SubagentToolUse` and `SubagentStop` show that the dialog
  was answered: a held dialog runs no tool and ends no subagent. When the item
  needs permission, that prompt is its latest observation, the event is not older
  than it and the main turn has ended, the item returns at once to its
  outstanding background work (“Waiting on …”) or to idle. It stays as it is
  while the main turn is active (the main thread's hooks decide) and while
  another known in-flight subagent or teammate could be the one asking.
  Subagents Claude does not report in `background_tasks` cannot be told apart.
- **The person's answer.** The session supervisor records when the person last
  pressed Enter, a lone Escape or a single digit in the app's terminal
  (`decisiveInputAt`, with the output sequence at that moment). Typing, arrow
  keys, Alt+Enter, bracketed pastes and the terminal's own replies do not count;
  nor does anything the workspace service sends (validation, findings and
  PR-comment prompts, MCP `terminal.input`). Only the desktop main process marks
  input `source: 'user'`. This needs no hook at all.

Hooks stamp `observedAt` in the hook process and the supervisor stamps the key in
its own process, both from the same machine clock. A key pressed in another
terminal emulator attached to the same Claude process is not seen.

## Saved conversations on this computer

The new-agent form lists local Claude conversations across all project folders,
including sessions created outside this app. Search by title or folder, browse by
last modification date, and load more when needed. The host uses the official
Agent SDK's read-only `listSessions` / `getSessionInfo` helpers. They read local
metadata without a model call; no transcript bodies go to the renderer.

Selecting an external conversation resumes its native ID in its original directory
and lets Claude retain its model. The table adds a new item in the selected project.
Selecting a conversation already on the table reuses that item (and its live process
when available); it does not move it between projects or duplicate it. Missing
folders/conversations fail explicitly. Archived table items must be restored first.
The same service paths are available to MCP through `workspace_sessions` and
`workspace_create_item`.

[Native session metadata reference](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser).

## Lifetime and recovery

Closing the window or quitting warns before stopping active sessions and their
child tools. Cancel leaves them running. A durable checkpoint preserves the active
set, original native identities and whether an agent was working or waiting.
Startup resumes those conversations on the existing map items. Only agents that
were actively working receive a continuation prompt; waiting agents require your
input. Manually stopped sessions stay stopped. Plain terminals reopen in the same
folder without replaying their old commands. Recovery errors remain visible with
Retry recovery. A native SessionStart hook confirms successful Claude restoration.

An unexpected desktop/workspace-service exit can leave the supervisor running.
Reconnecting to a surviving item attaches to its existing PID without a new prompt.
Resume after exit starts a new process for the same native conversation and map
node. The adapter does not substitute a new conversation if the saved one cannot
be opened. Launch retries preserve their request identity and frozen launch plan.
Settings → Data & diagnostics → Sessions provides explicit Stop controls, including for processes whose nodes were
removed from the map. Supervisor death is reported as a lost session.

## Terminal controls and recordings

Status, working directory, the agent menu and Stop share the item title row.
The menu contains Resume/reconnect and Add system prompt. A lost or failed session
(for example after a crash) also shows Resume directly in the title row. There is no History player.
Ctrl/Cmd +/− changes only terminal text size, and Ctrl/Cmd 0 resets it.
The terminal is fitted to an unpadded inner container so its final row remains
visible after window/font resizing. The minimap and map zoom slider are hidden
while an item is expanded. New PTYs receive a truecolor terminal environment without inherited `NO_COLOR`
or forced monochrome settings from the app launcher. Existing processes keep the
environment they started with; a new or resumed process gets the corrected settings.

Stop ends the process while preserving its last screen, including native applications
that clear an alternate screen during exit. The window remains readable and the
ordinary terminal scrollback remains scrollable; reopening reconstructs retained
output. Removing the History player did not remove durable recording/replay.

The private supervisor database now stores full output in sequenced chunks, read in
bounded pages. The live memory tail remains 256 KiB. Existing older sessions can
only recover their retained tail and show “Partial recording”; missing bytes cannot
be reconstructed. Recordings flush in batches (at most 200 ms apart, and on Stop),
so an abrupt supervisor/OS crash can lose the last unflushed batch. Automatic recording age/size pruning
remains undecided. Explicit deletion of a
stopped recording is available only after archiving, through Archive → Archived
session recordings. It preserves native conversations and project files.

## Verification and limits

Claude Code 2.1.281 or later is required. The optional live check covers project brief
and guide delivery, real MCP registration/linking of a local fixture PR, context
receipt, ended-conversation resume with remembered content, and the native
interactive UI rendering in Electron with a disposable-folder trust decision. The
deterministic desktop journey separately covers the complete UI launch → MCP → map →
reopen → resume path with no model calls. The live check's JSON report is ignored
local test output.

`scripts/smoke-claude.mjs` is explicitly enabled with `ACT_LIVE_CLAUDE=1`. Its two
print-mode calls have $0.75 limits, no built-in tools, only the table MCP server,
and omit unrelated user/project settings for the test invocation. The native
interactive resume uses the application's normal configuration. Reports and
screenshots stay under ignored `test-results`; temporary processes/data are cleaned
up. A fixture PR is a local map record, not a GitHub API call or comment.

Live tests are capability checks, not a statistical guarantee that every agent
follows the synchronization guide. User plugins/hooks can delay native startup or
completion, and native authentication/permissions can require terminal input.
GitHub metadata/reviews, Codex, remote machines and native Claude artifacts are
separate capability checks.

Provider references checked during implementation:
[Claude CLI flags](https://code.claude.com/docs/en/cli-reference),
[native hooks](https://code.claude.com/docs/en/hooks), and
[session plugins](https://code.claude.com/docs/en/plugins-reference).


## Launch preferences and Dock startup

Settings controls supported additional Claude arguments, Auto mode and Remote
Control (both on by default). Supported arguments currently cover effort, verbose/debug output, extra
directories, tool selection/allow/deny lists and permission mode. Each line is one
literal argument. Native session identity, model and table integration remain owned
by the app. Changes apply on a new launch/resume, while a retry uses its saved plan.
Turning Remote Control off disables it for that launch, including native auto-connect.
Claude retains its native authentication, first-use confirmation and permission UI;
ordinary tests verify the argv contract with a scripted CLI, not account eligibility.

The supervisor imports PATH from the user's login shell before the first fresh
session launch, caching it for later launches. Idle startup and recording reads
do not wait for the shell profile. This preserves Dock/Finder executable discovery,
with a bounded timeout and user/Homebrew directory fallback. This fixes native hooks
that call `node` after Finder/Dock startup. The table's own MCP/hooks continue to use
the bundled runtime through an absolute executable path. No user plugin/settings
files are rewritten. The display name changed to Agentic Crafting Table; persisted
workspace and native conversation identities remain unchanged.
