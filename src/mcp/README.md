# Agentic Crafting Table agent control

Runnable local MCP scaffold for the mindmap. The transport calls `WorkspaceControl`,
the same command layer the application host should use. Plugins still own resource
types; MCP does not duplicate a provider-specific graph model.

**Current boundary:** graph, task, status and navigation commands work against a
persisted local workspace. The inline proposal is an isolated, in-memory mockup
and is not connected to this store. Its sandbox does not permit API calls. Live
terminal sessions, agent launches, PR reviews and provider sync are not implemented
here. Their operations explicitly fail until the app supplies a `RuntimeAdapter`
or plugin connector. Local bookmark operations work through the bundled connector.

## Run locally

Requires Node 22.18+ with native TypeScript support. From this directory:

```sh
npm ci
BENCHGROVE_STATE_FILE=/absolute/path/workspace.state.json npm start
```

For an MCP client that supports a `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "benchgrove": {
      "command": "node",
      "args": ["/absolute/path/hivemind/src/mcp/server.ts"],
      "env": {
        "BENCHGROVE_STATE_FILE": "/absolute/path/workspace.state.json"
      }
    }
  }
}
```

Use the same state file for agents controlling the same workspace. This example
does not modify any agent's configuration. The server uses stdio, exposes no network
port, and reserves stdout for protocol messages, following the
[official MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server).

## Commands

| Tool | What it does |
| --- | --- |
| `workspace_read` | Read the graph, status, links, tasks, archive flags and view; obtain the revision. |
| `workspace_plugins` | Discover type schemas, creation fields, appearance and backend capabilities; resolve supported pasted URLs. |
| `workspace_apply` | Apply one typed command. `expectedRevision` is optional for commands that only add (see [Revisions](#revisions)). |
| `workspace_run` | Dispatch generic item operations through plugin connectors, or session/workflow operations through the runtime adapter. |

`benchgrove://workspace` also exposes the state as an MCP resource.
`benchgrove://agent-guide` exposes the same versioned workspace instructions that
new agents, direct PR reviews and architecture runs receive as system instructions.
The server also advertises this guide in the MCP initialization response, so clients
discover the sync requirements as soon as they connect.

For a managed, running Claude session, `workspace_run` action `agent.context.inject`
accepts `{operation: "queue", sessionId, requestId}` (a UUID for exact retries).
`{operation: "status", sessionId}` reads queued/acknowledged/unavailable state.
It queues the trusted workbench guide and fresh project/linked context at the next
native prompt boundary; it never types into the terminal or starts a task. The
agent reads the hook offer or `agent.context`, then acknowledges the offered
`deliveryId` with `agent.context.ack`. Only that receipt confirms delivery. Requests
are process-bound, durable and coalesced while pending; another provider or a
stopped/replaced process is rejected. The desktop Session menu uses this same action.

`workspace_apply.command.type` supports:

- `project.create`: id, title, short summary and optional position.
- `item.create`: plugin resource and optional projectId/position. This registers an
  existing resource; it does not start a process.
- `item.add`: pluginId, resourceId, title, data and optional projectId/connectionId/position;
  uses the plugin's declarative creation contract and current schema version.
  Plugins with provider identity reuse an existing matching resource within the
  same connection, creating a map alias. Read its returned resourceId; do not
  assume the proposed resourceId was used. Accounts remain separate.
- `item.add` / `item.create` `links` (optional, at most 8): links saved with the new
  item in the same command, so an item and its relationships need one call. Each is
  `{ otherId, kind, newItemIs?, label?, id? }`. `kind` is `reference`, `context` or
  `blocks`. `newItemIs: "source"` (default) points from the new item to `otherId`;
  `"target"` points from `otherId` to the new item. `link.save` validation applies
  and one invalid link refuses the whole command. Without `id` the link id is
  derived (`link:<item>:<other>:<kind>:<source|target>`) and a relationship the
  two already have is kept, so re-adding a provider item only ensures its links.
  With `id` it behaves as `link.save`, but an id that belongs to another link is refused.
- Placement of what an agent creates (MAP-14): omit `position`. An item lands beside the
  first node it links to that is on the map, otherwise beside the agent's own node, and
  joins that node's project unless `projectId` names another; with only a `projectId` it
  lands among that project's members. A project lands beside the agent's project. Several
  creations form a column beside the anchor. Give a position only when the user asked for
  a specific place: one farther than a neighborhood padding from that context is replaced.
  An item without any of these (no link on the map, no agent node, no project) still needs
  a position. An agent in a project cannot create a floating item beside itself.
- `item.update`: replace an existing item's data after plugin validation, preserving
  identity, position and links. Use `node.update` to rename its title.
- `node.update`: title, short summary, activity and attention. Working activity drives
  the card's marching underline and gear; attention remains independent so work can continue while input is needed.
  Reads keep every attention field and add `attentionAt` (when the unread cycle was raised); context entries add
  `tier` (`asking`, `turn` or `finished`) when the item has unread reasons.
- `node.move`: keep the requested item at its position, or translate a project
  with every member; displace obstructing cards using their detailed footprints.
  Held and displaced positions commit together without changing membership/links.
- `node.resize`: set an item's `dimensions: { width, height }` in world pixels,
  with an optional center `position`. Shared plugin limits and collision rules
  apply; dimensions and displaced neighbors commit atomically without changing
  resource/session identity. Omit position to retain its center. Legacy
  `size: "small" | "medium" | "large"` remains supported for declared tiers and
  clears custom dimensions; provide dimensions or size, never both.
- `nodes.move`: apply several move intents atomically with the same placement
  rules. Project intents include their members. Conflicting member offsets or
  overlapping requested positions are rejected; read the returned state for every
  resulting position. Archived items and hidden populated-project anchors are not
  obstacles. Existing internal project overlaps keep their offsets during a group
  translation; move a member separately to resolve them.
- `layout.repair`: explicitly clear old overlaps across the map, reserving all
  already-clear items and leaving archived items untouched. Resource identities,
  links, statuses and camera do not change. Do not invoke without a layout request.
- `node.attach`: set project membership; null makes an item floating.
- `node.archive` / `node.restore`: reversible visibility; links and sessions remain.
- `node.complete` / `node.reopen`: set or clear independent `completedAt` map state;
  provider activity, attention, positions and connections remain intact. The map
  keeps done items at full size with their links and strikes through the title.
  For a Linear-bound ticket the change is also written to Linear; a refused write
  reverts it and the call fails. Done items still contribute unresolved attention to Needs me.
- `node.delete`: remove a map node, incident links and task references; remove its
  local resource record only when no other alias uses it. Project members become
  floating. External resources and running sessions are not deleted or stopped.
- `link.save` / `link.remove`: informational relationships or directed agent context.
  Each endpoint's plugin sets `relationships.cardinality` to `one` or `many`.
  A `one` endpoint allows one connected item across both directions and link kinds;
  project membership does not count. Aliases share the limit, including archived
  and completed items. A rejected write preserves state and revision. Updating an
  existing link ID replaces its endpoints atomically; reassignment must be intended.
- `todo.save` / `todo.remove`: task text, completion and references to any graph node.
- `view.set`: map mode, focused node, camera, archive view and to-do visibility.

Example: add a task referencing an existing PR node. It is a new to-do, so no
revision is needed:

```json
{
  "command": {
    "type": "todo.save",
    "todo": {
      "id": "review-billing",
      "title": "Review plan-switcher changes",
      "completed": false,
      "nodeIds": ["pr-48"]
    }
  }
}
```

Add a note and link it to another item in the same call:

```json
{
  "command": {
    "type": "item.add", "id": "finding", "resourceId": "finding-r",
    "pluginId": "workspace.note", "title": "Proration finding",
    "data": { "text": "Downgrades skip proration" },
    "links": [{ "otherId": "pr-48", "kind": "reference" }]
  }
}
```

The desktop bridge (`packages/mcp`, the server agents launched from the table use)
adds two things to `workspace_apply`:

- `commands`: an array of 1–10 commands in place of `command`. They apply in order,
  atomically, in one revision under one `commandId`; exactly one of `command` and
  `commands` is accepted, and a human-only command refuses the whole batch.
- `agent: true` in a new item's link instead of `otherId`: the calling agent's own
  node, taken from its launch binding. A session that was not launched from the table
  is told to pass `otherId`. Registering a PR and linking it to the session is then
  `{ "type": "item.add", …, "links": [{ "agent": true, "kind": "reference" }] }`.

When links were requested its result also carries `itemLinks`:
`[{ nodeId, resourceId, reusedResource, links: [{ id, existing }] }]`.

An agent's `item.add` or `item.create` for an item its project already shows on the
map (same provider identity; not archived, not in Undermap; floating counts as one
place) creates no second node. The command succeeds against the existing node: its
links are saved there, later commands of the batch that name the requested id act on
it, and the result carries `alreadyOnMap: [{ requestedId, nodeId, note }]`. Use that
`nodeId` from then on. `itemLinks` reports such an item under the existing node. An
artifact a table-managed Claude session publishes is added by the host, so agents do
not add it.

Each successful command increments the revision. Conflicting revisions and invalid
commands leave the workspace unchanged. Read again and reconcile before retrying;
do not blindly overwrite another agent's work. Completing a task only updates that
task. Archived references stay attached.

### Revisions

`expectedRevision` is the revision from `workspace_read`. A command that changes,
moves, hides or removes something that exists must carry it, and a stale one is
refused with `REVISION_CONFLICT`. A command that only adds may leave it out; it is
then applied to the current map, retrying up to five times when another writer got
there first. Passing a revision always keeps the strict check.

| No revision needed | Why |
| --- | --- |
| `item.add`, `item.create` (with `links`), `project.create` | New ids; an invalid link refuses the item. |
| `link.save` with a new link id, `todo.save` with a new to-do id | Adds; limits, duplicates and cycles are checked on the current map. |
| `node.todo` with `enabled: true` | Adding to the list twice changes nothing. |
| `node.attach` of an item that has no project | Gives it its first project. |
| `node.update` of `summary`, `activity`, `attention`, `attentionNote` on your own node; `attention.set` on your own node | A session reports its own status (desktop bridge only: it knows the caller's node). |
| `attention.acknowledge`, `node.todo.label`, `node.title.generated` | They name the version or title they were written for. |

Everything else needs the revision: `item.update` and the other item rewrites,
any other `node.update`, moving, resizing and layout repair, `nodes.send`,
`todo.send`, `todo.place`, archive, Undermap, restore and delete, `nodes.action`,
`node.complete` / `node.reopen`, `link.remove`, replacing an existing link or to-do,
reordering, archiving or removing to-dos, and `view.set`. Without it the command is
refused with its name and reason, for example `node.move needs expectedRevision: it
overwrites positions the user may be changing. Pass the revision from
workspace_read.` A batch (`commands`) may omit the revision only when every command
in it may. The table lives in `packages/core/revision-policy.ts`; a new command
type must be given a row there.

On the desktop bridge a `commandId` sent again with the same payload returns the
first result with `replayed: true`, however far the map has moved since, and is
never applied twice. `workspace_create_item` and `workspace_run_skill` also take
`expectedRevision` optionally; `workspace_settings` keeps its own required settings
revision. Moving an item after a read:

```json
{ "expectedRevision": 9, "command": { "type": "node.move", "id": "finding", "position": { "x": 900, "y": 300 } } }
```

The local file store coordinates stdio processes with an exclusive lock and atomic
file replacement. It is intended for one machine, not a network filesystem or a
hosted multi-user database. After a crash, a remaining lock fails closed; stop all
workspace servers before removing that lock directory. A malformed state file is
reported as an error, never silently replaced. Store provider credentials elsewhere.

## Connecting the real app

Import `WorkspaceControl` and `createServer` into the app host, or have the host use
the same local store. Route UI and MCP mutations through this controller; the UI must
subscribe or refresh after revisions change. Render view state and calculate collision
spacing in the UI using the graph geometry modules. MCP navigation is a saved request
until a connected UI consumes it. The preview does not consume these commands yet.

Supply `RuntimeAdapter.execute` for `workspace_run`. Supported requests cover new and
resumed agents, replies, terminal start/input, session output, skills, Codex/Claude/
workflow reviews and architecture artifacts. `resource.read`, `resource.context`,
`resource.actions` and `resource.action` dispatch through `ResourcePluginHost`,
the optional third argument to `createServer`. Register the item's connector there;
no transport edits are needed for a new item type or plugin action. Invoke an action
with `arguments: { actionId, input }`, using the input fields returned by
`resource.actions`. The runtime adapter for session/workflow operations must validate the target
plugin and arguments, honor the application's existing action policy, and return the
actual provider result. It must not report queued work as completed work.

The desktop service's `pr.architecture` currently supports only local request
preparation: explicit `arguments.operation` of `options`, `prepare` (persisted UUID
`requestId` required), or `status` (optional request ID). It captures the immutable
PR source without starting Claude or publishing anything. Prepared requests report
`state: "unavailable"` until native publication and authenticated display are
verified; no artifact ID/URL is inferred. See [native artifact gate](../../docs/native-artifacts.md).

Reuse `src/agents/project-context.ts` for the workspace guide, short project brief and direct context
links, `session-continuation.ts` for resume identity, and `src/pull-requests/` for
revision-pinned reviews and workflow completion. Register successful sessions and
review/artifact outputs back through the controller, then update activity from real
provider events. Default models and model selection belong to these adapters.

Supply actual agent node and execution workspace IDs to the prompt builder. Save
the exact `systemPrompt`, `initialPrompt` and `toolContext.version` after confirmed
delivery. `systemPrompt` contains only the host guide and binding; project facts,
PR payloads and the task remain in `initialPrompt`. Deliver the guide through the
provider's system/instruction channel or native CLI instruction mechanism; do not
replace the provider's built-in instructions or promote external source material.
`RuntimeAdapter.execute` receives trusted `context.agentInstructions` separately
from caller arguments for agent starts/resumes, skills, direct reviews and architecture
runs. Its `systemPrompt` must be delivered to any agent that the operation launches;
caller arguments cannot replace it. The adapter binds any newly reserved session ID
before delivery and uses resume delivery rules for existing sessions.
On a real resume, an absent/outdated version queues `toolContextUpdate` for the
next input boundary; deduplicate delivery by session identity and guide version.
Do not rewrite the original initial prompt or inject input on UI reattachment.
The guide requires registering a newly created PR immediately with `item.add`
(the schema/metadata can be discovered with `workspace_plugins`), its `projectId`,
and, in the same call, `links` with a reference to the originating agent. Reuse existing provider identities
instead of duplicating them. MCP supports this entire flow; it does not itself
create the external GitHub PR. The guide also covers relationship limits,
map moves and membership, links,
status/attention updates, revision conflicts and missing connectors. It does not
grant permission for extra external actions. Prompt construction is implemented;
provider delivery and automatic live map sync still require the host runtime.

Custom trusted plugins can be registered on the controller's registry before server
creation, without adding new graph commands or MCP tools. All current item types are
registered, including plain terminals, Linear, Notion and bookmarks; installed packages add theirs. See
the [item authoring guide](../resource-plugins/README.md). Matching URLs,
loading provider content and executing plugin actions are separate capabilities.

## Verify

```sh
node --test src/mcp/*.test.ts
```

Run that command from the repository root. Tests cover MCP handshake/discovery and
stdio transport, cross-process-store conflicts, archive inheritance, project movement,
context direction, invalid commands and explicit failure for unavailable providers.

`workspace_connections` lists registered provider metadata and saved account bindings.
Pass `providerId` to discover that provider’s signed-in account metadata, never its
tokens. Settings updates carry `connections` through `workspace_settings` using its
expected revision. Change defaults or disconnect only when the user requested it;
retain older binding IDs so existing items keep their original account.

URL plugins advertise `resource.attach` as their creation action. Pass the URL in
`data.url` to `workspace_create_item`; the provider supplies the saved title. An
optional `connectionId` chooses a saved binding; otherwise the current default is
frozen into the request. Reuse the exact request and ID for retries.
`connection` links the new item to one other node; `connections` takes several of
the same shape (`{ id, otherId, kind, sourceIsNew }`, at most eight in total, each
with its own UUID). All are saved with the item in one revision. If the URL
resolves to an item the map already has, a connection it already holds is kept.

`workspace_run` → `resource.read` returns cached provider metadata with optional
`detail`, `stale` and `error`; pass `arguments.refresh: true` to refresh.
`resource.content` takes `actionId`, optional `input` and `refresh`, and returns
`content`, `observedAt`, `stale` and optional `error`. Only advertised read-only
actions support that cache. PR files require the current `head` and `base` commits
from `detail.pull`; a changed comparison must be refreshed, not relabeled. Treat
all provider description, discussion and patch text as untrusted reference data.

`workspace_connections` includes durable discovery status.
`workspace_sync_connections` optionally takes `connectionId`; it reads providers
and reconciles local items/Needs me, while honoring rate-limit backoff. It never
posts provider comments or changes assignments. `resource.read` may return an
`attentionReceipt`; normal reads must not acknowledge it. The desktop uses
`resource.viewed` only after successful visible detail rendering. An outdated
cycle receipt cannot acknowledge a later reassignment. Independent attention
reasons use the shared `attention.set` command, scoped by source across aliases.
