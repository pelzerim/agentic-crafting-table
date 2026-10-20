# Native Codex integration

Status: desktop creation, native terminal, saved-session discovery, MCP and graceful
close/reopen recovery implemented.

The installed CLI supplies models and saved-conversation metadata through its
app-server protocol. `node scripts/probe-codex.mjs` is an optional local probe: it
starts a dedicated stdio metadata process, performs initialization, reads the model
catalog and one metadata page, then closes it. It does not start a model turn,
change account configuration or print conversation text. The adapter projects
responses onto metadata schemas; transcript fields are not exposed to the renderer.
Requests have size/time limits, malformed frames disconnect, pending requests fail
on transport loss, and the observer never grants native approval requests.

`codex-cli` 0.155.1 or later passes this probe and returns its visible models (such as
`gpt-6-astra`) plus saved-session metadata. This shows local protocol compatibility, not model availability for every account or successful
agent execution. Three automated transport tests cover handshake/correlation,
metadata projection, refused approval requests, limits, disconnects and timeouts.

The native TUI supports connecting to a dedicated app-server with `--remote` and
resuming an explicit native identity. The Unix transport is WebSocket over a private
Unix socket, not JSON lines; disable per-message compression during its handshake.
The supervisor reserves its launch before starting a dedicated native server, records
the returned thread identity, then appends trusted guide and separate reference context through
`thread/inject_items` without a model turn. Empty unpersisted threads cannot be
resumed by the TUI. The observer unsubscribes from turns before the real terminal
resumes that identity, leaving approval ownership with the terminal. Global native
status notifications supply working/input/idle state. The table uses no separate
Codex background-task signal; unlike Claude (AGENT-07b) a Codex item reflects only
its thread status. Stop owns both the terminal
and its dedicated server/tool processes; disconnect retains the recording and never
silently creates another conversation.

A bounded live probe verifies the production driver's creation,
reference-context delivery, actual Astra response through native terminal input,
working→idle notifications, and same-ID resume after stopping the owned server.
It uses only disposable conversations and removes them. Five deterministic runtime
tests include a WebSocket/native-terminal fixture covering identity, approval
routing, archive inheritance, tool cleanup and disconnect replay. That fixture is
not a model. A production Electron journey additionally covers dynamically discovered
models, inherited working directories, native New/Continue selection, MCP context
acknowledgment and map updates, live reattachment without duplicates, archived-session
recovery after close, continuation prompts only for interrupted work, and retained
recordings. An optional real-model run exercises the complete production service →
native terminal → model → stdio MCP → SQLite path, creating a disposable to-do after
reading project context, with one-time approvals and no change to account
permissions; its conversations and workspaces are removed afterwards.

Choose **Agent session → Provider: codex**. The native CLI supplies the model list;
Astra is the default when available. Continue lists saved Codex conversations with
cursor pagination and reuses an existing table item/process. Imported/resumed
conversations retain native model selection. The guide is appended as developer
context, project facts as reference data, without replacing user or built-in
instructions. Per-session MCP bindings do not rewrite the user's configuration.
Current project/context changes are available through the same MCP context/acknowledge
contract used by Claude. Native first-use prompts remain in the terminal. Missing
CLI, startup, identity and connection failures are explicit. Do not replace the terminal with a custom chat implementation or
silently approve/disable user hooks to pass those gates. App-server/WebSocket APIs
are currently experimental; keep version probes and explicit unsupported errors.

Sources checked against the installed CLI and its generated schemas:

- [App-server protocol and native terminal connection](https://learn.chatgpt.com/docs/app-server)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Native hooks and trust](https://learn.chatgpt.com/docs/hooks)
- [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Native server crash ownership: production supervisors start a small
bundled owner process with an IPC lifetime channel. Supervisor death disconnects
that channel and the owner stops the private native server and its tool descendants.
This does not target the user's shared Codex daemon. The runtime crash test kills
the supervisor, verifies all owned server/tool/terminal processes exit, restarts it,
and verifies replay retains the lost record/native identity without running work
again. Normal Stop and close/reopen still use the same explicit cleanup path.
