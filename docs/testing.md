# Agentic Crafting Table — testing and release strategy

Status: planned coverage plus the current baseline. Tests accompany
each implementation step; they are not a final project phase.

## 1. Current coverage and limits

PR polling coverage: fixture GitHub responses drive persisted
resource-coordinator ticks, including aliases, approval/dismissal/reapproval,
comment counts, close/merge, restart acknowledgements, simultaneous refresh,
archive/account/lifecycle gates and stale/backoff recovery. Hidden Electron checks
verify closed-view map updates, approval in Needs me, viewed/manual dismissal,
restart persistence and reviewed card/detail screenshots. These tests expire only
isolated fixture cache entries and invoke the same backend poll used by the timer;
no real GitHub writes, paid review sessions or user workspace data are involved.

The original pre-native baseline had 89 passing tests covering graph rules, neighborhood
geometry, lifecycle, to-do grouping, plugin schemas/dispatch, context construction,
resume request semantics, review state logic, MCP transport and JSON-store conflicts.
That historical baseline alone did not prove native prompt delivery, Electron
rendering or provider/session recovery. Current coverage is described below.

A design pass adds regression checks for label/control
collisions, hover and keyboard connection meaning, Settings drafts and fixed actions,
minimum-size attention marks, provider-specific attachment identity, pixel control
states, and long provider content. Long-document fixtures check prose versus code
width; long-thread fixtures check selection and scrolling to the final message.
Refresh-failure captures preserve attribution and the saved-copy label. Variable
provider observation timestamps are masked only after their presence is asserted;
provider-supplied text remains inert. Review recovery still tests exactly one fixture
POST and explicit reconciliation. These are local contract checks, not live writes.

Settings submenu coverage (MAP-18): `packages/core/context-menu.test.ts`
covers the **Settings** entry of a map item (its two children, the reason on a disabled
Use size as default, no submenu on projects or below the map, and the `edit` slot it
keeps so layouts, earlier orders and hidden lists saved before it still apply).
`packages/core/item-size.test.ts` covers `sizeAsDefault` as a pure function: nothing to
change at the default, a tier becoming the default, a hand-resized item becoming its
tier's dimensions within the tier's limits, Claude and Codex as separate types, notes
keeping their text height, and that every other item resolves to its earlier width and
height once the returned pins are applied. `size-default.spec.ts` drives the hidden app
on the fixture workspace: the submenu by hover, click and keyboard, the disabled entry
and its reason, a resized agent saved as the default (settings as the Settings dialog
shows them, the other Claude agent pinned at 240 × 112, Codex untouched, no position
moved, a new agent arriving at the saved size, a reload), a tier change that pins the
item that followed the old default, and hiding the entry for one type. No provider is
involved.

Rail menus coverage (MAP-21): `rail-menus.spec.ts` drives the hidden app.
It reads the rail's buttons by position and asserts the order Needs me, To-dos, GitHub
inbox, Undermap, Settings, one column inside the frame, Settings below the divider,
and that the top right has no button left (only the silent connection status). It
walks the rail with Tab, checks each slot's tooltip and key, the Needs me badge
against the to-do badge's computed style, and the zero state (plain slot, same place,
still opens the list). Needs me is exercised as a sheet: rest to peek without moving
focus, click and N to keep it open with focus on the first row, position right of the
rail, keyboard resize saved in the view state, one sheet at a time with a peek over
it, Escape without the map stepping back, the slot closing it and a right click on the
map. Settings opens from its slot, shows the slot open and returns focus. At 1280,
1100 and 900 px the rail is compared with the zoom bar, the Atlas and an open item's
frame bar, and Needs me is opened over an open item. `panel-right-click.spec.ts` runs
its right-click and left-click cases once per sheet, since only one can be open.
Baselines `rail-needs-me.png` and `rail-needs-me-zero.png` hold the two slot states.
These are renderer checks over a fixture workspace; no provider is involved.

Item links in one call (MCP-02): `packages/core/item-links.test.ts`
covers `links` on `item.add`/`item.create` (one revision, direction, whole-command
refusal, stable derived ids on replay, blocking cycles, duplicates, one-partner
limits, a provider item the map already has). `packages/workspace-service/resources.test.ts`
covers `connections` on the attach path against the GitHub fixture.
`packages/mcp/item-links.test.ts` covers `workspace_apply` batches, the
`agent: true` shorthand with and without a bound agent, the advertised schemas, and
one stdio call through the production bridge and a real service. `agent.spec.ts`
drives the scripted agent registering its PR this way. No live provider is involved.
Undermap mirror coverage (MAP-18): `src/graph/undermap-mirror.test.ts`
covers `mirrorLayout` and `searchUndermap` as pure functions, with a fixed `now` and
explicit time zones (UTC, New York and Tokyo across a year boundary): the same layout
for reordered input and whatever positions are stored below, areas under their
projects, month grouping, labels, ranges and order, the budget and the month it cuts,
closed months as one line each, opening a month without disturbing the others,
columns lost to a close neighbour (never under four) and yielding downward, a
project that moves, the Loose area, a whole project below with Bring back, archived
records, and 1,000 items (at most 28 cards per area, layout under 250 ms).
`undermap-mirror.spec.ts` drives the hidden app in UTC with the clock fixed, on a
hand-made history (two projects, 133 items below with stored positions in a far
strip): send from a project by the menu, same camera before and after travel, the
plate in its place, the card first under its month line, Bring back to the exact
map position; line texts and counts; a pan carrying the lines; closed months that
open on a click or Enter and close on a click or Escape without moving the camera;
“+N more” and back; an opened card; a moved project; the Loose area and its menu;
search by title, project and month with arrows, Enter, a click, the empty text and
Escape; no drag, arrow-key move or resize grip; the Classic setting showing all 133
cards at their stored positions, a drag there, and Mirror again; the far plates; and
the audit's 1,001-item history mounting at most 112 cards. `undermap-performance.spec.ts`
measures travel, mounted cards and elements at 102 / 302 / 1,001 items below in
Mirror and at 1,001 in Classic and asserts the Mirror bounds. The placement journeys
of `below-map.spec.ts` and the Undermap journey of `dashboards.spec.ts` now set the
Classic layout first; the rest of the suite runs with Mirror, the default. These
are renderer and reducer checks on fixtures; no provider is involved, and nothing
was tried on a copy of a real workspace.

Writes without a revision (MCP-02): `packages/core/revision-policy.test.ts`
fails when a command type has no row in the table and pins the reviewed
classification, the conditional rows and the refusal text.
`packages/workspace-service/apply-at-head.test.ts` runs against the memory and the
SQLite store with another writer bumping the revision after each read: applied once,
replayed by `commandId` after the map moved on, refused before writing, given up
after five attempts. `create-at-head.test.ts` creates a terminal item without a
revision through real local IPC with simulated supervisor replies (no shell starts).
`packages/mcp/revision-free.test.ts` drives the production MCP server on a real
service: twelve concurrent revision-free writes, the own-node rule, mixed batches,
a stale explicit revision, `workspace_create_item` on the Linear fixture, and that
every tool taking `expectedRevision` is classified. The scripted agent in
`agent.spec.ts` registers its PR without reading a revision.

Mute project coverage (MAP-25): unit tests cover the `project.mute`
command (stamp only, kept through Undermap and Archive), its refusal from agents in
the reducer and both MCP transports, persistence across a real service restart, the
split of Needs me into counted and muted rows (aliases included), plate, dashboard,
Atlas and to-do models, menu entries, native notification suppression and the
finished/unblocked notices. `mute-project.spec.ts` drives the hidden app: muting from
the menu, the Needs me button, Dock badge and “Muted · N” panel line, a fast pointer
pass (no reveal), a dwell (true cards show), leaving, a click before and after the
cover parted, a pan, a right click, the chip, Enter and ⇧M, a drop onto a muted
project, Undermap and back, a desktop restart, and computed styles proving one linear
opacity transition of at most 150 ms with no looping animation, and none at all with
reduced motion. Three reviewed baselines (near, mid, far) fix the look. Native banners
are stubbed as in the notification journeys; real macOS banner suppression is not
separately evidenced. The dense-map gates do not mute anything; a 500-item probe with
half the projects muted was run by hand.

From the repository root, on the baseline's supported Node runtime:

```sh
npm ci
npm run check
npm run test:desktop
npm run test:runtime
npm run package
npm run test:package
```

Development is pinned to Node 26.8.2 and npm 11.19.1. Packaged background processes
use Electron 44.4.5's bundled Node 24.21.0 via `ELECTRON_RUN_AS_NODE`; the packaging
smoke test verifies PTY loading/input/resize/exit in that actual separate runtime.
Desktop coverage includes the isolated bridge, real map
persistence, an unknown plugin, pointer/wheel navigation, terminal survival and the
scripted native agent's UI → PTY → stdio MCP → service → SQLite → live map loop.
The native fixture also covers general-purpose Fable creation with an inherited
project folder, stopped alternate-screen retention, absence of History/playback controls, and
importing/resuming a saved Claude conversation from another folder without a
duplicate process. Real key events verify terminal-only font zoom and final-row
bounds after window resizing; pointer tests cover context-menu dismissal, dragging
creation forms without moving their map placement, and returning from full item
view via right-click or the pixelated X without restarting the terminal. Terminal input becomes enabled/focused in the same layout commit as the running
state; the performance journey types immediately after that state appears, catching
lost leading characters as well as measured input latency. The agent
journey checks New/Continue mode switching and preservation of the new-session draft.
Project-folder regressions cover shared plugin defaults, explicit overrides,
missing floating-item directories and persistence without rewriting saved items.
The Terminal desktop journey starts a real shell in the inherited project folder
through both the creation form and production stdio MCP, then clears the project
folder and replays the same request without another launch. Service fixtures also
cover concurrent creation and replay after service loss; existing agent/skill
journeys verify inherited folders and native resume with its original directory.
Pending-launch Stop regressions pause the real runtime during shell PATH discovery,
native server startup, initialize and context injection. They assert no terminal
spawns, owned setup processes exit, siblings still launch and replay/restart retains
cancellation. A hidden desktop test clicks both the item toolbar and Sessions Stop
controls during native preparation. A lifecycle test excludes manually stopping
processes from recovery while still draining them on close. Native protocol replies
are local fixtures; these tests invoke no paid model or live provider write.

Cache-failure regressions obstruct only an isolated fixture's temporary cache path
with a directory. They reproduce the supervisor disconnect, then verify continued
PTY input/output, bounded path-free diagnostics and retained SQLite history. Restart
replays current committed bytes with stale, absent or corrupt caches; a legacy
tail imports exactly once and keeps its partial marker. Journal tests cover tail
order, byte/chunk caps, oversized Unicode and deletion. This is a cache I/O fault,
not evidence of disk-full or hardware power-loss durability.

Large-recording replay is covered at three levels. Pure and journal tests check
restart points (earliest reset in the budget, line fallback, whole-character
suffix of an oversized chunk), mode restoration across split escape sequences,
pending chunks, range/deletion limits and the resumed mode scan. A runtime test
reads a >1 MiB flood with a tail budget and pages to the end, asserting the first
page starts after a line break and sequences stay contiguous with no duplicate
against an untailed read. `terminal-huge-replay.spec.ts` records 48 MiB of
synthetic Ink-style redraws (`huge-tui-terminal.mjs`) while the view is closed,
reloads the renderer and reopens it: replay must catch up within 1.5 s, replay
under 4 MiB, keep the longest timer gap and long task under 200 ms, show the final
transcript and "Earlier output skipped", echo input typed during and after the
replay, and wrap a paste in bracketed-paste markers enabled 48 MiB earlier.
`undermap-views.spec.ts` covers the same bound for a view that stayed mounted
while closed: reopening it after 16 MiB of output restarts from the bounded
replay (under 5 MiB written to xterm) in the same mount and session, keeping
modes such as bracketed paste. Its travel journey keeps a ticking terminal on
the map, opens an item from Needs me and closes it, then travels to the
Undermap and back four times: nothing reopens on return, no terminal reads run
below, and each reopened view runs exactly one read loop at a steady rate.

Runtime checks cover color environment/ANSI bytes and full recordings beyond the
256 KiB live tail across supervisor restart; migration coverage preserves v1 history
limitations. The native fixture emits tool hooks around MCP calls, including read→write, to catch
status observations accidentally invalidating the graph revision. It is not a model.
Codex adds a real WebSocket/PTY fixture through the same production service, UI, MCP
and recovery path; it is also explicitly not a model. See [native Claude support](native-claude.md)
and [native Codex support](native-codex.md) for separate live-provider evidence.

Unicode-copy regressions launch hidden Electron without LANG/LC_ALL/LC_CTYPE, like
Finder/Dock. They drag across a real PTY table and press ⌘C for both xterm-owned
selection and a scripted CLI-owned selection that invokes real macOS pbcopy. The
native path reproduces mis-decoded box drawing (`‚î`) without the locale fallback;
the ordinary xterm path is a passing control. Verify box drawing, dashes, accents,
CJK and emoji in the OS clipboard. Tests keep original formats only in main-process
memory and restore them if the clipboard still contains the fixture; assertions
return only flags, never unrelated clipboard text. Pure checks cover locale defaults,
explicit overrides and an unchanged parent environment. No real-Claude model call
is needed to establish this native clipboard boundary.

Terminal input/link regressions cover real PTY Shift+Enter with bracketed paste
and the distinct-key fallback, agent-view native Shift+Enter routing with a local
CLI fixture, plus a real zsh prompt where neither command runs
until ordinary Enter. The official addon's plain/wrapped URL and OSC 8 paths are
exercised with actual pointer events in normal and native mouse-reporting modes.
The menu uses spied native clipboard/browser writers to check exact destinations
without altering the user's clipboard or navigating externally; existing Unicode
copy tests continue to exercise the real clipboard. Checks include selection,
copy/open keyboard controls, Escape/outside dismissal,
links in stopped sessions,
unsupported URL rejection and a reviewed menu screenshot. All run hidden with
isolated workspace/session databases, no model or remote provider write.

Agent-menu regressions cover keyboard navigation, Escape/outside dismissal without
leaving the focused item and live reattachment/resume. The native
Claude fixture queues workbench instructions during a permission prompt, asserts no
PTY input/process replacement, changes the project brief, then reads and acknowledges
the real hook output through production MCP on the next submitted prompt. Service
tests cover queue persistence, repeated requests, stale offers, stopped/unsupported
sessions and old-process isolation. These prove local transport and hook contracts,
not a live model's compliance with the supplied guide.

Diagnostic-log checks flood both process streams, verify bounded current/rotated
files, upgrade an oversized log, refuse unsafe targets, preserve recording fixtures,
exclude a second owner, capture spawn/crash failures and restart cleanly. The actual
Electron runtime check exits the launcher before later service output arrives,
then verifies the detached writer drains output and releases ownership on exit.
This does not establish the entire release crash/update matrix.

Diagnostic-setting tests validate bounds, optimistic revision conflicts, restarts,
tail trimming and persisted log-owner policy. Support-export fixtures include
private titles, account bindings, IDs, URLs, paths, job prompts and native-session
errors and assert none appears in the allowlisted report. The hidden desktop
downloads to an isolated path without opening a native save dialog, checks the
JSON and persisted controls, and captures the Settings section at 900×640.

Recording-cleanup checks reject running/unarchived sessions and missing confirmation, keep
launch/native identity and neighboring recordings, paginate metadata, and prevent
deleted output from reappearing through buffered writes, old cached tails or a
supervisor restart. The v2→v3 fixture checks a private backup and version guard.
Hidden desktop coverage exercises cancel/confirm, both UI and MCP deletion, a
currently open stopped terminal, reload; journal fixtures also verify that native resume records new output after
old recording deletion.
The recording-cleanup screenshot checks the real native state and session-ID text,
then masks that variable metadata line. A capture-only stylesheet stretches the
mask across the row, preventing timestamp/random-ID glyph widths from changing
the mask. Titles, deletion state, controls, spacing and row bounds remain compared
with the usual tolerance.
Only isolated fixture recordings are deleted. Older backups are not erased; freed
database pages are reusable without promising immediate file shrink.

Plain-Terminal restart is tested through its real toolbar, PTY and MCP: keep the
saved directory and prior recording, disable the action during running work,
deduplicate concurrent requests, and replay an old attach or completed restart
after workspace-service death without starting another process.

### Background desktop runs

Window placement has pure geometry and persistence checks for negative monitor
coordinates, removed/repositioned displays, smaller work areas, invalid files,
debounced atomic saves, immediate close and write failures. Real hidden Electron
journeys resize/move, quit and relaunch against the same isolated preferences,
including the full session-recovery close path. Corrupt/off-screen saved state
must still produce a reachable window. Hidden launches also test a saved maximized
flag without revealing a native window. Native maximization, macOS Spaces and
physical display unplug/reconnect remain manual platform acceptance checks.
These tests run through `npm test` and `npm run test:desktop`; no provider writes
or user's workspace data are involved.

Every launch with `ACT_TEST_DATA_DIR` defaults to a hidden, non-focusable native
window. macOS uses accessory activation policy, omitting the test app from the Dock;
activation and second-instance callbacks cannot reveal it. This covers direct
Playwright launches, restarts, renderer fixtures and packaged smoke tests. Normal
launches without a test directory retain the usual visible, focusable window.
Set `ACT_TEST_SHOW_WINDOW=1` explicitly to watch a local test, for example:

```sh
ACT_TEST_SHOW_WINDOW=1 npm run test:desktop -- --grep "desktop loads"
```

The hidden window uses Electron's normal renderer, with background throttling
disabled for tests only. Animation frames, terminal reads and screenshots continue
to run; Electron reports the document as visible. This is not a browser mock or
an offscreen renderer. The existing screenshot tolerances and performance budgets
are unchanged. Background performance reports measure renderer/PTY responsiveness,
not OS presentation latency. Native focus, occlusion, Dock and real dialog behavior
still need the explicit visible/manual release checks.

The desktop bridge journey asserts hidden/unfocused/non-focusable state, absent
Dock entry and active document rendering, exercises activation/second-instance
callbacks, and verifies keyboard/pointer actions never reveal or focus the window.
The packaged smoke checks the same native window/Dock state. The full existing
desktop suite checks terminal input, resizes, recovery and screenshot parity.
See Electron's [window visibility behavior](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)
and [macOS activation policies](https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos).

### Spatial and update coverage

Type-specific sizing covers the native default footprint of every built-in,
supported-tier validation (including Small-only to-dos), legacy unsupported
choices, per-alias dimensions and independent Claude/Codex settings. Domain and
SQLite checks cover custom dimensions, tier compatibility, replay, stale/invalid
rejection, reload and collision displacement without resource/camera mutation.
Production MCP fixtures configure presets and resize through the shared command.

Hidden desktop journeys drag the actual bottom-right grip at multiple zoom levels,
assert the pinned visible top-left, neighbor clearance, updated neighborhood field,
persisted dimensions and keyboard sizing. Escape cancellation preserves the whole
workspace. Menus have no Size action; default widths remain unchanged. Settings
Save/Cancel/Reset, hidden-field validation and narrow layouts stay covered. Note
excerpts have bounded clipping checks. To-dos remain inline editable and done items
recover saved sizes on reopening. Native lifecycle checks preserve a running
terminal's process identity through per-node resizing and per-type settings changes.
Settings/map screenshots supplement assertions; no live writes/model calls.

Hover regression checks distinguish pointer focus from keyboard inspection and
clear emphasis on real pointer departure, including after resizing and zooming.
Pointer/keyboard hover must leave dimensions exactly unchanged and mount no
preview or detail content. Direct edges still meet projected bubble boundaries.
Mouse-click focus must not retain outlines or connector/grip visibility after exit.
Expansion starts at the saved projected bounds; to-do body/keyboard activation
opens its inline editor rather than full item focus.

To-do references assert direct map reveal for one item, including a browser-backed
item that must not launch its URL. Multiple references widen the overlay into a
separate region without changing row heights; selecting a reference restores the
normal width. Single-reference detachment leaves the resource intact.

Shortcut checks exercise T open/close, persisted auto-hide toggling and pointer exit
after keyboard navigation, while active editing remains protected. Text fields,
dialogs, menus and the real native terminal retain their keys. Matching/schema
tests cover modifiers, repeats, composition, already-consumed events and additive
compatibility with older view preferences; the pinned state has a visual baseline.
Immediate typing after opening verifies that shortcut focus cannot arrive later
and steal focus from a text field.

Spatial tests cover rounded member-following silhouettes with outward square pixel steps, full
corner clearance at zero/custom/default (240-world-pixel) padding, deterministic
geometry and membership choice where padded areas overlap, deduplicated status
counts, and centered titles above the enclosure with a reachable viewport-edge fallback.
An unrelated saved project anchor cannot stretch a populated neighborhood. A real
member drag verifies growth, recentering and corner containment before mouse-up,
unchanged other positions after drop, and the same centered title above the outline
at overview zoom without a central bubble or membership spokes. Empty projects
retain an anchor-based fallback. Real
Electron journeys switch zoom levels and assert identical outline paths and world
positions, no camera-driven geometry rebuilds, readable labels, explicit item
lines, pointer/keyboard project movement, hover geometry, cursor feedback, and
Enter/Escape navigation. A normal-motion journey samples actual compositor
animations at their start, middle and end in both directions, asserting the same
bubble grows/shrinks without moving the camera, outline or saved items. Reduced
motion skips the animation; the terminal journey verifies persistent mounts. Right-click creation verifies world placement and project
editing through the label; terminal checks compare the X and toolbar button bounds.
Seeded arrangements verify full containment, diagonal/elongated proportions, translation and
bounded contour complexity. A two-member diagonal regression excludes the empty
areas of the old circumcircle while retaining every corner plus padding. Its
production screenshot and right-click creation checks verify the visible fill and
project selection agree inside and outside that contour. UI and shared-settings
tests cover padding validation,
reset, conflicting drafts, live external updates to every project (also in focus
view), unchanged graph/camera, restart persistence and older settings defaults.
Collision coverage includes seeded mixed-size layouts and custom plugin widths,
negative coordinates, deterministic input-order independence, held-item precision,
archived descendants, ignored populated anchors and empty-project obstacles.
Atomic command tests verify replay, stale-write rejection, invalid-batch rollback
and unchanged resource/link identities. Two real pointer journeys measure rendered
rectangles at max zoom, clearance before drop, exact preview/commit agreement in
one revision, reload/zoom stability, rigid project movement against a floating
obstruction, and keyboard displacement. They also catch losing the initial pointer
delta at the drag threshold. Placement diagnostics run during drag and stay idle
on zoom. The separate dense-map journeys below add measured 200/500-item workloads;
explicit legacy-layout repair now has shared-domain and real-pointer coverage.
Cross-project drag checks cover stable pre-drag target geometry, deterministic
overlap selection, floating reach versus owned-item containment, and empty-space
ownership. Hidden desktop journeys transfer a connected working item into an
occupied project, verify exact preview/commit displacement and to-do regrouping,
reload and move it back. A real PTY fixture transfers its last source member into
an empty project without moving the destination anchor or changing its PID/cwd.
Shared command checks cover one-revision transfer, replay, stale rejection and
whole-batch rollback with unchanged resources, links and session identity.
The repair preserves already-clear items, archives, metadata, links and camera,
commits atomically and replays idempotently. An overlapping SQLite fixture proves
startup/zoom do not silently repair it and the board action survives reload.

Local update tests preserve the installed `.app` inode across repeated updates,
verify new contents and framework symlinks, remove obsolete files, retain a backup,
and abort without modifying the installed app when it starts during staging.
Packaging targets `release/staged`; `npm run install:local` smoke-tests that exact
bundle before updating the stable `release/mac-arm64` location. This is a guarded
development installer, not a signed automatic updater.

Installer verification/copy regressions mutate tiny isolated staged bundles during
verification or staging: same-size bytes, executable modes, link targets, and added
or removed files must fail before activation while preserving installed identity,
earlier backups and a workspace sentinel. A changed private copy also fails on
first installation; cleanup leaves no partial published app, and stable retry works.
Changing the source after copying still installs the original verified private
copy. Seven of these eight checks reproduce failures on the previous installer.

Installer crash checks kill actual isolated Node installer children during staging,
after preparation, after moving out old Contents and after activation. Recovery
preserves the installed directory inode, old or completely activated build,
framework symlinks, prior backup and unrelated recording sentinel. Additional
checks cover first installation, a concurrent live installer, refusal while the
app runs, retry without staging, ordinary rollback, unknown/replaced directories,
private metadata and newer schema rejection. The real `--recover-only` command
runs inside a disposable release tree. No real app or agent process is killed.
Hardware power loss and clean-machine distribution acceptance remain separate.

Storage checks use tiny local bundles and injected capacity observations, never
fill the host disk. They verify identical-build no-op behavior (including changed
timestamps), detection of same-size content/mode/symlink/directory changes,
low-space and capacity-read refusal before staging, and successful retry. A killed
installer fixture proves interrupted recovery still runs before low-space refusal.
The real installer also verifies an unchanged current bundle without creating a
duplicate backup.

A real local-socket test closes the desktop connection during subscription and
checks that no ready event or snapshot appears afterward and the socket closes.
Additional paused-reply fixtures reproduce closure during workspace/supervisor
hello and supervisor initialization. Each must reject promptly without releasing
the reply, close its peer, suppress ready events and leave an independent client
usable. Repeated connections check cancellation-listener cleanup; initialization
failure can retry. Launcher fixtures verify pre-aborted calls leave no workspace,
cancellation before spawn starts nothing, and startup polling stops before its
deadline. These are local IPC checks, not live-provider or root-cause evidence for startup stalls.
Five service-disposal regressions pause supervisor configuration and recovered
attachments/reviews, then close through production IPC or overlapping callers.
They verify prompt connection cancellation, correlated closing errors, review
drain before database release, no later recovery job starts, durable retry without
duplicate items, independent supervisor survival and immediate successor ownership.
All five fail against the previous shutdown implementation. Fixtures use temporary
SQLite stores, local sockets and injected providers; no remote action or model runs.
Five additional session-recovery checks reproduce late queued-job mutation,
overlapping passes, uncertain jobs stuck as running, calls after close, and stale
recovery candidates already settled elsewhere. Paused local supervisor replies
verify close drains before SQLite disposal, preserves unsent jobs, and reuses saved
launch identities after reopening. Acceptance/deduplication is simulated in these
protocol fixtures; the native runtime suite separately verifies actual PTY identity.
Three checkpoint-write fault tests cover recovery-start, persistent mid-restore
and final-checkpoint failures. They reproduce thrown start errors and unowned
background rejections, then verify visible retry state, launch gating, unchanged
durable identities and no repeated accepted sessions. A hidden Electron test injects
failure only into its isolated service's checkpoint writer; the error stays visible
past ordinary notification expiry and Retry clears it after storage recovers without
reloading. These injected failures do not establish physical disk-full or power-loss
durability, and never fill the host disk or modify the user's workspace.
Five further gate checks cover a transient write error whose final error record
succeeds, an interrupted recovering phase, and new/queued work on service restart.
Real SQLite/IPC verifies that attachment replay and simulated native launches wait
for durable recovery-start, retain request identities and do not repeat on retry.
The launch fixtures never start a real shell or model; native PTY coverage remains
separate. The shared background gate also closes immediately when shutdown starts.
A native runtime regression uses a local shell profile that records each invocation
and delays PATH discovery. Idle supervisor startup, session listing and recording
inspection must not invoke it; two fresh launches receive the repaired PATH from
one cached resolution, and replayed launch IDs do not run it again. This reproduced
the eager startup dependency before the change without using a wall-clock threshold.

Dense-map reports now include startup milestones for Electron launch, first window,
visible connection and rendered graph, plus an independent read-only IPC probe's
hello/snapshot timings. The probe never starts a service, runs a session or retains
graph text; it stores only counts, timings and allowlisted failure codes. Reports
retain the last eight failed attempts with their attempt number and phase
(credentials waiting, socket connection, hello or snapshot). Transport failures
keep their original local cause while pending calls still report CONNECTION_LOST
for reconciliation; raw causes are never serialized into IPC or support reports.
The probe distinguishes a missing endpoint from its own handshake/read deadline,
authentication failure and incompatible protocol. It closes
before navigation measurements and is cancelled on test failure. Local-socket
checks cover initially missing credentials/IPC, a stale socket with no listener,
later readiness, authentication and
protocol refusal, separate stalled hello/read deadlines, bounded history, privacy
and cancellation. Use `npm run test:startup` for five isolated hidden 500-item cold
starts, including the normal navigation/commit/drag gates each time. It keeps the
existing five-second connection assertion and performance budgets; reports for
each repetition live under `test-results/startup`. It does not enable test retries.
This improves evidence about startup stalls; a passing run does not establish their cause.

The hidden startup journey fails initial catalog reads through the real service,
then restores them without reloading Electron. It verifies automatic recovery,
error clearance, unchanged graph, and that a later service reconnect preserves
the user's current camera and unsaved edit draft.

Expanded-view checks assert the original bubble remains at its saved bounds and
connections/neighborhood geometry stay fixed during opening, dragging, switching
and closing. A real PTY journey checks click threshold, independent screen movement,
keyboard movement, Escape/pointercancel/lost-capture/blur rollback, reopen position, unchanged
PID/mount and terminal dimensions. It traverses linked terminal/PR/document views.
A note journey moves the expanded view away, hit-tests the exposed original bubble,
checks the unchanged workspace, zero card renders during movement and reclamping
after window resize. Normal-motion
checks sample opening, intermediate and closing frames, including closing from a
moved view to the original bubble; reduced motion is immediate. No live writes.

`expanded-resize.spec.ts` covers per-instance sizes without changing same-type
peers/defaults, anchored corners, pointer/keyboard/reset, all cancellation paths,
window shrink/restore, unchanged graph/edges and the resized return animation.
The native PTY case asserts retained PID/mount, changed rows/columns, last-row fit
and reachable controls at minimum size. Resized note/terminal captures are part of
the visual suite. `performance.spec.ts` records view resizing separately from its
stream/burst phase, enforcing fit p95 <32 ms, frame p95 <50 ms / p99 <150 ms and
coalesced fits without changing existing stream/idle/hidden gates.

Creation coverage includes quick/All layers, project omission inside neighborhoods
without mutating preferences, an empty center and no close X, non-overlapping ring
choices, and edge clamping. A normal-motion journey samples the seed-to-form growth,
drags the completed form while retaining its draft/world placement, and dismisses
it without creating data. Unknown plugins and plus-drag use the same path.

### Item-sized expansion regression coverage

`item-views.test.ts` checks metadata discovery/variants, old settings defaults,
invalid dimensions, unknown-plugin preference retention and screen-bound clamping.
The SQLite settings test reopens an older row, saves sizes and confirms graph,
camera and launch preferences survive. `item-views.spec.ts` exercises independent
Claude/Codex/Note dimensions, drafts, Save/Cancel/Reset and reload, bounded and
scrollable notes on resize, and connected to-do navigation back to inline editing.
`notes.spec.ts` resizes an unsaved ring note (kept unsaved, no error, size saved
with its first text), a saved note in every grip direction, at its minimum width
and maximum, by keyboard (top-left fixed, height from text), and a note while
writing (caret kept, text refitted to the new width).
Existing spatial/native terminal journeys protect animation, mounts, input and
resize; settings and summary journeys use the reorganized groups. All fixtures
are local; this does not establish live-provider acceptance.

### Neighborhood pixel appearance regression coverage

Pure geometry tests verify four disjoint shade bands, stable world-grid alignment,
negative-coordinate translation, deterministic scattering, solid centers, zero
fade, equivalent rectangle merging and bounded cost for huge square/elongated enclosures. Shared settings tests
cover older JSON defaults, partial appearance defaults, strict bounds, rejection
without revision changes, persistence/restart and unchanged graph/view data. The
stdio MCP fixture writes and rejects the same settings through the real service.

The hidden `neighborhood-appearance` journey verifies defaults, Save/Cancel/reset,
native invalid-field feedback, all three controls at a narrow size, external
updates during expanded-item focus, unchanged logical enclosure/membership/camera,
reduced-motion behavior and shading animations that finish rather than loop.
Reviewed screenshots cover the new Map controls and a large scattered field;
existing overview/diagonal/attachment/drag/zoom/terminal and dense-map journeys
exercise the new default material. Overall SVG opacity limits brightness when
projects overlap. Performance budgets and camera-only geometry reuse still apply.

### Settings tree regression coverage

`settings-tree.spec.ts` covers nested page selection, keyboard focus/expansion,
type-ahead, draft retention through collapse and navigation, hidden invalid-field
recovery, Cancel and narrow-window control bounds. Existing settings, per-type
size, provider-account, shortcut, diagnostics, recording and summary journeys
exercise their real controls through the sidebar. Reviewed screenshots cover
initial navigation, Claude/Note pages, narrow layouts and fixed Save/Cancel.

## 2. Test layers

Rollout coverage: sanitized GitHub fixtures exercise URL matching,
job/run identity, branch-scoped latest workflows, no-run feeds, paginated job lists,
approval versus timer/queue states, incomplete/unknown results, reruns and changes
during observation. Transport tests verify GET-only methods, fixed host and path
rejection before credentials. Real SQLite service tests cover generic attachment,
deduplication, unopened polling, attention acknowledgement/new runs, restart,
durable rate limits, stale results, archive and disconnected accounts. The hidden
`tests/e2e/rollouts.spec.ts` journey checks From URL, map badges, approval details,
automatic open-view refresh, completion notices, failure retention and restart;
its map/detail images are visual regression baselines. Ordinary tests never read
or mutate a live deployment. Authenticated read-only evidence is recorded
separately in `native-github.md`.

| Layer | Real components | Substitutes | Main proof |
| --- | --- | --- | --- |
| Domain | Pure graph, context, registry, status logic | Fixed clock/IDs and fixture data | Business invariants and error cases |
| Service | SQLite, transactions, jobs, subscriptions | Provider responses and fake runtime adapter | Durable state, conflicts, retry/recovery behavior |
| Plugin contract | Registry, controller, generic form/schema dispatch | Fixture connector where needed | A new type works without core branches |
| Terminal integration | Supervisor, node-pty, transport, child process | Scripted CLI instead of a paid model | Actual input/output/resize/process lifetime |
| Desktop end-to-end | Electron, renderer, preload, service, DB, PTY, MCP | Scripted agent and local provider fixture server | User actions and cross-process synchronization |
| Provider smoke tests | Installed Claude/Codex, selected real provider/workspace | No substitutes for the capability being checked | Supported native integration actually works |
| Model evaluations | Real agent + MCP on bounded tasks | Disposable test repository/provider fixtures | Agent follows the synchronization instructions |

Keep Node's existing test runner for domain and backend modules unless a specific
need justifies changing it. Use Playwright for browser-renderer flows and a smaller
suite launching Electron. Electron automation is
[experimental in Playwright](https://playwright.dev/docs/api/class-electron), so pin
compatible versions and test upgrades deliberately. Browser-only tests cannot
replace packaged app/PTY tests.

## 3. Deterministic test agent

Create a small child executable with a controllable script: print terminal output,
request input, wait for a signal, report a resize, invoke MCP, finish or fail. It
runs through the real PTY and launch adapter contract; it must not bypass input,
transport or persistence by calling renderer helpers directly.

Use it to check guide/brief delivery without reading a real conversation. Have it
report the exact received test context and call the actual stdio MCP bridge.
Simulate documented provider events through the same validated event boundary.
Use the fixture HTTP server for remote metadata and deliberately delayed failures.
Clearly distinguish this deterministic proof from tests of a native provider CLI.

The new general-purpose Claude opening has pure hierarchy tests for parent-first
PR/review order, cycles, aliases, disconnected/archived items, done state, floating
agents, declared future plugins and the 200-item cap. Service tests exercise
bounded parallel reads, failures, truncation, total content limits and invalidation
when a nested link is removed. The native fixture captures both SessionStart
output and the actual MCP offer and asserts PR → review → note content, completion
state and revision metadata. It prints a clearly labeled scripted What next line;
it does not establish real-model recommendation quality. Existing adapter and
desktop checks cover explicit task/skill preservation and resume/recovery without
onboarding replay. Live acceptance separately checks relevant suggestions, stale
reviews, sparse context and waiting for the user's choice without performing work.

The first milestone's automated acceptance journey is:

1. Start services and Electron with an isolated data directory and temporary repo.
2. Create a project; launch the scripted agent through the UI.
3. Verify the bound project/node/workspace IDs, brief, task and separate host guide.
4. Have the agent register a fixture PR through MCP and connect it to itself.
5. Observe the correct map update without refresh and without duplicate resources.
6. Type into the actual terminal; verify the child receives the expected bytes.
7. Resize the item and check the PTY dimensions; zoom away/back without respawning.
8. Simulate unexpected desktop termination and reconnect to the same process with ordered output.
9. Restart the workspace service while the supervisor remains alive; reconnect.
10. Exit the process; verify its real exit state. Reopen cannot pretend it is running.

The orderly close journey verifies the native warning configuration and Cancel,
then confirms shutdown and checks that PTYs and a shell child exit. Reopening
preserves node/resource IDs, layout and old recordings, resumes the working and
waiting Claude conversations, sends continuation only to the working agent, and
keeps an archived/unselected terminal stopped. It excludes a manually stopped agent and checks
that retry cannot duplicate live processes. Fixtures use real services, SQLite,
PTYs and MCP; the native dialog response is supplied by the test. No paid model
calls or external provider mutations are used. Checkpoint tests cover interrupted
close, launch draining, failed/uncertain recovery and refusal to stop if persistence
fails. Detached-session regressions verify shutdown still stops orphan processes
but never selects them for recovery. Legacy pending/failed orphan checkpoints are
retired automatically across service restarts; attached failures remain unchanged
until Retry. Hidden Electron loads a real legacy checkpoint and verifies no
attention or zero-restored notice, no recreated node and no launch job. Existing
notification-expiry and persistent-failure tests use genuine attached-item fixtures.
A schema-v4 upgrade fixture preserves an existing graph and camera.

A separate test exercises a saved native conversation resume. Another kills the
supervisor and confirms recovery reports the lost process rather than claiming it
survived. Reset state and terminate test processes in cleanup even after failure.

## 4. Required regression matrix

| Area | Essential cases |
| --- | --- |
| Graph | Self/duplicate links; both cardinality endpoints; aliases; archived partners; atomic rejection; link removal; context direction; moving a project preserves member offsets |
| Placement | Create/drop among mixed-size nodes; no overlaps using actual measured detailed footprints; held item stays fixed; negative coordinates; sparse/empty projects; deterministic results |
| Navigation | Actual wheel zoom around cursor; bottom-right slider clicks, dragging and keyboard input keep the same world point at the visible map center while zooming in/out, including after pan/resize; drag pan; no coordinate mutations from zoom; return location preserved; overview project-bubble top stacking; neighborhood bubble hidden and Project: NAME label behind all items; readable centered label above the outline at every zoom level, with unchanged item positions; pixel field visible in all three views with no stroke; rounded member-following silhouette and configurable broad fading pixels; full member footprints, including corners, stay enclosed with at least the configured padding (one detailed large item width by default); enclosure recenters/grows with added/moved members, ignores the saved project anchor unless empty, and scales with zoom without rearranging items |
| Neighborhood settings | Default and custom padding, pixel size, fade distance, scatter, style, texture and reset; UI/MCP validation and revision conflicts; invalid values rejected; persistence and older-settings defaults; changes update outlines in all views without moving items, camera or membership; camera-only zoom reuses geometry |
| Neighborhood biomes | Preset → biome and custom color → none; grounds, flat colors and sprites equal to the design reference; texture strength; growth chance, determinism on world cells and clearance around item footprints; a bake only when the field changes (none for pan or zoom); the flat fallback at small detail; plain for custom colors, muted projects and the Undermap; style and texture saved, discarded, reset, applied live and kept across a restart |
| Direct connections | Drop immediately saves without a relationship menu; automatically target either context receiver, prefer the drop target when both accept, otherwise save information only; duplicate/self/cardinality errors never downgrade or partly mutate; keyboard endpoints and connected local/native/URL creation use the same defaults; existing explicit links survive reload unchanged; straight boundary-to-boundary geometry in every direction and with reversed sources; directed context versus undirected reference/membership; live drag and semantic size changes keep endpoints on displayed bounds; no reversed/invalid segment for overlap; wide pointer/keyboard removal and undo remain usable; visual regression of a lower-right source pointing to an upper-left agent |
| Interaction | Surface drag versus click; ports versus drag; a press on any point of a card face drags the item and never the map (`tests/e2e/item-grab.spec.ts`: a grid of agent, PR, Linear, rollout, note and floating cards at near, mid and far zoom with real pointer input on the middle, words, badges, working mark, edges, corners and beside the + tab; slow, trackpad-like and after-hover drags; a second press while the first move saves; a press while a closed view flies back); right-click New item/New project at the clicked position with no persistent + New project button; board grab/grabbing and item pointer cursors; stepped hover/focus highlights without layout changes; floating attach preview; keyboard alternatives; expanded terminal selection/input; expanded-view X matches peer toolbar button height/alignment |
| Working indicator | Grazing (VIS-03): tufts in the card's own colour on the inside of its bottom edge and a sheep walking in 2 px steps, without changing card/content bounds or triggering card rerenders; the mark follows all sizes, manual resize and neighborhood zoom and never covers what the card says; a card without room for the sheep keeps the tufts and a glint; far-zoom icons keep the still stripe; provider mark, readable Working summary and independent Needs me remain; idle removes the mark without moving/resizing the item; expanded surfaces never mount it and background motion pauses during focus; reduced motion and Undermap keep the tufts and a standing sheep; one sheep per busy helper in its own paddock, capped by width, with the real number in the accessible name and tooltip; the item's own sheep asleep with a z while it only waits on its helpers, the others grazing, and lying without the z in the still states; the helper count follows foreground and background subagents and busy teammates, is written only when it changes and never stays on an item that is not working; every agent state of VIS-03 on a fixture card by node state alone (`tests/e2e/sheep-states.spec.ts`: gate, question, error, command, compaction, pinwheel, ended, flowers, bell, pen and the four moments, with labels, priority of the gate over a command, still frames and one reduced-motion baseline per state); hook mapping, scene rules, smoothing, rate limits and reducer invariants in unit tests, including that a burst of tool hooks costs no revision; dense-map performance budgets remain unchanged |
| Context menus | Exact short lists by board/neighborhood/item/project/line, pointer/ellipsis/Shift+F10 parity and keyboard navigation; provider titles read-only; membership saved atomically; Settings archive preserves its draft and exposes overlap repair; radial skills exist only for project/native capability, back through the ring, and plus-origin runs save their connection with the native agent; protocol-fixture UI/MCP replay/resume keeps one invocation |
| Circular creation picker | Empty-map double-click opens one circular picker at the cursor without zooming or creating an item; opening motion grows the center from zero and spreads/scales choices from that center, with asserted start/intermediate/final geometry and an inspected intermediate screenshot; layer changes retain the center; keyboard selection/dismissal works during entry and reduced-motion changes settle immediately; single clicks, item/control double-clicks and expanded content do not trigger it; right-click New item and plus-drag creation share it; configured quick choices/order persist; All replaces them with only remaining plugin types; right-click/Escape returns one layer then closes without opening a context menu; edge placement, empty All, keyboard selection and new plugin discovery work; selected forms preserve the original world position, project and connection context |
| To-do | Single-click inline title editing in map and overlay; Enter/blur saves and Escape cancels; validation/save errors preserve drafts; editing persists through shared commands/reload without changing identity/layout/links/completion; click versus drag and text selection stay distinct; keyboard editing works and active editing prevents auto-collapse; Map/drop links; project grouping; done/archive propagation; hover exit/icon reopen; icon-only width; animation completion; preserve draft/scroll/position; no collapse during drag/keyboard work |
| Notifications | Routine bottom-left success/info notices (including session-restored counts and finished turns/reviews) expire after about five seconds; important errors/warnings/action requests persist; completion notices stack, offer Open, and do not replay on reload; expiry/dismissal leaves unread attention and operation state intact |
| Needs me read state | Opening or manually marking seen removes the resource across aliases while preserving input/error/process state; read state survives restart; unchanged polls/replayed completions stay read; later completions reappear; stale receipts preserve newer events; legacy snapshots remain compatible; unread results survive more work |
| Lifecycle | Done remains compact; hover/focus reveals links; active menus and keyboard cannot delete; shared commands reject unarchived deletion atomically; archive restores or deletes, retaining inherited child archives when removing a project; checklist archive metadata survives edits and SQLite restart; session/recording deletion is archive-only; none of these implicitly kill sessions |
| Commands/events | Two concurrent writers; stale revision; command replay; mismatched replay payload; rollback; sequence gaps; duplicate events; subscribe during snapshot; reconnect after compaction |
| Persistence | JSON import; every schema upgrade fixture; migration failure preserves prior data; service crash before/after commit; job recovery; missing plugin/schema data retained |
| Sessions | Duplicate launch request; live attach versus native resume; input/Unicode/control keys; resize; slow consumer; output sequence; exit/crash; missing binary; unavailable workspace; reconnect; Sessions archive/restore/removal across restart and reconciliation; explicit stop before removing a live session; native conversations and map lifecycle preserved |
| Context | Edited brief exactly delivered; external text stays outside trusted guide; queued additions/removals; delivery acknowledgement; stale guide updated once; unavailable source visible |
| GitHub | All assignment pages; partial/rate-limit failure; provider dedupe; ambiguous repo mapping; per-account viewed cycles; stale review revision; complete diff or explicit failure |
| Review jobs | Double-click; timeout after POST accepted; restart; unrelated/ambiguous workflow runs; cancelled/failed jobs; successful job missing report; actual result URL binding |
| Boundaries | Renderer cannot access Node/secrets/arbitrary spawn; unauthenticated service input rejected; unrelated embedded page has no bridge; invalid plugin action cannot invoke runtime |

For map geometry, supplement named examples with seeded generated arrangements and
invariant assertions. Use representative screenshot snapshots at overview,
neighborhood, expanded terminal, dense map and collapsed to-do. Freeze clocks and
animation states for screenshots; test real animation/input separately. Do not
use screenshots as the only evidence for no overlap or a live process.

Implemented visual comparisons cover nineteen reviewed images across the map/form/terminal, skills and item-lifecycle
Electron journeys: overview, neighborhood, hover, inline creation, settings and a
real PTY terminal at regular/narrow dimensions. Fixed sample data and capture
conditions remove incidental variation. The terminal waits for confirmed resize
and repaint; it is not a static HTML imitation. Normal runs fail on missing or
changed images and never rewrite baselines. CI disables updates explicitly and
retains the HTML report, expected/actual/diff images and traces on failure. Intentional
changes require an explicit local update, image review and a matching code commit.
See [visual regression instructions](../tests/visual/README.md) for commands,
tolerance, rendering environment and remaining coverage limits. The current local
macOS baselines still need their first remote CI comparison; that run has not been
claimed as passing. Dense-map and to-do overlay images are included.

### Unified URL creation regression coverage

Picker isolation checks pointer hit testing in a visible gap over an actual item
and across a direct edge: no map preview, connector, background highlight or
connection tooltip may appear. Outside dismissal does not activate the underlying
item; hover returns after closing, with graph state unchanged.

The radial picker hides All when every non-project type is already in the quick
ring, both inside and outside a project. Removing a quick type restores All and
keeps that type reachable. Keyboard End targets the real final choice; the amber
unfinished center is captured in the picker visual baselines. Center preview
checks cover pointer/keyboard navigation, plugin icon/brand/tone/relative size,
All/back/exit cleanup, fixed center and world placement, no live content mounts or
creation, and expansion from the visible preview into its form. A sampled CSS
transition verifies intermediate growth; reduced motion cancels it. An unknown
plugin fixture supplies its own size/tone without picker branches.

Verify one From URL entry in both picker/settings layers, legacy shortcut projection
without data loss, new plugin discovery, specific provider matching before generic
Web link, HTTP(S)/credential validation and explicit ambiguous matches. Hidden
Electron journeys use the real service discovery IPC and fixture-backed provider
attachments for PR, Slack, Notion, Linear and Web links, retaining authoritative
titles, source URL identity, original project/position and connected creation.
Changing a URL must invalidate the old selection; unavailable providers cannot
silently turn into Web links. These are local fixture checks, not live acceptance.

The Linear journey renders a Markdown fixture through the bundled Marked and
DOMPurify libraries: headings/emphasis, nested and ordered lists, disabled checked
and unchecked tasks, quotes, tables, fenced code, autolinks and attachment links.
Raw HTML and unsafe/credential URLs stay inert. Browser-opening calls are captured
at the Electron shell boundary without launching a browser or contacting a host.
Regular/scrolled/narrow captures protect typography and horizontal overflow;
wide tables and code scroll independently of wrapped prose. Refresh-to-empty,
rename, restart and failed-refresh checks preserve the correct formatted snapshot.

External-drop tests cover browser URI lists/comments, URL/title pairs and plain
URL text; credentials, files, unsupported protocols and arbitrary text are inert.
Hidden Electron journeys check all five built-in URL categories, project/floating
placement after zoom/pan, draft preservation, expanded/input isolation and no
navigation or graph changes before confirmation. A Chromium drag-event pipeline
fixture opens the real form for an extension plugin, then explicit attachment
persists the authoritative fixture title and drop position without a relationship.
These tests do not establish native Safari/Chrome/Slack cross-app drag acceptance;
that platform check remains separate. Internal connection and to-do pointer drags
are covered by the existing journeys.

## 5. Plugin contract suite

Each plugin must run shared checks for discovery, creation schema, round-trip
persistence, invalid inputs, identity/deduplication, relationship limits, default
rendering, archive/restore and missing-plugin fallback. Connector checks add
timeouts/cancellation, disconnected state, authoritative title, bounded context,
action schema and stale observation handling. Migrating plugins add old-data fixtures.

`npm run test:plugins` runs the shared definition/connector harness and the SQLite
upgrade suite. Coverage inventories require a fixture for every registered type
and backend connector. The production service and hidden Electron compatibility
journey verify upgrade, plugin removal/downgrade/restoration, preserved identity and
unavailable rendering. A SQLite trigger fault verifies actual transactional rollback
with the original graph and a private backup retained.

Installed packages use a local bare git repository built from
`tests/fixtures/plugins/sample` by `tests/fixtures/plugin-repo.ts`; no network or
remote repository is involved. Unit suites cover git source parsing (unsafe
transports, credentials, option-like refs), the integrity file (changed, missing,
unlisted files, symbolic links, unsafe paths), the `plugin_lock` migration,
install/update/rollback/offline cache/remove/reinstall, API range refusal,
isolation of throwing, hanging and tampered packages with placeholder reasons, the
breaker, registration through the same registry as bundled packages, and that no
MCP code path reaches plugin management. `tests/e2e/plugins.spec.ts` drives the app:
consent naming the commit, the item type in the creation picker with its window
view and stylesheet, removal to a placeholder and reinstall, a tampered release
refused, update re-consent, a store file changed on disk refused at reload, and a
development folder approved and reloaded.

Keep an unknown-to-core example plugin in the suite. It must become available in
the inline picker and MCP discovery, persist and render, and execute its declared
action without adding a graph/controller/MCP switch case.

Notes additionally exercise production stdio MCP discovery, creation, editing,
directed context links, exact body context, invalid input/stale revision rejection
and SQLite service restart. Hidden desktop journeys cover All → Note, required
text, stable hover dimensions, literal HTML/Unicode/newlines, full-view editing and reload,
plus preserving an open draft after an agent changes the same note. A full-view
baseline covers the readable text layout. These checks use isolated local data,
with no provider calls or agent launches.

Text-first note coverage adds title omission with a local fallback, tiny shared
footprints, icon/keyboard opening, and a native SDK protocol fixture that generates
a Haiku title without calling a model. Service cases cover bounded/redacted input,
output validation, text/explicit-title/archive races, timeout, persisted shared
allowance, unchanged-content retry suppression, and no repeated writes/starvation
when the generated title already matches. An arriving title must preserve an
open text draft, while a changed body still conflicts. A live note-title model
request is pending human supervision. Hover checks hold inspection throughout
wheel zoom across levels and clear it on real departure, including the window edge.

## 6. Live integrations and model evaluations

**Testing policy:** Live mutating/write integrations require
human supervision of the specific run. Do not post GitHub comments or reviews,
trigger real workflows, send Slack messages, or perform other remote writes during
autonomous implementation/testing. Exercise those paths with local HTTP/process
fixtures instead and leave their live acceptance checks pending. Read-only provider
checks are separate evidence; neither they nor fixture tests establish live write
support. An opt-in flag or a general instruction to continue is not approval
for a supervised write test.

Direct PR reviews have local service and hidden desktop coverage for frozen native
launch plans, model choice, alias/request deduplication, immutable revision identity,
read-only terminal input, preparation failure, interrupted analysis restart and
retained output. The desktop runs scripted agents in real PTYs, not model calls.
Two-PR desktop regressions start concurrent reviews in different projects, switch
views before capture finishes, complete the second first, and verify each request,
prompt, private checkout, project and link. They run separately for Claude and
Codex and check that background completion does not take over the open view.
Service tests reject a mismatched clicked-resource assertion, captured PR/repo/SHA
and source retargeting during an optimistic revision retry, so a review always
starts for the PR that was clicked. These are local guards, not live-provider
evidence.
See [direct review evidence and remaining gates](native-reviews.md).

Workflow reviews have account-scoped transport fixtures, ten durable coordinator
tests and two hidden Electron journeys. They cover intent-before-POST, accepted
POST timeouts, explicit reconciliation, duplicates/aliases, close/restart, source
changes, missing reports, the configurable report marker (default: a Markdown heading or a bold label at a line start) and safe result navigation. The native transport is also
exercised end-to-end against a fake fetch boundary, so DTO mocks cannot hide invalid
allowlisted paths. These tests never post a comment to GitHub. See
[workflow evidence and live gate](workflow-reviews.md).

Live tests are explicitly enabled and use dedicated accounts/repositories and
disposable local/remote workspaces. Ordinary pull-request CI requires no provider
credentials, consumes no model tokens, and posts no real comments. Do not record
real credentials or private production content as fixtures.

Before declaring a provider supported, verify a real launch, native instruction
delivery, one input round trip, status observation, live reconnect, and ended-session
resume. For GitHub, verify metadata, assignment/view state and a complete review
result in a dedicated repository. For a remote machine, disconnect/reconnect SSH and the remote
MCP route while checking that only one process remains. Test installed versions and
record their versions with results.

Agent behavior needs evaluations in addition to adapter tests. Give a real agent a
bounded task with fixture context and check the resulting state: the PR is added
to the right project, linked to its origin, not duplicated, and status reflects the
outcome. Also check that reference-only links remain labeled background rather
than direct context sources or authority to perform work. Assert state
and tool behavior, not exact prose. Report success rates, cost and failures over
repeat runs; do not disguise nondeterministic failures with unlimited retries.

Native artifact capability is a separate check and may be unavailable. Report that
as unsupported rather than passing with a simulated artifact. Any fallback requires
an explicit product-spec update.
`architecture-requests.test.ts` exercises local preparation with real SQLite,
shared-service IPC and an isolated local Git repository. It covers same-request and
concurrent deduplication, account/base/head changes, binding changes mid-capture,
interrupted/reopened capture, queued checkpoint gates, incomplete or mismatched
source and sanitized failures. A PR-text artifact URL must not produce an artifact
identity; preparation creates neither a session nor an output item. Provider
metadata is fixture data. These tests prove request preparation, not publication,
real-model analysis or an authenticated artifact viewer.

## 7. Execution cadence and evidence

| When | Checks |
| --- | --- |
| During a change | Typecheck/build and affected domain/service/plugin tests; relevant UI or process journey |
| Before each coherent commit | Relevant checks, whitespace/diff review; preserve a buildable state |
| On every PR | Typecheck, build, deterministic domain/service/plugin tests, critical renderer and Electron/PTY flows; isolated data directories |
| Scheduled or manually enabled integration run | Credentialed provider smoke tests and bounded agent evaluations; no default production targets |
| Before release | Packaged macOS installation/launch, native module loading, update/migration, terminal/CLI checks, offline/reconnect, manual pointer/trackpad/accessibility pass |

Use macOS runners for the supported desktop/PTY release path. Add other OS matrices
only when those platforms become supported. Keep screenshots, Playwright traces,
normalized service/session logs and test versions on failure; exclude secrets and
real terminal history from routine CI artifacts.

Set an initial measured UI target on a recorded reference machine: with 200 visible
items across 10 projects and 500 links, p95 frame time during pan/zoom should stay
under 33 ms and local committed changes should appear within 250 ms p95. Add a
500-item stress fixture for regression tracking. These are enforced by the dense-map tests below, with fresh numeric reports
recorded on every run.
Manual checks cover trackpad feel, native CLI terminal rendering, keyboard focus,
reduced motion and large output; automated handler tests alone are insufficient.

### Terminal settings and large-session benchmark

Journeys read terminal text from xterm's accessibility tree, which exists only
while screen reader support is on. `playwright.config.ts` therefore defaults
`ACT_TEST_ASSISTIVE_TECH=1` (main reports assistive technology in test runs);
a test sets it to `0` to exercise the off-by-default product setting.
In the same way it defaults `ACT_TEST_NEIGHBORHOOD_STYLE=plain`: test launches draw
plain neighborhoods whatever the setting says, so the baselines of unrelated
journeys do not depend on the ground. The setting is still saved and shown.
`tests/e2e/biomes.spec.ts` launches with the variable empty so the setting decides.
`tests/e2e/terminal-settings.spec.ts` does so: it checks the Settings → General →
Terminals controls, that an open terminal gains and loses its accessibility tree
when the setting or the OS report changes, and that a saved scrollback length
applies to the open view (8,000 printed lines; the first retained row reached with
Shift+Page Up moves when 5,000 shrinks to 2,000 and stays when it grows), all
without remounting. Unit tests cover the schema defaults, page mapping, effective
options and replay tail sizes.

`npm run bench:terminal` (`scripts/terminal-benchmark.mjs`) is comparison-only and
never runs in CI or `test:desktop`: `tests/benchmarks/` has its own Playwright config.
For screen reader on/off × 10,000/5,000 lines of scrollback it streams a synthetic
Claude-like session (`tests/fixtures/claude-like-terminal.mjs`: Ink-style live-region
redraws plus coloured transcript/diff rows, 50,000 lines and about 24 MB by
default) into an open terminal, wheel-scrolls the history (360 real wheel events),
and reloads/reopens the view. It records frame intervals and long tasks for each
phase, stream throughput, xterm write p95, per-wheel-event time, reopen time and
replayed characters, writes `test-results/terminal-benchmark.json` and prints
medians. `BENCH_LINES`, `BENCH_REPEATS` and `ACT_TEST_SHOW_WINDOW=1` (visible window,
so the compositor paints) adjust it. It asserts no budgets; compare runs on the same
machine. [Performance notes](performance.md) record results.

### Terminal performance regression gate

`tests/e2e/terminal-stream.spec.ts` covers a long typewriter-style response through
the actual PTY and xterm. Its local CLI fragments Unicode/ANSI bytes, asks for
cursor-position replies, accepts input while streaming, pauses at the source,
and continues after an interrupt. The test checks all 900 token lines in the full
paged recording, Unicode and sequence integrity, the final visible sentence,
unchanged mount/PID, numeric delivery diagnostics, and existing 200 ms input / 50 ms
frame-p95 / 150 ms frame-p99 / 50 ms write-p95 budgets. Its report contains only
synthetic timings/counters. It runs in desktop CI and `test:performance`; it does
not reproduce or establish the cause of a real Claude API-stream interruption.

`tests/e2e/terminal-renderer.spec.ts` checks real WebGL2 activation and records the
GPU/backend reported by Chromium. Hiding and reopening a view, recording playback
and forced context loss must preserve the terminal and PTY. Isolated canvas
initialization failures (unsupported and thrown errors) must retain a usable DOM
terminal, including font zoom and stopped output. The WebGL case explicitly skips
when a runner lacks WebGL2; fallback cases still run. Text/row assertions use
xterm's existing accessibility tree, shared by both renderers; screenshots verify
actual painted content and fitting, and dedicated fallback checks assert DOM rows.
WebGL has separate terminal screenshot baselines; the original DOM captures remain
for fallback and runners without WebGL. Both initialization-failure cases compare
the original full-view DOM baseline, without changing visual tolerances.
These tests run in `test:desktop` and `test:performance`; performance reports record
which renderer ran. No Chromium GPU blocklist or host settings are overridden.
Input/wheel latency checks observe compositor pixels in fixture cells that change
only on handled input, then verify final text/counters. They do not time the
accessibility tree, which xterm intentionally throttles to one update per second.
Screenshot round-trip overhead is included in the existing 200 ms budget.

`tests/e2e/terminal-scroll.spec.ts` exercises actual Electron wheel input through a
real scripted PTY for SGR mouse, legacy binary mouse and application-cursor modes.
Small fractional movements must accumulate, larger gestures must retain their
distance, and direction changes must respond. Legacy coordinates above byte 127
must arrive unchanged. Explicit browser line/page deltas supplement real pixel
wheel gestures. Twelve wheel-to-visible-output round trips per mode gate p95
latency below 200 ms and frame intervals below 50 ms. These run with both normal
motion and Reduce Motion: immediate batching uses one IPC input per gesture;
normal motion bounds coarse four-line gestures to at most four deliveries while
preserving the exact final distance. Reports contain only fixture timings/counters.
Normal history remains anchored during output, stopped terminals stay scrollable,
recordings fit before replay (retaining the first row), recording gestures do not
reach the live process, and PID/mount/graph/camera stay
unchanged. Pure accumulator and input-schema checks cover idle/reversal reset,
font-size geometry, bounds and byte validation. Physical mouse/trackpad feel and
real-provider acceptance remain manual; these tests use no model or live service.
The DOM fallback is additionally sampled each animation frame to require at least
two intermediate rendered row positions during a coarse 12-line gesture. It tests
fractional reversal and hiding cancellation with the actual PTY. Pure pacing
checks cover 50 ms completion, continuous-input distance, late-frame draining,
reversal/reset, immediate fine input and reduced-motion bypass. This establishes
intermediate native line redraws, not continuous subpixel movement or subjective
smoothness on every physical mouse/trackpad.

`npm run test:performance` builds the app and runs the dense-map journeys below plus the real Electron/PTY/xterm
journeys in `tests/e2e/performance.spec.ts` and `terminal-scroll.spec.ts`. They are also part of `test:desktop`, so
normal PR CI executes it and uploads its numeric `performance.json` on success or
failure. The CLI is a deterministic local fixture, not Claude or a paid model.

The fixture redraws an ANSI screen at 30 Hz, measures 12 keyboard-to-visible-echo
round trips, emits over 4 MiB of output, replays the complete recording, and checks
idle, hidden and stopped views. It also verifies terminal mount continuity and the
actual Settings JSON download. Runtime tests retain byte ordering, full history,
stopped-screen preservation, restart and slow-consumer coverage. Journal tests
prove reads merge unflushed output without writing it and respect byte/page bounds.

| Gate | Required result |
| --- | --- |
| Foreground frame interval | p95 < 50 ms; p99 < 150 ms; at least 30 samples |
| Terminal read / xterm write completion | p95 < 100 ms / < 50 ms |
| Keyboard to visible fixture echo | p95 < 200 ms across 12 real input round trips |
| Output burst / history replay | Over 4 MiB reaches the screen within 10 s each |
| Backpressure | At most one live read in flight; no dropped output or remount |
| Idle view | Zero React commits/output writes; at most 15 polls in 1.2 s |
| Busy output | At most two metadata commits during the measured stream/burst |
| Hidden view / drained stopped session | Zero output reads after settling |
| Diagnostics | At most 512 samples per fixed metric; reset works; invalid values/content rejected |

The budgets intentionally allow runner variation but are assertions, not printed
benchmarks alone. A failure must be investigated with the stored report/trace;
do not automatically retry to green or increase budgets to conceal a regression.
[Performance notes](performance.md) record the local before/after baseline and how
to collect a real-workload report. The map and terminal fixtures exercise separate workloads.

### Dense-map regression gates

`tests/e2e/map-performance.spec.ts` loads 200 or 500 items across ten projects, with
500 or 1,250 explicit links. The mixed static records include agents, PRs, Linear,
Notion, to-dos and an explicitly unavailable optional plugin; no provider or agent
process runs. Every member initially fits in the 1600×1000 hidden window. Real
pointer pans and mouse-wheel zoom cross the semantic detail levels. Twelve shared
commands measure SQLite/IPC-to-visible-title latency. A real drag into an occupied
slot verifies live displacement and exact preview/commit agreement.

| Gate | 200 items | 500 items |
| --- | --- | --- |
| Navigation / drag frame p95 | < 33 ms | < 50 ms |
| Navigation frame p99 | < 150 ms | < 150 ms |
| Committed update to visible DOM p95 | < 250 ms | < 250 ms |
| Drag placement p95 | < 16 ms | < 16 ms |
| Card renders while panning | 0 | 0 |
| Camera-driven geometry / placement / saved-position changes | 0 | 0 |

At least 100 navigation frames are required. Numeric `map-performance.json`
attachments include machine/window mode and each phase, even on failure. The
200-item neighborhood also has a reviewed screenshot. Failed dense-map runs
also attach up to 64 KiB of each isolated fixture service log for startup diagnosis. The same tests run in normal
desktop CI and `test:performance`; `ACT_PROFILE_MAP=1` additionally captures a
renderer CPU profile for diagnosis. Profiles affect timings, so they are not used
for before/after claims. These tests measure renderer responsiveness, not OS paint
latency, provider throughput, arbitrary link graphs or every project arrangement.

## 8. Done means verified

A feature is complete when its acceptance journey passes through the production
path, relevant failure cases are covered, docs reflect the result and a coherent
commit exists. A mocked provider proves our adapter contract, not that the real
provider works. A design preview proves neither persistence nor process lifetime.
Record any unsupported capability alongside the delivered milestone.


Settings checks cover a v5 database migration with an existing graph and recovery
checkpoint, independent settings revisions, persistence and MCP read/write conflicts.
The desktop journey verifies default-on Remote Control, literal argument entry,
host-managed flag rejection, actual display assertion enable/disable and reopening.
The native fixture confirms configured arguments reach the real CLI process boundary.
Auto-mode checks cover default-on values in new/old settings, persisted off values,
MCP read/write, explicit split/inline overrides, one emitted flag, capability
failure and frozen retries. The hidden settings journey verifies toggle state,
override replacement and reload; the native-agent journey observes `auto` at launch
and `default` on resume after changing preferences. Restricted review fixtures still
require `dontAsk` and their tool allowlist. CLI `--help` is a read-only capability
check, not evidence of classifier behavior; no real-model permission action is run.
The real PTY regression invokes a Node hook with a minimal Dock-style PATH and a
controlled login shell. These tests make no paid model requests. OS-managed lock and
manual screensaver behavior are not changed by the display assertion.

Attention tests cover shared project/global deduplication, multiple reasons, archived
parents and done items. Hidden desktop journeys verify saved summaries and live
updates, pointer/keyboard highlighting on map and minimap (including aliases),
clearing on leave/close/removal, and map-only navigation without opening or
acknowledging. Hover does not move the camera or graph. Opening/marking seen does
acknowledge, while preserving underlying activity/input; later events resurface.
Archive/restore and reload are covered. Reviewed `needs-me.png` and
`needs-me-highlight.png` complement the existing map/terminal images. Summaries
are local fixtures; these checks do not call a paid model or mutate providers.

## Activity summary regression gate

Summary tests use deterministic clients and clocks with real SQLite to cover
debounce, stale response cancellation, manual-label preservation, fallback,
restart-safe attempt limits and v6 migration. A dedicated background Electron
journey sends real shell output through the native SDK protocol fixture and back
to the map, then restarts the service and verifies unchanged usage allowance.
No paid calls occur in ordinary CI. `ACT_LIVE_SUMMARIES=1 node
scripts/smoke-summaries.mjs` separately evaluates four synthetic cases through
the installed Claude CLI; record and review their labels, not just process exit.
See [native summary evidence](activity-summaries.md).

### Live PR content

PR context-menu coverage checks submenu pointer/keyboard navigation, Escape/back,
edge placement, and no commands on inspection. Native fixture journeys start both
Claude and Codex through the menu, keep another PR in view, complete comparisons
out of order, and verify default models and source/project/result bindings.
Workflow menu tests use an injected HTTP fixture to check a single `/review`,
linked results/restart and unsupported-capability errors. Unit cases cover lost
replies without resend, polling cancellation, preparation failure and mismatched
source rejection. These are local contract tests, not live GitHub writes or paid
model-review acceptance.

GitHub contract tests use local HTTP fixtures and injected credentials. Service
checks cover URL resolution, existing MCP items, cross-project aliases, safe retry
after an interrupted graph commit, cache persistence, rate-limit backoff, shutdown
cancellation, changed comparison commits, incomplete files and lifecycle isolation.
The hidden Electron PR journey uses a fixture connector through the real service,
IPC, SQLite and plugin view; it exercises URL-only creation, plain-text rendering
of hostile markup, direct Open pull request navigation through a stubbed native
browser opener, absence of content tabs, distinct PR state, restart, and stale
content after authentication failure. Opening the source performs no extra provider
read and leaves the map focus intact. Its reviewed screenshot joins the visual regression suite. A separate
opt-in native GitHub gate verifies real read-only account/API/service behavior;
ordinary tests neither read real credentials nor call GitHub.

Assignment tests exercise full discovery before mutation, direct verification of
missing PRs, account isolation, unambiguous/ambiguous project mappings, restartable
rate backoff, stale viewed receipts, alias attention, archive/delete and shutdown/
disconnect races. The desktop journey checks automatic appearance and successful
visible acknowledgement through the real service, bridge and plugin view, plus
Settings/MCP refresh. The real
viewed-cycle gate is still open and is not substituted by the fixture evidence.

Summary redaction also covers literal escaped newline/carriage-return/tab separators
in echoed shell commands and JSON, before truncation. The native summary fixture
rejects a surviving fake credential and retains bounded assertion diagnostics on
failure; it never calls a model or records prompts/terminal evidence in those logs.

### Items from plugin packs

Item types that ship in separately installed packs are tested in their own
repositories against a linked app checkout. The app keeps the generic journey:
an item whose type is not bundled stays a placeholder with its data and returns
unchanged when a package that owns its id (directly or through `legacyIds`) is
installed (`tests/e2e/plugins.spec.ts`).

### Notion provider read checks

Local API fixtures exercise complete title and block pagination, nesting,
unsupported blocks, identity/revision checks, error normalization and hard limits.
Named-profile tests verify account switching and token rotation without leaking
credentials. Service coverage keeps legacy aliases and relationships while binding
one canonical provider resource, and verifies context, cache and failure states
across restart. A hidden desktop URL-attachment journey checks the provider title,
indented content, inert HTML, refresh, stale content and restart; its visual baseline
is reviewed. Real page access is an additional read-only acceptance, still pending.

### Web link upgrade and Notion title/comment cue

Spec RES-10 and RES-03. `packages/core/convert.test.ts` covers `item.convert` and
`registry.conversions`: kept node/resource ids, position, size, project, links and
to-do attachments, the kept-title marker, the duplicate guard and refusal of any
source or target outside URL matching. `packages/workspace-service/link-upgrade.test.ts`
drives the coordinator with the Notion fixture transport: automatic upgrade with the
page title, no Needs me and no unread burst, idempotence (no request, no revision),
no upgrade and no request without an enabled account, the duplicate guard before any
read, a failed read leaving the link, archived links waiting, default-title
detection, a kept custom title surviving a page rename, title sync on rename and
“Untitled”, then a new comment raising the cue and Needs me and opening the page
clearing the count; one test starts the real service twice and uses `resource.convert`.
`src/resource-plugins/comment-indicator.test.ts` pins the shared comment cue for pull
requests and Notion pages and its use as dashboard status. `context-menu.test.ts`
covers the Convert entry. Two hidden desktop journeys in `tests/e2e/notion.spec.ts`
start with a saved web link to an `app.notion.com` page: one upgrades at start, keeps
its connection, shows the comment cue and Needs me “New comment”; the other blocks the
start-time read and converts through the item menu. None of this calls Notion; the
first start against a real Notion workspace is a separate pending check.

## Offline backup/recovery regression coverage

`packages/workspace-backup/backup.test.ts` uses disposable graph/runtime databases
and real WAL transactions. Round trips retain graph IDs/layout, camera/settings,
command receipts, unknown-outcome jobs, checkpoint identities, launch files,
recordings and deletion tombstones. An old graph/runtime pair migrates in the
recovery copy while the original and backup stay at their prior versions.
A recovered graph serves authenticated IPC clients with a new token and no runtime.

The suite verifies live-owner/process refusal, both write locks, lock release after
failure, unsupported/corrupt stores, traversal/duplicates, symlink parents and
external links, hard links, changed executable modes, missing/extra files, and
checksum rejection. It kills a real child after data copy but before manifest
publication, proves the partial bundle cannot be restored, then takes a new valid
backup. The root CLI is exercised end to end. All inputs are local sanitized
fixtures; no real workspace is replaced, no native conversation is copied/deleted,
and no model or provider action runs. Clean-machine/manual activation and hardware
power-loss acceptance remain manual checks, not covered by these checks.

### PR content and terminal return regressions

The PR fixture verifies safe Markdown descriptions/comments, all three comment
sources, collapsed controls, unchanged-refresh DOM preservation, cached restart,
stale reads and actual source-opening URLs. Review/workflow fixtures exercise the
collapsed launch controls and retain cross-PR source-binding checks; all writes
are isolated fixture calls. Conversation count/byte bounds have pure tests.

A populated real-PTY terminal closes under normal motion while frame timings
cover the entire return animation, including the switch between terminal/map
observers. Run with both WebGL and forced DOM fallback; the build-time xterm guard
must reject an unreviewed dependency update. Reopen must preserve mount and process identity. The working-rim
journey checks the returning surface before any hover. Existing pixel-based wheel
latency, multi-line/fractional movement, playback, WebGL loss/fallback and stream
budgets remain required. Physical trackpad feel and real Claude acceptance remain
manual; fixture timings do not establish live-provider correctness.


Task/selection coverage uses isolated SQLite and hidden Electron.
Core checks cover Linear identity, local completion, provider title updates,
archive/restore and ordered persistence, cross-group/duplicate rejection, common
menu actions and project/member movement. Pointer journeys use real Shift clicks,
a drag rectangle, grouped dragging and to-do row/project grips; keyboard reorder
and reload verify durable ordering. Existing editing, map attachment, lifecycle
and connection-menu checks remain enabled with strict visual thresholds.

Archive tests exercise map, project and Sessions controls with real local PTYs
carrying Claude metadata, plus the new runtime stop-on-archive policy. They assert
process exit, readable recordings and no automatic launch on restore/replay.
Service fixtures test restart reconciliation and cancellation of archived pending
launches. These are local protocol/process tests, not a paid Claude session or a
live Linear/GitHub/Slack write.

### Triage and Send to project coverage

Unit: `provider-runtime/linear.test.ts` (assigned query text with the positive
state and priority filter, the variables for each selection, refused state types,
priorities and cursors, paging, 100 cap, duplicate/finished/unknown states dropped
with and without the server filter, other account, malformed pages, repeated
cursor), `resource-plugins/define.test.ts` (multiselect settings fields),
`workspace-service/triage.test.ts` (settings fields, defaults and strict parsing;
a duplicate's to-do removed and re-imported when reopened; an unticked status
removes untouched to-dos at once, keeps touched and dismissed ones and re-imports
on re-tick, also across restart; minimum priority; empty selection; a changed
selection on a capped list removes nothing; a change during a read restarts it;
invalid selections refused by `settings.write`; one to-do per ticket across syncs and
restart on real SQLite, existing item/to-do dedupe incl. after deletion, dismissal
memory, cleanup of untouched to-dos only, truncated lists, retitle, setting off,
disabled connection, provider cooldown, read on start, service wiring and manual
refresh), `core/todo-send.test.ts` (import kept through edits, `todo.place` and
`todo.send` from Triage and for map to-dos, block placement without overlap or
moving others, refusals, `sendTargets`), `graph/todos.test.ts` (Triage group),
`core/context-menu.test.ts` (menu action) and `mcp/todo-send.test.ts` (agent reads
Triage and sends through production MCP). To-do context (TODO-11):
`core/todo-context.test.ts` (create, replace, append, limit, sanitising, writer
stamp, survival through rename, completion, reorder, archive, send and removal of
the writing agent, the map to-do variant, replay by commandId),
`core/revision-policy.test.ts`, `workspace-service/sqlite-store.test.ts` (schema
23: older bodies read as no context, context survives reopening, newer schema
refused), `mcp/todo-context.test.ts` (an agent writes without a revision, reads it
back and receives it in `agent.context`), `agents/tool-context.test.ts` (guide
line, budget, version) and `tests/e2e/todo-context.spec.ts` (glyph, open, edit
with the list kept open, Escape, save, reload, row menu, clear with its confirm,
map to-do). For Triage, no SQL migration was added, so there is
none to test: the import is part of the to-do body and its record a provider
observation; the restart cases cover both.

Desktop: `triage.spec.ts` starts the service with the Linear fixture and three
assigned tickets: Triage leads the list with its counts (`todo-triage.png`), nothing
reaches the map or Needs me, the checkbox completes, a restart keeps three rows, the
row menu sends one to a project (to-do card plus loaded ticket card, linked), a
refresh does not import it again, the card menu sends it on with the current
project checked, and a grip drag onto a project group sends another. A second
journey turns the setting off (no read, no to-do), checks the not-connected row and
turns it back on. A third journey has a ticket in Linear's duplicate state: it is
not in Triage; the settings offer exactly four status checkboxes
(`settings-linear-triage.png`), unavailable while the switch is off, with a hint
when none is checked; unticking Backlog and saving removes the untouched backlog
row and keeps the checked one; re-ticking brings it back; the reopened duplicate
arrives on the next refresh. All Linear traffic is the in-process fixture transport
(it applies the query's filter like the server); no credential is read. A live read
against a real workspace is a separate pending check.

### To-do horizons coverage (TODO-12)

The Triage journeys above were rewritten for the From Linear inbox: tickets wait
folded to a count, with Linear's own title, identifier and state chips and no
checkbox (`todo-triage.png` re-recorded); Take into Next makes one a to-do that
ticks like any other; the row menu still sends one to a project; dragging one onto
Later takes it there (the drag onto a project group is gone). The settings labels
now name the inbox (`settings-linear-triage.png` re-recorded).

Unit: `graph/todos.test.ts` (`todoList` groups and order, Done newest first,
saved rows read as Next, an item kept in the list ticks without its provider,
`archiveDue`, `untouchedDays`, `oldestTodo`), `core/todo-horizons.test.ts`
(`todo.move` between groups at a position without changing the project, done and
reopen in place, list-only ticks of kept items, touches by people only, agents
filing into Later with `todo.save`, inbox take / Not for me / undo, group-scoped
reorder, a placed import keeping its horizon and `todoTicketId`),
`workspace-service/triage.test.ts` (imports wait in the inbox untouched; Not for
me holds until the title, state or assignment changes and through a settings
change; a taken ticket keeps its renamed title while its state refreshes),
`workspace-service/todo-sweeper.test.ts` (setting choices, archive after the days
counted on an injected clock, kept items only leave the list, never),
`workspace-service/linear.test.ts` (a placed import's to-do follows its ticket to
Done and back; a list tick writes nothing to Linear), `workspace-service/item-titles.test.ts`
(no list label is generated; stored labels stay unused),
`workspace-service/sqlite-store.test.ts` (v25 upgrade from a seeded version 24
workspace) and `mcp/todo-send.test.ts` (an agent files into Later, moves and ticks
through production MCP and reads the horizon).

Desktop: `todo-horizons.spec.ts` seeds the design's sample and checks the sheet
(`todo-sheet.png`), the inbox open (`todo-sheet-inbox.png`), taking by button and
by drag, Not for me with Undo, ticking with Undo, Space, Done shown
(`todo-sheet-done.png`) and folded, N/L/Alt+↑↓ on a focused row while the new-to-do
field and the title editor keep their keys, drag between groups with the preview
and cancel, the soft limit (`todo-sheet-soft-limit.png`), Group by project
(`todo-sheet-by-project.png`, remembered across reload) and Later ages on a page
clock 34 days ahead with its group menu archiving them.
`todo-horizons-service.spec.ts` runs the service in process: Done goes to Archive
after the Settings choice on an injected service clock, a Linear ticket kept in
the list shows `BIL-128` and its state, ticks without a Linear write and ticks
itself when the fixture says Done, and a version 24 workspace opens migrated.
`todos.spec.ts`, `task-selection.spec.ts` and `todo-context.spec.ts` changed where
a ticked row now folds into Done, the project is a chip instead of a group, an
edit adds a touch time, and project heading grips are gone.

### Move to project coverage

Unit: `core/nodes-send.test.ts` (`nodes.send`: one item beside the target's items
with links kept and linked items left behind, empty-project anchor and floating
item, a selection as one block keeping its layout across projects in one revision,
items already in the target left alone, a to-do and an item kept in the to-do list
bringing attachments with the same result as `todo.send`, refusals for archived,
Undermap and non-project targets, projects, off-map items and duplicates with the
state unchanged, a muted target, an agent actor, and `moveTargets` order/current),
`core/context-menu.test.ts` (Move to project model, selection entry, list row still
Send to project) and `mcp/nodes-send.test.ts` (an agent moves a selection through
production MCP and sees the description).

Desktop: `move-to-project.spec.ts` on the shared visual fixture. A PR card's menu
lists the three map projects with its own checked and disabled
(`move-to-project-menu.png`); choosing another moves only that card in one revision,
centres the map on it within 4 px at zoom 1, leaves it selected and opens no view;
an empty project takes it on its anchor and the result survives reload. A floating
note has nothing checked; a to-do card has one Move to project entry and brings its
linked PR, keeping their offset. Two shift-selected cards move as one block from
the right-clicked one and stay selected. A muted target parts its cover and stays
muted. `triage.spec.ts` covers the renamed card entry. Tests run with reduced
motion, so the 250 ms flight itself is not measured. No provider is contacted.

### Copy URL and arranging item menus (MAP-27, SETTINGS-11)

Unit: `core/context-menu.test.ts` covers Copy URL's place after Open on …, on the
map and in Undermap, its absence without a web page and on projects, and Copy URLs
for a selection. For the saved menu (MAP-27) it covers: the default layout holding
a separator at each default group boundary and every state of the default menu
drawing unchanged, also from the type's whole default layout; a saved layout drawn
with only its own separators; folding of leading, trailing and doubled separators,
including around entries the item lacks or that are hidden; an unnamed entry
following its default predecessor without a separator; unknown and repeated ids;
slots shared by state variants; conversion of an earlier id-only order to the
separators it used to draw (`menuLayout`, and the same menu from the converted
layout); `moveMenuRow`, `addMenuSeparator`, `removeMenuSeparator`; hiding a slot
with both variants and with its submenu, the last-visible guard
(`canHideMenuEntry`, `setMenuEntryHidden`), a menu never left empty; that projects,
boards, connections, selections and Undermap ignore a saved menu; `saveItemMenu`
and `resetItemMenu` (default saved as nothing, earlier order dropped on save).
`core/settings.test.ts` covers the `menus.order`, `menus.layout` and `menus.hidden`
schemas, their defaults and settings saved before each existed.
`desktop/browser-url.test.ts` covers what may reach the clipboard.

Desktop, on the shared visual fixture: `copy-url.spec.ts` copies a pull request's
and a bookmark's URL by click and by Enter and reads them back from Electron's
clipboard, checks that the workspace state is unchanged, no view opened and
`shell.openExternal` was never called, that a note and an agent have no entry, that
two selected items copy both URLs and that the bridge refuses non-http(s) input.
The test puts the previous clipboard text back. `menu-order.spec.ts` reads each
menu top to bottom with its separators. It moves Copy URL above Open for GitHub
pull request by keyboard across two separator rows (focus stays on the grip; no
↑/↓ buttons exist), checks a Notion page's menu is unchanged, Reopen takes Mark
done's place and Reset saves nothing; drags an entry by its grip and back; drags a
row to the page's edge until the list has scrolled to its end and back; drags a
separator between two entries, removes one with × and adds one after the focused
row and at the end; hides Send to Undermap and Trigger review for pull requests
only, shows one again, checks the last-entry hint on Note and Reset this menu
(`settings-menu-order.png`); writes hidden entries and checks that a selection
menu and the item's Undermap menu still offer them; and writes an order in the
earlier shape, checks the same menu and the converted rows, and that changing it
saves a layout and drops the order. `example-plugin.spec.ts` finds the
plugin-loaded Reading link type in the Item type list with its own Read state
entry. Both specs are part of `npm run test:visual`.

### Linear workflow status regression coverage

Fixed GraphQL transport fixtures cover team-specific custom states, permission and
identity guards, stale menu preflight, incomplete/paginated workflow rejection,
ambiguous mutation responses and sanitized failures. Isolated SQLite/service
checks verify all aliases and saved snapshots, task/layout preservation, durable
request replay, no automatic uncertain replay after restart, and background
poll/read/write ordering with duplicate submissions. No live transport is used.

Hidden Electron journeys exercise colored map status without increasing the
compact footprint, right-click and detail menus, current-state semantics, keyboard
navigation/dismissal, explicit selection, stale/permission failures and reload.
Existing URL creation/Markdown journeys and strict screenshots remain enabled.
Shared PR menus and other provider views are regression-tested because the menu
and read-view hosts are shared. Live Linear reads and supervised status mutations
are separate acceptance gates, never implied by fixture success.


### Native Terminal startup and history

Startup replay has been removed. Hidden Electron coverage verifies no checkbox,
Up-arrow command recall and no replay after app restart with a legacy opt-in.
The real zsh supervisor fixture verifies startup functions, original ZDOTDIR,
Up-arrow recall, persisted history and ignored legacy launch replay fields.
Lifecycle tests retire old pending/failed terminal checkpoints across startup
phases while agent recovery stays covered. Coordinator tests retire queued and
uncertain legacy replay jobs and preserve manual New shell deduplication. These
use isolated shell configuration, not a real shell prompt theme or its files.

Terminal playback controls are removed, while stopped output, normal scrollback,
recording deletion and native resume remain covered. The 4 MiB performance journey
now measures ordinary saved-output restoration after renderer reload, with the
same latency budget; scrolling, hidden/idle reads, input latency and renderer
fallback budgets are unchanged. Manual real-Claude feel and other existing
live-provider acceptance gates remain separate.

### Review desk regression coverage

`related-items.test.ts` covers direct relationships, reverse links, aliases,
deduplication, archive exclusion and link removal. `desk.test.ts` covers immutable
PR ownership, actual summaries/states and current/changed/unverified revisions.
Discussion tests include bodyless approvals and retained review identities. Plugin
discovery tests protect frame metadata and independent map titles. Hidden PR
journeys verify desktop/narrow screenshots, Markdown safety, collapsed controls,
source links, live summary/link updates, empty-column removal and connected-item
navigation. Existing native-review and workflow fixtures protect model choices,
source binding while switching PRs, failures and restart. These are local fixtures,
not live provider acceptance; no GitHub writes or paid agent calls are authorized.

### Diagnostic session management

Session-management desktop journeys navigate Settings → Data & diagnostics →
Sessions and assert no Sessions action remains in the map top bar. Preserve
archive/restore/delete, orphan Stop, pending launch cancellation and MCP parity;
session actions must not submit or close Settings.


### PR comment actions

Local fixtures cover comment ownership, inline root replies, canonical discussion
links, uncertain writes, request replay, persisted versioned Seen receipts and
connected-agent validation/delivery. Hidden PR journeys verify sanitized HTML
including details/summary, copy via the Electron clipboard, collapsed/reordered
Seen comments across renderer restart, edited comments resurfacing, saved reply
drafts, fixture posting and removal of the context sidebar. Existing PR/review
screenshots and immutable review-source tests remain regression gates. These are
local fixtures: no real GitHub replies or paid agent turns are test coverage.


Linear card regressions measure non-overlapping title/status bounds at both the
64-pixel default and saved 48-pixel height. Core compatibility coverage protects
old dimensions/settings; hidden Linear and item-resize journeys protect geometry,
status menus and screenshots. Provider changes use fixtures only.


Task-label fixtures assert fast-model parameters, unchanged provider/map titles,
persisted list labels, source-change invalidation, late-result rejection and
one-attempt fallback on helper failure. No paid model calls run in the suite.
Overlay desktop checks cover pointer/keyboard resizing, Escape cancellation,
restart persistence, reset, icon collapse/reopen, existing movement/scroll/drafts
and generated label projection.

Ordinary `ACT_TEST_DATA_DIR` runs explicitly reject native summary/title calls
unless the test configures `ACT_SUMMARY_FIXTURE_LOG` and its isolated CLI fixture.
A regression protects this guard; the explicit summary-fixture journey verifies
that legitimate local helper tests still work.

To-do drag regressions check visible order before drop, unchanged workspace
revision during preview, repeated hover stability, cancellation, cross-project
rejection and restart persistence. Project headers receive the same preview and
cancellation checks; existing native drag and keyboard journeys remain gates.

Linear cache fixtures count workflow versus issue requests across distinct clients
and tickets, check account/team isolation, unknown-state refresh, caller mutation
isolation, failure retry, cancellation and fresh pre-write validation. All status
writes are local transport fixtures; no live Linear changes are tested.

To-do map-drop tests verify atomic checklist conversion, retained completion/order/
links, rollback, duplicate rejection and existing-node moves. Hidden desktop tests
use native row-grip drags to create, move again without duplication, and reload.
Existing reorder, map-to-list attachment and inline editing journeys remain gates.

PR visibility tests cover provider bot identity, legacy bot names, empty review
activity versus substantive feedback, retained thread-parent identity, independent
category switches and additive settings defaults. Hidden UI coverage changes bot/
activity preferences through Settings, reopens/reloads the PR, and verifies that
no provider writes occur. Existing all-events screenshots opt in explicitly;
filtering does not change map approval/attention behavior.

The native close/reopen journey runs with the close warning enabled and disabled.
Both exercise Cancel first; the disabled path then saves the preference through
Settings and cancels any unexpected warning. Both must stop processes and restore
agent sessions, preserve layout and retain the preference after restart.

New item shortcut journeys navigate to the Items parent page and verify reorder,
save/restart and All discovery. Map settings must hide those controls; the shared
control-state capture stays scoped to Map and checks disabled shortcut buttons
separately on Items.

Settings visual journeys open the page's Advanced settings disclosure
(`tests/e2e/settings-helpers.ts`) before editing size/neighborhood values. A default-mode regression checks hidden visuals, visible
functional controls and item guidance, invalid-draft reveal/focus, draft retention
and disclosure reset on reopen without losing saved dimensions.

Approved PR conversation layout tests cover Unicode preview boundaries, real parent
identity, missing/filtered parents, source locations, reply order, keyboard expansion,
unchanged refresh, Seen grouping and new-reply resurfacing. Hidden desktop captures
cover full and narrow frames and stepped thread cards. Existing fixture-only reply,
copy, review-launch and settings cases remain gates; these do not establish live
GitHub writes or agent delivery acceptance.

Unseen PR badge regressions cover zero removal, seen/unseen, edited versions, bot
filtering, aliases, no-fetch/no-op reconciliation and legacy map indicator repair.
Hidden desktop coverage checks immediate updates, app restart, unchanged approval
state and edited-comment resurfacing using local GitHub fixtures only.

The bot-only PR case changes the actual Settings → Items → GitHub pull request
controls: default hidden automation yields no pill, enabling bots yields one unseen
comment, and excluding discussion comments hides it again. The provider request
count must stay unchanged through both settings saves.

Advanced visibility explicitly checks the Map bubble fieldset, all three size
presets, draft retention and hidden-invalid-field reveal. This catches author CSS
`display:flex` overriding the native fieldset `hidden` attribute.

### Saved-first PR restart regression

An isolated hidden Electron fixture persists PR content/Seen receipts, restarts
the service and app with an expired cache, and holds all provider replies behind
a gate. Assert saved description, comments and Seen state before releasing that
gate; then assert fresh content replaces it. Reopen with disabled credentials and
verify saved content/state remain readable. Coordinator tests also cover expiry,
restart, provider-call independence and fingerprint rejection after a PR change.
These are local fixtures, with no live provider reads or writes.

Expanded-menu-bar drag coverage uses a real terminal: drag from state, directory
and toolbar whitespace, verify unchanged map positions/mount/PID, and verify
button gestures do not drag while Stop and Close still work.


### Native notification coverage (STATE-04)

`apps/desktop/notifications.test.ts` checks old-settings defaults, validation,
background/always/off and category switches, alias deduplication, baseline/reconnect
suppression, read/archive removal and announcement/test behavior.
`tests/e2e/mac-notifications.spec.ts` uses real main/preload/service/renderer with
only native notification show/close stubbed: settings persistence, failure feedback,
click-to-open/read receipt, banner dismissal, foreground return and no real window
activation. `notifications.spec.ts` retains recovery expiry/error/retry coverage.

Seen on open: `packages/core/settings.test.ts` covers the
`notifications.seenOnOpen` default, parsing, kept unknown type ids and the
`seenOnOpen()` decision (type, user/program origin, focus, visibility).
`attention.spec.ts` drives it in hidden Electron: a checked type clears on a Needs me
row, Enter and its web page while another type, hover and Show on map do not;
attention arriving while open stays unread; a blurred window does not acknowledge,
and a focus that follows an open acknowledges only if nothing newer arrived.
`mac-notifications.spec.ts` covers the notification click and the settings group
(sorted type list, All / None, save, kept unknown ids). Window focus and blur are
emitted on the hidden test window; real Dock hiding and banner clicks remain manual.
Ordinary tests cannot send OS notifications (`ACT_TEST_DATA_DIR` guard).

Manual acceptance on the packaged app: allow notifications in macOS; use Settings
→ Display → Send test notification, then generate a local completion while another
app is focused. Confirm ACT name/icon, one banner, sound setting, click-to-item,
Needs me acknowledgement and denied-permission/Focus behavior. Reopen ACT and
confirm old unread events do not generate a launch storm. No GitHub/Slack write or
paid model call is needed. Do not label stubbed delivery as this platform acceptance.

`npm run test:package` additionally verifies the complete macOS code signature.
Local packages are ad-hoc signed; this check establishes bundle integrity and
native runtime compatibility, not OS banner delivery or Developer ID notarization.

### Claude artifacts and Explain architecture

Unit: `src/resource-plugins/claude-artifact.test.ts` (claude.ai URL validator incl.
lookalike hosts/http/ports/asset paths, From URL ranking, schema-2 data rules, v1
upgrade, identity across spellings, no page fetch), `agent-hook-event.test.ts`
(Artifact PostToolUse parsing across several response shapes, non-publish actions,
ambiguous URLs, local `<title>` read), `agent-artifacts.test.ts` (card placement,
agent/PR links, reuse, renames kept, stale sessions), `architecture-requests.test.ts`
(launch, comparison-key dedupe, archived runs, plain failures, no restart on reopen,
humanOnly MCP launch), `claude.test.ts` (hosted prompt/provenance plan) and
`context-actions.test.ts` (shared menu/view action, lost-reply reconciliation).

Desktop: `claude-artifacts.spec.ts` pastes an artifact link, dedupes a second spelling
and opens it through the stubbed `openExternal`. `architecture-artifacts.spec.ts` runs
Explain architecture with the scripted native agent as `claude`: the agent is placed and
linked from the PR, emits a synthetic Artifact hook (no upload), the card appears linked
to agent and PR with the page title, a repeat request from the PR view's Review panel focuses the same session, a
republish keeps one card, and Open on claude.ai / Open in browser reach the stub.
These do not show that the real CLI sends this hook shape or that publishing works on
the account; that is the supervised first run in [native artifacts](native-artifacts.md).

### Answered permission prompts and readiness (AGENT-07c)

Unit: `agent-hook-event.test.ts` (a subagent's PostToolUse becomes a content-free
`SubagentToolUse`; its other events, nested launches and artifact publishes stay
dropped; the main thread's PostToolUse is unchanged), `agents.test.ts` (the observed
timeline Stop → SubagentStop → permission prompt, cleared by a later
`SubagentToolUse` or `SubagentStop` and not by an older one; untouched while the
main turn is active, for questions and idle prompts, and while another known
subagent could be asking; outstanding background work restores “Waiting on …”;
quiet settling repairs the item only with the person's key after the prompt, output
after the key and 20 quiet seconds), `agent-readiness.test.ts` (no key, a key before
or at the prompt, no output since the key, or a question never become ready),
`decisive-input.test.ts` (Enter, lone Escape and single digits; not typing, arrows,
Alt+Enter, bracketed pastes, cursor/colour/focus/mouse reports),
`rollout-validation.test.ts` (the stuck agent becomes selectable and is sent the
prompt; description and refusal texts) and `review-findings.test.ts` (a recipient
held at a prompt is marked).

Runtime: `tests/runtime/supervisor.test.mjs` drives a real PTY and shows that only
input marked `source: 'user'` with a deciding key sets `decisiveInputAt` and
`decisiveInputSequence`, that unmarked input (the service's pastes), binary input
and an unknown source do not, and that attach and read both report it.

Desktop: `agent-permission-prompt.spec.ts` runs the scripted native agent as
`claude`. The fixture raises `permission_prompt` after its turn ended and sends no
main-thread hook afterwards. A subagent tool hook clears it within seconds; in a
second round an arrow key changes nothing and a digit typed through the renderer
bridge clears it once the terminal has been quiet (about 20–30 s).

The fixture stands in for Claude Code. It does not show that the real CLI sends
`permission_prompt` without `agent_id` for a slash command's dialog, that such a
command's tools arrive as subagent `PostToolUse`, or which keys its dialogs accept;
that needs a separate supervised check.

### State language coverage (STATE-02, STATE-04, VIS-03)

`src/graph/attention.test.ts` pins the reason-to-tier table, the highest tier per item,
the order (tier, then the longest wait), the counted number without Finished and with
`countFinished`, the count wording and the rail button's name and title.
`project-dashboard.test.ts` and `atlas.test.ts` cover tier counts on boards, plots and
merged Atlas badges; `apps/desktop/notifications.test.ts` covers banner titles by tier
and Finished staying quiet until counted; `reference.test.ts` covers the ticket split.
`tests/e2e/state-language.spec.ts` drives the hidden app on `tests/fixtures/state-language.ts`
(the photo library project from `tests/fixtures/photo-library-project.ts` with one item per tier and Working combination, and a second
project): frame colour and width by computed style, shapes and accessible names, the
reason line, hover leaving the edge width alone, the grass and sheep (three stepped
animations, an 8 px band inside the bottom edge in the card's tone and never amber, paused
behind an open item, no animation with reduced motion), Finished left out of the rail, Dock and plate numbers while Seen clears
it, sheet groups and order, “Also count finished work”, the far-zoom corner and takeover
forms around 16 px, tier shapes on dashboards and the Atlas, and the ticket reference tag.
Set `ACT_STATE_CAPTURES=<dir>` to keep review PNGs of each surface. `attention.spec.ts`
keeps the size-and-zoom and stepping journeys for the working mark.
`map-performance.spec.ts` is the gate for its cost: it caught a 2× slower 500-item pan from
filter keylines and extra edge masks before delivery. The Dock badge is read from the
app in the hidden run; real macOS banners still need manual acceptance.

### Standup report coverage (STANDUP-01)

Disabled for now (`STANDUP_ENABLED`): the desktop journey skips, the service test for
`standup.open` skips, and a unit test proves a disabled service refuses to open and digests
nothing; rail, shortcut and settings tests follow the flag.

Unit: `packages/core/standup.test.ts` (1 day, 7 days and Last week including a Monday,
a Sunday and both DST changes in America/New_York, 8 March and 1 November 2026; dropped stories with unknown evidence;
outlook ordering; exact Slack and Markdown strings), `session-runtime/transcripts.test.ts`
(day slicing by local time zone, checked in Pacific/Auckland; what is left out, redaction, cap, file lookup),
`sqlite-store.test.ts` (v23→v24 upgrade, digest rows, pruning, shared allowance),
`todos.test.ts` (`doneAt`), `provider-runtime/github-activity.test.ts` (read-only paths)
and `workspace-service/standup.test.ts` (fingerprint caching, rewrite, AI off, request
limit, background headroom, PR digests through a GET-only fake, IPC). All use fake
clients; no model or provider is called.

Desktop: `tests/e2e/standup.spec.ts` seeds a Claude transcript in a temporary
`CLAUDE_CONFIG_DIR` and answers with `tests/fixtures/native-summary.mjs`: rail Actions →
Standup report…, range switch without re-digesting, untick → copied Slack text leaves
the story out, This week hidden and then shown for an open to-do, Brief, rewrite, and AI
off → facts with the reason and no request. The clipboard is stubbed. Baselines:
`standup-actions-menu.png`, `standup-report.png`, `standup-facts.png` (dates and chips
masked; the service uses the real clock).

Pending: no real Haiku or Sonnet call and no real GitHub read have been made; digest
and report quality, the CLI's real cost per call and real transcript shapes beyond the
fixture are unverified.

### Rollout view frame and jobs rail

Desktop: `tests/e2e/rollout-view-space.spec.ts` runs the rollout harness with the long
report fixture (`tests/fixtures/rollout-report.ts`, a sample thumbnail-service report) at 900×660: the panel is flush with
the frame, no frame or panel surface or line is green (computed styles), the hint footer
is gone, and the report column is wider and taller than before (590×417 → 646×497 open,
858 wide folded). It folds and unfolds the rail, checks the strip's glyph names, divider,
hover label and filter click, `[` with focus in the view, persistence in the workspace
view across a reload (the item's data and its validation stay current), the auto-fold
below 700 px without saving, and that approval stays reachable from Go to approval and
Actions while folded. Unit: `item-view-bounds.test.ts` (view-state patching and schema),
`shortcuts.test.ts` (`[` under Views). Baselines: `rollout-approval-detail.png`,
`rollout-queue-ladder.png`, `rollout-queue-stuck.png`, `controls-card.png`.

### Staged rollout validations, request context, follow-ups

Unit: `github-rollout/stages.test.ts` (workflow matching for the sample rule `^web\s*/\s*release$` with the stages preview, live and settle, the settle stage 10 minutes after live; including a pinned run's name
and replaced rules; environments and their status from job names; preview, live
and the delayed settle stage falling due, a later stage replacing an earlier one, the
window after which a stage is left alone, skipped or cancelled stages; the settings placeholder parsing as a valid two-stage example (preview, then live after 10 minutes, for workflows named `release`); the component from changed files),
`validation.test.ts` (a follow-up needs a verdict and a check) and
`rollout-validation.test.ts` with a fake clock (one request per stage and none at the
attempt's start; live waits while preview is open; the settle stage at exactly 10 minutes;
a restart of the service over the same store neither repeats nor loses a stage; the
previous stage's agent preferred; a person's later validation covers a stage and an
unchecked box keeps every stage quiet; the context JSON with pull request, run, jobs per
environment, previous final report and component, read through the cached files action,
and no prompt line over 1000 characters; follow-ups change the verdict and Needs me;
unrequested ids recorded and labelled, the next request taking the next id; the
delegation wording). Desktop: `tests/e2e/rollout-stages.spec.ts` drives a staged
Web / Release fixture run, with stage rules saved in its settings, through preview, live and the settle stage (live's
`completed_at` is set 25 seconds short of 10 minutes ago instead of faking the clock), with
the scripted agent reporting through the MCP bridge: one validation per stage arrives with its focus and
context, the V1 card shows finished and pending checks while progress is open, a
follow-up turns V1 to concerns with its tag, and a report for an id nobody requested is kept and tagged.
Nothing reaches GitHub or a model.
