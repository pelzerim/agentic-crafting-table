# Performance diagnostics

Open **Settings → Performance diagnostics** to inspect p95 timings, peaks, sample
counts and slow-budget indicators. Reset measurements before reproducing a dip,
then download the JSON report. Reports cover this window since its last reset;
they are not automatically saved or sent anywhere. Collection retains at most 512
numeric samples per fixed metric and aggregates older samples into totals/peaks.
No terminal text, input, prompts, directories or session identities are collected.

Frame intervals and long tasks are tracked separately for the visible map and
foreground terminal; hidden/stopped terminal measurements remain independent.
Other timings cover terminal reads (IPC included), xterm write callbacks, resize
fitting and input delivery to the supervisor. Input delivery is not visible echo;
the end-to-end test separately measures that. RAF intervals and parser completion
are useful signals, not measurements of every compositor/GPU paint. Long-task
support is reported explicitly; a single task over 100 ms is flagged. Other timing
warnings use the recent p95 after at least five samples. Peaks retain rare spikes.

`terminal.backlog-chunks` samples recorded chunks still unread after the last live
batch was consumed; `terminal.output-gap` counts missing sequence numbers when
a live view has to reset across a gap. These are bounded numeric diagnostics,
without text or session identifiers. A zero backlog only describes completed reads:
it cannot prove model progress, and a quiet stream does not identify a network
failure. Use these alongside read/write/frame timings, the retained recording,
and Claude's own transcript when investigating a reported cutoff.

The long-stream regression adds 900 token lines with fragmented UTF-8 and ANSI,
real cursor-position replies, source silence, interrupt/continue, and a final
sentence marker. It validates every recorded token in order, not just the last
visible marker, and retains the existing frame/write/input latency budgets.

`map.geometry` measures neighborhood outline construction, with a 16 ms diagnostic
budget. Geometry is cached independently of the camera. The spatial desktop test
resets metrics and traverses overview/close zoom, requiring zero geometry rebuilds
and unchanged paths and world coordinates. This catches camera-driven geometry
work independently of the timed 200/500-item map tests.

`map.placement` measures the shared collision resolver during move and resize previews, with
a 16 ms diagnostic budget. Zooming does not invoke it. The pointer regression
checks that samples are collected while dragging and remain at zero across camera
changes. The dense-map tests enforce a 16 ms placement p95 budget for both move
and bottom-right resize drags. Resize is reported as its own phase, including
neighbor displacement, changing neighborhood geometry and the committed dimensions;
frame budgets remain 33 ms at 200 items and 50 ms at 500 items.

## Local baseline

Measured with the production renderer on macOS arm64, Apple M3 Pro, Electron
44.4.5. The synthetic fixture runs in a real PTY, redraws ANSI text at 30 Hz,
echoes 12 keyboard inputs and emits over 4 MiB. These paired development runs are
evidence for the specific changes, not a general guarantee for native Claude or
large project maps. CI keeps fresh numeric reports for comparison.

| Measurement | Before | After |
| --- | ---: | ---: |
| Idle React commits over 1.2 s | 12 | 0 |
| Stream/burst React commits | 72 | 0 |
| Input-to-visible-echo p95 | 108.9 ms | 34.1 ms |
| Sustained-stream read p95 | 3.4 ms | 1.0 ms |
| Foreground frame interval p95 | 9.2 ms | 9.1 ms |
| Burst completion | 794 ms | 798 ms |

Burst throughput and frame cadence were already within budget and show no material
improvement in this comparison. The clear improvements are removing unnecessary
React work and reducing interactive echo latency. The subsequent complete desktop
suite measured 46.3 ms echo p95, 788 ms burst completion and 341 ms history replay,
with zero idle commits and zero stopped-session reads; normal run-to-run variation
is why CI uses explicit budgets rather than exact baseline equality.

## Changes and ongoing checks

- Visible terminals use the official WebGL renderer when available; hidden views
  release it, and initialization/context-loss failures keep a DOM fallback.
  Renderer changes preserve the terminal and process. The regression report
  identifies the renderer, and the capability test records Chromium's backend.
- Output no longer sets React session/recording-end state on every poll. Metadata
  changes and opening History still refresh the toolbar correctly.
- History reads combine durable pages with pending output without forcing an
  SQLite commit and full tail-file rewrite. Existing batched and exit flushes keep
  the recording; reads do not claim to make pending bytes durable.
- Live reads wait for xterm consumption and adapt from 16 ms during output to
  100 ms when idle. Hidden terminals, completed history playback and drained
  stopped sessions do not poll. Terminal mounting and native sessions are retained.
- Resize fits coalesce per animation frame. Disposed terminal writes release
  pending consumers, including when cancelling history replay.

Run `npm run test:performance`; all gates and workload details are in
[the testing strategy](testing.md#terminal-performance-regression-gate). The same
test runs in normal desktop CI; reports are retained even for passing runs. No
provider credentials, model calls or user sessions are involved. When a real
workload still feels slow, collect a report and use it to choose the next trace or
fixture rather than assuming this synthetic workload explains every dip.

Automated Electron runs now use a hidden, non-focusable window with background
throttling disabled. The document remains visible to the renderer, retaining RAF
samples and the same terminal workload/budgets without taking desktop focus.
Reports record this mode; compare like-for-like runs and do not treat hidden-window
timings as OS presentation latency. Use `ACT_TEST_SHOW_WINDOW=1 npm run test:performance`
for an explicit visible run. The original baseline above used a visible window.

### WebGL verification

The hidden Electron 44.4.5 run on the Apple M3 Pro used WebGL2 through ANGLE Metal
(`ANGLE Metal Renderer: Apple M3 Pro`). Input-to-painted
echo p95 was 58.5 ms; SGR/legacy/application-arrow wheel response p95 was
100.2/101.4/131.1 ms (all below the existing 200 ms gate). Stream/burst frame p95
was 10 ms, xterm write p95 4.4 ms, and live view-resize fit p95 8.2 ms. Burst,
history, idle/hidden/stopped reads and mount continuity also pass unchanged gates.
These checks now compare compositor pixels in fixture cells that change only on
input, including screenshot overhead, then assert final content/counters. xterm's
accessibility text is throttled to one second and is unsuitable for this timing.
The earlier baseline timed DOM text, so these figures are not a paired speedup
claim. Three reviewed terminal snapshots record the WebGL font rasterization/cell
rounding. Reports: `test-results/terminal-gpu-confirmation/`;
GPU/fallback evidence is in
`test-results/terminal-gpu-final/`. No dense-map or live-provider claim is implied.

### Terminal screen reader and scrollback

`npm run bench:terminal` (see [testing](testing.md)), Apple M3 Pro, Electron 44.4.5,
WebGL renderer, synthetic Claude-like stream of 50,000 transcript lines (about
24 MB with live-region redraws), two runs per variant; medians. “Before” is the
previous fixed configuration (screen reader on, 10,000 lines), “after” the new
default (off, 5,000).

| Variant | Stream ms | xterm write p95 ms | Stream frame p95 / max ms | Scroll frame p95 / max ms | Reopen ms | Replayed chars |
| --- | --- | --- | --- | --- | --- | --- |
| Hidden window · before | 1530 | 2.7 | 9.1 / 33.4 | 9.0 / 13.0 | 308 | 1.24 M |
| Hidden · SR off, 10k | 1497 | 1.5 | 9.2 / 33.7 | 9.1 / 9.4 | 282 | 1.24 M |
| Hidden · SR on, 5k | 1809 | 2.5 | 9.2 / 33.3 | 9.2 / 17.0 | 264 | 0.62 M |
| Hidden · after | 1274 | 1.9 | 9.2 / 29.1 | 9.0 / 9.4 | 251 | 0.62 M |
| Visible window · before | 1680 | 2.7 | 9.2 / 29.1 | 9.1 / 13.1 | 320 | 1.24 M |
| Visible · SR off, 10k | 1545 | 2.0 | 9.2 / 29.2 | 9.0 / 9.4 | 328 | 1.24 M |
| Visible · SR on, 5k | 1650 | 2.4 | 9.2 / 29.6 | 9.1 / 13.1 | 280 | 0.62 M |
| Visible · after | 1495 | 1.5 | 9.1 / 29.3 | 9.0 / 9.4 | 275 | 0.62 M |

No variant had a long task or a frame over 50 ms; wheel input was paced by
Playwright (16.7 ms per event in all variants). Screen reader off consistently
lowered xterm write p95 (about 25–45 %) and the worst scroll frame (13–17 → 9.4 ms);
5,000 lines halved the replayed tail and opened the view about 10–20 % faster.
Stream duration varied ±15 % between identical runs, so its differences are noise.
The synthetic workload did **not** reproduce lag in long real sessions: the
measured gains are real but small. A real large session remains
the acceptance check; if it still lags,
profile that session rather than the synthetic one.

## Undermap mirror layout

`undermap-performance.spec.ts` replays a history of four projects
(units of work sent below through the app's own commands) and travels to the Undermap three times per size
with a camera over the first project, 1440 × 900 at 70%. One hidden Electron run on
an Apple M3 Pro; orders of magnitude, not budgets, except the asserted bounds (Mirror:
at most 28 cards per project mounted, under 4,000 elements, travel under 400 ms).

| Items below | Layout | Travel (median of 3) | Map nodes mounted (cards) | DOM elements | Worst frame at rest |
| --- | --- | --- | --- | --- | --- |
| 102 | Mirror | 83 ms | 52 (48) | 963 | 17 ms |
| 302 | Mirror | 83 ms | 55 (51) | 1,038 | 17 ms |
| 1,001 | Mirror | 98 ms | 44 (40) | 952 | 17 ms |
| 1,001 | Classic | 355 ms | 1,005 (1,001) | 18,282 | 17 ms |
| 102 / 302 / 1,001 | Classic, earlier audit | 104 / 190 / 384 ms | 106 / 306 / 1,005 | 2,032 / 5,545 / 17,914 | 21 / 18 / 17 ms |

Mirror gives the map at most columns × 4 cards per project (plus one opened month)
and mounts only those in the 600 px cells around the window; `mirrorLayout` itself
takes about 6 ms for 1,000 items. Opening a month of 43 items in the 1,001 case
left 70 cards mounted (1,407 elements). The audit's single “Page crashed” at about 300 items did not
occur in any of these launches (Mirror: three sizes, several runs; Classic at 1,001)
and was not investigated further.

## Dense-map baseline

The same macOS arm64 / Apple M3 Pro / Electron 44.4.5 machine, hidden unthrottled
1600×1000 window, ten projects and 500 / 1,250 links produced these paired local
measurements. Static workloads mix agents, PRs, Linear, Notion, to-dos and compact
unavailable-plugin cards. No providers run. The first trace identified repeated
React Flow node/edge subscriptions and DOM updates during camera movement; outline
geometry and collision resolution stayed idle.

| Navigation p95 | Before | After |
| --- | ---: | ---: |
| 200 items | 24.7 ms | 10.1 ms |
| 500 items | 75.8 ms | 34.5 ms |

Node projections now preserve identity when their geometry/content is unchanged.
Event callback identities and the detail renderer also remain stable across camera
updates. Panning requires zero card renders; semantic zoom still changes card
geometry deliberately. One real title edit continues to update the visible card.
These local measurements are evidence for this workload, not universal guarantees.
Budgets remain 33 ms for 200 items and 50 ms for the stress case; no budget was
raised to accept the fix. Full command-to-DOM updates stayed below 250 ms p95.
Drag placement measured about 2 ms / 8.4 ms p95 in the acceptance run.

Run `npm run test:performance` for map and terminal gates. To inspect a slow map
run, use `ACT_PROFILE_MAP=1 npx playwright test tests/e2e/map-performance.spec.ts`;
the CPU profile is attached alongside bounded numeric diagnostics. Normal Settings
reports include `map.frame-interval`, `map.long-task` and `map.card-render` without
capturing titles, node IDs or map contents.

## Pixel neighborhood rendering

The first full desktop run caught 500-item navigation p95 of 50.1 ms against
the unchanged 50 ms limit. The profile showed no camera-driven geometry builds
or card renders during pan. Coalescing equal pixel runs vertically as well as
horizontally reduces one representative 50-item field from 543 rectangles /
11,367 path characters to 76 / 1,674, with the same painted cells. Shared SVG
opacity caps brightness across overlapping fields. Raster work is limited to
16,384 candidate cells and 512 cells per axis for extreme spreads.

After optimization, two unprofiled runs of each workload passed: 200-item
navigation p95 16.7/16.7 ms; 500-item navigation p95 49.9/41.9 ms; 500-item
drag p95 25/25 ms and placement p95 8.8/8.5 ms. Headroom at 500 items remains
limited and varies with machine load; these are measured fixture results, not a
guarantee for arbitrary maps. No budget was raised.

## Neighborhood biomes

Biome ground and growth (BIOME-01) are baked into one canvas per project and
scaled by the viewport transform. A bake happens when the enclosure, the
appearance, the color or the set of covered cells changes; `map.biome` records
each one. Baking one field in Node took about 1.4 ms for 4,240 cells (one project
of the dense fixture) and about 5 ms at the 16,384-cell cap.

Measured with the 500-item dense fixture (ten projects, one per color preset,
1600×1000 hidden window, device scale 1) on an Apple-silicon Mac that was running
other test suites at the same time. Four interleaved rounds per column; each cell
is the median with the range of the four runs. “Before” is the tree before
biomes, built separately.

| Frame interval (ms) | Before | Plain colour | Biomes · Quiet | Biomes · Full |
| --- | --- | --- | --- | --- |
| Pan at 20% zoom, mean | 18.5 (18.0–18.7) | 18.6 (18.5–18.8) | 13.5 (13.2–14.0) | 13.9 (13.7–14.0) |
| Pan at 20% zoom, p95 | 33.7 (33.4–33.7) | 33.6 (33.5–33.9) | 25.1 (25.0–25.3) | 25.5 (25.4–25.8) |
| Wheel zoom, mean | 25.2 (24.6–26.3) | 25.0 (24.3–25.9) | 25.0 (24.6–25.6) | 25.3 (24.8–26.0) |
| Wheel zoom, p95 | 125.0 (124.9–126.0) | 124.6 (124.1–125.4) | 125.2 (124.8–125.9) | 125.2 (125.1–133.3) |
| Pan at 80% zoom, mean | 10.2 (10.1–10.5) | 10.2 (9.8–10.4) | 9.5 (9.4–9.6) | 9.5 (9.4–10.1) |
| Pan at 80% zoom, p95 | 16.9 (16.8–16.9) | 16.9 (16.7–17.1) | 16.7 (16.7–16.8) | 16.7 (16.6–17.0) |
| Item drag, mean | 10.2 (10.0–10.3) | 10.2 (10.1–10.3) | 10.4 (10.3–10.7) | 10.4 (10.3–10.6) |
| Item drag, p95 | 17.0 (16.9–17.1) | 17.0 (16.8–17.3) | 17.1 (17.0–17.4) | 17.2 (17.1–17.2) |

`map.biome` counted 0 bakes in every pan and zoom phase. During the drag it
counted 150 (Quiet) and 170 (Full) samples at 1.1 / 1.0 ms mean, 2.0 ms p95 and
about 4 ms maximum. Plain colour equals Before within the spread. With biomes the
drag mean is about 0.2 ms higher, which overlaps the spread, and the p95 is the
same. At 20% zoom and device scale 1 the default pixel size is under one device
pixel per detail unit, so those pans draw the flat fallback; with pixel size 48
the canvases are shown at that zoom and the pan measured the same (13.7 ms mean,
25.4 ms p95 against 18.6 / 33.5 for Plain colour). The lower pan times with
biomes were not investigated. Wheel zoom is dominated by cards changing detail
level in every column. These are fixture results in a hidden window on a loaded
machine, not OS presentation latency.
