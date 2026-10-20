# Desktop visual regression tests

The visual, item-lifecycle, connections, to-dos, item-picker, skills, attention, reviews and dense-map Electron journeys compare the production renderer against
reviewed PNG baselines. These run as part of `npm run test:desktop` in macOS CI.
They complement real pointer/keyboard, geometry, persistence and PTY tests.

| Baselines | What they show |
| --- | --- |
| `map-overview`, `map-neighborhood`, `map-item-hover`, `map-title-above`, `map-diagonal-neighborhood` | Titles centered above rounded member-derived enclosures, diagonal two-item layout, clipped-title fallback, links, type styling, status counts and pixel hover |
| `map-dense-neighborhood` | Twenty visible members in a ten-project, 200-item map with 500 explicit links |
| `map-done-item`, `archive-browser` | Compact done state with hidden links and a searchable archive preserving project/child state |
| `map-direct-connections` | Direct boundary-to-boundary links, including a diagonal context arrow toward an upper-left agent |
| `context-menu-item`, `creation-picker-project-skill` | Four object actions and the project quick ring with Run skill; related controls stay outside the menu |
| `connection-endpoint-picker` | Keyboard-only endpoint selection; relationship type/direction are automatic and direct drops open no form |
| `pull-request-overview` | In-app pull request metadata, files, checks and discussion from a sanitized provider fixture |
| `pull-request-review-actions` | Native Codex and Claude review buttons with model selection from an isolated fixture catalog |
| `needs-me` | Live attention reasons and navigation, deduplicated by resource |
| `todo-map-edit`, `todo-inline-edit` | Direct map title editing and an invalid draft retained in the to-do overlay |
| `todo-overlay`, `project-skills` | Grouped compact to-dos and the movable native skill picker |
| `todo-attach-picker` | Compact header attachment control with an on-demand, focused item selector |
| `todo-completed-text` | A completed task retains its readable text and checked icon in a shaded short map row |
| `creation-picker`, `creation-picker-all`, `creation-agent`, `creation-pr` | Circular quick choices and remaining plugin types, native-agent fields and the current URL-provider unavailable state |
| `settings`, `settings-narrow` | Settings including provider connections, summary opt-in and neighborhood padding/reset at 1280×800 and at 900×640 after scrolling its actions into view |
| `terminal-expanded`, `terminal-narrow` | Real PTY/xterm ANSI output, compact toolbar, breadcrumb, outline and final terminal row at both sizes |
| `local-data-support` | Diagnostic size/backups, preserved terminal history and safe report download at 900×640 |

## Reproducibility

Every journey uses a new temporary SQLite workspace and fixed sample data. It
never reads a real conversation or calls a provider. The terminal launches a local
script in a real PTY; its resize acknowledgement must match xterm and the supervisor
before capture. The sample Claude item is presentation data, not a running model.

Captures pin the Electron dependency, content dimensions, device scale 1, sRGB,
dark mode, reduced motion, renderer date and neutral pointer/focus where appropriate.
macOS launches also pass `-AppleShowScrollBars WhenScrolling` in the process-local
[argument domain](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/UserDefaults/AboutPreferenceDomains/AboutPreferenceDomains.html).
This fixes the overlay scrollbar mode when the host's automatic setting would
otherwise change with its mouse/trackpad; no user or system preference is written.
The hover image intentionally retains hover. Native controls and the production
fonts remain visible; there are no replacement test styles. The skill-picker image
masks only the randomly named temporary working directory.
Animation/input behavior remains covered separately without freezing it.

Test windows are hidden and non-focusable by default, with background throttling
disabled so the normal Electron renderer keeps painting. The existing
baselines also pass in this mode, without new masks or tolerances. Use
`ACT_TEST_SHOW_WINDOW=1 npm run test:visual` when a visible debugging run is needed.

Baselines were reviewed on macOS 27 arm64 with Electron 44.4.5. They are grouped
by OS because font rasterization and native controls can differ. The CI runner is
macOS 14; its first remote comparison still needs verification. Inspect rendering
environment differences explicitly rather than regenerating images automatically
or increasing tolerance to hide them. Each test attaches its Electron/Chromium and
architecture metadata to the report. New OS support needs its own reviewed images.

## Normal check and failure review

```sh
npm run test:visual
npx playwright show-report
```

Normal runs never write baselines, including missing ones. A mismatch fails with
expected, actual and diff images in `test-results` and the HTML report. CI retains
these plus Playwright traces on failure. Comparison allows at most 50 changed
pixels above the 0.2 perceptual color threshold; no automatic retries are enabled.

Check the diff against the intended change. If the change is accidental, fix the
UI and rerun against the existing baseline. Missing controls, text clipping or
shifting geometry must not be accepted just because a screenshot was produced.

## Intentional design changes

```sh
npm run test:visual:update -- --grep "visual forms"
npm run test:visual
```

The update command is explicit and should be scoped to affected journeys. Review
every changed PNG alongside the code, include both in the same commit, and describe
why the visual change is intended. CI explicitly disables snapshot updates. Never
use automatic baseline acceptance as a way to make a failed build pass.

Completed review workflows and every interaction state are not covered by these
twenty-five images yet. Add baselines as those features become
implemented; a screenshot of an unavailable provider is not integration proof.

- `recording-deleted`: explicit recording cleanup at 900×640; only the varying session timestamp/short ID is masked.
