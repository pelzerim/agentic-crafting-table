# Developing Agentic Crafting Table

How the repository is laid out, how to build, test, package and install it, and
where it stands. For using the app, see [Using the app](using-the-app.md); for
writing plugins, start at [Plugins](plugins/README.md).

## Where it stands

An Electron desktop connected to an independent local service, with SQLite
persistence, authenticated IPC and automatic service reconnection. Projects and
plugin-backed items can be created, edited and moved on the real map; their
positions and camera survive reopening. Terminal items run real local shells that
survive renderer or workspace-service restarts. Native Claude and Codex sessions
receive project context and a connected MCP server, can update the live map, and
can resume saved conversations. Connections, lifecycle actions and the grouped
to-do overlay share UI/MCP state. Installed project skills launch native agent
runs with the same context, terminal and recovery. Automatic URL imports, GitHub
URL attachment, persistent PR content and automatic assignment discovery are
implemented. Native PR reviews and durable `/review` workflow tracking have
fixture coverage; real-model review acceptance and a supervised workflow run
remain open. Read-only Notion, Linear and Slack connectors are implemented; their
live acceptance gates remain open. Claude artifact integration (Explain
architecture and published-artifact cards) is implemented; its first supervised
real publication remains open.

The first usable milestone is the local project → Claude → MCP → map loop. Local
macOS packages are ad-hoc signed development builds, not Developer ID signed or
notarized releases.

## Existing code

- `src/graph`: geometry, relationships, lifecycle and to-do grouping.
- `src/resource-plugins`: versioned definitions, registries, views and connectors.
- `src/agents`: context/guide generation, resume contracts and activity summaries.
- `src/pull-requests`: assignment reconciliation and review/artifact launch logic.
- `packages/core`: shared controller, atomic commands and replay/conflict contracts.
- `packages/workspace-service`: SQLite, authenticated local IPC and background service.
- `src/mcp`: compatibility exports, JSON store and working stdio MCP server.
- `packages/mcp`: production stdio bridge to the desktop's live workspace service.
- `packages/session-runtime`: independent native PTY supervisor and Claude/Codex adapters.

The target workspace/package layout is described in the [architecture](architecture.md);
it has not yet replaced these directories. The internal `benchgrove` MCP identifiers
are legacy compatibility names, not the displayed product name.

## Build and run

Use Node **26.8.2** (`.nvmrc`) and npm **11.19.1**. The packaged app uses Electron
44.4.5 and its bundled Node 24.21.0 for background processes; no system Node is
required to run the packaged app. Native modules are rebuilt during installation.

```sh
npm ci
npm run dev            # build and start the app
npm run record:demo    # re-record docs/media/demo.gif (needs ImageMagick's magick)
```

`npm run spike` opens the isolated spatial-renderer fixture: pixel cards, project
outline, wheel zoom, dragging, and an expanding xterm view. Its input is echoed;
it does not run shell commands or provider sessions.

## Verify

```sh
npm run check          # Typecheck, domain/MCP tests, production build
npm run test:desktop   # Electron UI and isolated bridge checks
npm run test:visual    # Compare the main views with reviewed screenshot baselines
npm run test:runtime   # Real PTY, recovery, replay and slow-consumer tests
npm run test:performance # Dense-map and real terminal performance gates
npm run test:startup   # Five hidden 500-item cold starts with normal performance gates
npm run package        # Build separately in release/staged/mac-arm64 (Linux: linux-<arch>)
npm run test:package   # Packaged app + separate background PTY input/resize/exit
npm run install:local  # After quitting: verify and install into release/mac-arm64 (Linux: linux-<arch>)
npm run sandbox:linux  # Linux, once per checkout: the AppArmor profile Electron's sandbox needs
```

GitHub Actions (`.github/workflows/ci.yml`, macOS and Ubuntu) runs `check`, `test:runtime`, `package` and
`test:package` on every push.

A release is a tag `vX.Y.Z` on the public repository: bump `version` in `package.json`,
commit, tag and push the tag. Installed apps look the tags up once a day and show a notice;
`npm run update` moves a checkout to the newest tag and installs it. The desktop, visual and performance suites are local gates: their
screenshot baselines and frame budgets were recorded on a development Mac and do not match a
hosted runner, and the full suite outlasts a job. Run them before packaging.

Automated Electron runs use hidden windows and stay out of the Dock. Screenshots,
keyboard/pointer actions and terminal performance checks still run. To watch a
journey while debugging, opt in with `ACT_TEST_SHOW_WINDOW=1 npm run test:desktop`
(the same switch works for visual, performance and packaged smoke tests). Normal
app launches remain visible. Tests continue to use disposable workspaces.

Visual checks fail on changed or missing baselines. Review expected/actual/diff
images with `npx playwright show-report`; intentionally changed designs use the
explicit `test:visual:update` command and image review. See the
[visual testing guide](../tests/visual/README.md) before updating baselines.

The root lockfile is authoritative, including the legacy MCP workspace. Ordinary
tests use isolated temporary data and make no paid model calls. See the
[MCP README](../src/mcp/README.md) for running the standalone server and the
[plugin authoring guide](../src/resource-plugins/README.md) for the existing extension
contract. The [testing strategy](testing.md) describes coverage, automated journeys
and live integration checks.

An optional live check uses your Claude account and two Haiku print-mode calls,
each capped at $0.75, plus a native interactive resume without sending a new task:

```sh
npm run build
ACT_LIVE_CLAUDE=1 node scripts/smoke-claude.mjs
```

Run this after builds finish; rebuilding `dist` while services are starting can
remove their entrypoint. Ordinary tests and CI never run this check.

## Package and install locally

Packaged builds are locally ad-hoc signed development builds, not notarized releases.

The local installer keeps the installed app directory in place so a pinned Dock
shortcut continues opening the current version. It refuses installation while
the app or its background services are running, preserves the previous contents
under `release/mac-arm64/bundle-backups`, and leaves workspace data untouched.
Do not move the installed `.app` into a backup before replacing it: macOS follows
that directory's bookmark and can keep launching the older build. Launch and pin
`release/mac-arm64/Agentic Crafting Table.app`, not the staged or backup build.

Interrupted installation is recovered on the next installer run before checking
the installed app's metadata. If the staged build is unavailable, quit the app
and use `npm run install:local -- --recover-only`. It restores the known previous
contents or retains a completed activation, preserving the Dock identity and
workspace. Unknown files are left intact for manual recovery.

On Linux, `npm run package` wraps electron-builder's unpacked directory as
`release/staged/linux-<arch>/Agentic Crafting Table/Contents` and writes
`Contents/bundle-info.json` (identifier and version, which macOS keeps in
`Info.plist`), so the same installer swaps `Contents` in place. `install:local`
then writes `~/.local/share/applications/agentic-crafting-table.desktop` and makes
it the `act://` handler. Ubuntu 23.10 and later also need the AppArmor profile from
`npm run sandbox:linux` before any Electron run, development or packaged.

An unchanged verified build reports **Already up to date** and creates no additional
copy or backup. Changed builds check available disk space before staging; a refusal
reports required and available MiB. Free space before retrying. Older rollback
builds are never removed automatically, and recovery-only mode does not require
space for another app copy.

## Diagnostics

For a slowdown during normal use, open **Settings → Data & diagnostics → Performance diagnostics**,
reset the measurements, reproduce it, and download the report. Collection is local
and bounded; exports contain timings and counts only. See [performance notes](performance.md).

Workspace and supervisor startup diagnostics live in `service.log` in their data
directories, with two rotated backups by default. Each file defaults to 1 MiB and
is readable only by your account. **Settings → Data & diagnostics** changes
these limits; lower values trim old diagnostic output. Terminal recordings remain
intact. The same section downloads a local support report with versions, aggregate
counts and performance measurements, excluding private content and account details.

**Terminal recording storage** in that section shows storage without deletion
controls. History is kept by default. Archive the session, then use **Archive →
Archived session recordings** to delete its stopped recording with explicit
confirmation; native conversations, project files, map items and session identity
remain. Database space becomes reusable rather than automatically shrinking, and
older backups remain intact.

## Working in this repository

Keep the [specification](specification.md) current and make small coherent commits
with relevant validation. Track source, docs, test fixtures and dependency lockfiles;
exclude credentials, runtime databases, terminal logs, dependencies and generated
build output.
