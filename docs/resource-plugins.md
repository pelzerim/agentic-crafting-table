# Project-map resource plugins

For the current product requirements, see the
[product specification](specification.md) and [architecture](architecture.md). This document retains detailed
proposal/scaffold notes; the specification takes precedence if they disagree.

Status: modular item architecture accompanying the interactive proposal. Definitions,
creation schemas, generic presentation, frontend view dispatch, backend connector
dispatch and persisted MCP commands run locally. The bookmark example includes a
working connector and detail view. External provider connectors and real terminals
still need implementation. The interactive proposal keeps its separate sample state.

To write a plugin package, start at [docs/plugins](plugins/README.md): a step-by-step
[authoring guide](plugins/authoring.md), a [design guide](plugins/design.md) and a public
[example plugin](../examples/plugins/reading-list). For bundled item types, see the
[item authoring guide](../src/resource-plugins/README.md) and copy the
[bookmark definition](../src/resource-plugins/items/bookmark/definition.ts).

## Navigation

The latest spatial proposal uses one canvas at three scales: workspace clusters,
the project neighborhood, and an expanded item. Selecting a resource moves the
camera to that node and grows the same node into the main working surface. Its
terminal, PR actions, document, or artifact lives inside that node. Opening a
connected resource moves the camera along the relationship and expands that item.
Escape or the zoom-out action returns to the project, then the workspace.

Orientation comes from the workspace/project/item trail, a tiny locator showing
the camera's position on the actual graph, and a narrow map edge around the item.
In-node connected-item buttons preserve navigation. Reduced-motion settings skip
the camera animation. Expanding or navigating never changes node coordinates.
Dragging a card surface moves the underlying node; the map remains pannable.

The earlier proposal used a workbench pane and a 166px sidebar. It is retained as a
previous concept; the current preview demonstrates the continuous map direction.
The scaffold's `preferredView: 'focus' | 'inspector'` contract is legacy layout
metadata. In a production spatial renderer, both values would mount the plugin's
detail view inside its expanded node. The canvas host owns camera position,
semantic zoom, expansion geometry, and navigation; resource plugins own contents.
Keep the live terminal mount stable throughout camera and size changes. Dispose
only the view when appropriate, never the underlying agent session on zoom-out.

## Visual identity

The product is named **Agentic Crafting Table** and uses pixel bubbles:
rounded silhouettes built from stepped pixel edges, a beveled surface, a hard
4px shadow, orthogonal connections, and a faint grid over earthy greens. The
wordmark, project names, and resource text use clear sans serif typography;
pixel styling stays in the shapes and surfaces. Provider logos retain their
original silhouettes. A design control
compares this with the earlier soft treatment.

Plugin stylesheets use the core design tokens from
`apps/desktop/renderer/tokens.css` ([design tokens](design-tokens.md)) instead of
their own colour, font or focus values: `color: var(--act-ink-dim)`,
`font: var(--act-fs-ui) var(--act-font-mono)`,
`outline: var(--act-focus-ring)`. A plugin may keep short local names for
readability, but they must be aliases (`--rv-ink: var(--act-ink)`), never copies
of hex values; agent identity uses `--act-agent-claude` / `--act-agent-codex`,
not the status colours. If a plugin needs a role that does not exist, add it to
`tokens.css`. New hex literals in plugin CSS fail `design-tokens.test.ts`.

Map prominence is plugin metadata rather than an activity state. Linear tickets,
Notion pages, code/workflow reviews, and artifacts are small (148×44); PRs and
remote machines are medium (198×82); agents and plain terminals retain their 218×100 size.
Projects remain prominent anchors. In the overview, the same tiers become 28px,
40px, and 48px pixel bubbles; touch targets have a 44px minimum. Small items show
an icon and one short label at 12px, with status badges. Full titles and status
remain accessible and appear on hover or when opened. All types
still expand to the same full focus surface, and their connection ports and
attention badges remain outside the bubble silhouette.

Linear tickets override the small tier's width to 240px while keeping the 44px
height, so the map shows both the identifier and title, e.g. “BIL-128 · Plan changes”.
Plugins can declare `appearance.width` and `appearance.showFullTitle`; overview
dots and expanded focus views ignore the width override.

Text-first types can be written on the map: `appearance.paper: { textField, paperField }`
makes the card face the item's text on a paper tile (Notes use it). Pair it with a
map size `growLines: { field, min, max, footerField }`, whose height follows the
text through the shared `wrappedLines` estimate, and `creation.hotkey` for a
one-letter pick while the creation ring is open. `authorship: { field }` asks the
host to record the agent that last changed the text; plugins never write it.

Agent and terminal bubbles show a short activity line under the session name.
The provider/model (or terminal readiness) appears above it; status and attention
badges stay independent. The three initial Billing summaries in this preview were
generated by a real one-off Claude Haiku 4.5 call from sample session output.
Replies and sample shell commands update the preview labels locally. This browser
proposal does not continuously call Claude or read live terminal sessions.

`src/agents/activity-summary.ts` scaffolds the live backend summarizer with an
injected Anthropic client. Its default request uses `claude-haiku-4-5`, thinking
disabled, no tools, and at most 64 output tokens. Summaries target 3–6 words and
48 characters, using only the latest 6,000 characters of host-redacted output and
the authoritative session state. Identical snapshots reuse cached/in-flight work;
new revisions supersede old requests. An eight-second timeout or invalid response
falls back to a factual status label, and an old result cannot replace a newer one.
The future host should debounce output changes, refresh immediately for state
changes, and dispose cached state when detaching a session. Live event ingestion,
redaction, debounce scheduling, and the concrete API transport remain host work.
Model and thinking options follow Anthropic's
[model reference](https://platform.claude.com/docs/en/models/overview) and
[thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking).

Each resource type has a stable icon, color, and label. Projects use mint; agents
use teal; PRs use violet; Notion pages use stone; Linear tickets
use rose; artifacts and code reviews use copper. The pixel finish uses a shared
bubble silhouette; the alternative soft treatment retains individual type shapes.
Compact nodes, expanded headers, and connected controls retain the same identity.

Claude agents use the Claude mark, Linear tickets use the Linear logo, and GitHub
PRs and workflow runs use the GitHub logo. These also appear in connected-item
shortcuts and the session resume list. Plugins declare a `brand` or a
`providerBrands` map (lowercase provider keys); the host resolves static logo assets
and retains `icon` as the fallback. The proposal uses pinned Simple Icons 15.15.0
assets, tinted with each resource type's existing theme-aware color.

Type colors remain stable as status changes. Small separate badges show waiting
(`!`), working (rotating gear), and ready for review (`✓`), with text explaining the status.
Icons, labels, and shape cues keep type recognition independent of color vision.
Large content surfaces stay quiet, with color concentrated in icon badges and a
subtle card tint. Archive preserves the type identity and hides attention badges.

Plugins can declare optional `appearance: { tone, shape, size }` metadata. The host owns
the theme-aware palette, allowed geometry, and status indicators. Missing metadata
falls back to a neutral rounded card. The proposal's design controls compare
**Color + shape** with **Color only** and adjust the card tint.

## Ownership

Agentic Crafting Table owns projects, resource records, attachment edges, map positions, routing,
authentication connections, session lifetime, and the project status rollup.
Resources and attachments are separate records: a shared remote machine can appear
on several projects without becoming several machines.

A plugin package owns one or more item types under its namespace, such as
`agent.session`, `github.pull-request`, `notion.page`, `linear.ticket`
or `slack.message`. Every built-in item folder under `src/resource-plugins/items/`
is such a package. It provides:

- `act-plugin.json`: the manifest, which declares everything the package registers.
- A definitions entry (`plugin.ts`): item definitions (stable id, icon, schema
  version, input recognition, validation, preferred view) plus declarative
  contributions. It is platform-neutral and loads in the service, the MCP bridge
  and the renderer.
- An optional service entry (`service.ts`) with `activate(host: ServiceHost)`:
  connectors, account types, runtime operations and other backend registrations.
  API clients and credentials stay here. Persist only a `connectionId` on a
  resource, never tokens in plugin data.
- An optional renderer entry (`renderer.ts`) with `activate(host: RendererHost)`:
  detail views, optional map nodes and view contributions. Generic nodes use the
  resource title and normalized status.
- Optional stylesheets listed in the manifest. They use design tokens only.

The shell resolves by id; it has no provider switch statement. The type contract
is framework-independent.

## Plugin packages (API 1)

`packages/plugin-sdk` is the frozen plugin contract, version `PLUGIN_API = 1.2.0`
(1.1 added settings presets, 1.2 applies them to every workspace; packages built for
`^1.0.0` still load):
the manifest schema and parser, the `ServiceHost`/`RendererHost` interfaces and
module shapes, re-exported definition helpers (`defineResourcePlugin`, field
validation) and view helpers (`views.ts`: view header, freshness, Markdown,
choices, glyphs, state chips), and a test harness (`testing.ts`:
`pluginPackageContract`, `resourcePluginContract`, `resourceConnectorContract`).
A test pins the exported surface so an accidental breaking change fails.

```jsonc
// act-plugin.json
{
  "id": "acme",                        // namespace; ids it registers are acme or acme.*
  "name": "Acme items",
  "version": "1.0.0",
  "apiRange": "^1.0.0",                // caret range of the host plugin API
  "entries": { "definitions": "plugin.ts", "service": "service.ts", "renderer": "renderer.ts" },
  "contributes": {
    "itemTypes": ["acme.widget"],
    "accountTypes": ["acme.account"],
    "runtimeOperations": ["acme.sync"],
    "mcpTools": ["acme_report"],
    "settingsPages": ["acme.widget"],                       // pages showing the package's settings
    "actionContributions": { "github.pull-request": ["acme.tag"] },
    "agentGuide": ["acme.guide"],
    "settingsPresets": ["acme.review-workflow"],             // API 1.1; every workspace since 1.2
    "css": ["styles.css"]
  },
  "legacyIds": []                      // older identities outside the namespace it owns
}
```

`PluginPackageRegistry` is the single registration path. A package must register
exactly what its manifest declares: the registry compares declared item types,
runtime operations, MCP tools, guide snippets, settings pages and menu
contributions with the definitions module, and `ServiceHost`/`RendererHost` refuse
undeclared connectors, account types, operations and contributions. Every
identifier must be in the package namespace (MCP tools use the namespace with
underscores) unless `legacyIds` lists it, which is how first-party packages keep
persisted and MCP identities such as `rollout.validation` and
`workspace_report_validation`. Two packages cannot declare the same operation,
tool, account type or guide snippet.

Bundled packages are listed in `src/resource-plugins/bundled/plugins.json` in
registration order. `node scripts/bundled-plugins.mjs` generates the definitions,
service, renderer and stylesheet lists from that file and each manifest; a test
fails when they are stale. The catalogs (`catalog.ts`, `catalog.server.ts`,
`catalog.client.ts`) and the renderer stylesheet read only those lists. Packages
installed from git (below) are registered after them through the same registry and
get the same host services.

### Host extension points

An item type needs no host branch for any of these:

| Extension | Package side | Host side |
|---|---|---|
| Runtime operations | `runtimeOperations` declarations with an agent policy (`allow`, `humanOnly`, or a per-`operation` rule with redirects); handlers via `ServiceHost.runtimeOperation` | `packages/core/runtime.ts` builds the `workspace_run` vocabulary and refusals from host plus package declarations; the service dispatches by lookup |
| MCP tools | `mcpTools`: name, zod input, annotations, optional agent-only refusal, and the runtime request it forwards | `packages/mcp/service-server.ts` registers them generically |
| Map presentation | `ServiceHost.presentation(type, { indicators, attention, opened })` | `resource-presentation.ts` applies the type's hooks to saved snapshots |
| Account types | `ServiceHost.connectionProvider(adapter)`, optional Settings `order` | `ProviderConnections.register`; the host itself provides only GitHub |
| Settings pages | one `settings` section (`ResourceFields` with defaults, optional `placeholder` examples) for an item type's page, plus an optional `validate(values)` that throws to refuse values the fields accept (text that must parse) | stored under `settings.plugins[<package>]`, rendered and validated generically, `validate` where settings are saved; `ServiceHost.settings()` reads it |
| Contributions to another type | `actionMenus` (menu groups, optionally `when` a boolean package setting is on), `ServiceHost.contributeActions`, `RendererHost.contributeViews` (`headerAction`) | `ResourcePluginHost` merges declared actions after the type's own and refuses shadowing; `describe()` merges menus |
| Agent guide | `agentGuide` snippets | appended to the shared guide in package order |
| Settings presets (1.1, 1.2) | `settingsPresets`: `{ id, packageId, values }` for another package's declared settings | applied once per workspace (by preset id) when the package loads, which is the service start after it is installed, turned on or updated, to each target setting that is unset or still at its declared default; values a person changed are never overwritten. A preset whose target package is not loaded yet waits for a start where it is. Removing the pack leaves the applied values. Lets a pack ship its own defaults (such as a `/review` workflow contract or rollout stage rules) without changing the app's neutral ones |
| Plugin-owned state | `WorkspaceServices.storage` | `plugin_records` table: namespaced rows, ordinal/key pages, transactions, 1 MiB per row, 16 MiB per package |
| Long-running work | `ServiceHost.onWorkspace(services => lifecycle)` | hooks run at observe, start, pause and close |

Rollout validation is the complete example: the `github.rollout` package declares
`rollout.validation` and `workspace_report_validation`, builds its coordinator in
`onWorkspace`, and registers its card indicators as presentation hooks. A package
that leaves the app for a separate repository keeps its saved identities through
`legacyIds`, so its items return unchanged once it is installed.
The PR package owns its unseen-comment presentation. The code-review engine
(Claude/Codex reviews, findings, architecture preparation, /review watching)
remains host functionality registered through the same operation table.

A caller that injects its own `ResourcePluginHost` (test fixtures) keeps its
connectors and presentation hooks; packages then get no `connections` and add only
registrations that need none, so fixtures never reach a real provider.

## Installing plugins from git

Features for a particular team or tool use this path: they live in their own
repository as a plugin pack, and the app carries none of their code. A pack that
takes over a type the app used to bundle declares the persisted ids in
`legacyIds`; saved items return unchanged once it is installed.

Plugins are trusted code. An installed package runs in the workspace service and
the app window with the same access as the app: provider accounts, terminals,
files and agents. There are no scoped transports or permission enforcement; the
safeguards are explicit consent per package and commit, a pinned commit, and an
integrity check of every released file. Agents can never install, update, enable
or remove plugins: these are desktop-only service methods that no MCP tool or
`workspace_run` operation forwards, and the lock is not part of the settings
document `workspace_settings` writes.

### Release layout

A plugin repository commits its built output on each release tag. The app never
builds, runs npm or executes anything before the user approves a commit.

```text
my-plugin-pack/
  act-plugin.json              manifest; entries point into dist/
  act-plugin.integrity.json    sha256 of act-plugin.json and every dist/ file
  dist/
    definitions.mjs            platform-neutral: no node:*, no DOM
    service.mjs                optional, Node ESM
    renderer.mjs               optional, browser ESM; may import other dist/ files
    renderer.css               optional, listed in contributes.css
  src/ …                       not part of the release
```

Each entry is a self-contained ESM bundle whose default export is the module
(`PluginDefinitionsModule`, `ServiceModule`, `RendererModule`). Pure SDK helpers
such as `defineResourcePlugin` are bundled into the package; host services are
reached only through `ServiceHost`/`RendererHost`. `ServiceModule.activate` may
return a promise. Stylesheets use the `--act-*` tokens only.

Generate the integrity file after building, then commit both:

```sh
node packages/plugin-sdk/act-plugin.ts pack path/to/my-plugin-pack
node packages/plugin-sdk/act-plugin.ts verify path/to/my-plugin-pack
git -C path/to/my-plugin-pack add act-plugin.json act-plugin.integrity.json dist
git -C path/to/my-plugin-pack commit -m "release 1.2.0" && git -C path/to/my-plugin-pack tag v1.2.0
```

`pack` refuses a manifest that does not parse, needs another plugin API, or names
an entry or stylesheet outside the release. Releases contain only regular files
(no symbolic links), at most 2000 files and 64 MiB.

### Installing, updating and removing

Settings → Plugins lists built-in and installed packages with id, version,
commit, source and status. **Install from git** takes a repository (https://,
ssh://, git@host:path or a local path; credentials in the URL are refused) and a
tag, branch or commit. The app runs the user's own `git` without a shell, with
prompts and hooks disabled and a timeout, into a cached bare repository under
`<data>/plugins/repos/`, resolves the ref to a commit and extracts only
`act-plugin.json`, the integrity file and `dist/` into
`<data>/plugins/store/<id>/<commit>/`. Every file must match the integrity file
and nothing else may be present, the manifest must parse against this app's plugin
API, and the package id and item types must not belong to a built-in or other
installed package. Nothing from the package runs yet.

The review shows the exact commit, source, API range, everything the package adds
(item types, account types, runtime operations, agent tools, settings, actions on
other types, guide text, stylesheets, service and window code) and a trusted-code
notice. **Trust and install**, which names the commit, records the approval in the `plugin_lock`
table with the per-file hashes; the app then restarts the workspace service
(sessions keep running in the supervisor) and reloads the window.

An update is a new fetch of a ref: the review names the build it replaces and the
contributions it adds or removes, and asks for approval again. **Check for
update** fetches the saved ref and says when nothing changed. The three previous
approved builds stay on disk; **Roll back** switches to one of them without the
network after verifying it. When the remote cannot be reached, the cached
repository is used and the review says so. **Turn off** keeps the package
installed but unloaded. **Remove** deletes its code and keeps its source;
**Reinstall** fetches and asks for approval again.

Items, links, layout and settings of a turned-off, failed or removed package stay
untouched. Its items render as unavailable placeholders with the reason (turned
off, could not load and why, removed) and come back unchanged when it loads again.

### Install links

A pack can be shared as a link. The app registers the `act` URL scheme (declared in
the macOS app's `Info.plist` through the electron-builder `protocols` setting; only
a packaged build registers itself), and
`act://plugins/install?source=<repository>&ref=<tag or commit>` brings the window
forward, opens **Settings → Plugins** with the install-from-git form filled in and
starts the normal fetch. The person still sees the review (commit, integrity check,
what the package adds, the trusted-code notice) and must choose **Trust and
install**; a link never installs anything by itself.

```sh
open "act://plugins/install?source=https://github.com/acme/my-plugin-pack.git&ref=v1.0.0"
```

Percent-encode the source when it contains `&`, `#` or spaces. Only
`plugins/install` is accepted. The source must be an `https://`, `ssh://` or
`git@host:path` repository that the form accepts (no local paths or `file://`, no
credentials); `ref` is optional (the default branch when absent) and must be a
valid branch, tag or commit; any other parameter, a repeated one, a user, port or
fragment refuses the link with a notice on the Plugins page. Pin a tag or commit in
links you share. The link is handled by the desktop main process (`open-url` on
macOS, also before the app is ready; the second-instance command line elsewhere)
and passed to the window, which only fills the form; agents and MCP have no path
to it.

### Loading and isolation

At startup the workspace service, before building the registry, verifies each
enabled package against its approved hashes (on every load, not only at install),
checks the manifest and API range, imports the definitions entry with a 5 s
timeout and registers the package after the bundled ones; a clash with another
package fails only that package. Service code activates one package at a time:
registrations are held back until `activate` finishes within 5 s, so a package
that throws or hangs registers nothing. A failing package is withdrawn, turned off
with its reason in the lock, and its items become placeholders. Every connector,
action, runtime operation, account adapter, presentation hook and lifecycle hook it
registered runs behind a per-package breaker: ten failures in a row (cancellations
excluded) pause it for five minutes, then one call is let through. Presentation
and lifecycle hooks fail quietly so they never disturb host work. The MCP bridge
loads the same verified builds for tools, guide text and agent policies.

The window imports each loaded package's renderer entry and stylesheets from
`craft://app/plugins/<id>/<commit>/<file>`. The protocol handler serves only the
renderer entry, declared stylesheets and `dist/` files of builds the service
loaded, inside the build folder, each checked against its approved sha256; the CSP
is unchanged. A failing import or view keeps the generic view and shows the error
in the item's frame.

### Developing a plugin

Settings → Plugins → Advanced → **Load from folder…** approves an unpacked build
in place (no integrity file needed); it is labelled Development. Rebuild with your
own tooling, then **Reload plugins** restarts the workspace service and reloads the
window; Node's module cache cannot be cleared in place, so a restart is the only
reliable reload. The [authoring guide](plugins/authoring.md) walks through this loop with
[`examples/plugins/reading-list`](../examples/plugins/reading-list), whose end-to-end test
(`tests/e2e/example-plugin.spec.ts`) builds and loads it this way.
`tests/fixtures/plugins/sample` is a minimal package with one item
type, a connector, a runtime operation, guide text, window code and a stylesheet;
`tests/fixtures/plugin-repo.ts` turns it into a local bare repository with tagged
releases for tests.

## Adding a resource type

Create a package folder such as:

```text
src/resource-plugins/items/build-run/
  act-plugin.json     # Manifest: id custom.build, entries, contributes
  definition.ts       # Required: fields, identity, creation, appearance
  plugin.ts           # Definitions entry: { definitions: [build], ... }
  views.ts            # Optional: ResourcePluginViews
  renderer.ts         # Optional: activate(host) { host.views(build.id, views) }
  connector.ts        # Optional: ResourcePluginConnector
  service.ts          # Optional: activate(host) { host.connector(build.id, connector) }
```

Add the folder to `bundled/plugins.json` and run `node scripts/bundled-plugins.mjs`.
Definitions with `creation` appear in `registry.creationTypes()` for the host's
inline picker. A pasted reference is offered to all registered matchers; multiple
matches remain explicit choices. The bookmark package is a complete local example.

```ts
const build = defineResourcePlugin({
  id: 'custom.build',
  apiVersion: 1,
  schemaVersion: 1,
  name: 'Build run',
  icon: 'workflow',
  preferredView: 'inspector',
  creation: { label: 'Track build' },
  fields: { buildId: { label: 'Build ID', kind: 'text', required: true } },
});
const plugin: PluginDefinitionsModule = { definitions: [build] };
export default plugin;
```

The same fields supply creation metadata, validation and MCP JSON Schema. The
default presentation needs no custom view. Add a connector for live content and
actions. `ResourcePluginHost` and `ResourceViewRegistry` dispatch by plugin id;
new types require no map, project-model, navigation or MCP tool branches. Test a
package with `pluginPackageContract` from `packages/plugin-sdk/testing.ts`.

## Runtime behavior

### Needs me

**Needs me** is the single attention concept across the tool. PR assignments and
agents waiting for input feed the same entry point, badge, and project/global
count. Each resource counts once. There is no separate **Assigned to me** category,
filter, or badge. Provider assignment remains internal sync metadata; the PR's
visible attention label is simply **Needs me**.

On connection and subsequent syncs, discover open PRs assigned to the authenticated
GitHub user. Use the assignee filter, not the separate requested-reviewer filter;
[GitHub documents both](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests).
Collect every page successfully before reconciling removals. Failed or partial
discovery must preserve the last successful attention state instead of marking PRs unassigned.
An installed webhook integration may update this state sooner; polling remains a
fallback, not a Codex task automation.

`src/pull-requests/assigned.ts` reconciles these snapshots by provider PR id and
connected account. Resolve to the existing resource to avoid duplicates. Attach
to the project when its repository matches uniquely; otherwise retain the PR in
Needs me until a project is selected. Never guess between projects sharing a repo.
Removing an assignment or closing a PR removes its attention state without deleting
the resource, manually added links, or artifacts.

New assignments show “Needs me” on the PR and in the project/global attention count.
Clear it only after that user successfully opens the PR detail. Hovering, seeing a
circle, viewing the Needs me list, or generating a background snapshot does not clear it.
“Viewed” is independent of review/approval. Repeated syncs and new commits preserve
viewed status; a fresh assignment after unassignment starts a new unread cycle.
Persist this per account/user in the host store. The prototype uses sample
assignments and holds viewed state only in memory.

### Three PR review actions

Every loaded PR exposes **Start Codex review**, **Start Claude review**, and
**Post /review & watch**. The first two create one-off sessions, defaulting to
the provider's default model (the latest Sol for Codex, `opus` for Claude). Each has a model selector populated by its
connected provider's available models. If a requested model is unavailable, report
that explicitly rather than silently substituting it. The prototype's options are
a sample catalog, not an account availability check.

`src/pull-requests/reviews.ts` builds a launch from the project brief, complete
captured PR comparison, and selected model. These sessions return findings in the
tool and finish; they do not modify code, approve, merge, or post reviews. Keep the
terminal and report attached to the PR after completion. A second click while the
same review is active opens it. An intentional new review after completion creates
a new request id; retries of the same request retain their idempotency key. The
host must atomically persist and deduplicate those keys before calling providers.

The third action follows a repository workflow configured per installation and,
optionally, per repository (Settings → Items → Workflow review → /review workflow):

1. Post exactly `/review` as a PR issue comment. The workflow must run on
   `issue_comment: created`.
2. Track the configured review job (default `review` in
   `.github/workflows/review.yml`).
3. Watch its bot result comment being edited with the report, and save direct
   URLs. A configurable report marker (a regular expression; by default a Markdown
   heading or a bold label such as `**Verdict:**` at a line start) tells the
   written review from a progress note. An optional configured failure text in
   that comment marks a review that did not complete; without one only the job
   result counts.

The contract is frozen with each request. The app ships only neutral defaults; a
plugin pack can supply its own contract with a settings preset.

The workflow chooses its own model; the local Claude model selector does not
override it. Other jobs in the same workflow are unrelated to this action. Detect
support per repository; never assume another repo accepts `/review`.

Persist the trigger comment id, provider request identity, run id, job identity,
and progress/result comment id. After an uncertain POST response, reconcile the
existing request before retrying; GitHub comment creation has no native
idempotency-key guarantee. Use user/App credentials whose comments can trigger the
workflow, not a workflow's default GITHUB_TOKEN. Watching belongs to a durable
backend worker and continues when the UI is closed. Handle permission errors,
queued/running/cancelled/failed runs, missing reports, timeout, and reconnection.

Run correlation is an explicit adapter requirement: a workflow may not echo the
triggering comment id into its run name or result comment. Do not
bind to the newest run or filter issue-comment runs by the PR's head SHA (their
workflow head can be the default branch). Match repository, workflow, event,
trigger actor/time, review job, and the bot comment's exact run URL; refuse ambiguous
concurrent candidates. For deterministic correlation, a follow-up workflow change
can include the triggering comment id in `run-name` and the result comment marker.

The watcher scaffold assumes a verified run/comment binding and rejects observations
for other runs, jobs, PRs, or authors. A green job alone is not success: the workflow
can edit a failure note into the comment when no synthesized report exists.
Only a finished review job with its real report becomes Complete; expose failure
and log links otherwise. Keep the reviewed commit separate from the head when the
button was clicked: a workflow may resolve the latest PR head during execution.
The live adapter should extract and retain that revision, or label it unknown.

The interactive proposal simulates all three actions and shows a local sample
result instead of fabricating a GitHub comment URL. No real sessions, comments,
reviews, or background watchers are started. Live provider adapters, durable
idempotency, workflow correlation, and backend watching remain to be implemented.

### PR architecture artifacts

The PR action **Explain architecture with Claude** starts a Claude session attached
to the same project. `src/pull-requests/architecture.ts` builds its launch request
from the short project brief, PR description, complete captured diff, changed-file
references, and immutable base/head commits. The session inspects surrounding code
at those revisions and produces a private Claude artifact containing:

- An overview of components, responsibilities, boundaries, and dependencies.
- A rendered flow diagram with decision branches and error paths.
- Added/changed/unchanged labels, before/after behavior, and evidence in source.

The action is analysis only. It does not submit a GitHub review, modify code, merge,
or share the artifact. Use the supplied deduplication key to reuse the same pending
or completed run for a PR revision. A different head commit starts a new run; keep
the old artifact's revision visible instead of silently relabeling its content.

Completed outputs are `claude.artifact` items (schema 2: `url`, `artifactId`, optional
`sourcePrId`, `headSha`, `sessionId`). The agent hook adds one when the session publishes
with Claude Code's Artifact tool, linked from the session and the PR; people can paste the
claude.ai link too. The item never fetches the authenticated page and opens it in the
system browser; no iframe or embedded web view is used. Details, current evidence and the
pending supervised first run are in [native artifacts](native-artifacts.md).

### Zoom and compact project clusters

In the current continuous-map proposal, the overview keeps the central project
bubble and compact resource bubbles inside a visible neighborhood outline. The
outline uses the same world-space geometry in overview and neighborhood views.
It encloses the project anchor and members, reserving their expanded footprints
at the neighborhood entry scale. Zoom projects that same boundary through the
camera; it does not recalculate a different compact hull.
Dragging the project translates every member by the same world-space delta,
including archived items and saved session positions. Individual resources remain
independently movable. The keyboard movement shortcut applies the same group move.

Inside a project, the central project bubble and its connections fade out.
A small clickable neighborhood title shows the project name and status rollup,
such as “1 working · 2 need me”; clicking it opens project context and actions.
The surrounding neighborhood expresses membership, leaving only item-to-item
connections. Resource cards stay expanded at this level, even when fitting the
neighborhood requires a lower camera scale. Returning to the overview restores
the project bubble and its connections without changing the saved layout.

Camera movement interpolates a separate detail value. Each card gradually changes
width, height, pixel silhouette, icon position and text opacity around its fixed
world-space center. The project header fades in as the central project bubble
fades out; nearby projects fade instead of abruptly disappearing. Manual zoom
uses the same continuous detail range between .54 and .65. The map keeps a stable
canvas height, and returning to the overview restores the saved camera without
a final recentering step.

Each circle retains the plugin's icon, resource identity, status, connections,
and click behavior. Working agents have a rotating gear, input requests
have an exclamation badge, and completed reviews have a check badge.
Hover or keyboard focus reveals the resource's name and status. Reduced-motion
preferences stop the gear animation. Selecting an agent still opens its terminal
in focus mode; returning to the map retains the zoom level.

There is one set of node positions, shared by every zoom level. Rendering, camera
movement and zoom never run collision layout or mutate those positions.
Dragging a project in the overview moves its whole cluster. Circles can also be
moved independently and their connection handles remain usable. Clicking a project
or non-agent resource expands the detailed workbench. These prototype view states
are in memory; zoom does not change ownership, links, or agent context.

### Free placement and connections

Every project and resource box has its own position. Dragging works regardless of
agent activity or selection; it never changes project membership or relationships.
The proposal preserves positions while switching between the map and agent focus.
Project movement translates all members together; item movement changes only that item.
Positions and links are in memory in the proposal; persistence belongs to the host.

In the overview, each connected group within a project has only one visible project connection.
The anchor is its most prominent item (agent/terminal, then PR/remote machine, then small
resources), with a stable id tie-break. BIL-128 therefore connects through its
agent rather than also drawing a line to Billing. Explicit relationships and
project membership remain intact. Cross-project links retain an anchor in each
project; archiving an intermediary or removing a link restores any needed project
connections. Inside a neighborhood, project connections are hidden altogether.
The main map and minimap use this same projection. The pure helper
in `src/graph/project-links.ts` accepts the visible graph and a plugin priority.

Grab any closed card's surface to move it; a click opens it. Pointer movement must
exceed 6px before it counts as a drag, and releasing a drag cannot open the item.
There is no corner move handle. In focus view, drag the title area to pull the item
back onto the map, while terminal text, forms, and action buttons remain usable.
Alt + arrow keys move a focused map card in 16-unit steps. Link ports retain their
separate drag gesture.

Drag a connection handle onto another item, then choose the relationship and its
label. Informational links are undirected descriptions, such as a PR implementing
a Notion brief. Context links have a direction and must point to a plugin declaring
`acceptsContext: true` (agent sessions do so). Links can cross project boundaries.
The continuous-canvas prototype creates links by dragging a port. Right-click an
item-to-item line and choose **Remove connection** to unlink it. A wide invisible
hit area makes thin lines easy to target; the menu identifies both endpoints and
highlights the selected line. Removal updates the map, minimap and connected-item
shortcuts, while keeping the items, positions and project membership. **Undo remove
connection** restores the last removed link. Automatic project-membership lines
are derived separately. Agents can remove explicit links through the existing MCP
`workspace_apply` command `link.remove`. Label editing and a keyboard connection
picker remain proposed extensions.

### Nearly full-canvas focus

Opening a node expands that same item to a 16px horizontal inset on desktop
(8px on narrow screens). A breadcrumb, narrow map edge, and an 82px-wide minimap
preserve orientation; the earlier floating neighbor cards are removed. Reviews
add their source PR to the breadcrumb. Connected items remain reachable inside the
item. Escape returns to the project. Longer content expands the preview naturally.
The neighborhood outline stays visible around the expanded item with a distinct
2px green stroke; normal map boundaries use a quieter 1.5px stroke.

### Independent review items

Codex and Claude review actions create a `code.review` resource with its own
position, state, captured PR comparison, provider/model, session, findings, and
archive state. A GitHub `/review` creates a separate `github.review-run` resource.
Each is linked directly to its PR; no review is embedded as the PR's mutable
result. Completed reviews remain on the map. Starting another review adds a new
item, while opening a running review reuses that active item.

The PR lists its unarchived review items as navigation targets, and each review's
breadcrumb links back to the PR. Review items are excluded from resumable general
agent sessions and do not accept extra agent context after launch. The proposal
includes a completed Claude review and simulates all three review actions; it does
not start providers, run GitHub workflows, or post comments.

`src/graph/graph.ts` keeps positions, project membership, and links independent.
It rejects self-links and duplicate relationships, deduplicates resource aliases,
and collects only direct incoming context through the plugin's `getContext` hook.
Plugin definitions also set `relationships.cardinality`: `one` limits a resource
to a single partner; `many` is the default. Both endpoints are
checked across reference/context links in either direction, with aliases sharing
the resource limit. Project membership is separate. Existing archived/completed
connections still count. UI and MCP use the same controller and rejected writes
leave the graph unchanged. Explicit removal or link editing allows reassignment.
Informational links never implicitly expand an agent's scope. A new agent's launch
can include these short summaries alongside its project brief and task.

For an existing session, a newly linked context source is queued for the next turn.
The proposal shows the summary and simulates delivery with the next reply. It does
not interrupt running work or rewrite the saved initial prompt. Removing a link
cancels unsent context and stops future inclusion; already received context remains
in the session history. Live turn scheduling and context delivery need a runtime
adapter. Read failures must be reported rather than silently dropping a source.

### Project context for new agents

Every newly created agent receives the Agentic Crafting Table workspace guide,
a brief project summary, connected context, and its task.
The brief contains the goal, current state, key decisions or unresolved questions,
repository/branch, and a few attached resource references. Keep the generated brief
to roughly 100–150 words; link to detailed resources instead of copying documents
or terminal history. Resource plugins can contribute relevant facts through
`getContext`; the host composes the project-wide brief.

The creation screen previews the brief automatically. It can be edited for that
agent without changing the project, and no extra confirmation step is required.
The task stays a separate field. Direct creation and skill launches share the
same prompt-building boundary in `src/agents/project-context.ts`.

The versioned guide in `src/agents/tool-context.ts` explains how to keep the map
current: discover plugin schemas and live IDs, add PRs and remote machines,
attach/move items, link results and explicit agent context, and update short
summaries, activity and attention. It requires revision-aware writes, provider
identity deduplication, preservation of existing layout and user lifecycle choices,
and honest reporting when a capability is disconnected. Registering or moving a
map item does not launch a session, provision infrastructure, or migrate a process.
Reviews and architecture launches include the same guide without relaxing their
task-specific restrictions.

Pass the actual agent node and execution workspace IDs as the optional launch
binding; the project ID always comes from the selected project. Reserve the node
identity before preparing a launch where possible. Never substitute a resource ID
for a node ID. Missing IDs must be resolved from native session identity. Persist
the guide version only after delivery succeeds. The creation preview keeps the
editable brief separate from a read-only workspace-guide preview; final node IDs
are bound at launch. The guide is also available at `benchgrove://agent-guide`.

Generate the brief from the current project state when opening the creation flow.
Use that exact preview when starting the agent, and save it on the session as its
initial-context snapshot. Reopening a session does not resend it. A future agent
gets a new brief from the current state. Runtime adapters must pass `systemPrompt`
as trusted provider/native CLI instructions and `initialPrompt` as the agent's
initial input. The project brief and external resource contents never enter the
system channel. MCP also supplies the versioned guide during initialization and
passes trusted agent instructions separately to the runtime adapter on launches.
The guide requires an immediate map update when the agent creates a PR, including
project membership and a link to the originating agent. The scaffold tests this
with an injected launcher and an MCP client performing the complete registration flow;
real runtime adapters and automatic semantic summarization are still unimplemented.

### URL-only attachments

Pull requests, Notion pages, and Linear issues are attached with a single URL.
No manual title is requested. Each plugin advertises `creation.mode: 'url'` and a
placeholder, and its `matchInput` parses provider identity. The original title
comes from the authenticated provider connector's `ResourceSnapshot.title`, not
from a URL slug or a status label. `ResourcePluginHost.resolveUrl` returns the
record only after a connected provider supplies a nonempty title. Failed or
cancelled lookups do not return a record to persist.

The preview uses labeled sample metadata for its example links. Other valid URLs
produce a clearly marked title-pending item with a link to the source; it never
claims to have fetched their content. Provider connections and persistence of
resolved metadata still need to be wired into the application runtime.

### Web links

**Web link** (`web.link`) is a small globe bubble with URL-only creation. Clicking
it opens that URL in a browser, preserving the map's camera and selection. Query
parameters and fragments are retained. Its `activation` metadata is generic, so
the host can apply this behavior without branching on the plugin ID.

The backend connector loads the document title (or social title), falling back
to the domain if the page requires login, has no title, or cannot be read. It
uses bounded public HTTP(S) requests, follows at most four redirects, pins DNS
answers and never sends credentials. It does not proxy private-network pages;
those links can still be stored and opened normally in the browser. Call the
existing `ResourcePluginHost.resolveUrl` to obtain a record with its automatic
title before saving. A URL can be offered as either its specific resource type
or a general Web link, without overriding the user's selection.

The standalone map demonstrates page titles for example.com/example.org and
uses the URL's domain for other pages; it does not make live metadata requests.
The real metadata connector is separate from this sample preview. External
navigation works in the browser preview built with `scripts/render-map-preview.py`.

### Slack messages and threads

`slack.message` adds a small 210×44 bubble with the Slack mark. Paste a message
or thread permalink into the same URL-only inline creation flow. The selected
message remains distinct from the thread root: the path identifies `messageTs`,
and `thread_ts` identifies the root when opening a thread. Keep both timestamps
as strings, with workspace host and channel ID. A message link opens that message;
a thread link opens the conversation and highlights the linked message. See Slack's
[permalink reference](https://docs.slack.dev/reference/methods/chat.getPermalink/).

Slack has no page title, so its future connector should derive a short display
label from the fetched message text. It supplies channel, author, timestamp and
message content for the expanded view; `getContext` supplies the selected message
or fetched thread, with author attribution and source link, to connected agents.
Read access is governed by the authenticated Slack connection. This does not post
messages or grant agents permission to reply.

The definition, URL parsing, validation and registry/MCP discovery are implemented.
The proposal includes a labeled sample thread connected to the implementation
agent. Other valid Slack links preserve their identity and show a pending preview.
A live Slack connector, message loading and agent context delivery remain runtime work.

### Plain terminal sessions

Claude sessions should use the same real terminal surface as ordinary shells.
The proposed runtime is xterm.js in the item, connected through an authenticated
local bridge to node-pty running the installed `claude` binary.
Remote machines from a plugin pack would use a remote persistent terminal (for
example, an SSH connection to a tmux session).
The terminal forwards keystrokes and resize events and renders the process output;
Claude owns its conversation UI, tool permissions, slash commands, and model behavior.
This does not require replacing Claude Code with an Agent SDK conversation.
[xterm.js](https://github.com/xtermjs/xterm.js/),
[node-pty](https://github.com/microsoft/node-pty).

Start a new interactive session with the project brief and task as its initial
prompt. Reattach an existing live process when reopening a node. Only when the
process has ended should resume launch Claude again with its saved session ID.
Claude supports initial prompts, session resume, and appended system context through
its [CLI](https://code.claude.com/docs/en/cli-reference). A session service owns the
PTY independently of map views, so zooming and changing selection never terminate it.
The main implementation work is reconnect/scrollback, resize handling, remote
sessions, and process lifecycle—not rebuilding Claude's interface.

Working/needs-input map badges can observe Claude's documented lifecycle and
permission [hooks](https://code.claude.com/docs/en/hooks). Observers must not answer
permissions or inject keystrokes. Summaries remain supplemental metadata, outside
the interactive terminal. The current prototype shows a labeled terminal preview;
it does not run a PTY or Claude process.

`terminal.session` is a separate plugin for a plain shell, with a neutral console
icon and a terminal-shaped node. Choose **Attach resource → Terminal**,
then name it and select a local workspace or attached remote machine, shell, and working
directory. The node expands into its terminal while retaining map navigation.

A terminal has its own stable PTY session id, workspace id, shell, and working
directory. It needs no AI provider, model, task, or project-summary prompt. Mount
it through the existing `attachTerminal` host service. Reopening the node attaches
to that same session and restores scrollback; leaving or archiving the node does
not end the shell. Preserve the session identity and history on restore. A remote
machine is linked to its hosted shell as an informational relationship.

Terminals can move, link, archive, and restore like other resources. They do not
accept agent context as input: connecting a reference must never execute text as
a command. A terminal-to-agent context adapter should use a user-selected excerpt
rather than automatically forwarding all scrollback. Shell activity and connection
state remain separate from AI agent activity.

The proposal includes a billing shell and a plugin-driven attachment form. `pwd`,
`ls`, `git status`, `clear`, and `help` demonstrate local sample output. Commands
are never executed. Real PTY creation, input/output, resizing, reconnection, and
persistent scrollback still require a terminal runtime adapter.

### Starting or resuming an agent

The **Start agent** node offers **New session** and **Resume session**. The resume
list is scoped to the project and shows the conversation title, provider/model,
workspace, branch, last activity, and a short history preview. Active sessions
offer **Open** and reuse their existing map node. Saved sessions offer **Resume**
and restore the original conversation in its agent node.

Resuming preserves the native session identity, original context, model, workspace,
and conversation history. It does not regenerate or resend the new-agent brief.
New messages append to the existing conversation. The current interactive proposal
uses sample saved sessions and in-memory history; no provider reconnection occurs.

`src/agents/session-continuation.ts` distinguishes attaching to an active process
from resuming a saved conversation. Its request refers to the existing resource;
it contains no new task or initial prompt. Session identity includes provider,
connection, workspace, and native session id to avoid collisions across accounts
or machines. The host must persist that identity and resolve it atomically to one
resource before asking the provider to continue it.

If a real resume lacks the current tool-guide version, the continuation request
includes `toolContextUpdate` with `delivery: 'next-turn'`. The adapter must queue it
once per native session identity and version at the next input boundary, record
the version only after confirmed delivery, and leave the original prompt intact.
Attaching the UI to an active session sends no guide or new input. The prototype
keeps sample resumed histories unchanged; real delivery still needs the adapter.

The provider adapter must discover authorized sessions, verify project membership,
workspace availability, and resume capability, then attach or resume by native id.
An unavailable workspace or unsupported continuation must report an error instead
of silently starting a new conversation. Discovery, persistence, provider adapters,
and terminal reattachment remain to be implemented.

### Resource and session lifecycle

#### Archive and restore

Right-click any item or project to open **Archive**, **Mark done**, and **Delete**.
The same menu works on the neighborhood title and expanded item. Archived items
offer **Restore**. Shift+F10 opens the menu from a focused node; arrow keys select
an action and Escape dismisses it.

Every expanded project or item has an **Archive project** or **Archive item**
action. **Undo archive** reverses the most recent action, and the workspace's
**Archive** button switches the same map to archived content. Open a node there
to restore it. Active parent projects remain as muted orientation when only their
individual items are archived. An empty Archive explains where items will appear.

Archiving is a reversible visibility state. Preserve resource ids, map positions,
links, history, initial context, and provider session identity. Exclude archived
nodes from the active map, minimap, project rollups, and Needs me counts. Archiving
does not stop agents, terminate remote machines, close PRs, or change external resources.
Existing sessions and context links retain their state; new project summaries
omit archived resources. Background outputs inherit an archived project's visibility.

Archiving a project hides its cluster by inheritance rather than rewriting every
child's archive flag. Restoring it reveals its previously active items; children
archived individually stay archived. Restore an archived parent before restoring
an individual child. Cross-project aliases are unaffected. Restoring a PR does not
mark it viewed; it can return to Needs me. Provider sync must preserve archive
metadata and must not automatically resurrect an archived item.

`src/graph/archive.ts` implements these visibility and restoration rules without
deleting nodes or links. Persist archive timestamps in the host store for a live
app. The proposal holds archive state in memory for the current preview session.

#### Done and delete

**Mark done** sets a separate `completedAt` flag. The item keeps its position,
size, content and links; its title is struck through. Its menu changes to
**Reopen**.
Done items no longer contribute to active project counts or Needs me. This flag
does not stop a running agent or complete a linked to-do. It changes provider
state only for items whose connector mirrors completion (Linear tickets).

**Delete** immediately removes the selected map node, its incident connections
and to-do references. Linked items remain. Deleting a project leaves its members
as floating items. The host removes an unreferenced local resource record but
preserves records used by other map aliases. Neither deletion nor completion
calls a provider to delete a PR, page, ticket, message or session.

The shared MCP controller exposes `node.complete`, `node.reopen`, and
`node.delete`, with revision checks and persisted completion state. The browser
proposal remains an in-memory demonstration, separate from that controller.

- Keep activity, attention, and connectivity separate. An online remote machine
  cannot imply that an agent is working. A project can have working agents and a pending
  input request at the same time.
- Snapshot timestamps let the host identify stale state. A disconnected provider
  becomes unknown/stale, not silently idle or complete. Combine project activity
  with all outstanding input, review, and error items.
- Backend subscriptions follow tracked resources, independently of which view
  is open. Abort subscriptions when tracking stops. Views dispose their own
  listeners on unmount.
- The terminal service owns persistent local PTY/remote sessions. Mounting a
  detail view attaches to an existing session. Leaving focus mode detaches the UI;
  it does not stop the agent. Reopening restores session output and input.
- Skills receive selected resource context through `getContext`. A skill run
  creates an agent-session resource, and outputs become new attached resources.
  Resource plugins and skill definitions are separate extension points.
- Missing plugins preserve the resource record and display a fallback with its
  title and plugin id. The scaffold rejects incompatible data versions without
  changing data. Add explicit migrations before supporting schema upgrades.
- Plugins are trusted code. Bundled packages and user-approved packages pinned to a
  git commit load (see Installing plugins from git). A plugin marketplace and
  untrusted or sandboxed plugins are outside this version.

## Spatial creation and zoom

The current proposal has one creation flow anchored at a point on the map.
Right-click empty space and choose **New item** to open the inline item picker
at that location. A normal empty-space click dismisses open menus; dragging pans
the map. Escape or clicking elsewhere dismisses the context menu. The toolbar
button and dragging a node's plus to empty space also open the picker. Dropping
a plus on an existing item creates a relationship instead.
New items inside the visible project neighborhood inherit its membership;
items outside it float independently. A dragged connection and project membership
are separate: a floating item can provide context to an agent in a project.

The picker uses each registered plugin's creation handler. Agent creation includes
the editable project summary and directly connected item, and offers existing
sessions to open or resume without duplicating them. Creation, resume, terminal,
and provider output remain sample state in this proposal.

The tiny zoom track sits above the map-location box. Unlabeled markers indicate
the neighborhood and close-up transitions; level names remain available to assistive
technology. The track has no visible percentages or plus/minus buttons. Internal
scales are .65 and 1.15, with a maximum map zoom of 1.35. Item focus is a separate expansion
within the same map. Neighborhood boundaries and their project headings use world
coordinates, so panning moves them together with their items. In overview, dragging
a project still moves its entire cluster.

The neighborhood has one enclosing perimeter around every visible member, with
padding equivalent to 20 screen pixels at the .65 reference scale. A hull of the
padded cards is traced with outward
steps, creating a box-like outline that follows the outermost items without narrow
connecting corridors or internal holes. It updates when items move, join, leave,
or change visibility. The project heading aligns with the left edge of the area,
just above it. The overview keeps the project bubble inside its own compact outline.

The boundary remains visible in maximum map zoom and item focus. In focus, its
screen-space outline includes the expanded item, with overflow compressed to a thin
rim inside the canvas. The breadcrumb and minimap retain project context; this
presentation does not change the world-space membership geometry.

`src/graph/neighborhood.ts` exposes the perimeter and its point-distance calculation.
Creation membership and proximity attachment use this same shape, including the
space enclosed between members. The prototype caches world geometry independently
of panning and zoom, and recalculates it only for member changes.

Floating items show an attachment preview within 36 screen pixels of a project
bubble or the current neighborhood boundary. Releasing there assigns membership
without changing the resource identity, position, or existing relationships.
`ProjectAttachment.projectId` is optional until attachment.

Spacing runs when initializing, adding or moving items, keeps the held item in
place, and pushes other cards in that project to the nearest free edge. It reserves
expanded card footprints at the .65 reference scale, including the card,
status badge and connection handle, with a 12-pixel gap outside that footprint.
Camera transitions do not run spacing or change the layout. `src/graph/spatial.ts` contains the pure geometry and
attachment rules, including deterministic resolution for dense mixed-size groups.
The prototype mirrors these rules for its local canvas state. Alt+arrow moves a
focused item; Shift+arrow pans the map; Escape cancels a draft or active drag.

## To-do overlay

A collapsible list floats at the left of the map. Tasks can be added, edited,
completed, reopened, or removed with an undo action. Each task is one line, with
a small link icon and count on the right. Clicking it reveals existing references
with open and detach actions. Attachments are added only by dragging from the map.
Any registered resource or project can be referenced. Multiple references are
supported per task.

Dropping a node or its connection plus onto a task adds a reference and preserves
the original map positions, project membership, and graph edges. Clicking a
reference opens the existing node on the map. Item focus collapses the overlay;
a persistent small icon on the left reopens it. There is no top toolbar to-do counter.
Drag the list header to reposition the overlay anywhere within the map. Its position
is preserved when closing and reopening it, and clamped to the available map when
resizing. Alt+arrow on the header also moves it; Escape cancels an active drag.
Checking a task never completes its attached agent,
closes a PR, or archives a project. Removing a reference only detaches it from
the task. All to-do state is local to the current prototype session.

Working items show a small rotating gear on their map bubble and focused header.
Other lifecycle states keep their own markers. Reduced-motion preferences stop the
rotation while preserving the gear and text status.

## Agent control through MCP

`src/mcp/` contains a runnable stdio server backed by a shared, revisioned command
layer and local file store. It covers projects, plugin items, positions, membership,
archive/restore, relationships, tasks, status and navigation. See
[the MCP setup and integration guide](../src/mcp/README.md).

The inline prototype is not connected to MCP. Live provider actions require a host
runtime adapter and fail explicitly when it is absent. The next app implementation
should route both UI actions and agent commands through `WorkspaceControl` and
subscribe its renderer to committed revisions.

## Local verification

Using a Node runtime with native TypeScript support:

```sh
node --test src/agents/*.test.ts src/graph/*.test.ts src/pull-requests/*.test.ts src/resource-plugins/*.test.ts src/mcp/*.test.ts
```
