# Project skill runs

Double-click empty project space (or right-click → New item), then choose
**Run skill** in the radial picker. It is always in the project quick ring when
native agent creation is available; it is absent outside a project. The movable inline picker inherits the project folder, discovers skills
for the selected provider, and lets you choose a model and optional arguments.
The run becomes a normal agent item with the real native terminal, context guide,
MCP connection, status events, recording and recovery. Its toolbar shows the launch
provider/model and folder. Native model changes can supersede that launch model.

The service asks the installed provider for metadata; it does not parse skill
bodies or replace their native behavior. Claude SDK `supportedCommands()` initializes
without yielding a user message, persistence or external MCP servers. The discovery
invocation disables ordinary hooks/Remote Control and closes promptly. Built-in
commands (including names that shadow custom commands) are excluded. Codex uses
`skills/list` for the exact folder, including disabled/error metadata. Ambiguous
enabled Codex skill names cannot launch until resolved in native configuration.
Neither lookup starts a model turn. Native capability failures remain explicit.

The host rechecks the selected ID before the first launch. Claude receives its
`/name` invocation and Codex its `$name` invocation as one literal initial-prompt
argument. Optional arguments are not interpreted by a shell. The normal table guide
and project context remain separate. Skill files retain their own native behavior,
including native permissions and any model overrides they define.

`workspace_skills` and `workspace_run_skill` expose the same operations to agents.
The original request, resolved skill, prompt, folder and runtime plan are frozen.
Concurrent/repeated requests reuse their identity; changed retries fail. Skill runs
are durable normal agent jobs, so recovery reconciles the existing process/native
conversation. Explicit resume never resubmits the skill invocation. A plus-origin
run includes the optional shared creation connection in that frozen identity;
context direction, capacity and atomic commit use the normal agent-creation rules.
Back/right-click/Escape from skill selection returns to the radial picker before
closing it. Merely previewing the radial action never executes a skill.

## Verification

The opt-in live check runs real Claude Code (2.1.282 or later) and Codex (0.155.1 or
later): each discovers a disposable project skill and returns a marker present only in
its body, verified in the native assistant messages. Claude also acknowledges project
context through the real MCP connection. Native test approvals are one-time and scoped
to context reads/acknowledgement; unrelated Codex hooks stay untrusted. Test
conversations, processes and workspace data are removed. Such bounded runs prove the
native launch path, not that every third-party skill performs its advertised workflow.

`ACT_LIVE_SKILLS=1 node scripts/smoke-skills.mjs` repeats this opt-in capability gate.
Set `ACT_SKILL_PROVIDER=claude` or `codex` to check one provider. It uses real account
model calls with a two-minute process deadline per provider; normal CI never runs it.
Existing first-use authentication can still require a separate manual native check.
The deterministic Electron journey uses explicit protocol fixtures, covers UI and
real stdio MCP launches/retries/resume, and compares the reviewed picker screenshot.
Domain tests cover metadata projection, unavailable skills, exact argument handling,
frozen retries and no repeated invocation on resume.

Provider references: [Claude skills](https://code.claude.com/docs/en/skills) and
[Codex app-server metadata](https://learn.chatgpt.com/docs/app-server).
