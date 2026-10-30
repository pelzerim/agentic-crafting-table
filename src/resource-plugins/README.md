# Adding an item type

This page covers item types bundled with the app. For a plugin package in its own repository,
follow the [plugin authoring guide](../../docs/plugins/authoring.md).

Every item is a plugin. The shared core owns projects, positions, zoom, relationships,
tasks, archive state and persistence. An item owns its data, appearance, creation
fields, optional content views, provider operations and agent context.

## Start with one file

Copy the `items/bookmark/` package (its `act-plugin.json`, `definition.ts` and
`plugin.ts`) into a new folder, add the folder to `bundled/plugins.json` and run
`node scripts/bundled-plugins.mjs`. A definition is enough for schema discovery,
validated creation and the generic map/detail presentation. It requires no new graph node class,
database table, MCP tool, or provider switch in the core.

Declare `mapSizes` when more than the native footprint is useful. It contains a
`defaultSize` and a `sizes` record keyed by the supported `small`/`medium`/`large`
tiers. Each preset declares width, height, description, summaryLines, optional
public `fields`/`fieldLines`, and optional showType/iconOnly. Keep the native
default dimensions in sync with `appearance`; copied definitions also copy their
size policies. Declared fields must exist in the plugin schema. These presets
drive the right-click menu, per-type Settings controls, collision footprints and
MCP validation. Single-tier types omit the Size submenu; without this metadata,
the host preserves one native tier. Expanded `view` dimensions remain separate.
See [the built-in content matrix](../../docs/item-map-sizes.md).

```ts
import { defineResourcePlugin } from '../../define.ts';

export const buildRun = defineResourcePlugin({
  id: 'acme.build',
  apiVersion: 1,
  schemaVersion: 1,
  name: 'Build run',
  icon: 'workflow',
  preferredView: 'focus',
  appearance: { size: 'small', tone: 'blue', shape: 'artifact' },
  creation: { label: 'Track build' },
  fields: {
    buildId: { label: 'Build ID', kind: 'text', required: true },
    url: { label: 'Build URL', kind: 'url' },
  },
});
```

The field vocabulary supports text, multiline text, HTTP(S) URLs, numbers, booleans
and choices. It generates validation and serializable JSON Schema for agents. Add
`validateData` only for constraints beyond these fields. Provider-created outputs
can omit `creation` to stay out of the generic creation picker. `matchInput` can
recognize pasted references; ambiguous matches remain explicit choices.

Working-directory inputs use `kind: 'directory', fromProject: 'workingDirectory'`.
The shared `fieldDefaults` helper copies the optional project folder into new
drafts without overwriting explicit input. Pure `item.add` commands apply the
same metadata in the core, independent of field names. For a runtime creation
action, resolve omitted inherited fields in its backend creator and validate the
result before freezing the launch plan; `validateCreationFields` defers those
missing fields to that creator. Persist the resolved folder so retries, existing
items and saved sessions never adopt a later project change. A floating item or
project without a folder still needs an explicit directory when required.

URL-backed types declare `creation: { mode: 'url', action: 'resource.attach',
label: 'Attach …' }` and a syntax-only `matchInput`. They join the single **From URL**
picker entry automatically. `plugins.discover` exposes preferred `urlCandidates`
for UI and MCP: specific matches win over `creation.urlFallback: true` (used by
Web link), while equally specific matches require a choice. Detection does not
fetch content; the connector resolves the authoritative title on attachment.
Legacy field-based types can set `creation.group: 'url'` to fold their old shortcuts
into this entry while retaining existing data/edit/MCP contracts, as Bookmark does.

A new URL type also takes over existing Web links it matches (spec RES-10).
`registry.conversions(resource)` lists the specific types for a saved
`urlFallback` item; `item.convert { id, pluginId, connectionId?, keepTitle? }`
rewrites that resource in place (same resource and node ids, links and to-dos)
and refuses a provider identity that already exists. The service reads the
provider before converting, at start, when accounts change and through the
`resource.convert` runtime action behind the menu's “Convert to <type name>”.
Nothing type-specific is needed: a syntax-only `matchInput`, a connector that
loads the item and, for provider types, `providerIdentity` for the duplicate guard.

For provider items, define `providerIdentity(data)` as a stable normalized key,
independent of title and URL spelling. GitHub PRs use case-insensitive owner/repo
plus PR number. The trusted registry scopes that key to the plugin and optional
`connectionId`. It omits the function from serialized UI/MCP descriptions.
`item.add` and `item.create` reuse an existing matching resource and create a map
alias; use the returned node's `resourceId` rather than assuming a proposed ID was
used. The alias inherits observed activity/attention/summary, but has its own layout,
project, done and archive state. Original items are not moved or restored. Different
connections remain distinct. Editing data into another existing provider identity
fails atomically. Plugins without this capability retain independent resources.
Existing duplicate records are not silently rewritten on startup.

Types that should open a browser instead of expanding can declare
`activation: { kind: 'browser', urlField: 'url' }`. The desktop validates the saved
record and sends the field through its HTTP(S)-only browser bridge. Camera and
item positions remain unchanged; custom types need no map or transport branch.

Types with a page on their provider's website declare `webLink: { label, template }`,
e.g. `'https://github.com/{owner}/{repo}/pull/{number}'`. `{field}` parts are filled
from saved data and URL-encoded; a template that is only `{field}` takes a whole
saved URL. A list of templates uses the first one whose fields are all present.
Anything that is not https is dropped. The link backs the **Open on …** menu entry
and, when enabled in Settings → Map, double-clicking the item.
Types with URL creation and an available connector also get Refresh item in the
context menu. Adding a field-based type makes it available in the circular picker's
All layer; users can promote it to an ordered shortcut in Settings. URL-backed
types share From URL in both places.

For a complete local example, see `items/note`. `workspace.note` declares one
required multiline `text` field (with `rows: 8` for the shared editor), a tiny
blue appearance, a provider-free context connector and an inert text view. The
view calls optional `services.editResource()` to open the host editor instead of
writing data directly. Agents discover the same `{ text: string }` schema, use
`item.add`/`item.update` and read `resource.context`. `generatedTitle: { field: 'text' }`
hides the manual title field, allows omission of `item.add.title`, and gives the
shared backend title coordinator a required text source. This is an explicit
AI capability: saves use a local label; the isolated fast helper refines it later.
Provider items can instead declare `attachTitle: { evidence(snapshot) }` returning
`{ kind, text }`: the host queues one title request when the item is first attached,
spends the attempt before the call and keeps that title (or a rename) on later
refreshes (Slack uses this). It runs only in the backend registry.
`appearance.size: 'tiny'` is smaller than a to-do; `openFromIcon: true` adds an
accessible open button. New types need no table,
graph branch or MCP tool. Notes in the current project or its explicitly connected
hierarchy contribute reference material. Direct incoming context remains separately
identified; informational links do not authorize actions.

Optional `context: { parentField, fields }` metadata declares an existing linked
parent's node-ID field and allowlisted saved facts for the agent hierarchy. Reviews
use `sourcePrId` so they follow their PR regardless of link direction; source commit
IDs help the agent distinguish stale reviews. Declare only safe scalar facts, never
credentials, raw terminal history or arbitrary data. New plugins use the same
cycle-safe traversal and their existing backend `getContext`; no graph or MCP
transport branch is required. Missing connectors retain summary-only entries.

## Add capabilities when needed

Markdown-based read views can reuse `renderMarkdown` from `markdown-view.ts` with
the `markdown-content` class. It uses bundled Marked and DOMPurify, retaining
read-only task lists and safe formatting while keeping raw HTML inert. HTTP(S)
links use the host browser opener; images become attachment links. Keep the
provider's original Markdown in snapshots/context rather than saving rendered HTML.

```text
items/build-run/
  act-plugin.json     Manifest: id, version, apiRange, entries, contributes
  definition.ts       Shared: identity, fields, creation, appearance, URL matching
  plugin.ts           Definitions entry: definitions and declarative contributions
  connector.ts        Optional backend: status, actions, subscriptions, context
  service.ts          Optional: activate(ServiceHost) registers the connector
  views.ts            Optional frontend: custom detail or map contents
  renderer.ts         Optional: activate(RendererHost) registers the views
```

| Entry | Purpose |
| --- | --- |
| `plugin.ts` | Credential-free definitions shared by UI, storage and MCP. |
| `service.ts` | Backend connectors and other service registrations; inject API clients here. |
| `renderer.ts` | Optional custom views; never imports backend connectors. |

The manifest declares everything a package registers; see the
[plugin package section](../../docs/resource-plugins.md#plugin-packages-api-1) for
the SDK (`packages/plugin-sdk`), namespaces, legacy ids and host extension points.

An application can instead inject definitions with
`createResourcePluginRegistry([buildRun])`, register a connector on
`ResourcePluginHost`, and register views on `ResourceViewRegistry`. No automatic
filesystem scanning, arbitrary package loading or marketplace is involved.

`ResourcePluginHost` resolves connectors by plugin id, validates action inputs,
rejects unadvertised actions, and bounds callers on cancellation even when a
connector ignores its signal. A read-only action that returns menu choices may set
`cacheChoices: true`: the coordinator saves its last answer per item, answers an ask
with input `{ cached: true }` from it at once (marked `cachedAt`) and `{ refresh: true }`
from the provider, and forgets it before any write on that item. `loadResourceChoices`
uses this to show the saved menu first and replace it when the live read differs;
`heedsBlockers` still applies to a saved answer. Late observations/results are discarded; cancellation
does not promise to undo an external write. Durable writes need a coordinator. `getContext` lets any new
item become a context source for an agent. `acceptsContext` is a separate definition
capability for receiving context, typically an agent session.

Set `relationships: { cardinality: 'one' }` to allow a resource to connect to one
distinct item. The default is `many`. Both endpoints apply their own rule, so two
`one` endpoints form a one-to-one relationship, while a `many` endpoint can connect
to several `one` resources. Built-in types use `many`.
Reference and context links share the limit in either direction. A second link kind
to the same partner is allowed. Project membership is independent. Aliases share
their resource's limit; archiving or marking done does not free a connection.
`WorkspaceControl` validates these trusted definitions on `link.save`, including
updates and restores. Remove an old link or update its endpoints to reassign it;
the host never silently drops an occupied connection. The UI must use this same
controller. `workspace_plugins` includes the effective rule for every type.

`ResourceViewRegistry` dispatches optional node/detail mounts, forwards status updates,
and disposes each mount once. `presentResource` supplies a consistent icon, brand,
size, fields and fallback model to the canvas. The application provides its generic
renderer. Missing plugins and incompatible data retain the saved record and show
an unavailable item; they never delete it. Schema migrations must be explicit.

Views own their UI only. The host owns terminals and background processes, so
closing an expanded item must not stop its session. Only backend connectors get
provider credentials; records hold references such as `connectionId`.

## Same capabilities from coding agents

`workspace.todo` is a local map item containing only task text. It uses the
same movement, attachment, reference/context links, archive and delete commands as
other items. Complete/reopen it with `node.complete` / `node.reopen`; `completedAt`
on the map node is the only completion flag. Completing a to-do never completes
its linked agent, PR or project. Its connector supplies only task text as agent
context; read the graph for completion state. Retired v1 notes remain valid saved
data but are not exposed in forms, discovery or context. No data migration or
automatic deletion is needed. It requires no external account. Appearance metadata
keeps its completed title row and switches an empty box to a checked box without
adding a to-do branch to the map renderer, geometry or MCP transport.
The floating To-do list includes map to-dos alongside checklist entries, grouped
by project. `src/graph/todos.ts` derives the groups without copying map tasks:
their own project membership wins over links, and edits/completion target the
original node. Checklist entries are grouped only when all attached references
resolve to one project. Floating or ambiguous entries appear under **No project**.
Archived map tasks are excluded. Moving a map task to another project changes its
group on the next render; completed tasks retain their project grouping.

1. `workspace_plugins` discovers the type, required fields and connected capabilities.
2. `workspace_apply` with `item.add` creates it using `pluginId`, title and data.
   Optional `links` save its relationships in the same command (no item type needs
   anything for this; `relationships.cardinality` still applies).
   The registry supplies its current schema version. `item.update` replaces its
   data after validation. Position, membership, resource identity and links remain.
3. `workspace_run` with `resource.read`, `resource.context`, `resource.actions`, or
   `resource.action` dispatches to its connector. New plugin actions need no new tools.

`item.create` remains available to import a full existing resource record, including
provider-created outputs. Neither creation command starts a session or contacts a
provider. Runtime operations are explicit connector or host actions.

The bookmark example works end to end in the local MCP server: create it, read its
status, obtain its saved notes as context, and request a formatted reference. It
does not fetch URLs. External providers still need their real connector implementations.

`web.link` is the general **Web link** item. It has URL-only creation and a
`browser` activation descriptor; opening it navigates directly to the saved URL.
Its connector reads a public page's title, with a domain fallback. Use
`host.resolveUrl('web.link', id, url, signal)` before persisting the attachment.

Authenticated definitions declare `connectionProvider`. The shared `item.bind`
command binds an existing item to an account, reconciling a matching provider
resource without discarding map aliases, layout, lifecycle, links or to-do references.
Cardinality is revalidated atomically. Binding is explicit; startup does not merge
older unbound resources or change account selection.
Metadata requests have redirect, time and size limits, pin public DNS answers,
and send no credentials. The browser preview uses sample titles and domain
fallbacks rather than live metadata, but opens the original URLs normally.

`slack.message` demonstrates URL-only attachment of a message or thread. Its
definition preserves workspace, channel, selected message and optional thread-root
identity. It is discoverable through the same catalog and MCP tools; content
loading and context extraction still require an authenticated Slack connector.

## Production UI boundary

The Electron renderer consumes `registry.creationTypes()` and serialized schemas,
mounts item contents through `ResourceViewRegistry`, and submits the same commands
as MCP through the workspace service. The frozen HTML reference remains sample
data. Amber belongs to Needs me (STATE-02): an indicator toned `amber` keeps that tone id and is drawn in the neutral waiting colour, and a cue's label row gives way to the Needs me reason while the item needs me (the cues stay as icons). `appearance.tone`, size, icon and brand affect the current renderer; `shape`
is a reserved styling hint, with a shared stepped silhouette used today.

## Explicit data upgrades

Increment `schemaVersion` only when the saved data shape changes. Add trusted,
synchronous migrations to the definition; each step has a unique source version
and a strictly newer target no higher than the current schema:

```ts
migrations: [
  { fromVersion: 1, toVersion: 2, migrate: data => ({ content: data.body }) },
],
```

A migration receives a copy of the data and returns JSON data, not a resource.
It cannot rename resource IDs, map IDs, title, account binding, links or positions.
Keep the semantic provider identity stable. The registry strips executable
migrations from renderer/MCP descriptions. Build each version's validator from
its own fields; do not inherit an older `validateData` closure by spreading an
already-created definition when changing those fields.

Before accepting commands, the sole workspace writer prepares each plugin's full
upgrade batch, validates results and provider identity collisions, writes a private
SQLite backup, and commits the records atomically. Bad data, callbacks or storage
failures preserve every original record for that plugin and expose an unavailable
reason. Other plugins can still load. No migration path, a missing plugin or an
older installed version leaves data untouched. Reinstalling compatible code makes
it available again. Backups live beside the database; restore only with the app
and service stopped. Do not commit databases, backups or real account data.

The reference upgrade fixture is
[`plugin-migrations.test.ts`](../../packages/workspace-service/plugin-migrations.test.ts).
It covers chained versions, aliases, archived items, camera, jobs, rollback after a
real SQLite failure, removal/downgrade and the production service startup path.

## Verification

From the repository root:

```sh
npm run test:plugins
npm run check
```

Copy `resourcePluginContract(definition, { valid, invalid })` from
[`testing.ts`](testing.ts) into the new type's test. Supply explicit sanitized data.
For a backend connector, also call `resourceConnectorContract` with a fixture-only
factory and inputs for every advertised action. The catalog coverage checks fail
when a shipped definition or connector has no shared-contract fixture. Never inject
a real account or network writer into this suite. Test provider pagination, errors,
identity and stale observations separately at the adapter/service boundary.

The shared harness checks discovery, UI/MCP metadata, commands, invalid input,
round-trip persistence, resource identity/aliases, links/to-dos, archive/restore,
default presentation and missing/newer-plugin preservation. Connector checks cover
dispatch, schemas, context and cancellation. The unknown-type MCP test and hidden
`workspace.spec.ts`/`plugin-compatibility.spec.ts` journeys verify discovery, creation,
reload, migration and unavailable/restored rendering through production paths.

Backend connectors can supply `creationOptions` for a field with
`optionsSource: 'resource.options'`. Return stable values, optional display labels
and an empty/default selection. The shared creation-options service/MCP route
applies cancellation. A `creation.action: 'resource.attach'` fields form validates
and loads the provider record before persisting its authoritative title, using the
same durable attachment path as URL imports. Implemented example: GitHub URL lookup. `appearance.size: 'icon'` selects a 48-pixel map icon; all
sizes use the same graph geometry and full item view. An unverified legacy record
may return `undefined` from `providerIdentity` to retain its original identity.

`providerIdentity(data, resource)` also receives the host record. A connector newly
introduced for legacy records may withhold provider identity until `connectionId`
is present, preserving previously independent unbound aliases. `item.bind` then
reconciles them through existing shared domain rules; Notion's service test covers
this upgrade path without losing nodes, positions or relationships.

Connected `load` results may include `resolution: { data, aliases }` when a provider
returns an immutable ID for a renamed human identifier. Supply schema-valid data
and up to 63 prior identity payloads; the host also includes the original request
(maximum 64 total). `providerIdentity` must return a key for every payload under
the same account. Attachment/refresh reconciles existing aliases atomically and
preserves their map nodes. Don't return this metadata for unverified/offline data.
See the unknown-provider reconciliation fixtures and Linear connector.

Creation presentation can supply `creation.shortLabel` for the compact ring and
`creation.label` for the confirmation action. Optional `creation.labelByField`
selects a label from a declared field's value (for example Start Claude/Codex).
Select fields support `optionBrands` (a row of square logo buttons for known providers) and `optionLabels`; IDs and validation remain unchanged, and
live catalog labels take precedence. New plugins need no picker/transport branch.
