# Reading list: example plugin

A small, complete plugin package for Agentic Crafting Table. Copy it to start your own; the
[authoring guide](../../../docs/plugins/authoring.md) explains every part.

It adds one item type, **Reading link** (`reading-list.link`): a page to read later with a note
and tags. The app checks the link and raises **Needs me** with the reason "Link is broken" when
the page is gone.

| Part | Where | What it shows |
|---|---|---|
| Manifest | `act-plugin.json` | Everything the package registers, under the `reading-list` namespace |
| Item type | `src/definition.ts` | Fields, `validateData`, creation, map sizes, appearance, `webLink`, context menu |
| Definitions entry | `src/plugin.ts` | Runtime operations with agent policies, an MCP tool, a guide snippet, a settings section |
| Connector | `src/connector.ts`, `src/check.ts` | HTTPS title check, poll budget, Needs me with a short reason, agent context |
| Service entry | `src/service.ts` | `plugin_records` storage, a `humanOnly` operation, a workspace-wide read operation |
| View | `src/views.ts`, `src/renderer.ts` | The shared frame header (chip, meta, primary action, ↗, freshness, ↻), stale and empty states, cleanup |
| Styles | `src/styles.css` | Design tokens only |
| Tests | `test/plugin.test.ts` | Contract harness and unit tests, no network |
| Build | `scripts/build.mjs`, `scripts/act-plugin.mjs` | `dist/` bundles and the integrity file |

End-to-end coverage lives in the app: `tests/e2e/example-plugin.spec.ts` builds this folder, loads
it through Load from folder, creates an item, raises Needs me, opens the view and marks it read.

## Try it from this checkout

Requires the app's dependencies (`npm ci` at the repository root) and Node 26.

```sh
cd examples/plugins/reading-list
npm test                       # contract harness and unit tests
node scripts/build.mjs         # writes dist/
```

Then, in the app: **Settings → Plugins → Advanced settings → Load from folder…**, choose
`examples/plugins/reading-list`, read the review and click **Trust and load from folder**. The app
restarts its service and reloads the window. Add an item with the creation ring (double-click the
map → **All** → **Reading link**).

After changing code, run `node scripts/build.mjs` again, then **Settings → Plugins → Advanced
settings → Reload plugins**.

## Install it from git

The app installs released packages from a git tag. A release commits `dist/` and
`act-plugin.integrity.json`. To try that path with a local bare repository:

```sh
APP="$PWD"                                   # the app checkout
cp -R examples/plugins/reading-list ~/act-reading-list
cd ~/act-reading-list
ln -s "$APP/node_modules" node_modules       # SDK, esbuild and zod from the app checkout
npm run release                              # build, pack (writes the integrity file), verify
git init -b main && git add -A && git commit -m "release 1.0.0" && git tag v1.0.0
git clone --bare ~/act-reading-list ~/act-reading-list.git
```

In the app: **Settings → Plugins**, Repository URL `~/act-reading-list.git` expanded to its full
path (for example `/Users/me/act-reading-list.git`), Tag `v1.0.0`, **Fetch**, review, **Trust and
install**. A folder loaded with Load from folder must be removed first: one package id loads once.

## Make it yours

1. Rename the namespace everywhere: `reading-list` (package id, runtime operations, guide id,
   collection keys stay yours), `reading-list.link` (item type) and `reading_list_` (MCP tools).
2. Change `act-plugin.json` `name`, `description` and `version`.
3. Keep `npm test` green, then follow the [authoring guide](../../../docs/plugins/authoring.md).
