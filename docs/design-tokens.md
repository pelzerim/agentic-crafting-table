# Design tokens

`apps/desktop/renderer/tokens.css` is the single source for colour, type,
spacing, shape, elevation and stacking in the renderer and in resource plugin
stylesheets. It defines custom properties on `:root`, all prefixed `--act-`.
The app is dark only; a light theme would be one override block for these
properties, not a rewrite.

## Stylesheet layout

`apps/desktop/renderer/styles.css` only imports `tokens.css` and then one file
per surface from `apps/desktop/renderer/styles/` (base, map, overlays, picker,
attention, cards, item-view, terminal, resource-choice, todos, inline-title,
archive, rail, settings-editor, pr, provider-views, rollout, markdown,
paper, code-review, below, mute). The import order is the cascade order: a later file wins
over an earlier one at equal specificity, so add rules to the file of the
surface they style and keep overrides of another surface out of earlier files.
Component stylesheets (`pixel-theme.css`, `settings.css`, `atlas.css`,
`project-dashboard.css`, `blocking.css`, `safety.css`) and plugin stylesheets
are imported by their modules and load after `styles.css`.

## Roles

| Group | Tokens |
| --- | --- |
| Surfaces (dark → light) | `--act-deep` `--act-bg` `--act-sunken` `--act-card` `--act-surface` `--act-panel` `--act-raised` `--act-control` `--act-hover` `--act-selected` `--act-control-hover` |
| Lines | `--act-line` `--act-line-control` `--act-line-strong` `--act-line-accent` |
| Ink | `--act-ink-bright` `--act-ink` `--act-ink-soft` `--act-ink-dim` `--act-ink-faint` (#8fa596) `--act-ink-on-selected` (#c8d8cc) `--act-ink-on-accent` `--act-ink-on-attention` |
| Accent and focus | `--act-accent` `--act-accent-bg` `--act-focus` (#b4dfbf) `--act-focus-ring` `--act-section` |
| Map links | `--act-link` (#9fb5a4, resting links at 2px) `--act-link-active` (hovered, selected or inspected links at 2.5px) `--act-selection` (solid 2px selection outline; never amber, never dashed) |
| Undermap | `--act-undermap` (#170d10, the Undermap field and its locator tile) `--act-undermap-panel` (Undermap locator and overview panels) `--act-undermap-line` `--act-undermap-surface` `--act-undermap-ink` (+`-dim`) `--act-undermap-accent` `--act-undermap-edge` |
| Muted project | `--act-mute-hull` (the field's tint, drawn at the field's own opacity) `--act-mute-veil` (the opaque cover; `-attach` while a drop is accepted) `--act-mute-card` and `--act-mute-note` (card and note silhouettes) `--act-mute-star` `--act-mute-atlas` (its Atlas blob) `--act-mute-ink` (moon and “Muted”). Night blue-grey: never amber or mint, and distinct from the Undermap red |
| Needs me | `--act-attention` (#e8bd72, the umbrella and My turn) `--act-attention-asking` (#ffd98a, Asking me) `--act-attention-finished` (#a88f5c, Finished) `--act-needs-me-fill` `--act-needs-me-edge` `--act-needs-row-bg`. One amber ramp, exclusive to Needs me; the shape carries the tier and brightness repeats it |
| Status | `--act-ok` `--act-pending` (+`-bg`, `-line`; in-flight operations in settings and item views, never Needs me) `--act-cue-waiting` (provider cues toned `amber`, stale data and remote marks: neutral) `--act-error` (+`-bg`) `--act-bad` `--act-danger-fill` (#a64d41) `--act-danger-ink` `--act-info` (+`-bg`, `-line`) `--act-neutral` |
| Blue family | `--act-blue-sunken` `--act-blue-surface` `--act-blue-raised` `--act-blue-hover` `--act-blue-line` `--act-blue-line-strong` `--act-blue-ink` (+`-dim`, `-faint`): surfaces, lines and ink of a view inside a blue item frame (the rollout view), so the body does not clash with its frame. Semantic colours (mint, amber, red, info blue) stay as they are |
| Indicator tones | `--act-tone-green` `--act-tone-violet` `--act-tone-red` `--act-tone-coral` |
| Card tones | `--act-card-teal` (+`-bg`) `--act-card-amber` `--act-card-blue` `--act-card-indigo` (+`-bg`): map card `--tone` values beyond the indicator tones |
| Cards | `--act-card-lift` (the face lift of a hovered or open card; its edge keeps its width, because a 2px edge means Asking me) |
| Dashboards and blocking | `--act-working-ink` `--act-working-sheep` `--act-working-sheep-head` `--act-todo-ink` `--act-needs-row-bg` `--act-strip-neutral` `--act-strip-violet` `--act-strip-blue` `--act-ink-on-coral` `--act-coral-bg` (+`-hover`) `--act-coral-ink` `--act-shadow-popover` |
| Agents and brands | `--act-agent-claude` `--act-agent-codex` `--act-brand-linear` `--act-brand-github` `--act-copper` (+`-bg`, `-line`, `-ink`, `-fill`) |
| Note papers | `--act-paper-mint` (default) `-sky` `-lilac` `-peach` `-slate`, `--act-paper-ink` (`-slate-ink` on slate), `--act-paper-tape`, `--act-paper-agent-tape` (copper, agent-written notes). Decoration only, never status; no yellow, because amber means Needs me |
| Type | `--act-font-ui` (system UI stack) `--act-font-mono` and the scale `--act-fs-caps` 10 · `--act-fs-meta` 11 · `--act-fs-ui` 12 · `--act-fs-body` 13 · `--act-fs-panel` 15 · `--act-fs-title` 18 · `--act-fs-display` 24; weights `--act-fw-regular/-medium/-strong` |
| Spacing | `--act-sp-0_5` 2 · `-1` 4 · `-1_5` 6 · `-2` 8 · `-3` 12 · `-4` 16 · `-6` 24 · `-8` 32 |
| Sizes | `--act-control-size` 26 (every control in an item view's frame bar: actions, ⋯, ↗, ↻, close) |
| Shape | `--act-shape-control`, `--act-shape-panel` (stepped pixel corners; no border radius) |
| Elevation | `--act-shadow-sm/-md/-lg`; `--act-z-map` 0 · `-card` 10 · `-edge` 20 · `-overlay` 100 · `-panel` 200 · `-menu` 300 · `-toast` 400 · `-modal` 500 |

Agent colours are identities, not status: Codex is `--act-agent-codex`, never
the info blue.

## Rules

- **Colour.** Use a token. If no role fits, add one to `tokens.css` with a role
  name (what it is for, not what it looks like). `design-tokens.test.ts` fails
  on any new hex literal outside `tokens.css`. The existing literals that are
  more than ΔE 3 from every role are recorded per file in
  `design-token-debt.json`; a file may not add to them. Remove entries as
  literals are replaced.
- **Contrast.** Faint ink is for meta text on card, panel or raised surfaces.
  It never sits on `--act-selected`; text there steps up to
  `--act-ink-on-selected`. Solid danger buttons use `--act-danger-fill` under
  `--act-danger-ink`.
- **Focus.** One colour, two mechanisms. Pixel-shaped controls draw the inset
  pixel border-image ring from `pixel-theme.css`. Everything else uses
  `outline: var(--act-focus-ring)` with `outline-offset: 2px`, or `-2px` for
  rows inside menus, lists and scroll containers that would clip an outer ring.
  `outline: none`/`0` is only allowed when the same control draws a
  replacement (outline, box-shadow or border-image in `--act-focus`); the guard
  test enforces it. A background change alone is not a focus state.
- **Shape.** Canvas surfaces (map cards, menus, the Atlas) clip to `--act-shape-panel`
  with no border radius. A card draws its 1px edge as a stepped ring masked by
  `--pixel-panel-border`, so the edge follows the notches instead of being cut
  off by them; the edge colour comes from `--card-edge`. A card that is Asking me
  masks with `--pixel-panel-border-thick` for a 2px edge (`--card-edge-width`).
- **Type.** Use the scale tokens; there are no half-pixel sizes. Sentences are
  at least 11px (`--act-fs-meta`); 10px (`--act-fs-caps`) is for uppercase
  labels, counts and chips only. Errors are never shrunk into a line: inline
  title errors appear as a popover below the field.
- **Fonts.** `--act-font-ui` is the system UI font (SF Pro on macOS); no
  webfont is requested or bundled. Code, IDs and counts use `--act-font-mono`.

## Shared components

`apps/desktop/renderer/ui/` holds the app-wide primitives; their CSS is
`styles/components.css` (imported right after `base.css`). Use them for new
chrome instead of styling a bare element.

| Component | Use |
| --- | --- |
| `Button` | `.btn[data-variant][data-size]`: primary, secondary, quiet, icon, danger, danger-solid, copper (irreversible triggers); md 30px, sm 26px. `aria-busy` shows the pixel spinner and the wait cursor; disabled is `not-allowed`. |
| `Chip` | `tone` ok · pending · error · info · neutral · agent, `variant` soft · outline · mono; 2px pixel corner, never a 999px pill. Map domain states onto a tone. |
| `Toast` / `Notice` / `ErrorNotice` | Toast: bottom-left map outcome, 300px, tone glyph, one action, pixel close; only `error` is `role=alert`. Notice: inline status next to its cause. ErrorNotice runs `humanError` so raw provider/IPC text sits behind Details. |
| `FloatingPanel` / `PanelHeader` | Movable panel with grip, 15px title, extras and pixel close. `modal` traps Tab and makes siblings inert without a scrim; `clear` opens it away from endpoints and chrome. |
| `RailPanel` | A rail tool: its slot toggle (icon, badge, key) and the sheet that opens beside the rail, with the shared header, resize grip and one-sheet-at-a-time state (`rail-state.ts`). Needs me, To-dos and the GitHub inbox use it; a new workspace menu starts as a rail slot, not as a floating button. |
| `useOverlayFocus` | Focus in on open, Escape closes, focus back to the opener (or `returnTo`). |
| `PixelCombobox` + `itemOptions` | Searchable choice list, grouped by project, item icons via `NodeIcon`; Escape closes only the list. Replaces native selects in pickers. |
| `DirectoryField` + `useDirectoryChoices` | Every working-directory input: a typed path with the project default, global default and recent launch folders as grouped suggestions (`<label> suggestions` listbox), plus **Choose folder…** for the native dialog. Escape closes only the list. |
| `Segmented` | Two or three exclusive choices with a help line for the selected one. |
| `PixelGlyph` / `ItemIcon` | One pixel icon set in `src/resource-plugins/pixel-glyphs.ts` (row strings, crispEdges): 8×8 for status and small controls (close, more, refresh, chevron, check, alert…), 12×12 for UI and item-type icons. The Needs me tier shapes (`asking`, `my-turn`, `finished`) live there too; `TierMark` and `TierCounts` (`ui/tier-mark.tsx`) draw tiers and their counts on every surface. `ItemIcon` draws types at 12×12 (`size={8}` for cues and 8px marks); plugin views use `pixelGlyphElement`. Brand paths are for provider logos only; no Unicode close/more/refresh/chevron in controls. |

Bare `<button>` elements inside `.live-workspace` still get the legacy chrome
(`.live-workspace button:where(:not(.btn))`); `.btn` is exempt, so there is no
`:not()` opt-out chain to extend.
