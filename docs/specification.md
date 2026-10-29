# Agentic Crafting Table — product specification

Status: implementation specification. This captures the agreed product
direction; it does not claim that the prototype is a working desktop app.

This file is the product source of truth. [Architecture](architecture.md) defines
the implementation boundaries and [testing](testing.md) defines verification. The
[interaction reference](../prototype/reference.html) records the visual direction.
Where older notes or sample behavior disagree with this specification, this file
takes precedence. Future changes should update the requirement and its tests.

## 1. Purpose and delivery scope

Agentic Crafting Table is a spatial workspace for coding projects, their agents,
terminals, execution environments, and related information. A user can see where
work stands, enter a real agent terminal, and follow its connections without
leaving the mental model of a single map.

The initial application is a local-first, single-user macOS desktop app that also
runs on Linux. It owns
local workspace data and connects to existing provider accounts. The public app is
the base; item types and defaults specific to one team (for example an internal
ticket tracker) ship as separately installed plugin packs (EXT-02).
Multi-user collaboration, hosted workspace storage, mobile apps, a public plugin
marketplace, and untrusted or sandboxed plugins are outside the first release.
Trusted plugins the user approves, pinned to a git commit, may be installed
alongside the bundled ones (EXT-02). Other desktop operating systems can follow once adapters are tested.

**First usable milestone:** create a project, run a real local Claude session with
project context, have it register a PR through MCP, and reopen the app window
without losing the project, map layout, or running session. Loading that PR's live
GitHub content follows in the next milestone; registration alone is not a live
GitHub integration. A real plain terminal is included in the first milestone.

## 2. Current baseline

The production app has moved beyond the frozen HTML proposal.

| Area | Implemented | Still incomplete |
| --- | --- | --- |
| UI / graph | Real Electron map, continuous item expansion, draggable project titles, creation ring, links, lifecycle and to-dos | Further release/manual acceptance |
| Persistence / MCP | SQLite service, live UI updates, revisioned shared commands, native agent bridge | Remaining release hardening |
| Agents / Terminal | Local Claude/Codex and shell PTYs, context, native resume, recordings, skills, summaries and recovery | Remaining platform/capability checks |
| GitHub | Authenticated PR reads, automatic assignment reconciliation, durable native and workflow review items | Real-model review acceptance; supervised `/review` acceptance and repository contract; native artifact capability |
| Other resources | Web metadata/browser activation, Notion, Linear and Slack read connectors | Live Notion/Linear/Slack acceptance |
| Tests | Domain/service, hidden Electron, native PTY, visual and performance suites | Live write checks require human supervision; fixtures do not establish live-provider success |

The existing `benchgrove` MCP name, resource URIs and configuration identifiers
are legacy internal identifiers. Preserve compatibility until an explicit migration;
the displayed product name is Agentic Crafting Table. The macOS bundle identifier,
application-data directory, package name and MCP identities remain stable across
display-name changes; renaming must preserve existing workspaces and conversations.

## 3. Map and navigation requirements

The map follows these refinements: reading and attention hierarchy, label
placement, connection inspection, Settings, creation wording, working surfaces and
provider identity, while preserving the spatial, terminal and provider requirements
below.

| ID | Required behavior |
| --- | --- |
| MAP-01 | One continuous map supports workspace overview, project neighborhood, and expanded item views. Items expand in place as the camera approaches; navigation must not feel like opening a separate inspector panel. Keep the original bubble and its connections on the map. Animate its expanded surface continuously from the bubble’s actual visible bounds into the full-item view and back, including normal-motion intermediate frames. Keep the surrounding camera and neighborhood fixed during this expansion, preserve terminal mounts, and skip the animation for reduced motion. |
| MAP-02 | Expanded items use type-specific bounded dimensions (SETTINGS-07), leaving surrounding map space. Agents and Terminals have larger defaults; notes and to-dos never enter detail focus (notes are written on the map, RES-09). A visible project pixel field and location trail preserve orientation; hide the locator and zoom control in this view. Connected items are directly reachable. A pixelated X or right-click anywhere returns to the project without opening a context menu. The X button has the same outer height and vertical alignment as the other buttons in the expanded item toolbar; center its glyph within that shared button height. Escape steps back through project and overview. |
| MAP-03 | In overview and neighborhood views, omit the central project bubble. Keep the same floating **Project: NAME** title horizontally centered above the neighborhood field. Center its text and status counts, with project actions accessible alongside. Use readable screen-space text at every zoom level and keep the title behind item content. If the cap or title extends offscreen, keep the title reachable at the visible viewport edge without moving the map. Omit derived project connection lines at every zoom; the pixel field expresses membership. The title supports opening, group dragging and project actions in both views. Preserve saved project anchors and member positions. Zoom transitions must not move members, rewrite saved positions or alter outline geometry. |
| MAP-04 | Each project has a dynamic, padded pixel field following the rounded convex enclosure of all visible member footprints, drawn as a **spline hull**: long straight runs between distant members bow gently outward into curves, while single items and compact groups keep their rounded hull. The curve stays convex, never self-intersects, always contains the full padding around every member, and changes continuously while a member is dragged. Use **B · Broad steps**: four broad fading shades of large square pixels, **24 world pixels** by default, with **no stroked outline**. Fade inward from the logical edge across 96 world pixels by default; keep the center solid. Pixel size, fade distance and optional edge scattering are configurable (SETTINGS-09). Derive the enclosure from full detailed member footprints, ignoring the saved project anchor except for empty projects. Recenter and grow live when members move/add/remove, retaining other positions. Default minimum logical clearance is one large item width; preserve SETTINGS-03 padding and membership/attachment hit tests independently of visual opacity. Use a stable world grid and deterministic scattered cells, with no camera-dependent rerasterization or idle motion. During dragging, the field follows the member immediately; other geometry/material changes use a short shading transition, skipped for reduced motion. Keep the field behind titles, connections and items in all zoom levels and expanded-item views; remove the separate focus-view outline frame. Attachment feedback brightens the field without adding a stroke. Bound render complexity for extreme spreads using integer multiples of the chosen pixel size. This supersedes the earlier visible pixel-stepped stroke. The logical enclosure is stepped on the same world grid as the default 24-pixel fill (whole multiples of it for very large projects), so **the visible field decides membership**: at the default pixel size a point is inside a project exactly when its cell is painted. Creation, attachment, owned-item transfer previews and drops, the Atlas and far-zoom dashboards all use this smoothed field; an item dropped outside the drawn field does not join (beyond the floating-attachment reach). |
| MAP-05 | All map levels share world-space positions. Zooming changes camera and presentation, not saved layout. Expanded surfaces may move independently in screen space (MAP-19). Transitions preserve orientation, with no radial redistribution or jump on returning to overview. |
| MAP-06 | Mouse wheel zooms around the pointer. Empty-space dragging pans the entire scene, including project outlines and members. Terminal/document scrolling remains native when the pointer is inside expanded content. A press on an item that slips up to 6 screen pixels before the release is still a click: it opens the item and neither drags it nor pans the map. Further than that it drags the item; in Undermap, where items cannot be dragged, a press on an item never pans. |
| MAP-07 | A very small zoom bar in the bottom-left corner of the map, right of the tool rail (hidden while the project column or the Atlas overview unfolds), shows current position and transition markers. Using this slider zooms around the center of the visible map canvas: keep the world point currently at that center fixed on screen while changing scale, adjusting camera translation accordingly. Apply this to slider clicks, dragging and keyboard changes, in both zoom directions and after panning or resizing. The slider is a pixel control (square thumb) with a live percentage readout that resets to 100% on click; there are no step buttons, the − / + / 0 keys step and reset the zoom; the slider announces its value as a percentage. Each tier threshold carries a small glyph instead of a text label (board, icon, card) whose tooltip names it (“65% · Icons below”). The icon glyph appears only while dashboards are off: with dashboards on there is no icon band (MAP-23), so the bar shows the dashboard and close-card glyphs only. A mint tick marks the project dashboard threshold (MAP-23) while dashboards are on, with the accessible name and tooltip “Dashboards below N%”. |
| MAP-08 | Grab any collapsed item surface to move it, regardless of activity. Distinguish click from drag with a movement threshold. Buttons, link handles, terminal input and text selection keep their own behavior. A press anywhere on a card's visible face (middle, words, badges, the working mark, every edge and corner) moves the item once it passes the click slip, at every zoom and whether the drag is slow, fast, hesitant or follows a hover; it never pans the map. That holds while an earlier move is still saving (the new drag starts from where that move left the map) and while a closed view is still flying back to its card. Only real controls in the card keep the press: buttons and the completion box, fields and text being edited, links, inner regions that scroll, the + link tab where it is drawn and the resize grip. Dragging an expanded item's menu bar (except controls) moves only its open view (MAP-19). |
| MAP-09 | Moving a project moves its members by the same delta, preserving their offsets, links and identities. Moving an individual member moves only that member. Panning never changes world positions or membership. |
| MAP-10 | Double-clicking empty map space opens the circular New item picker (MAP-16) at the cursor without zooming the map. Outside a neighborhood, the board's right-click menu offers **New item**, **New project** and **Open archive**; inside a neighborhood, it offers only **New item**: New item opens the same circular picker; New project opens the project form directly at the clicked map location. Remove the persistent **+ New project** button. A single empty-space click does not open a form. An item's or project's menu opens at the pointer but never covers that card's title row: it moves just below the row, or above it when there is no room below. Dismiss an ordinary context menu on another right-click, an outside click or Escape; the circular picker uses the layer navigation in MAP-16. Inside an outline the item belongs to that project; outside it is floating. Projects can also be created at a chosen map position. Double-clicking items, controls or expanded content retains their own interaction and must not open the map picker. After type selection, inline creation forms can be dragged by their heading, preserving field values and the original map placement; keep the form within the canvas. |
| MAP-11 | Place the plus/connection handle on the right edge at the vertical center of each collapsed item, including compact and done states: a 16 px pixel button straddling the edge outside the content, shown on hover or keyboard focus, so it never covers status text. The resize grip is a 12 px corner tab with a three-step pixel stair in soft ink, shown on hover, focus and selection. Drag an item's plus/connection handle to another item to connect them, or to empty space to open the same circular picker and create a connected item inline (MAP-16), retaining the source item and drop location. Show validation failures before committing a new item or edge. Pressing Enter or Space on the focused + opens an endpoint-only connection picker with the same automatic relationship policy. No side panel is needed. |
| MAP-12 | A floating item dropped in/near a project shows an attachment preview and joins it on release. Dragging an owned item inside another project's neighborhood shows **Move to NAME** and highlights that destination; releasing transfers only that item. Resolve overlapping areas by nearest center, with a stable ID tie-break. Use neighborhoods from the start of the drag for target selection so a source outline growing with its member or displaced destination items cannot steal the drop. Keep live outline/collision previews. Empty-space drops retain current membership; Item settings still allows explicit detachment. Commit membership and placement atomically, preserving IDs, resources, links, content, session history and running processes. Project/group drags never transfer membership. |
| MAP-13 | Detailed map items do not overlap at maximum zoom. Placement/drag operations resolve collisions while keeping the held item under the original grab point, including the first movement across the drag threshold. Preview displacement during dragging and commit the held and displaced positions atomically on drop, retaining the preview until the operation settles; a conflict/error visibly reverts it. Use 20 world pixels of clearance between detailed item footprints. Project movement preserves member offsets. Apply the same rules to keyboard and agent/MCP moves; reject conflicting fixed positions in a multi-item request. Reserve sufficient detailed footprints so zooming itself does not rearrange the map. Expanded focus content is a camera/view projection, not a giant persisted layout rectangle. For older overlapping layouts, provide an explicit Settings → Map → **Clear overlaps** action using the same shared placement rules; it runs immediately after an inline confirmation. Preserve already-clear items, metadata, links and archived positions; do not rearrange saved layouts automatically on startup or zoom. |
| MAP-14 | Creating any item or project reserves its full detailed footprint and places it in the nearest free space to the requested location. Existing items keep their positions. This rule applies to UI, MCP and provider-created items, including several creations in one transaction. **Agent placement.** An agent that creates an item or project does not have to choose coordinates: `position` is optional for agents. Without one the item lands in context, beside an anchor: the first node it links to that is on the map, otherwise the agent's own node; with neither, among the members of the project it names, at the nearest free spot to their centre (an empty project's own spot). Beside means the right-hand column starting on the anchor's row, filled downward, then the row below the anchor, then the nearest free spot, so several items created together form a tidy column and nothing else moves. An item with no `projectId` joins its anchor's project; a named project wins, and an anchor outside it does not count. A new project lands clear of every other project's neighborhood, beside the agent's project. A position an agent does give is kept only within reach of that context (one neighborhood padding from the destination project's members, or from the anchor of a floating item); a farther one is placed as if none was given. An anchor or project that is archived or in Undermap never counts, so the item stays on the visible map. With no context at all a position is still required and is used as given. Positions from people, the desktop app and providers are never replaced. **One node per project for an agent.** When an agent's `item.add` or `item.create` names a resource that already has a node on the map (not archived, not in Undermap) in the project the new item would join, or floating when it would float, no second node is created: the command succeeds against that node, its `links` are saved on that node, later commands of the same batch that name the requested id act on that node, and the result's `alreadyOnMap` names it (`requestedId`, `nodeId`). The same resource in another project still gets its own alias, and people, the desktop app and providers create aliases exactly as before. |
| MAP-15 | Show a grab cursor over the empty board, changing to grabbing during a pan. Show a pointing-hand cursor over item/project bubbles to indicate they open on click; switch to grabbing during an actual item drag. Use the normal arrow elsewhere. Keep native text-entry, terminal, resize and control cursors within expanded content. Cursor changes must not change the existing click-versus-drag behavior. |
| MAP-16 | The New item type picker is a circle of individual pixel bubbles around the opening cursor position, each with a readable label and type icon. Bubbles read as raised UI above the map (opaque raised fill, top-left bevel, 2 px hard shadow) so map cards never show through them; the interaction layer itself stays transparent. While the ring is open, a transparent interaction layer shields all map items and connections, including gaps between choices: no background hover preview, highlight, tooltip or connector control. Clicking outside dismisses without activating the item underneath; map interaction resumes afterward. Keep the ring compact around an empty amber pixel bubble with a dashed edge at its center, visually distinct as an unfinished item; omit explanatory copy and the close X. Hovering a type or navigating to it with the keyboard transitions the center into a small preview using that type's icon, color, compact label and relative size. Initial focus alone keeps the blank draft. Leaving the choice returns the center to its unfinished appearance; All and pagination remain navigation rather than item previews. Previewing does not select, fetch, launch or create anything. Keep the center fixed as its local size/color/content transitions quickly; reduced motion settles immediately. Selecting grows this currently visible seed into the form. On opening, animate that center from zero size, then grow and spread the choices outward from the same center into their final ring positions with a quick, lightly staggered ease-out. Use scale/translation/opacity without bounce, camera movement or layout changes. Layer changes spread the new choices from the existing center. Reduced motion shows the final layout immediately; opening animations must not prevent dismissal or keyboard selection. Inside a project, omit Project from both layers without changing saved shortcut preferences. Its first layer contains the quick choices configured in Settings (SETTINGS-04), plus **All** only while non-project item types remain outside those choices. Project alone does not keep All visible; the board menu still provides New project. Selecting All replaces the quick-choice bubbles with another circular layer containing all remaining available item types; do not repeat the quick choices or show both layers at once. A right-click in that layer returns to the quick-choice layer. Another right-click closes the picker; a right-click from the initial layer closes it immediately. Consume these right-clicks without opening another context menu. Escape provides the same back/close sequence, and choices are keyboard accessible. Selecting a type grows the center bubble into its inline creation form, centered at that visual seed and clamped inside the canvas. Keep the original requested world position, project/connection context and collision-safe placement. The form has no close X; Back/right-click/Escape returns to choices, followed by another right-click/Escape to close. Editing existing items retains its normal close control. Merely opening, changing layers or dismissing the picker creates nothing. Keep the bubbles reachable near canvas edges without changing the requested world position; show an explicit empty state if All has no remaining choices. |

**RAIL-HOLD — Holding a rail tool open.** Right-clicking a rail tool's slot (Needs me,
To-dos, GitHub inbox, Reminders, every `RailPanel`) holds it open: Escape, a map click,
opening an item, travelling to Undermap or a click on its own slot leave it open. Another
tool still opens over it (by hover or click) and hands it back when it closes. The held
slot carries an accent inset frame and a small lock in its top-left corner, its tooltip
ends “Held open · Right-click to release” (otherwise “Right-click to hold open”) and its
accessible description is “Held open”. Right-clicking the held slot again releases and
closes it; right-clicking another slot moves the hold there. The hold lives for the
window session and is not saved.

**MAP-BADGES — Note badges.** A note of one or two plain words, at most 12 characters
(one line; no list, heading, checkbox, code or emphasis), that is connected to an item is
shown as a **badge** on that item instead of as paper. A note connected to several items
is a badge on each; projects and other notes are never labelled. The note and its links
are not drawn on the map (the connection is the attachment), it is no plot member, and a
badge note connected to nothing stays paper. `data.display` overrides the rule per note
(the note's menu, **Show as ▸ Note / Badge**, the shown one checked; not in its form):
`"badge"` makes any one line of up to 24 characters a badge, `"note"` keeps it paper,
`"auto"` or none applies the rule. A badge is drawn in its note's paper (mint when the
note has none); the menu's **Colour** row of paper swatches changes it, on the badge and
on the paper alike. Any item field can be offered this way: a field's `menu` makes it a
submenu or a swatch row in the item's menu, and `form: false` leaves it out of the form.
On the card a badge is a mono tab straddling the top edge, right of
centre, counter-scaled to stay at least 11 px on screen; up to three side by side, more
as “+N” (titled with the rest). In the overview tier it is a small paper pip, its words
in its tooltip. Click opens the note's edit form; right-click opens the note's menu. The
card's accessible name gains “, badges S2, v1.4”; each tab is a button named “Badge
<words> on <item>”. Needs me rows and dashboard rows show the item's badges as chips
after its name. A badge never raises attention or changes counts. MCP `workspace_read`
returns `badges: [{ noteId, text, paper, itemIds }]`, and the agent guide (v2026-10-22.2)
tells agents to label items this way and to reuse one note for several items. Not built
yet: a free chip for an unconnected badge note, highlighting every card with the same
words on click, and a setting to turn badges off.

**MAP-30 — Snap to grid.** An optional invisible 48 px grid that item centres land on
when a position is decided, so connections run straight or at even angles; off by
default. The rule and its settings switch are SETTINGS-SNAP-GRID.

**MAP-19 — Independent expanded-view movement.** Drag anywhere on the expanded item's menu bar (including status, directory, provider/model text and empty space; excluding buttons and other interactive controls)
to move its open view in screen space, without moving or resizing the map bubble,
rewriting graph/camera state, rearranging neighbors or changing its connections.
The original bubble remains rendered at its saved position and size, with a subtle
open-item highlight. Connections continue terminating at that bubble. The open
surface still grows from that bubble on entry and shrinks from its current screen
position back to the bubble on close; reduced motion settles immediately.

Respect a small movement threshold; controls, links, native terminal input and
text selection keep their normal interactions. The heading also supports arrow
keys (10 pixels; Shift for 40). Escape during a drag, pointer cancellation, lost
capture and window blur restore its previous screen position without closing the
view. Keep the surface inside the window and reclamp after window/view-size
changes. **Remember each item's view position and size across reloads and restarts**: they are saved with this machine's view state per item, not as map
coordinates or workspace commands, cover both map layers, and are forgotten when the
item is deleted or its view size is reset. Switching linked items,
closing and reopening retains the existing terminal mount/session. To-dos and notes remain
inline. This replaces the older
behavior where dragging an expanded heading dropped the item back onto the map.

**MAP-20 — Independent expanded-view resizing.** Each expanded surface has a
bottom-right pixel grip. Drag it to change that individual view's width/height in
screen pixels, anchoring its top-left. Its map bubble, connections, neighborhood,
camera and Settings defaults are unchanged. Keep the resized surface inside the
canvas with a 12-pixel margin; card-mode plugin views retain their smaller policy (at most
75% of canvas width/height). Minimum dimensions are 480 × 280 for focus views and
320 × 240 for cards, reduced only if the canvas cannot fit them. Existing saved
type defaults remain compatible. Refit native terminals during resizing without
restarting processes, remounting terminal views or losing content/input.
At narrow widths, place native session controls on a second header row rather
than overlapping the title or close button; keep terminal content fitted below.

Arrow keys on the grip resize by 10 pixels (Shift: 40); Home or double-clicking
the grip restores the type's current default size. Escape during resizing, pointer
cancellation, lost capture and window blur restore the previous view geometry.
Remember each item's override when switching/closing/reopening and across reloads and
restarts (saved with this machine's view state),
independently of other items of the same type. Window resizing reclamps without
discarding the preferred size. Opening/closing retains the zoom effect from/to
the original map bubble. Inline and browser-only items still do not mount a view.

**MAP-18 — Short context menus and radial skills.** Item menus lead with
**Open** (focused when the menu opens; opens the item view) and **Connect to…**
(the keyboard connection editor), separated from the rest. The remaining actions
form separated groups: provider actions (each marked with an amber remote glyph;
an irreversible one such as Merge ends in “…” for its confirm step), then Open on
the provider, Copy URL (MAP-27) and a **Settings ▸** submenu, then map housekeeping (to-do, auto-name, Mark
done, Undermap). **Settings ▸** holds **Item settings…** (Edit note… for
notes and other types with a generated title, as before) and **Use size as default**:
the latter makes this item's map size the default for its type — the type's default
tier (SETTINGS-07 map sizes) becomes this item's tier, and when the item was resized by
hand, that tier's saved width and height become this item's dimensions — so the next
item of the type arrives at this size. Existing items keep their sizes. It is disabled
with the reason when the item already has the type's default size and no custom
dimensions. The submenu is one entry for MAP-27 ordering and hiding (hiding it hides
both; the capability stays in Settings → Items). This is the default; a person can rearrange an item type's entries and
separators and hide entries (MAP-27). Top-level rows lead with a 16 px glyph, menus are at least 200 px
wide so labels stay on one line, and a menu near an edge flips to the other side
of the pointer rather than sliding back over the clicked card. Shortcut hints are
shown only for actions that have a workspace key (none today). They then contain
Item settings (Edit note for notes), Mark done/Reopen and Archive. Project title
right-click and ellipsis show the same three: Project settings, Mark done/Reopen
and Archive project. Delete appears only in the archive, which uses the settings
list system: archived projects lead as rows with **Restore project** (their items
collapse to “N items return with the project”), archived items are grouped by
project with **Restore** (an item whose project is still archived explains
“Restore <project> first”), and Delete sits in each row's ⋯ menu behind an inline
confirm with Keep focused. Lines offer only Remove
connection. Separate lifecycle actions visually; omit Cancel and all duplicated
creation and workspace actions. Pull requests additionally offer **Trigger review →
Claude, Codex, /review**, reusing PR-02/PR-03. Hovering/entering the submenu does
not start anything. Explicitly choosing a provider starts a review using its
default model; model selection remains in the PR view. The `/review` choice posts
the workflow trigger, with that effect identified in its tooltip. Keep the source
PR frozen while preparing; show progress/errors and an Open action for the linked
review without stealing focus. Submenus open inward at window edges and support
Right/Left and Escape to enter/leave. Pointer and Shift+F10 menus share the
same actions and support arrow/Home/End navigation. Retain outside-click,
right-click-again and Escape dismissal, and the expanded-item/picker back gestures.

Run skill belongs only in the New item radial view inside a project, including
plus-to-create. When the native runtime can create agents, keep Run skill in the
first ring without rewriting saved shortcut preferences. Reserve its slot within
the seven-choice limit (plus All), placing displaced configurable choices in All.
The action opens the native skill picker at that placement with the project
context; Back/right-click/Escape returns to the radial ring before dismissing it.
A plus-origin skill run creates its agent and automatic connection atomically,
using the same retry identity and cardinality rules as other connected creation.
No skill executes merely by opening or previewing the action.

Item settings hold local name/content and project membership, applied atomically
on Save. Provider-owned titles are read-only; provider identifiers remain hidden.
Refresh stays in provider detail toolbars; browser-only URL items expose Refresh
title in their settings. Project settings have name, summary and working directory.
Settings → Map provides Open archive and workspace-wide Clear overlaps without
losing an unsaved settings draft. The to-do overlay owns an accessible item/project
attachment control alongside existing drag-and-drop; remove Attach to to-do from
object menus. Keep the overlay compact and its attachment selector hidden until
requested. Lifecycle operations remain independent of native session lifetime.

**MAP-18 — Undermap.** The layer below the map is called **Undermap** (a name, always capitalized). Item and
project menus on the map offer **Send to Undermap** (Send project/selection to
Undermap) instead of Archive. The Undermap is a second map: the same camera, pan and
zoom, reached through the portal, **4** / **U**, with the sink and rise. It has two
layouts (Settings → Map → Undermap layout); **Mirror** is the default.

*Mirror.* Every project with something below has an area in its own place: centred
under the project's items on the map and starting at their top edge, drawn as the
project's field in the Undermap tint with the project's plate above it. An item sent
below lies under its own project, and because travelling keeps the camera you arrive
under where you were. Positions below are **computed, not stored**: `mirrorLayout`
(`src/graph/undermap.ts`) is a pure function of the nodes, the card footprints and
the opened months. When a project moves on the map its area follows. Nothing below
can be dragged, nudged with the arrow keys or resized; a click, the context menu,
Bring back and Archive work as before, and a drag that starts on a card pans the
layer. Inside an area the items are grouped by the **month** they were sent
(`belowAt`, or the project's when the whole project went; the system's time zone),
newest month on top. Each month has a divider line across the area with its name,
its count and the first and last day something was sent (“SEPTEMBER · 42 18 Sep –
29 Sep”; a month outside the current year carries its year). Under the line the
month's items are ordinary cards packed into columns, newest first. An area is
seven columns wide (260 px each; a wider card spans columns) and gives up columns,
down to four, when a neighbouring project's area is close. It never moves an area
that holds its place; an area lower down yields downward when the one above it
needs the room. An area shows its budget of columns × 4 cards, newest first
(28 at seven columns). Months are open while the budget lasts; the month it runs
out in shows its newest cards and ends in “+N more ▸”, which opens the rest of that
month (“Show the newest N ▾” closes it); every older month is its line alone with
its count and a disclosure (“JUNE · 37 ▸”). Clicking a closed line, or Enter on it,
shows that month's cards in place and the area grows downward; a second click or
Escape closes it. One month per area can be opened this way at a time, and opening
one never changes what the others show. Opened months are view state and are
not saved. Items of no project, or whose project was deleted, share one **Loose**
area with the same lines, at the map's left edge below its bounds; its plate has no
project menu. A whole project sent below keeps its plate in its place and its
members are packed by the same rule, dated by the project. Only cards near the
window are mounted, and a closed month mounts nothing. Below the dashboard zoom
(MAP-23) an area is one plate, “Project · N below”, with its six newest months and
their counts; the Atlas draws the computed boxes and counts everything below. The
Undermap bar reads “Undermap · N items”, a find field, Archive and ↑ Back to map.
Typing there (or **/** while below) lists the items whose title, project or month
contain every word, newest first, eight at a time with the total; Enter or a click
flies to the item, opens its month when it is closed and marks the card for four
seconds; Escape leaves the field. A reveal from elsewhere (Needs me history, the
GitHub inbox, a notification) opens the month the same way. The search covers the
Undermap only.

*Classic* keeps the earlier layout: items arrive beside their
project's items already
below, never on top of them and never rearranging anything there: an item, a
selection or a whole project moves as one block that keeps its layout, to the first
clear spot right of, below, left of or above that project's items below (stepping
outward), clear of every item below and of other projects' neighborhoods. When
nothing of the project is below yet, the block keeps its position if that spot is
clear; items below can be dragged, and projects below show dashboards (MAP-23).

Both layouts share the data, so switching either way loses nothing and needs no
migration: sending below still writes the classic position and the saved
`mapPosition` in both, and Mirror only stops reading the positions stored below.
The UI and MCP share the send, and a selection is one revision. Items
below keep their
state, links and project membership and pause provider polling, AI titles
and Needs me, and leave the to-do list until they return (checklist to-dos that merely
link to them stay), but are not archived. Sending a terminal or agent below (directly or
with its project) stops its session and keeps its history; it is not resumed after
restart, and returning it to the map does not relaunch it — resume or restart it explicitly. A portal button
under the to-do button (with a count) travels to the layer below and back with the
same camera. In Undermap, items appear full size in neighborhoods drawn in a very dark
version of each project's color, with the date they were sent; they are cold (no polling, no Needs me; a
working mark stands still); nothing can be created there. Zooming out past the minimum
rises to the map at the previous zoom; **↑ Back to map** does the same. The item
menu below offers **Bring back to map** (the nearest free spot to its map position
from before it was sent below, in its project, never moving other items; a project
brings back the members that went below with it to their map positions), settings and **Archive**. An item cannot
return while its project is below, archived, or deleted (deleting a project marks
its items below as unable to return). **Archive** keeps the previous behavior;
restoring from the archive returns an item below if it was archived from there.
The archive list groups entries by project. Sending or returning an item plays a
~900 ms portal sink/rise with particles. Travelling between layers is brief (default
260 ms); Settings → Map (advanced) sets that travel duration or turns all of these
animations off, and reduced motion always disables them. The portal button is a
pixel portal in an obsidian frame, centered and still until hovered or focused:
purple toward Undermap, green back toward the map.

**MAP-21 — Tool rail and GitHub inbox.** The rail is the one origin of every
workspace menu: a vertical, Minecraft-style hotbar at the left edge whose
fixed slots are, top to bottom, **Needs me**, To-dos, Reminders (MAP-REMINDERS), the
GitHub inbox, Undermap and, below a divider, **Actions** (STANDUP-01) and **Settings**. Tab walks them in that order; each names itself with its
key in a pixel tooltip on its right, shown at once on hover or focus and gone while
that tool's sheet or dialog is open, so it is readable before hover opens the sheet. Nothing actionable sits top right any more: that
corner holds only the connection status, which is empty while connected (STATE-02).
The to-do icon is static. The Needs me slot shows the shape of the highest tier present
(STATE-02): the diamond on an amber fill with a bright edge while something is Asking
me, the triangle on the amber fill for My turn, a dim dot on a plain slot with a dim amber
edge when only Finished work remains, and the pixel “!” on a plain slot at zero, so the
origin never moves. Its count badge is the Needs me number (Asking me + My turn); its
accessible name is `Needs me: N`, or `Needs me` when that number is zero, and its title
spells out the tiers (“Needs me · 2 asking · 3 my turn · 1 finished”). The GitHub inbox
and to-do badges are neutral (the to-do badge counts tickets waiting in From Linear, TODO-12; its
accessible name adds `: N in the inbox`, and an empty inbox shows no badge): only Needs me is amber. Settings is a pixel gear that opens the Settings dialog (not a
sheet) and shows its slot open while the dialog is up.
Rail tools (Needs me, To-dos, GitHub inbox) share one panel: its sheet opens right of
the rail, level with the rail's top, never covering the rail; every sheet has the same
header, colors and a resize grip (drag, arrow keys, Home resets), and each remembers its
size across reloads. **Every sheet carries the same close button, a pixel X at the top
right of its header**, and every tool opens, pins and closes alike: closing
by the X, Escape, the slot, its key or a right click also unpins, so no tool stays
pinned while hidden, and none comes back open or pinned after a reload. The to-do list
no longer has a collapse chevron or a remembered pin; T pins and closes it as its slot does. Sheets are not dragged. Only one sheet shows at a time: clicking a
tool (or its key) pins it open and unpins any other; hovering another tool peeks over a
pinned one, which returns when the pointer leaves; going to Undermap closes every sheet.
Keeping Needs me open moves focus to its first row; a peek leaves focus alone. Escape
closes it and returns focus to its slot, without also stepping the map back. Every slot
shows "open" the same way (a highlighted slot frame), including Undermap while you are
in it. The rail stays in place and usable while an item is open, so Needs me is always
one click away — unless the open item view reaches the rail column or the trail row: then
the rail with its slot buttons (an open sheet stays) and the map trail slide off their
edges together, Dock-style (160 ms; no motion under reduced motion), and return the moment
the view closes or no longer reaches them. Their keys keep working while they are away. The GitHub
inbox mirrors github.com/pulls/inbox: open PRs where your review is requested, you
are assigned, you are the author or you are mentioned, merged per PR with reason
chips, per connected account. The service refreshes it once a minute (honoring rate
limits, keeping the last list on errors) through four fixed read-only searches.
Hovering the slot opens the panel; clicking keeps it open until clicked again or
Escape. **A right click on the map closes every rail sheet, Needs me included**, pinned
or peeking. When it closes a kept (pinned) sheet that is all it does; the next right
click opens the map's own menu (board, project, item or connection). A sheet that only
peeks from a hover does not hold the menu back. **A right click on a sheet itself closes that sheet**: anywhere on it that takes no right click of its own, so a to-do row still
opens its row menu and a text field keeps its own. One inside Settings, an editor or a
menu closes nothing. A right click that is a back gesture
(leaving an open item, the New item picker) only goes back. A left click on the map
closes none of them. The tabs are **Inbox** (the default), Needs review, Assigned,
Yours and Mentioned, each with its count. Inbox lists other people's PRs not
marked Seen, newest update first (a PR you authored shows only under Yours, without
Seen or Back to inbox, whatever other reasons it has); a PR new to the list lands there by itself. Each
Inbox row offers **Seen**, which takes it out of Inbox while it stays in its reason
tabs, drawn quieter and offering **Back to inbox**. A seen PR returns to Inbox when
it has new activity after it was seen: a newer GitHub update time or a reason it
did not have then (a new review request, assignment or mention). Seen is saved in
the workspace per PR across accounts with the update time and reasons it had then,
survives restarts, and is forgotten once the PR leaves every account's list. An
empty Inbox reads "Nothing new". The slot badge counts what the Inbox tab shows
(every unseen PR of someone else, so seeing a row lowers it and your own never count); the slot's name reads
`GitHub inbox: N new`, adding `, M reviews requested` for the unseen review requests. "Show
on map" adds the PR to the one project already holding PRs from that repository
(otherwise floating at the map center) and reveals it; PRs already on the map show
"Open on map" (or "Open in Undermap"). **Hide** removes a PR from the inbox for good
(per PR, across accounts) from any tab. The last inbox list is saved per account, so it shows at
once after reloads and restarts while the next refresh runs. Its states live in
the body: three skeleton rows while the first list loads; without a GitHub
account, a call to action whose **Open Connections** button opens Settings on
Connections; a failed read as an alert ("Couldn't refresh · …") with **Retry**
above the last list. Refresh is an icon button whose tooltip says when the list
was last updated.

**First run.** The empty workspace gives one instruction (“Double-click anywhere
to add an item · right-click for more”), a Create your first project button and a
three-step Get started checklist: Create a project → Connect GitHub or Linear
(Connect… opens Settings on Connections) → Start an agent. A finished step
collapses to one struck-through line with its result. While the map holds only
projects the checklist docks at the bottom centre; it disappears once an item
exists, all steps are done, or Hide is chosen (remembered on this machine). The
card never takes map gestures; only its buttons are interactive.

**MAP-REMINDERS — Reminders.**
A rail tool for daily reminders at set times per weekday, for breaks and routines:
not an item type, not on the map, never a Needs me reason, not visible to agents.
**Slot.** `reminders` sits **after To-dos**: Needs me ¹, To-dos ², Reminders ³, GitHub
inbox ⁴, Undermap ⁵, divider, Settings (keys of inbox and Undermap shift by one).
The glyph is an 8-bit bell. The slot is plain when nothing is due or snoozed; **due**
shows a mint dot and pulses once when a reminder comes due (reduced motion: dot
only); **snoozed** shows a dim dot. The badge counts reminders due now; the accessible
name is `Reminders` or `Reminders: N due`. Amber stays Needs me's.
**Sheet.** Opens right of the rail like To-dos (same panel, peek on hover, pin on
click, remembered size). One row per reminder: name, its schedule in words
("Mon–Fri · 15:00", "Mon Wed · 09:00 · Fri · 16:00", "Daily · 10:30"), and
today's state: *in 2 h 15*, **Due · 15:00** with buttons **Done**, **Snooze 10**,
**30 min**, *Snoozed until 15:20*, *Done 15:11*, *Missed*, *Off*, *Not today*. An edit
button opens the row inline: name, one or more rules, each with weekday chips
(Mon … Sun, plus Weekdays and Daily shortcuts) and a time, "+ another time", an on/off
switch, delete; Save and Cancel. "+ Add a reminder" adds a row with Weekdays · 09:00.
**Model.** Reminders live in their own table, not in settings or workspace state:
`reminders(id, ordinal, label, enabled, rules JSON, created_at)`; a rule is
`{ days: ('mon'|…|'sun')[], time: 'HH:MM' }`; a reminder fires at most once per rule
per calendar day in the machine's local time. A first run starts with no reminders. Seeding, when a build
provides seeds, happens once (a `reminders_seeded` mark), so deleting them sticks. Per-day state `reminder_days(reminder_id, date,
due_at, fired_at, done_at, snoozed_until)` keyed by (reminder, date) makes firing
idempotent across restarts, windows and replays; rows older than 30 days are pruned.
The workspace snapshot carries `reminders: { list, today, revision }` and the
renderer reads it like plots; RPC `reminders.save` (whole list, ordered),
`reminders.done`, `reminders.snooze` (10 or 30 minutes) change it and broadcast.
**Firing.** The workspace service is the clock: every 30 s it compares local time
with today's rules and fires a reminder whose time has passed and whose day row has
no `fired_at` (a snoozed one fires again at `snoozed_until`). Firing emits a
`reminder-due` service event; main shows a native notification (title = the
reminder's name, body = its time) through the existing desktop notifications under
the **Reminders** preference below, regardless of the Needs me mode, and the renderer
shows the slot state and, while the window is focused, an **in-app notice** beside
the rail, level with the slot: name, time, Done, Snooze 10, 30 min; it stays until
acted on, until the day ends, or until the reminder is marked done from the sheet.
It shows one due reminder at a time (the next follows), is hidden while the window is
in the background or the Reminders sheet is open (whose row offers the same buttons),
and shows again on return while the reminder is still due. Escape closes it without
marking anything; it stays closed for that firing and returns when a snooze ends.
Catch-up: a reminder whose time passed while the service was not running fires on
start if less than **90 minutes** have passed on the same day; otherwise its day row
becomes *Missed*. At the end of the day an untouched due reminder is *Missed*; nothing
nags and nothing carries over. Nothing fires for a reminder disabled at its time.
**Settings.** Settings → Notifications gets one row under Needs me, **Reminders**:
"Notify with sound" (default) · "Notify silently" · "In the app only"
(`notifications.reminders`, additive; older settings read "sound").
**Accessibility.** Rows and controls are focusable in visual order; the notice is
`role="status"`; the sheet's heading is "Reminders".

**MAP-22 — Project column, Atlas and map overview.** The bottom-right corner shows
the **project column** by default; `mapCorner: 'projects' | 'atlas'` (Settings value, default
`projects`, no Settings row yet) switches it to the Atlas described below, which behaves as before.
The folded column (44 px wide, pixel panel, growing upward) has one 32 × 32 icon per project on the
Map that is not muted (MAP-25), in the project's colour with its **tag**: the initials of a name of two
or more words (first letters, at most three) or the first three letters of a one-word name, upper case;
tags that clash within the column get a trailing digit, numbered by project id. The icon's top-right
corner carries a badge only when something waits on the person: the shape of its highest such tier
(diamond Asking me, triangle My turn) and that tier's count; working agents and Finished items earn
no badge, so the column stays quiet until something needs the person. A 3 px copper left edge marks a
project with something **new since the column was last unfolded**: a Needs me row (item id and
attention version) that was not there, or a last activity later than it was; unfolding (and anything
shown while unfolded) clears it. The baseline is kept per window in the renderer, never saved; the
first projects a window shows are the first baseline. Quiet projects dim. Projects with Asking me come
first, then My turn, then working, then by last activity; at most 10 icons, then “+N”. Hovering or
focusing an icon shows a tooltip with the project's name, counts and age, its Needs me rows (at most
four, then “+N more”), its written Next line and its meta text (“2 to-dos · 1 working”, or “Nothing
open”); clicking it fits the project (as an Atlas blob click). **M**, the fold control or “+N” unfolds
it into the **Projects** panel (380 px, at most 60 % of the window, scrolls). The panel says each fact
once and spends colour only on what waits on the person. Each project row, top down: a header (a 3 px
bar and the tag in the project's colour, the name as a button that flies there, tier counts, age of its
last activity); its **Needs me rows**, each a tier mark, “title — reason” and the age it has waited,
clicking it centres the item without opening or marking it, and on hover or focus one action, **Seen**
(the same acknowledge as the Needs me sheet); a row still waiting after Seen stays, dimmed, without
Seen. Rows **group by plot only when Needs me rows lie in two or more plots** (MAP-24): a plot header
(swatch in the plot's colour and the name) flies to the plot and selects its items as a dashboard plot
row does; plots in map order (band of their topmost item, then leftmost), plots without rows left out,
then “Loose” for rows in no plot; rows indented under their header. Then the model's two lines while
Summarise projects is on (SETTINGS-AI, AGENT-07) and each exists: **Next** (copper pen, the one
recommendation) and **Status** (dimmed, one sentence on what agents are doing), both titled “Written
by the summary model”; without them nothing stands in: the rows are the facts and no local line
restates them. Last, a dimmed **meta** line with only what a person still acts on besides the rows:
“N to-dos” (open ones; opens the to-do list at the project's first open to-do) and “N working”; zeros,
done to-dos and pipeline totals are never shown. Working agents are never rows. Quiet projects (no
Needs me, nothing working, no activity for 24 h) fold into one “N quiet projects ›” line that expands.
Up and Down move through rows, Enter acts, Esc or M folds. The panel stays open beside the Needs me
sheet; with Needs me open, Esc closes Needs me first.
The panel's header holds **filters** and a **pin**, and its top-left corner a **resize grip** (drag, or
arrow keys; Home resets; 260 × 160 px at least, bounded by the window). Each project row and plot header
has a fold chevron (“Fold <name>” / “Unfold <name>”). **Needs me** (ticked by default) shows the rows
above; unticked, each project lists every item on the Map in it (no archived, Undermap or hidden-plot
items; muted projects stay absent), grouped by plot in map order with a header per plot, then “Loose”;
in each group items waiting on the person first, then by title; a row shows the item's icon, title and
state (Asking me, My turn, Working). Type chips, all on by default, hide items and Needs me rows of their
kind: **Agents** (agent and terminal sessions), **PRs** (pull requests, code reviews, review runs),
**Rollouts**, **Tickets** (Linear), **Notes** (notes, to-dos), **Other**. The panel stays open while an
item is open, and M toggles it then too; an item row opens its item (closing the open one), a project or
plot row closes the open item and flies there. **Pinned** (“Keep the projects panel open”), it also stays
open with Needs me, To-dos, Reminders, the GitHub inbox or the Controls card, moving left of an open rail
panel, and Esc and row clicks leave it open; M closes it and unpins. Size, folds, filters and the pin are
saved in `view.projectsPanel`. src/graph/project-column.ts builds the model from `projectDashboard()`; the column
re-renders only when its model changes, never with the camera. On the
Undermap the column is not shown (Needs me and Working pause there) and M does nothing; with
`mapCorner: 'atlas'` the Atlas keeps its Undermap behaviour.

With `mapCorner: 'atlas'` the bottom-right locator is the **Atlas**
(220 × 150, pixel panel). It draws each project as a coarse pixel blob in its own colour and each
item as a glyph that reads in monochrome: idle dot, a mint working spark (6 × 6), and for
unread Needs me the 8 × 8 shape of its tier with a dark rim (diamond Asking me, triangle
My turn, dim dot Finished; the same unread state as the Needs me control; one amber
concept, no red). Done items without attention are hidden. The
area outside the camera is dimmed behind a framed viewport; a footer names the
project under the camera centre (“Near …” between projects) with its working and
Needs me counts. Bounds come from projects and items only, never the world origin
or window size, and follow committed layout rather than drag previews. Clicking a
blob fits that project; clicking a badge centres its item without opening it or
marking it seen (like “Go to item on map”); dragging pans live; clicking empty space
centres there. Hovering a blob or badge shows a tooltip above the panel; hovering a
Needs me entry brackets its badge (STATE-02). The Atlas is one focusable group:
arrow keys choose projects spatially, Enter flies there, N visits the next badge.
From 20 projects, or when idle dots would sit under 3 px apart, idle dots are
dropped; a project's Asking me and My turn badges collapse into one mark in the shape of
the highest tier with their count beside it when they overlap or from 20 projects.
Finished dots are never counted or merged and go where idle dots go. Past 12 projects the
corner Atlas marks each Asking me or My turn badge with a single 4 px pixel in its tier's
amber instead (no shape or count, so project colours stay visible); the counts remain in the footer and the unfolded overview. The static layer is memoised (a few paths per project, one path
per glyph kind), so its node count does not grow with items and only the frame and
footer follow the camera. It is dimmed when everything already fits on screen and
shows a placeholder when the layer is empty. In Undermap the panel uses the
Undermap tint (the tile is that tint over the deepest surface, not black) with
the Undermap's darker project colours, no badges (Needs me pauses below) and a
“N items below” footer. The viewport frame and its corners are clamped inside the
tile. The canvas shows no React Flow corner credit (`proOptions.hideAttribution`);
Settings → General → About credits React Flow (MIT licence).

Workspace keys come from one registry (`WORKSPACE_SHORTCUTS`) and pause in text
fields, terminals, menus and modal dialogs; rail sheets keep them. The number keys
count the hotbar slots from the top and act as a click on that slot: **1** Needs me,
**2** to-dos, **3** GitHub inbox, **4** Undermap, **5** Settings. They are derived
from the rail's slot list (`rail-slots.ts`), so a slot added there takes the next
number (nine at most; **0** resets zoom). **N** and **,** still act on the Needs me
and Settings slots. **T** toggles the
to-do list, **U** travels to Undermap and back, **/** focuses the Undermap's find field while below (MAP-18), **+ / − / 0** zoom in,
out and to 100%, and **?** opens a Controls card that lists every
key from the same registry (Escape closes it). Keys an item view handles while it has
focus are listed there under Views: **[** folds or shows a rollout's jobs rail, and **⌘E**
does Close and mark seen (STATE-02) while the open item is in Needs me, also from inside a terminal.

Pressing **M** (a workspace shortcut, ignored in text fields, terminals and dialogs)
or the Atlas's expand corner unfolds it into the **map overview**: the same
renderer at 440 × 292 with project names on blobs, a project list with working and
Needs me counts (Needs me first), a Map / Undermap switch that travels layers with
the portal's travel, and the hint “Click to fly · drag frame · ←→ projects · M /
Esc”. Choosing a blob, badge or project row flies there and folds the overview back
into the Atlas; M or Esc closes it. It stays open while travelling layers, is hidden
in full item view, and is never open at the same time as the Needs me sheet:
opening either closes the other. Hover peek is not used.

**MAP-23 — Far zoom.**
Only projects not cut by the viewport edge, and the one whose field covers most
of the viewport, get the full two-line title. A partly visible neighbour shows a
single-line plate at 70% opacity with no ··· and no counts, except the Asking me and My
turn marks with their numbers when either is above zero; this state is a DOM attribute, so
panning re-renders no cards. The project title's second line gives the three Needs me tiers
and Working, each as its mark, number and word, omitting zeros (“◆3 asking · ▲3 my turn ·
■2 finished · ✦4 working”). The title has only these two lines (a 300 × 48 px footprint,
348 px wide when all four counts show): the PR pipeline strip, its
ready/failing counts and recency appear only on the project dashboards, not in
the title. The Atlas uses the same counts.

Items keep their saved positions. With dashboards **off**, cards shrink toward
46 × 46 between zoom 0.75 and 0.45 and become title-less icons below about 0.55;
the neighbourhood tier starts at 0.65 and the icon (overview) tier lies below it.
With dashboards **on** there is no icon-only band above the dashboard threshold:
the neighbourhood tier starts at the threshold (at most 0.65) and the card shrink
ramp moves down with it, so items look at the threshold as they do at 0.65 with
the default, and only below it (floating items outside any project) does the icon
tier begin. Map rendering, far-zoom badges/dimming/fly-to-click, Escape zoom-out,
note far mode and the zoom bar all derive the tier from one function
(`zoomLevel`/`zoomDetail` in `src/graph/spatial.ts`) that takes the dashboard setting. A saved threshold equal to the former 0.45 default moves to
0.65 once on upgrade (the store cannot tell it from an unchanged default); a later
choice of 0.45 is kept. In the icon tier each icon carries
a **status badge** at its bottom right: a rimmed plate with a distinct 8 × 8 glyph
from the first indicator (the mint working spark for a working item without one), so state reads
in greyscale. The working spark is one static 8 × 8 glyph, a four-point star tilted off
the axes so it never reads as “+” (which keeps meaning add or more); dashboards, plot
chips and tallies, the project header, the Atlas and these badges all draw it, and the
card's grass and sheep stay the only working motion (VIS-03). Glyphs are
decorative; accessible names keep the words (“2 working”, “1 asking”). **Takeover rule:**
from 16 px on screen an icon that needs me keeps its type icon, wears its tier frame as a
ring that stays 2 px or 1 px on screen and carries the tier shape in its top-right corner;
under 16 px the shape replaces the icon and frame and face are dropped, because a corner
mark would be a few pixels. Working icons keep a still mint stripe below the icon, solid
under 16 px,
and done or merged items stay visible but dimmed until hovered or focused. In the
icon tier clicking an item flies to it at neighbourhood zoom without opening it or
marking it seen; a second click, a double-click or Enter opens it. With
SETTINGS-DOUBLE-CLICK-WEB on, a double-click on an item with a web page opens that
page instead, without flying or opening the item view. The neighbourhood tier
and above are unchanged. Footprint name tags, priority label placement, plugin short keys and
bundles are not part of the map.

**Project dashboards** (“Status board”). Below the dashboard
threshold (SETTINGS-DASHBOARDS; default 0.65, where cards would otherwise turn
into title-less icons, so the ladder reads card → dashboard) each neighbourhood keeps its pixel field and colour, but its items, their
links and its title are replaced by the project's dashboard. Zooming back above
the threshold returns them; a ±0.01 band keeps a zoom resting near the threshold
from flickering. The dashboard is a pixel panel in screen space (constant 11–16 px
text, a project-coloured top edge) centred in the neighbourhood's on-screen bounds by default, or pinned to their top (16 px inset) when Settings → Map → Placement is Top,
clipped to the canvas and clear of the tool rail, the connection status, Undermap portal,
zoom bar and Atlas; several projects each get their own without overlapping. Its
header is the project name (a button that goes to the project) with “active 3m
ago · 26 items”. **Needs me · N** lists the project's unread Needs me entries in the
Needs me order (tier shape first, title, the reason in its tier's amber and the age as
text; Finished rows are unfilled; the same unread state, not marked seen by the
dashboard). N is the counted number (Asking me + My turn); with only Finished entries the
heading reads “Finished · N”. Working rows lead with the spark; **Working** lists working agents with their
summary and age; **To-dos** lists the project's open to-dos (the to-do list's
entries for that project: checklist to-dos whose attached items all belong to it,
and its map tasks, in list order) under “To-dos · 3 open · 2 done”, completed ones
collapsed into that count; each plugin **pipeline** (PRs) shows one cell per resource and
its states as glyph + count + label (“1 checks failing (1 yours) · 3 approved”);
each plugin **tally** (tickets) counts resources by state, or says “Status not loaded” when no state is known yet. A working row without a summary shows only its age. Sections come in that
order: what waits on you, what is running, then your own next steps, ahead of the
aggregate PR and ticket lines; room goes to rows in the same order. Each section can be
turned off (Settings → Map → Dashboard sections, SETTINGS-DASHBOARDS); the PR (pipeline)
and ticket (tally) lines are **off by default**. A section that is off takes no room and
is left out of the full, split and compact forms; its data is not shown anywhere on the
dashboard, except that with Needs me off the header keeps the tier counts (“◆1 asking ·
▲3 my turn”) (Needs me is the attention surface, so it can be hidden but never silently), plot rows,
block headers and chips keep their need/working counts, blocks still rank by their Needs
you and working rows, and a PR row under Needs you still previews without the PR line.
Plots off also means the dashboard is not split by plot. With every section off a dashboard
is its header alone (name, the Needs you count, recency and item count). With one shown plot a **Plots**
section (MAP-24) follows To-dos: “Plots · N”, one row per shown plot with its sprout
glyph in the plot's sign tone (MAP-24), name and right-aligned counts (each tier's shape and number, the mint spark and “1” working, then its item
count; zeros omitted), plots with Needs you first, up to four rows. A plot row flies to
its plot at zoom 0.8 and selects its items; pressing and dragging it moves the project
like any other part of the dashboard. Empty sections are
omitted; long lists end with “+N more”. When the room is narrower than 300 px or
too short for Needs you, a compact form shows the name, Needs you, working and
open to-do counts, item count and, when PRs are on, the pipeline strip with ready/failing counts
(otherwise the first ticket tally's count when tickets are on).
A to-do row's checkbox completes it with the to-do list's command (a map task's
item completes); its 25 px pointer target swallows the press, so pressing the box
never drags the dashboard, and only the box toggles; its title flies to the map task, or to the single item a
checklist to-do is attached to, and otherwise opens the to-do list with focus on
that row. **PR previews:** each strip cell is a button (compact strips too) that
flies to its PR like a row; hovering or focusing a cell, or a PR's Needs you row,
shows a small card beside it: icon and title, repository and number (the plugin's
frame title) with the author, the status with its glyph, unread reasons, other
indicators (e.g. “1 unseen comment”), failing check names, linked items with
their type, what still blocks it (“Blocked by #64 Thumbnail refresh loop”, LINK-04)
and when it last changed. A blocked PR's strip cell carries a coral underline. It uses saved workspace state and the
plugin's locally saved snapshot only (never a provider read); leaving, blur,
Escape or pressing on the dashboard hides it, and it never renders per frame
while panning. Rows are
buttons: clicking or Enter flies to the item at zoom 0.8 (which shows items again)
without opening it; the next click opens it. Arrow keys, Home and End move between
a dashboard's buttons; right-click opens the project menu; wheel over a dashboard
zooms the map. Dragging a dashboard (its background, a row or a cell) moves its
project exactly like dragging the project title: once the pointer travels past
4 px the dashboard and field follow it (grab/grabbing cursor, the map does not pan,
hover previews close), release commits one move of the project and its members,
and the click that would follow is swallowed; a shorter press is still a click.
Escape during the drag puts the project back. Floating items stay far-zoom icons with badges;
links with a hidden endpoint are hidden rather than drawn to a dashboard edge.
In Undermap's Classic layout, projects below show dashboards in the Undermap tint without Needs you
or Working (background work and Needs me pause there); the Mirror layout shows the plate of MAP-18 instead. The zoom bar (MAP-07) marks
the threshold with a mint tick labelled “Dashboards below 45%”.

**Split by plot** (plot blocks). When a project shows **two or more** plots (MAP-24: plots
on, the project's switch on, not hidden, at least one non-archived member), its
dashboard stays one panel but the Needs you, Working, Plots and project-wide PR
sections are replaced by one **block per plot**: a band lightly tinted in the plot's
color over the card, with a 3 px bar in its sign tone (MAP-24) at its left edge; rows keep their ink, so
Needs you amber and working mint still stand out. Its header is the plot row (sprout, name cut with “…”, tier shapes with numbers, mint
spark and N, item count; click flies to the plot at 0.8 and selects its items), then that
plot's Needs you rows (Needs me order), Working rows (newest first) and to-dos, then
its own compact pipeline line (“2 PRs”, a 6 px-cell strip and the states with
“(N yours)”) when Pull requests is on; a block without PRs, or with PRs off, has no PR line. A **Loose** block (caps label, no
tint, no click) comes last with the same rows and PR line for items in no shown plot
(loose, in a hidden plot or past the plot cap), and keeps its header whenever it has
items, so block counts add up to the header total. A plot's to-dos are its map tasks
and checklist to-dos whose attached items are all in it (all loose → Loose); a to-do
attached to items in several blocks, or to none, goes to a **To-dos** section after the
blocks. Ticket tallies, when on, stay project-wide after that. **Order:** blocks with Needs you
first, by the position of their highest row in the Needs me order (so the first amber
row is the first Needs me entry among plots), then blocks with working agents (most
recent first), then quiet blocks; ties by map position (top in 120 px bands, then
left), never by name, so a rename only changes text; Loose always last. **Room:**
rows are handed out across blocks in the unsplit order: Needs you (up to five) and the
Loose header, the first two Working and to-do rows, headers of the remaining plots,
pipeline lines, tallies, then up to four Working and to-do rows; a block that gets a
row gets its header, and one with more rows than its share ends with “+N more”.
Header-only plots that do not fit fold into one line “+3 quiet plots · Docs refresh,
SSO rollout, …” (“+N more plots” when one of them has work) before any Needs you row
is dropped. The compact form adds one line of plot chips (sprout in the plot's sign tone, first word of the
name, then the shape of its highest tier and its Asking me + My turn number, or the mint spark and N), in block order, cut by width; a chip flies to its
plot. Dragging from any part (headers included) moves the project; arrow keys,
Home and End walk headers and rows in visual order. A plot appearing, dissolving,
hiding or being renamed is an ordinary content change: one re-render, no motion; a
newly formed plot's block is outlined once in its color. With zero or one shown plot the
dashboard is unchanged, including the single Plots row.

**MAP-24 — Plots.** (A garden patch, with a Plots section at far zoom.) A **plot** is a group of a
project's items that are linked or sit close together. Detection is automatic.

*Links.* Items of one project connected by links (reference, context or
blocks, through any number of items) are always in the same plot, however far apart
they sit and however many they are: a linked group is never cut down by size or by
its share of the project, and **two** linked items are already a plot. The one
exception is a link between two plots that **already exist**: it never joins them, so
linking a card of one plot to a card of another leaves both as they are, for as long
as they stay linked. "Already exist" means the plots of the previous recompute (the
saved plots, so it holds across a restart); when a project has no plots yet, two
proximity clusters of 3 or more items count as existing plots. An item in no plot that
is linked to a plot joins it, together with everything linked to it that is in no
other plot. Such a loose chain that reaches several plots joins exactly one and never
merges them: the plot with the fewest link hops from the chain's items (summed over
the items), then the smallest footprint gap, then the lowest member id. When a link is
removed, members that are no longer linked or near fall out; a member left with only a
link into another plot joins that plot. Two plots separated by this rule stay separate
even if the link that first joined their halves is added again; dragging a card of one
within the join gap of the other merges them (proximity), and their links then keep
them together. Links to other projects' or floating, archived or Undermap items play
no part.

*Proximity.* Two members of the same project are neighbours when the gap between
their detailed footprints is at most **72 world px**, and the connected components are
**clusters**. A member already in a plot leaves its cluster only once its gap to the
rest of that plot exceeds **120 px**, so small nudges never split a plot. A cluster
holds at most **12** items and at most **60%** of its project's items; a larger one is
a pile, not a group, and each of its items stands alone (the 120 px rule never makes a
pile: where it would, the 72 px clusters decide). Clusters join plots as a whole
through any link of their members. A cluster with no link is a plot from **3** items,
and a project keeps at most **6** plots: linked plots always, then unlinked ones
largest first with a stable tie-break. So a project can show more than six plots only
when more than six are linked groups, and a plot can exceed 12 items or 60% only
through links.

Floating, archived and Undermap items never count; done items do. Detection is
settled: recomputing with its own result changes nothing. Plots are
recomputed by the workspace service on each committed revision (drops, placement
commits, membership changes, links saved or removed and at load), never during a drag,
pan or zoom. Patches and signs stay drawn while an item is open; the open item covers
only what lies under it.
After a recompute a plot keeps its id, name and sign spot when it shares at least half
its members (Jaccard ≥ 0.5) with a previous or recently dissolved plot; otherwise it is
new. Geometry is never persisted; plot identity, names, hiding and the per-project
switch are kept in SQLite (`plots`, `plot_projects`, migration 18; colors, migration 28).

**Pinned members** (Move to plot): a person can choose membership. Right-click on an item
or a selection on the map offers **Move to plot ▸** after Move to project: the plots of the
project every selected item is in, by name in map order (hidden ones as “Name (hidden)”), the
plot every selected item is already pinned in checked and unavailable, then a line and
**New plot**. With items of several projects, or an item in no project, the submenu holds only
the unavailable line “Items in one project only”. Picking a plot pins the items in it; New plot
makes a plot of exactly the items, named like any other (the local fallback until Name plots
names it). Pinning into a plot with no pinned members yet also pins the members it shows, so the
plot stays the one the person picked rather than moving its identity to the new item. An item is
pinned in one plot at most: pinning it in another unpins it. An item pinned in a plot (and a
selection all pinned in the same plot) has **Remove from plot**: the item is unpinned and follows
detection again; a plot whose last pinned member is removed is an ordinary plot from then on and
dissolves if detection does not keep it. A plot with pinned members is a **pinned plot**: its
pinned members on the map are always its members wherever they sit, one member is enough, and it
keeps its id outright. Detection treats them as one linked group that is never cut by size or
share, never merged with another pinned plot and kept first among the six plots of a project; an
unpinned item near a pinned member (72 px, or 120 px for an item already in the plot) or linked
to one joins the plot as it would join a linked group, and leaves again by the same rules, so a
detected plot whose items sit next to a pinned member becomes part of the pinned plot. Pinned
members moved to another project, below or archived are left out while they are, the pin
is kept and they come back when they return; a pinned plot with none on the map is dormant and
never reclaimed by another group. The sign of a pinned plot shows an 8 px pin glyph in the sign
tone between the sprout and the name, and its tooltip starts “Pinned · N items”. Pin, create
and unpin are person-only `plot` requests (`pin` refused for items outside the project or a plot
of another project); pins are stored per plot (`plots.pinned_member_ids`), and `PlotView` gains
`pinnedMemberIds`, the pinned members it holds.

**Look:** each plot is a tinted patch on the neighbourhood's 24 px world grid: a quiet
tint in the plot's color (about 0.13 inside and 0.07 on a one-cell edge ring, so the
ground still shows through and the plot reads as a variation of its place; hover lifts it
to about 0.19 and 0.1) of the cells
within one cell of the members' footprints, clipped to its own project's field. Members
a little apart (linked parts up to 240 px from each other) share one patch, so a plot
reads as one field with nothing dark between its members; only members further than
240 px from the rest get a patch of their own, each clipped the same way, with
nothing drawn between them, so a long link never paints over unrelated cards. No
outline, dashes, amber or selection colour, and never drawn on cards, so Needs me,
working rims and selection are unchanged. One small **signpost** per plot (a neutral
plate with a 3 px bar in the plot's sign tone at its left edge, 8 px sprout glyph in that tone,
constant 11 px name, 2 px post into the patch) sits at the first of six
spots on the edge of its largest part (of equal parts the one with the lowest member id; top and bottom × left, centre, right) that covers no card,
project title or other sign, preferring the spot crossing the fewest links; a valid
spot is kept so the sign does not wander, and with all six covered it sits at the
plot's inner top-left behind the cards. Names longer than 24 characters are cut with
“…” and shown whole in the tooltip. During a drag the patch follows its members and
the sign keeps its spot. Below the dashboard threshold (MAP-23) patches and signs are
hidden and the dashboard is split by plot (MAP-23); with one shown plot it lists that
plot in its Plots section.

**Colors** (a tinted patch, a swatch row and biome-native palettes): a plot has one of six color **slots**, stored by the ids `rose`, `sky`,
`citron`, `orchid`, `clay`, `slate` in this order. The project's neighborhood color decides
what each slot shows, so changing it repaints the project's plots, still all different:

| Neighborhood | Slots 1–6 |
| --- | --- |
| Grassland | Buttercup `#f2c94c`, Daisy `#f6f6ee`, Fern `#4f8a52`, Bluebell `#8fa8e8`, Bark `#a07a4a`, Sage `#c4dcb4` |
| Woodland | Moss `#8fa868`, Acorn `#c27a3a`, Pine `#3f6f3a`, Birch `#f4ece0`, Toadstool `#c8473c`, Honey `#e6c27e` |
| Mountain | Quartz `#f0f0f0`, Slate `#6f8296`, Lichen `#a8b878`, Iron `#d9a987`, Flint `#4a4a52`, Granite `#c8a8a0` |
| Tundra | Snow `#ffffff`, Glacier `#3fa9a2`, Aurora `#b8a0f0`, Fox `#f0a03c`, Fjord `#3f6f9a`, Frost `#c9f2ee` |
| Ocean | Foam `#dce6fb`, Lagoon `#6fd6cf`, Coral `#f08aa8`, Kelp `#5fae6a`, Sandbar `#e8d8a8`, Abyss `#24387a` |
| Geode | Crystal `#ecdcfd`, Violet `#7a52b4`, Rose quartz `#f0a8c8`, Citrine `#f0d878`, Obsidian `#2e2442`, Opal `#a8e0e0` |
| Badlands | Sandstone `#ecd2ac`, Ochre `#e09a4f`, Rust `#8a3a2e`, Sagebrush `#9aa878`, Bone `#f6efe4`, Mesa `#d97a6a` |
| Desert | Dune `#f8f0d8`, Cactus `#5f9a54`, Terracotta `#c8623f`, Turquoise `#4fb6b0`, Dusk `#b88ab8`, Driftwood `#9a7a4a` |
| Swamp | Lily `#a8dc7a`, Murk `#2f6a64`, Reed `#d4c47a`, Mud `#6a4a32`, Bloom `#ec9cc4`, Mist `#d6ece4` |
| Nether | Lava `#ff9a3a`, Ember `#ffd45a`, Ash `#8a7a78`, Soul `#6fe3e6`, Crimson `#d8303a`, Bone `#eee2cc` |

A custom neighborhood color (any other `#rrggbb`) computes its six from its own HSL: hue
offsets −25°, +25°, −55°, +55°, −90°, +90°, saturation at least 0.45, lightness its own plus
0.08 held within 0.62–0.74. Each is named for the 30° hue band it lands in (Red, Orange,
Yellow, Lime, Green, Jade, Teal, Sky, Blue, Violet, Magenta, Rose, bands centred on 0°,
30°, …), so the six never share a name. The plain neighborhood style uses the same
palettes. A slot's **sign tone** draws its signpost bar and sprout and the dashboard's
plot bars and sprouts: the color itself, or at HSL lightness below 0.5 the same hue and
saturation at lightness 0.62, so dark slots (Pine, Obsidian, Abyss, Murk, Mud) stay visible
on the dark sign plate. Patches and the dashboard's block band use the color itself.
The Undermap keeps each project's own palette. A plot without a color (slot) takes the first one no other plot of its project shows; other projects may reuse
colors. Past six plots (only through linked groups) colors repeat: the plot takes the color
whose nearest plot is farthest from its members, then the first in palette order. New
plots are colored in detection order, so the result is deterministic. The color is stored
with the plot and travels with its identity like its name; another plot appearing or
dissolving never recolors the rest, and a plot reclaiming a dormant identity keeps its
color unless a plot that stayed shows it now. A person's color (the sign menu) overrides
the assigned one, survives recomputes and restarts, and may repeat another plot's: both
keep theirs. **Automatic** clears it and the assigned color returns. The sign menu's color
row is the shared colour picker (COLOR-PICKER) in its compact form: the six slots, then
**More colours** for Your colours and **Custom colour…**. A person's color may be a custom
`#rrggbb` (`chosenColor` holds a slot id or the hex, lower case): it is drawn as it is,
its sign tone computed the same way, and the plot keeps its assigned slot for the
assignment of the others.

**Signpost:** hover or focus brightens the patch, dims other cards to 50% and shows a
tooltip (name, item count, Needs me and working counts). Click or Enter selects the
plot's items (Shift adds them to the selection). Dragging past 4 px moves the items by
the same delta as one `nodes.move` revision; Escape puts them back. Double-click or F2
renames inline (Enter saves, Escape cancels, an empty name hands it back to
automation). Right-click or Shift+F10 opens **Select items · Rename plot… · Name
automatically**, then a **Color** section, then **Move plot to ▸** and **Send plot to Undermap**,
then **Hide this plot**. The Color section is a
row of the project's six swatches (one radio group named “Color”; each swatch is named and titled by its
color's neighborhood name, the shown one is ringed and checked; Left/Right walk the row, Up/Down treat it as one
stop, Enter, Space or a click picks) and below it **Automatic · <assigned color's name>**, checked
while no color is chosen. Choosing a color or Automatic is the person-only plot operation
`color` (`color` null for Automatic). A hidden plot shows again once its membership changes
enough to be a new plot; the project menu lists **Show hidden plots (N)** and a
**Show plots** switch for that project.

*Moving a plot.* **Move plot to ▸** lists the map's projects like Move to project
(MAP-26), the plot's own project checked and disabled, then **No project**. A project
sends all the plot's items as one `nodes.send` block led by its first member: they keep
their layout and land beside the target's items. **No project** is `nodes.send` with
`projectId: null`: the items leave their project together, keep their layout and land
beside the project's items but off its ground, never inside another neighbourhood; an
item already without a project stays put. The plot keeps its identity, name and chosen
color in the new project when its items form a plot there again (a record that left
another project is reclaimed by member overlap, as a dormant plot is); items without a
project form no plot. **Send plot to Undermap** sends every member with the selection's
Send to Undermap.

**Names:** a plot shows a local name until it has another: a ticket or PR reference
shared by two or more titles, otherwise the word most titles share, plus the count
(“Billing · 4 items”), or just “4 items”. With Name plots on (SETTINGS-AI), the
service asks the tool-free Haiku title helper (one turn, 32 output tokens, thinking
off) for 2–4 words of at most 24 characters describing the shared goal, from up to 12
member titles with their type and, for agents, their existing short activity summary,
plus the project name; never terminal output, note bodies, diffs or comments. Names are
lazy: only plots the map has shown are named, most recently shown first, 30 s after
their membership last changed, at most every 10 minutes per plot and inside the shared
hourly and daily allowance; failed attempts count, KEEP or an unusable answer keeps the
current name. A user's name is never replaced and follows the plot through identity
matching; **Name automatically** hands it back and asks at once. Plot names are not
agent context (LINK-01); the MCP map read lists shown plots read-only (`id`,
`projectId`, `name`, `memberIds`, `generated`) and agents cannot rename, hide, name or color
them. Settings → Map → **Show plots** (on by default) hides every plot and pauses
naming.

**MAP-25 — Mute a project.** (Night.) Mute is a **display
preference on one project**. It changes what the app shows and announces and almost
nothing about what runs: agents, terminals, AI titles and MCP are untouched, and no
attention is acknowledged. Provider polling of an item that only muted projects show
slows to the longest step of its cadence (an item also placed in an unmuted project
keeps the ordinary one, and an unconfirmed change still reads every tick); unmuting
reads such items on the next tick and starts their cadence over. A muted project stays
where it is on the map.

**State:** `mutedAt` (a timestamp) on the project node, set and cleared by the shared
command `project.mute { id, muted }`. It is one revision, survives a restart, and is
kept through Undermap and Archive and back. Old data reads as unmuted; there is no
migration. Items take the state of the project they are in now: moved in, an item goes
under the cover; moved out, it shows as it is. **Only a person mutes or unmutes:** the
reducer and both MCP transports refuse `project.mute` from an agent with the
human-only message, so an agent cannot hide its own questions. Agents read `mutedAt`
in the workspace read and otherwise read and write a muted project as before.

**On the map:** the neighbourhood is drawn in a night blue-grey and covered by one
static layer: the field's own pixel bands as an opaque veil, flat silhouettes where its
cards are (lighter for notes) and a few fixed stars. The layer is above the project's
own cards and links and below every other project's cards and plates; a link that
leaves the project is cut where the veil begins. Covered cards are not painted, cannot
be hovered, focused, dragged, selected or connected, and their working rim does not
run. Plot patches and signs of a muted project are not drawn. The **name plate stays**
with its swatch, name and ··· menu; its second line is a moon and **Muted** in dim ink
instead of counts, and its accessible name is “*Project*, muted”.

**Looking inside:** while the pointer rests on the covered neighbourhood for **180 ms**
with no button held, no menu open and the window focused, the **whole cover draws
back** and the real cards show as they are, including their Needs me tiles and working
rims. A pointer that only crosses the project opens nothing. Leaving closes it after a
**320 ms** hold; re-entering within the hold keeps it open. Keyboard focus on the plate
reveals in the same way, and **Show on map** from a muted Needs me row flies there and
reveals for a few seconds. Cards under a drawn-back cover are still look, don't touch.
Looking changes no count anywhere.

**Unmuting:** a plain left click (no modifier, under 4 px of travel) on the
neighbourhood **once the cover has parted**, about 0.4 s after the pointer arrived;
never a click before that, a pan, a right click or the click that focuses the window.
Also: the plate's Muted chip, which reads **Unmute** on hover or focus; **Unmute
project** in the project ··· and right-click menus; **Enter** on a focused muted plate;
**⇧M** on a focused plate (which also mutes). After unmuting, the notice corner says
“*Project* unmuted”, how many of its items need you, and offers **Undo**.

**Muting:** **Mute project** in the project ··· menu and the right-click menu of the
project or its neighbourhood, above **Send project to Undermap**. With items waiting
it reads “Mute project (Needs me: 2)”. Not offered in Undermap.

**Motion:** minimal for everyone. Nothing drifts, twinkles, slides or loops. Muting,
unmuting and the reveal are one linear opacity change of at most 150 ms; with
`prefers-reduced-motion` there is no transition or animation at all. The dwell and the
hold stay in both cases, because they are about intent.

**What mute silences:**

| Surface | Muted project |
| --- | --- |
| Plate counts, card tier shapes and frames, working grass and sheep, blocked badges, plots | Hidden; the cards are true again while the cover is drawn back |
| Far-zoom dashboard (MAP-23) | Name, item count and “Muted” only; never Needs you, Working, To-dos, plots or pipelines. The cover is still drawn |
| Project column (MAP-22) | Absent: no icon, no row, never summarised; unmuting brings it back and queues its summary |
| Atlas and overview (MAP-22) | Dim hull with a moon, no item marks; footer and Projects list show “Muted” instead of counts; N skips its items |
| Needs me button and Dock badge | Count only unmuted projects |
| Needs me panel | Its rows collapse into one line **Muted · N** below the counted rows; opening it shows the rows with Seen and Map. An item also placed in an unmuted project stays counted through that alias |
An item that still waits on the person after its alert was seen (a question, a review
request, an approval gate, a failure) stays listed as a dimmed row without the Seen
action and is never counted; it is the fallback Next when no alert is unseen. The strip
leaves out zero counts: no to-dos line without to-dos, no done count at zero, no empty
pipeline stage. Rows end in an ellipsis and the strip wraps, so nothing runs past the
panel's edge.
| Native notifications and sound | None for its items; open banners close when it is muted; unmuting announces nothing |
| Bottom-left finished and unblocked notices | None for its items |
| To-do list | Its to-dos leave the list, by when and grouped by project (Next, Later and Done), and return when the project is unmuted. Triage is unaffected and Send to project works; agents still read them |
| Startup recovery (AGENT-06) | Agents of a muted project are not resumed at startup, and unmuting does not start them; each stays resumable from its item |
| An item of it that is already open | Stays open and usable; Mark seen still works |
| Undermap | No cover and no Muted plate there; it returns muted |

Not built: the optional “! N waiting Xh” safety valve on the plate, timed mute, and a
“N muted” total in the Atlas footer.

**MAP-26 — Move to project.** Right-clicking any item card on the map (agent,
terminal, PR, rollout, ticket, Notion, Slack, note, bookmark, artifact, to-do…)
offers **Move to project ▸** with the map's projects in to-do-list order. Archived
projects and projects in Undermap are left out; the project the item is in is
checked and unavailable; a floating item has none checked; with no project the
submenu says so. The list comes from the workspace snapshot, so it opens at once.
A muted project is listed like any other. Not offered in Undermap or on projects.

*Selection.* When the right-clicked card belongs to a selection of items, the entry
moves the **whole selection as one block** that keeps its layout around the
right-clicked card, whatever projects the items came from; the project is checked
only when all of them share it. Items already in the chosen project stay where they
are. A selection that contains a project does not offer the entry.

*What moves.* Only the chosen items: linked items stay behind and every link is
kept. A to-do card (or an item kept in the to-do list) is the exception and brings
its attached items exactly as in TODO-10. The block lands on the first clear spot
beside the project's items (right, below, left, above, stepping outward) or on an
empty project's anchor, never inside another neighbourhood and without moving
anything else. Ids, resources, content, session history and running processes are
untouched; a running agent or terminal keeps running in its working directory (the
new project's default directory applies only to sessions created later). Plots,
counts and the to-do list follow the new membership.

*The view follows.* After the move the map flies to the right-clicked item's new
position with the motion of Show on map (none under reduced motion, zoom 1), leaves
the moved items selected and opens nothing. In a muted project the item lands under
the cover, which parts for a moment as for Show on map; the project stays muted.

One shared command, `nodes.send { ids, projectId }` (first id leads; `projectId: null`
takes the items out of their project, see MAP-24 Moving a plot), does this
atomically in one revision for the app and for agents through `workspace_apply`,
under the same policy as other transfers. It refuses archived or Undermap targets,
non-project targets, projects and archived or Undermap items among `ids`, and
duplicates; a target every item is already in changes nothing. The to-do **list**
row keeps the name **Send to project** (TODO-10): it also places list-only and
Triage to-dos that are not on the map yet, creates their items, and leaves the
camera alone because the list is the place being worked in.

**MAP-27 — Copy URL and arranging item menus.** *Copy URL.* Every item that has a web page
(the URL its **Open on …** entry opens: pull request, rollout, Linear ticket, Notion
page, web link, bookmark, Claude artifact, and any plugin type that declares
`webLink`) has **Copy URL** directly after that entry, on the map and in Undermap.
Types without an Open on … entry today (Slack message, workflow review, code review)
get Copy URL when they gain a `webLink`, with no further change. It puts that URL on the clipboard through the main
process, which accepts only http(s) URLs without credentials, exactly as opening
does. The menu closes and the notice corner says **URL copied** for a few seconds.
Copying opens no view and no browser page, records no opening and acknowledges
nothing, whatever “Opening an item marks it seen” says. An item without a web page
(note, to-do, agent, terminal) or whose URL cannot be built from its saved data has
no such entry. When every item of a selection has a web page, the selection menu
leads with **Copy URLs**, which copies them one per line in the order the items are
stored; one item without a page removes the entry. The expanded view's header
already links out with Open in …; it has no copy control.

*Order, separators and hidden entries.* Each item type's menu can be arranged in
Settings → Items → Right-click menus (SETTINGS-11): its entries reordered, its
separators moved, added and removed, and single entries hidden. Entry ids are
stable: `open`, `connect`, `plugin:<group id>` for a provider group, `open-web`,
`copy-url`, `convert`, `edit`, `send-project`, `add-todo`, `auto-title`, `complete`,
`below`. Entries that replace each other by state share one slot, so both take the
same place and hide together: Mark done and Reopen (`complete`), Turn into todo and
Remove from to-dos (`add-todo`), every Convert to … (`convert`).

Saved per item type id, all empty by default:

- `menus.layout`: the menu's rows in order, a JSON array of entry ids and `---`
  for a separator. No entry id can be `---`.
- `menus.hidden`: the entry ids (slots) the menu leaves out.
- `menus.order`: the shape saved before separators were rows, entry ids only. It
  is still read (see *Earlier saved orders*) and never written.

The default layout is the default entries with a separator at each default group
boundary (basics, provider actions, opening and settings, housekeeping), so a menu
nobody arranged draws exactly the separators of MAP-18. The shared menu model
applies a saved menu, not the window, with one rule for all types:

- saved ids the menu does not have (a removed plugin action, an entry absent in
  this state or while a setting is off) are ignored and kept in the saved lists;
- an entry a saved layout does not name (added by a later version or a plugin
  update) follows the entry it follows by default, in that entry's block. It
  brings **no separator**, also when it starts a new default group: a saved
  layout's lines are only the ones the user placed. A type nobody arranged has no
  saved layout, so there the new group gets its default separator;
- no saved layout, or one that names nothing the menu has, is the default menu
  unchanged;
- the menu never draws two separators in a row, nor one first or last. Separators
  left next to each other by hidden entries or by entries this item does not have
  fold into one, so a saved layout may hold doubled or dangling `---` rows;
- a hidden entry is left out with its submenu; its row keeps its place in the
  layout. A type's last visible entry cannot be hidden, and a menu whose every
  present entry is hidden draws them all rather than opening empty.

*Earlier saved orders.* A `menus.order` list converts when read: its entries in
the saved order (the rule above for missing ones), with a separator wherever two
neighbouring entries belong to different default groups, which is what such an
order drew before. The menu is therefore unchanged by the upgrade. The stored
list is left as it is until that type's menu is next changed in Settings; saving
then writes the converted rows to `menus.layout` and removes the type from
`menus.order`.

*Scope.* A saved menu applies to the menu of a single item on the map. A
selection's menu, a project's, a neighbourhood's, a connection's, a plot's, every
Undermap menu and the entries inside a submenu keep their own order and show every
entry. Hiding removes no capability: the action stays in those menus where it
applies, in shared commands and MCP, and in the item's view where the view offers
it. **Item settings…** hidden from a type's map menu remains in that item's
Undermap menu and in views that mount an edit control; Settings itself is reached
from the rail, so a hidden entry can always be shown again.

**MAP-17 — From URL creation.** All URL-originating types share one **From URL**
choice in both picker layers and shortcut settings; remove individual PR, Slack,
Notion, Linear and Web link choices. Paste a URL and show the detected provider
before attaching. Use installed plugin matchers, prefer a specific provider over
Web link, and use Web link for other HTTP(S) URLs. Equally specific matches require
an explicit inline choice; an unavailable provider stays visible with its connection
error instead of silently becoming a Web link. Detection performs no provider read
or write and creates nothing. Fetch the authoritative title only on attachment.
Preserve the original placement, project and optional relationship. Editing the URL
invalidates previous detection and retry state. Existing saved URL shortcuts project
to one From URL entry at their first position; retain unrelated/missing preferences,
resource/plugin identities and existing item editing.

Dragging an HTTP(S) link from another app onto the map opens this same From URL
form with the URL prefilled, using the drop location and containing project
(floating outside a neighborhood). Browser link/address and plain URL text drops
use the same provider detection. Dropping creates nothing and performs no provider
request until attachment is confirmed. Reject files, unsupported schemes and
non-link text without navigating away. Keep an existing creation/edit draft and
native input/expanded terminal interactions intact. When a link payload contains
several URLs, use its first supported URL in this single-item form.

### Visual identity

**VIS-01:** Use restrained crafting-table-inspired pixel bubbles: stepped rounded
edges, subtle bevels, hard shadows and quiet earthy surfaces. Use the selected
compact copper workbench with cyan, gold and orange linked inset tiles and a
golden spark rising above them, on a rough cocoa dirt-and-stone backing with
large, distinct square pixels. Leave generous visible pixel-tile space between
the workbench and the outer border. Do not copy game assets. Text uses readable
sans serif type;
do not use pixel fonts for content. Remove the full-width app header and its
product/workspace text. Use the selected product icon only for the macOS
application/Dock icon; do not display a floating product icon on the map.

**VIS-02:** Type identity uses consistent icon/color cues. Agents and Terminal are
large; PRs are medium; boxes are small attached icons; Linear, Notion, Slack, Web link, to-dos,
reviews and artifacts are compact. Linear retains enough width for identifier and
title. Notes are paper tiles whose text is the card face (RES-09); paper colour is
decoration and never status, and there is no yellow paper. All types have usable
hit targets; to-dos edit in place instead of opening
full content surfaces.
Use Claude, Linear and GitHub marks for their respective providers; retain a
generic fallback. Status must not rely on color alone.

**VIS-03 (Grazing; replaces the underline and gear):** On the map a working
card grows grass and keeps a sheep. Tufts one or two pixels tall, at 2 px a pixel, stand on
the inside of the card's own bottom edge in the card's own colour (its type tone, or the
paper's edge colour on a note), in an irregular pattern that is the same on every render. A
7×4 pixel sheep (14×8 px) in the brightest mint, its head a shade darker, walks along that
edge at about 8 px a second, legs at about six frames a second, turns at each end and faces
the way it walks. It eats: the tufts at its mouth and behind it are gone, come back as
stubs a little way back and stand again once it has passed; at each turn the grass behind
it is whole again. Everything moves in 2 px steps; nothing is tweened. The grass belongs to
the item and the amber frame is about me (STATE-02), so a card that works and needs me
shows both, and nothing in the mark is amber; on an Asking me card the grass and the sheep
are drawn over the thick frame's bottom band. On a light note paper the sheep is drawn dark
so it can be seen. The sheep needs an 8 px band inside the bottom edge that nothing the card
says reaches. A card narrower than 120 px or lower than 44 px, every tiny card, and a card
whose title or summary reaches into that band (a card tightened by zooming out, for one)
keeps the tufts, 4 px, and gets a small mint glint that runs through them in steps instead
of a sheep. A far-zoom icon keeps its still mint stripe below the icon. **Flock:**
a working item shows one sheep plus one for each helper it has busy (`helpers` on the node,
AGENT-07d): a Claude session with two busy subagents has three. The bottom edge is divided
into equal paddocks, one sheep each, so they never meet; each walks its own stretch out of
step with the others and eats its own bite. A paddock is at least 44 px of edge, so the
width caps the flock: `min(1 + helpers, floor((width - 18) / 44))`, never fewer than one,
which is four on a 200 px card. A glint card stays a glint card. The mark's accessible name
is “Working”, “Working, 1 subagent” or “Working, N subagents”, and the card's tooltip says
the same with the real number, also past the cap. Reduced motion and Undermap show the same
number of sheep, standing. An item without helpers, including every Codex session and
every item that is not an agent, keeps exactly one sheep. **Asleep:** while the item itself only waits on its
helpers (`waiting` on the node, AGENT-07d), its own sheep, the one in the first paddock,
is asleep: lying down, three pixels tall, a little way into its paddock, not walking and
not eating, its tufts whole. A two-by-three-pixel z rises beside its head in three 2 px
steps over 1.5 s every 3 s, mint and then dimmer, and is gone until the next. The helpers'
sheep graze as before, and the cap never drops the sleeping one. The name and the tooltip
then read “Working, waiting on 1 subagent” or “Working, waiting on N subagents”. Reduced
motion and Undermap show the lying sheep without the z; so does a card whose text comes
within 12 px of the bottom edge. A glint card is unchanged. On a light note paper the lying
sheep and the z are dark like the standing sheep.

**States.** The mark
says more than Working. An agent card shows it whenever the node carries one of the states
below, also while it is not working; a card of any other type is unchanged. Everything is
drawn from plain node state (AGENT-07e), never from summary text, at 2 px a pixel with the
same sprites.

| State | What the card shows | Node state | Signal |
| --- | --- | --- | --- |
| Permission prompt (A1) | The sheep stands at a closed amber gate and nudges it | `pose: gate` | PermissionRequest, permission notification |
| Question or waiting for me (B2) | The sheep faces out of the card and blinks | `pose: asking` | AskUserQuestion, idle prompt, a Codex input request |
| Stopped with an error (C1) | The sheep lies on its back; one leg twitches | `pose: fallen` | StopFailure, error attention |
| Compacting (H1) | Wool flies off, the sheep is thin, the wool grows back; loops | `pose: shearing` | PreCompact … PostCompact |
| Running a command (D3) | The sheep pushes a block along its paddock | `pose: command` | A Bash tool in flight for 1.5 s; shown for at least 3 s |
| Waiting on helpers (W1) | The sheep sleeps (above) | `waiting` | Turn ended, helpers busy |
| Working | Grazing (above) | none | Any other tool or none |
| Idle beside a shell or watcher (F2) | No sheep; a small pinwheel turns on a post near the right end | `beside: n`, not working | Background shells and watchers in the last snapshot |
| Session ended (G1) | No sheep; the tufts have grown tall | `pose: ended` | SessionEnd, or the item's session is not running |
| A helper finished (E1) | A sheep trots out past the right edge | `moment: leave` | The helper count fell |
| A helper started (E2) | A sheep walks in from the right | `moment: enter` | SubagentStart, or the helper count rose |
| A tool failed (I1) | The sheep stumbles once and carries on | `moment: stumble` | PostToolUseFailure |
| A tool was denied (J1) | The sheep walks into a fence and bounces back | `moment: bump` | PermissionDenied |
| Tasks done (K1) | One flower per finished task at the right end; the newest opens | `tasks: { done, total }` | TaskCreated, TaskCompleted |
| Another model (L1) | The sheep wears a small bell | `bell` | PostModelSwitch |
| In a worktree (M1) | The sheep grazes inside a small fenced pen | `pen` | The session's working directory is a Claude worktree |

When several apply, the item's own sheep shows the first of gate, asking, fallen, shearing,
command, asleep, grazing; ended and the pinwheel apply only when none of those does and
the item is not working. The pinwheel, the flowers, the bell and the pen compose with the
pose where a sheep stands or walks; the moments play once on a grazing card. Only the item's
own sheep, the first paddock, changes; the helpers' sheep graze. Amber is used for the gate
alone and nothing is red. The flowers take at most a third of the edge (12 px each) and the
sheep keep to the rest; the pen is at most 68 px of the first paddock. The gate, the pen,
the pinwheel, the fence, the wool and the twitching leg rise above the sheep's 8 px: a card
whose text comes within 12 px of the bottom edge shows the pose without them. A glint card
shows none of this, and a card that is not working and has no room shows no mark. Reduced
motion and Undermap show each pose's resting frame and play no moment. The accessible name
and the tooltip say the state in words: “Needs your permission”, “Waiting for your input”,
“Stopped with an error”, “Compacting”, “Working, running a command”, “Idle, 1 background
task running”, “Session ended”, with “, 3 of 5 tasks done”, “, on another model” and
“, in a worktree” appended where they apply. The mark replaces the
spark pip on cards only; the spark stays the Working mark in rows, counts, plates, the
Atlas and the far-zoom badge. Keep explicit “Working” text beside the short summary where
the size supports one. CSS animations set up once on the map draw all of it: there is no
per-card timer or canvas, no rim and no surface tint; a card reads its own layout once when
it renders to know whether the sheep has room. A working far-zoom icon leaves
out its sub-pixel stepped edge, and tier marks get their dark keyline from the glyph's own
stroke rather than a filter, so a 500-item map pans as before. The mark never intercepts the
pointer, the resize grip or the “+” handle, and never covers the card's text, the corner
slot or the reason line. It is not drawn on an expanded view; it pauses behind an open item and
under a mute cover, is skipped off screen, and stands still (tufts and a standing sheep, or
tufts alone on a card too small for one) with reduced motion and in Undermap.

**Working animal:**
Settings → Map → Working chooses the animal for every card's mark: **Sheep** (default) or
**Raccoon** (`workingMark.animal`). A change applies to every card at once, without a reload,
and is part of the settings MCP reads and writes. A plugin package may preset it (target `app`,
plugin API 1.3): once per workspace, only while it is still the default. The raccoon is 9×4 pixels in three tones,
its grey fur (legs included), a dark band over the eyes with dark tail rings, and pale ear
tips and muzzle; light note papers draw it dark like the sheep. Each pose keeps the sheep's
beat, place and words: it forages the tufts with the same bite and regrowth, its swathe two
pixels wider; it rattles the amber gate; it faces out and blinks; it lies on its back with a
leg twitching; while compacting it washes its paws, two `--act-info` drops rise, and it carries
on; it pushes a small trash can for a command; it sleeps curled up under the z. The bell, the
pen, the tall grass of an ended session, the pinwheel, the flowers and the moments are the
sheep's. A raccoon needs a 50 px paddock instead of 44 px, so a card fits fewer of them; with
Sheep chosen every number above is unchanged. **Helpers** (Kits / Same size, default Kits,
`workingMark.helpers`) is shown only while Raccoon is chosen: kits are 7×4, so a helper's
paddock has two more places to stand. Reduced motion and Undermap show each raccoon pose's
resting frame as they do the sheep's.
Agents/terminals show a very short activity summary. Reduced-motion
preferences retain the still tufts and sheep and other working cues but disable motion
and shorten/skip camera transitions. Keyboard focus and action alternatives must
support opening, moving, connecting, and managing items.

**CARD-CUES — Card status cues.** A card's status cues keep a fixed priority (the
plugin's order). When the row runs out of width a cue never truncates: later cues
first switch to their glyph plus leading count (“3” with the comment glyph), or the
glyph alone; the full label stays in the tooltip and accessible name. The type
eyebrow is dropped on cards shorter than 80 px. A collapsed card's title takes every
line the card has left under its other rows (type eyebrow, summary, fields, status
cues) and only the last line that fits ends in “…”; it never shows fewer than two
lines where it showed two before, and a short title is unchanged. Summary and field
rows keep their own clamps, and text never changes a card's footprint. The count is
measured only when what the card shows or its size changes, never while panning;
while a card shrinks between zoom levels its title keeps two lines, and compact and
far-zoom cards are unchanged. Rows a type marks as tight keep their single line.

**VIS-04 — Hover feedback.** Hovering an item or project bubble visibly highlights
it in the restrained Minecraft-inspired visual language: a crisp stepped pixel
outline and a slightly brighter beveled edge/surface. Preserve the type's color cue,
readable text and status indicators. Keep hover distinct from selection and provide
equivalent visible keyboard focus. Clear pointer highlights/line emphasis on exit;
mouse focus must not retain keyboard inspection. Hover and keyboard inspection
never enlarge items or reveal a temporary content preview. Keep the saved map
footprint and content stable, including while zooming. Do not mount live content,
start sessions, fetch providers or reflow neighbors on hover. A real pointer
departure or pan clears inspection; zoom must not leave stale emphasis behind.
Use a quick restrained color transition, with no soft glow or bounce; reduced
motion skips it. Do not repeat an item title beneath it on hover/focus or in a
native title tooltip. Keep its name in the bubble and accessible label; connection
meaning and attention hints remain.

**VIS-05 — Direct map item resizing.** Resize individual items continuously by
dragging a small pixel grip at the bottom-right of their map bubble. The grip
appears on hover or keyboard focus, with a diagonal resize cursor, once zoom shows
item details. No right-click Size submenu. Keep the visible top-left corner fixed
as the bottom-right follows the pointer, accounting for semantic zoom and camera
scale. Connections, neighborhoods and displaced neighbors update during the drag;
commit the new dimensions and collision-safe positions atomically on release.
Escape, pointer cancellation or window blur discards the transient preview. The
grip supports arrow keys (8 world pixels; Shift for 24). Resizing does not open,
drag, connect or edit the item; suppress camera zoom during the gesture.

Preserve native defaults exactly: agents/terminals 240×112, PRs 200×84, Linear
240×64 (48-pixel compatibility floor), to-dos 220×48, notes 160 wide (S/M/L 160/220/300, height from their text) and box badges 48×48. See the complete
[type/content matrix](item-map-sizes.md). Settings → Items → [type] retains the
supported preset dimensions, default tier and Reset map sizes; Claude/Codex remain
independent groups. Existing saved tier choices keep their effective dimensions.
New custom dimensions persist on each map alias independently of its resource,
other aliases and expanded-view preferences. Custom dimensions take precedence
over preset dimensions. Settings saves still resolve growth collisions atomically;
Cancel changes nothing. No startup layout rewrite or destructive migration.

Content follows the largest supported preset that fits the custom dimensions,
falling back to its smallest presentation. Only saved summaries and declared public
fields appear; no provider fetch or model call is triggered by sizing. Larger
notes are wider (their height always follows the text: 3–14 lines, a stored height is ignored, so a vertical drag of the grip changes nothing and the top-left corner stays put); larger PRs show status/repository/number. To-dos keep
one editable line (Small presentation, at most 72 pixels tall), and boxes remain
compact badges (32–96 pixels per side). Other types use their declared minimum
footprint and a maximum of 640×480. Validate limits in the renderer and shared
UI/MCP command. Projects retain their neighborhood title, with no resize grip.

Semantic zoom continues simplifying items. Below the readable zoom a note keeps its
paper size and shows its generated title (about 12px on screen) with checklist
progress or a line count; far away it is a paper square with the fold. To-dos stay
inline editable. Done items keep their size, grip, content and links; the
struck-through title, the corner check (LIFE-02) and a type's completed icon mark them. Resizing does not change
membership, links, resource data, camera or session identity. Expanded items use
their existing separate view dimensions and have no map resize grip. Legacy tier
commands remain compatible and clear a custom dimension override; unsupported new
choices fail without mutation, while unsupported old tiers resolve to the native
default without deleting saved data.

## 4. Data, links, status, and lifecycle

**DATA-01 — Separate identities.** A project, resource, map node, explicit link,
provider connection, execution workspace, and runtime session are distinct.
Moving or aliasing a resource does not clone its external object or running process.
An item can have one project membership or be floating. Membership is independent
of informational/context links.

**DATA-02 — Project working directory.** Projects have an optional local working
directory. Every new item with a working-directory input copies it as an editable
default, including Claude, Codex, Terminals and skill runs. Plugin metadata declares
this default so future types share the same behavior. UI and MCP use the same
default when the directory is omitted; explicit choices take precedence. The chosen
directory is saved with the item/launch. Changing the project or membership later
does not move existing sessions or retarget a retried launch. Resume/reconnect uses
the session's saved/native directory. When neither the input nor the project names
a folder, a new launch uses the global default (SETTINGS-WORKING-DIRECTORY) if it
still exists, then the most recent launch folder; only with none of these does it
require selecting one. The same order prefills UI forms and applies to MCP/agent
creation that omits the directory. Managed review workspaces remain owned
by their review run, which has no user-selectable working-directory input.

**DATA-02a — Recent working directories.** Each successful new Terminal, Claude,
Codex or skill launch records its real path in a durable most-recent-first list of
10 distinct folders (SQLite, survives restart). Resumes and review workspaces do
not add entries. Listing drops
folders that no longer exist. The desktop bridge exposes only the paths. Every
working-directory field (new Agent, Terminal, skill run, project settings and the
global default) is one shared field: type any path, pick from the labelled project
default, global default and recent folders, or **Choose folder…** for the native
dialog. New-launch forms prefill the project folder, then the global default, then
the most recent folder.

**LINK-01 — Relationship meanings.** Informational links connect related objects;
directed context links target an item whose plugin accepts context. Direct sources
remain identified separately. Agent context is centered on the agent item: a
parent-first inventory of items connected to it, directly or through other connected
items, so an attached PR carries its linked reviews, notes and tickets. Its project
contributes only its title/summary and a short title-only list of other members as
background; archived and Undermap items are excluded. The opening "What next" turn
orients on this connected work. Informational relationships are
background, not permission to act. Do not traverse unrelated projects by membership
or map proximity. Preserve link kind/direction and show cross-links explicitly.
New connections automatically give context whenever an endpoint accepts it. Prefer
the drop target when both do; if only the drag source accepts context, reverse the
arrow to point toward it. Use an informational link only when neither endpoint
accepts context. Dropping onto an existing item saves immediately, without a
relationship menu. Plus-to-create uses the same rule for the selected/new or resumed
item; the keyboard alternative chooses the other endpoint and a kind (Context,
Reference or Blocks), defaulting to what a drop would make. Its endpoint is a
searchable combobox grouped by project with item icons, the chosen or browsed target
gets the hover ring, the dialog opens clear of both endpoints and the map chrome,
and Kind is a segmented control with a one-line meaning for the selected kind. Duplicate,
self-link, stale-state and cardinality errors reject the operation without silently
falling back to information. Preserve the meanings of existing saved links and
explicit links supplied through shared commands/MCP.

**LINK-02 — Cardinality.** A plugin declares `one` or `many` distinct partners;
`many` is the default. Validate
both endpoints, both directions,
both link kinds, and all aliases of a resource. Several link kinds to the same
partner still count as one partner. Project membership is excluded; links to
archived/done resources still count. Reassignment requires removal/replacement
of the existing connection and cannot silently discard it.

**LINK-03 — Connection display and removal.** At every zoom, show explicit item links only. Project membership is conveyed by
the outline and title, without lines to a central project anchor. Draw connections
as direct straight lines between the facing boundaries of the displayed bubbles,
following their center-to-center direction. Do not route through fixed left/right
ports or add elbows/detours. Context arrows point toward the receiving item;
reference lines stay undirected. Endpoints follow moving
or resized/compact bubbles without crossing their content. Preserve the wide
interaction area and existing link meaning. When a project has more than 12 links
(counted per endpoint project), its non-blocking links rest at 35% stroke opacity;
links of the hovered, focused or selected items return to full strength, and
inspection still mutes the rest. Blocking links never fade, and sparse projects
keep full-strength links. A user can right-click an explicit line to remove it, with a wide hit area and an undo action.
Removal preserves both items and membership and is also available through MCP.

**LINK-05 — Hover links.** A link may be saved with `reveal: "hover"`
(`link.save`, creation connections and MCP). It keeps its kind, direction and meaning, so a
hover context link still gives context, but the map draws it only while it is revealed:
either end is hovered, keyboard-focused, selected (Shift-click or marquee) or open; the
link itself is hovered, keyboard-focused or highlighted; or a menu for the link or an end
is open. Otherwise it is transparent and takes no pointer events, on the map and in the
Undermap alike. Moving the pointer from an end onto the line keeps it shown, so its menu
(Make blocking, Remove connection) stays reachable; it also keeps its place in the tab
order and shows on keyboard focus. Hover links do not count toward the dense-project
resting threshold (LINK-03). Plots still group their ends (MAP-24), plot signs still avoid
them, and the Atlas draws no links. Rollout validation links use it (see Rollout observation, Trigger validation and Start a new agent);
schema 26 marks those saved earlier: each context link labelled “Validation” with a rollout
at one end. Every other existing link stays drawn.

**LINK-06 — Implied connections.** When A connects to B and B to C, the map
leaves out the line from A straight to C: the path already shows it. Only drawing changes;
the link stays saved, and agent context, blocking, plots (MAP-24), MCP and everything else
that reads links see it as before. A link is implied when a path of two or more other
drawn links joins its ends. A blocking link needs a path of blocking links that follows its
direction (A→B→C implies A→C, not C→A). A reference or context link takes a path of any
kinds: context links in it follow their direction, reference and blocking links count both
ways. So two pull requests in a blocking chain keep one line to the agent that made both,
and a reference or context path never hides a blocking link. Hover links (LINK-05) and links
not drawn at the current view (archived, Undermap, covered or dashboard-replaced ends) are
no path; implied links still are, so a longer chain hides every shortcut along it. Later
links are tried first and each one hidden stays a path for the rest, so in a cycle or
between two equal paths only one link goes and the same links always give the same lines.
An implied link is revealed exactly like a hover link (either end hovered, focused,
selected or open, the line itself, its menu) and does not count toward the dense-project
threshold (LINK-03). Removing a link of the path, or an end leaving the view, draws the
implied line again. The result follows the set of drawn links only, never the camera or
item positions. Settings → Map → Connections → **Hide implied connections** (on by
default) turns this off and draws every link.

**LINK-07 — Hidden items.** A first-party service may keep an item it starts
off the map while it works (`hiddenAt`, with a short `hideLabel` such as “validation agent”
naming it in menus). A hidden item is live: its session runs, it reports through its launch
binding, its links stay saved and its agent context, MCP reads (`workspace_read` lists it
with `hiddenAt`) and connected-agent lists see it as before. Only the map leaves it out: no
card, no line to or from it, no obstacle for placement, layout or overlap repair, no path
for implied links (LINK-06), no part of a project's activity or Needs me, and no
notification. Hidden is not archived and not below: nothing pauses. The item menu of
anything linked to a hidden labelled item offers **Show <label>** (the most recently hidden
one, also when it was archived meanwhile); choosing it clears `hiddenAt`, restores it from
the archive if needed, places it beside the item the menu belongs to by the shared
in-context placement (MAP-14) and flies the map to it with it selected. An item with a
`hideLabel` on the map offers **Hide <label>**. Archive lists a hidden archived item and its
Restore shows it. Hiding and showing (`node.hide`, `node.show`) and creating an item hidden
are human-only: agents are refused. The flag is an optional field, so no migration.

**LINK-04 — Blocking links.** A `blocks` link is directed: its source must be
finished before its target (e.g. one PR must merge before another). Create one in
the keyboard connection editor (Kind: Blocks) or turn any link blocking from its
menu (right-click or Shift+F10 on the line: Make blocking, which names the
direction; on a blocking link: Make normal, Reverse blocking). MCP agents use
`link.save` with kind `blocks`; unknown kinds are refused. Self-links (including
aliases), a second blocks link for the same pair and cycles are refused with a
reason (“A already blocks B, through other items. This would create a blocking
cycle.”); a pair may also keep a context or informational link. A blocker is
**resolved** generically, never per type: the item is marked done, archived,
deleted, or its plugin indicator reports the finished stage (a merged or closed
PR, a done or cancelled ticket, a passed rollout). Agents and terminals have no
finished stage, so they block until marked done. An unresolved blocking line is
dashed coral with a stop bar across the blocked end; once resolved it turns
dotted, grey and dim. Hovering or focusing it outlines both items and the tip
says “A blocks B” (· resolved). A blocked item shows a small coral stop badge
whose tooltip and accessible name read “Blocked by #64 Thumbnail refresh loop”
(plugins may declare a short reference such as `#{number}`); its full view
header lists “Blocked by” chips that go to each blocker. When the last blocker
resolves the badge disappears and a quiet notice says the item is unblocked; it
never raises Needs me. Agent context entries carry `blocks` / `blockedBy` facts
(resolved blockers marked); a blocking link or a blocker's resolution changes the
context material, so it is offered again.

**STATE-01 — Independent dimensions.** Keep observed activity, connection state,
attention, and user lifecycle separate. An archived item can still have a running
process; marking done is a user decision and provider refresh must not undo it.
Unknown/disconnected observations must not be presented as confirmed completion.

**STATE-02 — Needs me.** This is the only attention concept. Finished agent turns,
completed reviews, waiting agents, errors requiring action, newly assigned PRs,
PRs whose current head commit has failing checks (PR-05) and rollouts whose current
validation failed or has concerns contribute unread reasons to it. Count a resource
once even if it has aliases or multiple reasons. Project/global rollups exclude
archived items and expose why attention is required. Viewing a waiting agent does
not satisfy its input request. New attention on a done item must still be discoverable.
A single Needs me control opens a live list of deduplicated items and their reasons;
choosing one zooms to the item and opens it. The list closes from its X, Escape, its
button or a right click on the map (MAP-21), not from a left click on the map. **By default opening never marks attention seen**: not from this list, the map (click, Enter, double-click), a completion
notice, a native notification, a dashboard row or a provider page link. **Per item
type, opening can mark it seen**: Settings → Notifications has one group,
“Opening an item marks it seen”, with a checkbox for every registered item type
(built-in and installed, sorted by name, with All / None), all off by default and saved
as `notifications.seenOnOpen` (item type ids; ids of types no longer installed are kept
and ignored). This is the only place the behaviour is decided: there is no per-item or
per-project toggle and item packages do not choose (`manualAcknowledge` stays inert).
For a checked type, a person opening an item of that type sends the same
acknowledgement as Mark seen, aliases included. Opening means any of: card click,
Enter, double-click, the item's open icon, a Needs me row, a dashboard row, a
completion notice, a native notification click, Open in the item menu, a link to the
item from another view, inline editing of an inline item, and the item's web page
(“Open on …”, double-click-to-web, browser-activated types). It applies only while the
ACT window is focused and visible. An open made while the window is in the background
(a notification click arrives just before focus) is acknowledged when the window
gains focus, provided that item is still open and no newer attention arrived in
between; otherwise it stays unread. Never acknowledging: the hover preview, “Show on
map” and opens the app makes on its own. Attention that arrives for the item open
in the focused, visible window is acknowledged as it arrives, for every item type and
whatever this setting says: the person is looking at it, so it never enters Needs me
(it is listed under Earlier). An item that was already waiting when it was opened is
left alone, and nothing is acknowledged while the window is in the background. For
checked types Mark seen therefore does not appear after opening; for unchecked types
it appears as before. Without this setting, Needs me
clears only through an explicit acknowledgement: the labelled “Seen” button inside
the list row (dismiss without opening), a middle click on the item's map card or its
list row (also without opening in the app; an item with a web page opens there, see
MAP-WEB-MIDDLE-CLICK; ignored for items not in Needs me), a middle click
inside the open item's frame (it stays open; links keep their own middle click), or **Mark seen** in
the expanded item's frame bar. Mark seen is a pixel check icon button immediately left
of the close X, the same size, in the Needs me button's amber ink, fill and edge, named “Mark seen” with the tooltip “Mark seen (remove from Needs me)”. It
appears for every item frame (provider views with the shared header, agents and
terminals) only while the open item or one of its aliases is listed in Needs me,
sends the same acknowledgement as Seen, then hides. It is a fixed control like the
X and never folds into More actions. **Close and keep in Needs me** is its counterpart
for the checked types: when, and only when, opening the item acknowledged its entry, the
same slot holds a pixel close X with the tier mark of that entry in its corner, in the same
amber, named “Close and keep in Needs me”. It closes the item and puts back exactly the
cycles the open acknowledged (`attention.restore` names their versions, as
`attention.acknowledge` does); a newer cycle, a reason that has since cleared, or
closing with the plain X ends the offer, and nothing else changes. **Close and mark seen** sits
immediately left of Mark seen whenever Mark seen shows: a pixel close X with a check in its corner, in
the same amber, named “Close and mark seen” with the tooltip “Close and mark seen (⌘E)”. It sends
the same acknowledgement as Mark seen, then closes the item; **⌘E** does the same. Seen/Mark seen clears that
resource from the list across aliases, not its underlying input request, error,
process or user-done status. Persist the read state across app restarts. A later
completion or new attention event makes it unread again; unchanged polling and
replayed completion events do not. A delayed acknowledgement must not clear
attention that arrived after the user saw the entry. Unread results remain
discoverable even if more work starts. Pixel indicators and project/global counts
use the same unread state, including compact/done items.

**State language (Ladder, with Frame + underline).**
Needs me stays one list with one Seen; its reasons fall into three **tiers**, a display
grouping and never a second concept. The mapping is one constant next to the reasons
(`attentionTierOf` in `src/graph/attention.ts`) and every surface reads it:

| Tier | Meaning | Reasons | Shape | Card frame | Counted |
| --- | --- | --- | --- | --- | --- |
| Asking me | Something is stopped until I act | `input` (question, permission, rollout gate, job approval), `error` | Bright diamond | 2 px bright amber | Yes |
| My turn | Work waits on me; nothing is stopped | `review`, `assigned`, `checks-failing`, `comment`, `validation` | Amber triangle | 1 px amber | Yes |
| Finished | For my information | `finished`, `approved` | Dim dot | None; the type edge stays | No |

An item with several reasons takes its highest tier. The **Needs me number** is Asking me
+ My turn, one resource once, without archived items and muted projects: the rail badge,
the sheet, the Dock badge, the dashboard heading and the mute hint all show that number.
Finished is listed and marked everywhere but not counted, and raises no macOS banner;
Settings → Notifications → **Also count finished work** (`notifications.countFinished`,
off by default) adds it to the number and lets it raise a banner. Seen and Mark seen clear
a Finished entry like any other, and “Opening an item marks it seen” applies unchanged.
The sheet groups its rows under “Asking me · N”, “My turn · N” and “Finished · N” in that
order (Finished says “not counted” while it is not), each group the longest wait first.
**Age is text only** (“4h”, from `attentionAt`, recorded when a cycle is raised): nothing
pulses, grows or changes colour with age.

**Marks.** Every tier mark is its 8 × 8 pixel glyph (`asking`, `my-turn`, `finished` in
`pixel-glyphs.ts`); there is no text “!”, and the one umbrella “!” that remains (the rail
at zero, the Atlas column head) is the pixel `bang`. A mark always stands beside its tier
or reason in words, or names both in its accessible name (“Asking me: Needs permission”),
so the tier is never colour or shape alone. On a card the shape sits in the top-right
corner slot (the done check takes that slot only when nothing needs me), the frame repeats
the tier, and where the card has a second line it says the first reason and its age in
words (“Needs permission to push · 1m”): in the summary slot, or in place of the provider
cue labels, whose cues stay as icons. Small cards and icons keep shape and frame only. The
open item's frame bar names tier and reason next to Mark seen. Because a 2 px edge means
Asking me, **hover and an open item no longer thicken the edge**: both lift the face and
brighten the 1 px edge; selection stays the separate light rectangle.

**Amber is exclusive to Needs me**: `--act-attention` (My turn and umbrella),
`--act-attention-asking` (brighter) and `--act-attention-finished` (dim). Provider cues
that a plugin tones `amber` (Queued, Changes requested, Waiting approval, Updates paused),
stale-data marks, remote-menu marks, the to-do pin and group count and the unblocked
notice draw in neutral or info. **Wording:** “Needs me” is the one umbrella phrase;
tiers are named “Asking me”, “My turn”, “Finished”, and counts read “N asking · N my turn
· N finished · N working”. “Needs you”, “need you”, “N need”, “N waiting” and “need me”
are retired. A broken provider connection says “Not connected”, never “Needs attention”.
Not built: a “Not confirmed” mark for unknown activity, counting Undermap items, tier
marks on to-do rows, new sounds and the arrival blink.

**Ticket references on cards.** A card whose title leads with a
ticket reference and “ · ” (“BIL-128 · Plan changes”; Linear tickets today, by pattern and
not by item type) shows the words alone as its title and the reference as a quiet mono
tag at the left of its status row, before the reason and the status cue. The tag is never
shortened or amber: cue labels shorten first. The item's title itself is unchanged, so
the card's accessible name and tooltip, Needs me rows, dashboards, to-dos, search and plot
names keep “BIL-128 · Plan changes”. Where the status row shows no labels (far-zoom icons,
cards under 48 px, cards whose cues are icons, an editable title) the title stays whole,
so the reference never disappears. A type may also declare a short reference for its items (`view.reference`,
`#{number}` for pull requests): a card whose title carries no ticket reference shows that
one as the same tag, trimmed off the end of a placeholder title such as "owner/repo #48",
but only on a status row the card already has (a pull request's review state and
comments), so the declared reference never adds a row or takes title lines. The large
pull request size therefore lists the repository alone in its fields.

Every attention signal carries a short reason from whatever triggered it: plain
text, one line, sentence case, no trailing period, at most 48 characters (longer
text is cut with “…”). It is stored with its source (`attention.set` `note`,
`node.update` `attentionNote`, snapshot `attentionNote`), replaced or dropped
whenever that source changes reason or clears, and kept with each Earlier entry.
A restated reason (a replayed event or the same attention in new words) updates
the note without making a seen item unread. Copy names the trigger, for example
“Production needs approval” (a single gate whose name fits; otherwise “Job needs
approval” / “N jobs need approval”), “Rollout failed”, “Rollout finished”, “Agent
needs permission”, “Agent asked a question”, “Agent waiting”, “Agent finished”,
“Agent hit an error”, “Terminal exited with an error”, “PR approved”, “Checks
failing”, “2 new comments”, “Assigned to you”, “Validation found concerns” and
“Validation failed”. Needs me rows show the reasons after the tier shape, the
card's corner shape names tier and reasons in its tooltip and accessible name (“Asking me:
Agent waiting”), the card repeats the first reason in words on its second line, native notifications use them as the body and completion notices as
their detail. A signal without a note (older data, or an agent that gave none)
falls back to its category label (“Waiting for your input”, “Finished · ready to
view”…); a category that has a note anywhere on the item is not repeated as a
label. Agents raising attention through MCP pass `attentionNote` / `note`.

Each entry includes its saved AI/activity summary when available, separate from
the attention reason and project name. An agent's entry quotes instead the line it
ended its last turn on (`lastLine`, in italics, two lines at most, the whole line as
its tooltip): Claude's Stop hook carries the turn's last assistant message, the
service redacts secrets, keeps its last non-empty line without Markdown markers and
clips it to 160 characters, and the next prompt clears it. Only that line is stored;
the message itself is neither kept nor sent to the renderer, and every other hook
still leaves the session without text. The same line is the body of the agent's
native notification (in place of the attention details), and an agent card with room
for two or more summary lines (the large size) shows it in place of its summary, after
the attention reason; small and medium cards keep their summary. Each group heading (Asking me, My turn,
Finished, Earlier) is a fold toggle with a chevron; a folded group keeps its heading
and count and hides its rows. Folds are remembered on this Mac (browser storage, not
the workspace) and never change what is counted. Hovering or keyboard-focusing an entry
highlights its bubbles on the map and minimap without moving the camera, opening
content or acknowledging attention. Clear that highlight when the pointer/focus
leaves, the entry disappears, or the list closes. A labelled crosshair “Map” button
(tooltip “Show on map”) centers the item without opening it or marking it seen; keep the list available.
Opening via the entry's main button retains the normal view/read behavior. The list is
the Needs me rail sheet (MAP-21): it opens right of the rail, level with its top. An entry's summary drops any part that only
repeats its reason. When a hovered or focused entry's card sits mostly under the
list, its minimap box pulses (a steady thicker box under reduced motion).

The desktop connection shows nothing while connected (a status region still
announces it). Losing the desktop service shows an amber “Reconnecting…” chip
at the top right, the only thing in that corner, until it returns, then
“Reconnected” for two seconds.

The Needs me control is always present as the rail's top slot (MAP-21). With Asking me
or My turn items the slot is amber, takes the highest tier's shape and its badge shows
their count; with only Finished items it is a plain slot with a dim dot; with none it is
a plain slot in the neutral style of the Settings slot and still opens the list. Below the unread entries, a quiet
**Earlier** section lists Needs me notifications that left the list (seen,
dismissed, cleared, archived or deleted), newest first, so forgotten work can be
found again. Each keeps a snapshot of its title, reasons, trigger notes and project plus when it
was raised and seen, recorded once per attention cycle (resource and version) by
the workspace service in SQLite; it keeps the newest 100. Earlier shows only the
latest entry per item, and none for an item that currently needs you again. The list shows 10 and
loads 10 more each time it is scrolled to the end. Earlier rows are one compact
line (title · stored trigger reason, or the category label for entries recorded
before reasons were stored, then “Seen 14:02”, a weekday within a week, else the date);
project and full times are in the row's tooltip. A “Loading earlier…” row marks
the page end while more exist, and a failed page shows “Couldn't load earlier”
with Retry in its place. Opening an Earlier entry
reveals the item (travelling to Undermap if needed); an archived item explains
how to restore it, and a deleted one says it is no longer on the table.

**STATE-03 — Notification lifetime.** Bottom-left informational and success
notifications automatically disappear after about five seconds; for example,
“1 session restored” must not remain on screen indefinitely. Important errors,
warnings and messages requiring user action remain visible until resolved or
explicitly dismissed. Expiring a routine notification must never hide a newer
important message. Dismissing a notification does not clear an unresolved Needs me
reason or change the underlying operation/session state.
Successful native agent turns and completed reviews add a bottom-left notice
with the item title and an Open action, as well as the persisted unread entry.
Notices stack without obscuring one another and expire after five seconds;
expiry or the notice's close button does not mark the item as seen. Every
bottom-left notice (completion, unblocked, added/updated, Connection removed/Undo,
map error) is the same 300-pixel pixel toast with a tone glyph, at most one action
and the same pixel close. Only errors are `role=alert`; map and form errors show
one human sentence and keep raw provider/IPC text behind a Details disclosure. Reopening the
app retains unread entries without replaying historical completion notices.
Starting/attaching/resuming a session and explicitly stopping one do not announce
a successful completion. Failed/lost sessions retain their error attention.

**STATE-04 — macOS notifications.** Mirror new unread Asking me and My turn events and
bottom-left announcements into the native notification system. A banner's title names the
tier before the item (“Asking me · Cache metrics agent”) and its body is the reason.
Finished work raises no banner unless “Also count finished work” is on (STATE-02); its
quiet in-app completion notice is unchanged. The Dock badge is the Needs me number. Default to delivery
only while ACT is in the background; Settings → Notifications offers Background /
Always / Off, separate Needs me and completion-announcement switches and sound
(disabled, not hidden, while Off), and an immediate test action whose result
appears on its row. Completion notices use one native notification,
even when both switches are enabled. Existing in-app notices stay unchanged.
Do not replay saved unread events at startup or repeated provider polls. Attention
that arrives for the open item while ACT is focused and visible is acknowledged at
once; while ACT is in the background it stays unread until marked seen. Clicking
a native notification focuses ACT and opens its item when still available; that marks
it seen only for item types checked under “Opening an item marks it seen” (STATE-02).
Generic/stale targets simply return to the table. Dismissing a native notification alone never
acknowledges Needs me. Marking an item seen or archiving it removes its outstanding
native attention notification.
Delivery requires an open app and macOS permission; Focus/banner/sound preferences
remain controlled by macOS. Settings must report delivery failures without losing
in-app alerts. Notification content uses titles/status, not terminal output or
full comment bodies. Native banner delivery and click-through require manual
platform acceptance; fixture tests alone do not establish macOS delivery.


| ID | Item/project action | Result |
| --- | --- | --- |
| LIFE-01 | Archive | Hide from the active map; retain identity, layout, links and session metadata. Archive view permits restoration. Claude sessions stop when their item or project is archived, preserving history; restore never starts them. Restoring a project preserves independently archived children. |
| LIFE-02 | Mark done | Keep the item's size, opacity, content and links; strike through its title (to-dos also show a checked icon) and show a pixel check in the card's top-right slot unless unread Needs me occupies it (STATE-02: attention on a done item stays visible). A done card drops the animated working rim; its summary still reports a running process. Only far-zoom dimming (MAP-23) and the Atlas (MAP-22) treat done items differently. Permit reopening. It does not stop a process or approve a PR. Items bound to a provider that tracks completion (Linear) mirror it both ways; see Linear workflow updates. |
| LIFE-03 | Delete from archive only | Reject deletion of active records in shared UI/MCP commands. The archive offers Restore and Delete; Delete is a quiet danger action that asks inline with Keep focused before deleting a project or item. Remove the map record and dangling links/to-do references. Deleting an archived project detaches its members while keeping them archived and individually recoverable. Remove an unreferenced resource record, but do not delete provider data or stop a process. Live sessions remain reachable through session management. |

**CONNECTION-01 — Provider accounts.** Settings discovers already signed-in
provider accounts only when requested, and stores stable account bindings without
credentials. Selecting a new default does not retarget existing items. Disconnect
makes the table's bindings unavailable without deleting items or signing out of
other applications; reconnecting the same account retains its binding ID. UI and
MCP share revision/conflict handling. Choosing, changing or disconnecting an
account applies immediately rather than through Save: the service method
`connections.select` rewrites only that provider's bindings in the same revisioned,
atomic settings write that `settings.write`/MCP `workspace_settings` use, and the
open Settings draft adopts the new bindings (a draft from before an unrelated
external change still conflicts). Disconnect asks inline first. Each provider is
one list line with a status chip, account/sync/rate-budget meta, Sync now, a ⋯ menu
(Change account, Disconnect, How to connect) and its own errors. GitHub initially
uses GitHub CLI's existing accounts and credential store; expired/unavailable
accounts are explicit. How to connect shows numbered steps with copyable Terminal
commands: providers may declare optional structured `setupSteps`; otherwise the
numbered lines of the plain `setupHint` (still exposed for compatibility) are
used. Linear's steps walk through personal API key creation, the concealed macOS
Keychain password prompt (on Linux, `secret-tool`'s), Connect Linear/account selection and attaching an issue
through From URL, without collecting credentials in the renderer. Browser sign-in
remains a separate capability.

## 5. Agents, terminals, skills, and synchronization

**AGENT-01 — Real terminal.** Agent nodes display the installed Claude/Codex CLI
process through a real PTY and terminal emulator. The provider owns its interface,
slash commands, permissions and conversation. Plain Terminal nodes use the same
surface for a shell without an AI task or injected agent prompt.
Use xterm's GPU-backed WebGL renderer when available, including on macOS. Fall
back to its default renderer when WebGL cannot initialize or its context is lost;
opening a terminal must not depend on GPU support. Hidden surfaces release their
GPU renderer. Renderer changes preserve output, scrollback, input and process
identity, including stopped sessions and retained scrollback.
Screen reader support and scrollback length are settings (SETTINGS-TERMINAL).
Preserve native ANSI colors; launcher/CI color-suppression variables must not make
an interactive terminal monochrome. Place session status, directory, resume/reconnect
and stop controls in a single compact row at the top. Remove History/playback
controls from all native terminal views. Keep ordinary scrollback and stopped
output readable; this change does not delete recordings or native conversations.
For agents, group **Resume / reconnect**, **Add system prompt** and **Stop session** in a
**Session** dropdown; Stop session is its last item, after a divider, in the amber the
irreversible controls share, enabled only while the session is starting or running and no
stop is pending. An agent whose session is lost or failed also shows **Resume**
directly beside that dropdown; plain terminals keep their direct **New shell** and their
direct **Stop session** at the far right. Stopping a running agent whose turn is working asks inline (“Stop
Claude? The current turn is lost…” with **Keep running** focused and **Stop**); idle
agents and shells stop at once (VIEW-05). The dropdown supports keyboard
navigation, Escape and outside-click dismissal.
Omit redundant "Native Claude session" labels and stacked control bars. Fit every terminal row,
including the last prompt line, within the available content area after resizing.
Ctrl/Cmd +/− adjusts the focused terminal's font size only; Ctrl/Cmd 0 resets it.
**⌘F** never reaches the process: it opens a find bar at the terminal's top right
(or refocuses it, prefilled with a one-line selection). Typing highlights every match,
case-insensitive, with a “2 of 5” or “No results” count; Enter or ⌘G steps forward,
Shift+Enter or ⇧⌘G back, and Esc closes it, clears the highlights and returns focus to
the terminal. A full-screen CLI can only be searched on its visible screen.
Shift+Enter inserts a line break without submitting; ordinary Enter keeps the
CLI’s submit behavior. Agent views send distinct Shift+Enter (CSI-u) for the
native CLI to interpret. Plain terminals use a bracketed newline when supported,
otherwise the distinct key; never substitute a plain submit key.
Do not send input from inactive/stopped/read-only surfaces or while composing text.
Recognize printed HTTP(S) URLs (including wrapped URLs) and OSC 8 hyperlinks with
xterm’s link support. Hover underlines the link and shows a pointer. Left-click
opens a compact menu with **Copy link** and **Open in browser**, displaying the
actual destination. Nothing opens or copies on hover or menu creation. Links work
in stopped sessions and history; text selection remains possible. Escape/outside
click dismiss the menu, keyboard navigation works, and actions use the isolated
host clipboard/browser bridge. No arbitrary URL schemes or terminal escape text
may be executed. A link menu must not navigate away from the item or resize it.
Mouse-wheel and trackpad movement inside a terminal belongs to that terminal.
Accumulate fractional movement and preserve multi-line gestures in full-screen
CLI interfaces, without dead zones or stale movement delaying direction changes.
Each wheel event that completes a line is written at once, one report per line;
an agent CLI merges what arrives between its own frames, so the terminal queues
nothing. Handling a wheel event must not measure layout: a trackpad sends over a
hundred events a second and each measurement lays out the whole map. Keep the
cell height until a resize or font change, and keep the report the terminal
encodes for a line step until the pointer, the mouse mode or the grid changes.
Do not pace, smooth
or wait for the CLI's redraw, and do not invent momentum: agent CLIs drain and
animate their own scrolling, and a client-side queue only adds latency and
overshoot. A reversal, typing, terminal mode change, hiding, reset or read-only
transition discards the fraction of a line not yet sent. The terminal answers XTVERSION with
the app's name and version, as a terminal program names itself — not with the
emulator library's: Claude keys a wheel profile made for VS Code on the name
`xterm.js` (no acceleration, fast gestures throttled to a few rows per frame and
then a jump, three rows for any report that follows a 40 ms gap). Under its own
name the app gets the profile Claude uses in native terminals such as Warp: one
row per report when slow, accelerating with sustained speed, frames drained in
proportion. Claude probes for synchronized output only in terminals it knows,
so Claude sessions launch with `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1`; frames arrive
whole either way. Pixel mouse reports are declined so coordinates stay exact
cells. A CLI asks these questions once,
at startup, and an agent resumed at app start or launched in the background has
no view to answer them: while no view watches a session the supervisor gives
the emulator's answers (XTVERSION, the synchronized-output and pixel-mouse mode
queries, primary device attributes), and it stays silent once a view watches.
Preserve ordinary
scrollback's native viewport behavior and reading position. Native terminal
content still moves in character rows; do not transform or rewrite CLI output to
imitate pixel scrolling.
Keep the CLI's native mouse protocol/cursor-key mode and normal shell scrollback;
new output must not drag a reader away from history. An open view watches its
session: the supervisor's output and state events wake the view's reader as
soon as the CLI writes, and wheel/keyboard input wakes it too; polling only
backs up a missed notification and never waits out an idle delay after input. Closing an
agent keeps the map responsive while releasing hidden graphics resources. Recording playback never
sends scroll input to the live process. Scrolling must not move or zoom the map.
Native terminal copying must preserve Unicode box-drawing, punctuation, accents,
CJK and emoji. Finder/Dock launches supply a UTF-8 LANG fallback when missing, so
CLI-owned selection and clipboard tools agree with xterm's Unicode output. Honor
explicit locale settings; do not reinterpret already-rendered text to mask encoding
errors. New and resumed processes inherit the fallback; live processes keep their
environment until restarted. Clipboard regression tests preserve existing contents.
Hide the minimap and map zoom controls while an item fills the screen; keep the
breadcrumb and Back action for orientation.

**AGENT-02 — Launch context.** New general-purpose agents receive a short project
brief (roughly 100–150 words) and current connected-item context automatically:
project first, then items and their linked subitems (for example PR → review →
note). Include identities, relationships, activity, done state and bounded source
content. Deduplicate aliases, handle cycles deterministically, exclude archived
items, and label missing/truncated/omitted content so it can be read through MCP.
The creation form has no Task or Project brief override fields.
Persist the exact delivered snapshot. Keep trusted, versioned host instructions
separate from project facts and external material. Append through the provider's
supported instruction mechanism without replacing its built-in instructions.
For a new general-purpose **Claude** session, send an opening prompt that asks for
a short prioritized **What next** list grounded in that hierarchy. Name the relevant
items, explain why each suggestion is useful now, avoid already completed or
duplicated work and expose blockers. A completed review linked to an open PR can
lead to a suggestion to inspect/apply findings; read the actual result and compare
its captured revision before claiming specific applicable findings. Give fewer
suggestions or a useful clarification when context is sparse/unavailable. This turn
may read context and acknowledge its delivery, but must only suggest work and wait
for the user's choice; it must not implement fixes, start jobs or perform remote
writes. Native authentication/permissions still apply. Reattach, resume and recovery
never replay this opening prompt. Explicit tasks, skills and review jobs retain
their own prompt. Codex retains its existing task-free opening behavior.
Claude model selection includes Fable, Opus, Sonnet and Haiku; the installed CLI
resolves availability and reports unsupported choices.

**AGENT-03 — Keep the table current.** The host guide explains the tool, IDs,
plugin discovery, relationship rules and MCP operations. It requires immediately
registering created PRs, linking results to their agent/project in the same call (MCP-02), and updating status. It must preserve user layout/lifecycle and dedupe
provider identities. Graph registration does not provision infrastructure or move
running processes. The guide does not expand permission for unrelated external work.

**AGENT-04 — Reattach versus resume.** Opening a live session attaches to its
existing process without resending prompts or starting a second process. Resuming
an ended conversation uses its native ID and original workspace/account/model;
an unavailable session reports the reason instead of silently creating a new one.
The inline start flow defaults to **New session**, with an adjacent **Continue
session** button. Only Continue shows and loads the searchable, paged list of all
saved conversations for the selected provider (Claude or Codex) on this computer,
across working directories, including
those started outside the table. Show title, folder and last activity. Resuming an
external conversation creates a table item using its native ID and original folder;
if it is already on the table, reuse that item/live process. Preserve native model
selection rather than overriding it with the new-session default. Missing
conversations or folders fail explicitly. Continue requires selecting a conversation;
switching back to New preserves the new-session draft and clears the resume choice.

**AGENT-05 — Guide/context updates.** Queue newly connected context and outdated
guide updates for the next supported input/turn boundary, deduplicated by identity
and revision. Never type into an arbitrary permission prompt. Removing a link
cancels undelivered context; already-delivered conversation history stays intact.
Failed source reads/delivery remain visible and retryable. A new delivery is offered
only when what the agent is told about changes (items, links, titles, project brief,
guide); moving items and live activity, status or summaries do not make an offer
stale. Acknowledging any delivery the agent was offered acknowledges the current one.

**Add system prompt** explicitly queues the current workbench guide, project brief
and incoming context for an already running Claude conversation. It adds context
with the next submitted prompt, without replacing Claude's native system prompt,
typing into its terminal or starting another task/process. Explain this timing in
the menu. Resolve project/link facts at delivery so queued context stays current.
Requests survive service restart and stay bound to the selected process; a stopped
or replaced process cannot receive them. Show queued versus Claude-acknowledged
status, deduplicate pending requests and exact retries, and keep failed/unconfirmed
delivery retryable at the next prompt. The shared MCP operation uses the same
validation and queue as the UI. Unsupported providers expose an unavailable action
with a reason; reconnect does not implicitly resend the guide.

**AGENT-06 — Lifetime.** Selection and zooming do not terminate sessions. Archiving a Claude session or its map item stops its running or starting process while retaining history and resume identity. Archiving a project also stops its Claude sessions; restoring never starts a process automatically.
On macOS, closing the app window (window button or Cmd+W) only hides it: no
checkpoint, stop or quit. Sessions, polling, native notifications, Needs me and the
Dock badge continue. Clicking the Dock icon, launching the app again, clicking a
notification or Window → Agentic Crafting Table shows the same window with its
state intact (no reload). Hiding saves window placement; a full-screen window
leaves full screen first. The hidden renderer is background-throttled, so terminal
and map rendering pause until it is visible; keep-awake is unchanged. Quit (Cmd+Q,
the app menu or an application update) stops active work without asking by
default. On other platforms closing the window behaves like Quit.
Settings → General → Closing the app offers “Warn before closing with active
sessions” (default off; a saved “on” from before this default turned off once).
When on, Quit (and window close where it quits) warns that active work will stop
and offers Cancel by default. Leaving it off skips only confirmation; errors remain
visible and orderly shutdown and startup recovery remain mandatory. After confirmation (or when disabled), save a durable checkpoint of active sessions/jobs before
stopping managed processes and their tools. Do not close successfully until they
have stopped. Retain the table, layout, settings and session identities across
restarts and application updates; app updates must never create an empty workspace.

On startup, resume the agent sessions that were active at confirmed close, using
the same native conversations, project bindings, model and working directories.
Agents interrupted while working receive a continuation prompt that first reconciles
existing results; idle/waiting agents reopen without answering pending decisions.
Manually stopped agents stay stopped. Stop is available during preparation as
well as after launch: cancel pending native setup, prevent a later PTY spawn and
retain the launch identity so retry/restart cannot revive cancelled work. Closing
while a manually stopped process drains must not select it for automatic resume.
Reattach any surviving live process without
launching a duplicate. Only sessions with a current, unarchived map item are
recovery candidates. A detached session is stopped during normal shutdown but is
not restored, recreated on the map or reported as needing attention. Retire old
pending/failed checkpoints for removed items automatically, preserving their
recordings and session metadata. Skipping obsolete entries alone produces no
notification (including no “0 sessions restored” notice). Real failures for existing
items remain visible and require explicit Retry.

Plain **Terminal** items start the user's normal login shell without ACT startup
wrappers, command capture, or automatic command replay. Keep shell configuration,
plugins, history and key bindings under the shell's control. Terminals stay stopped
after app close; their output remains readable and **New shell** starts explicitly.
The former startup checkbox is removed. Ignore persisted opt-ins and retire old
terminal replay checkpoints/jobs without executing their commands. Preserve existing
recordings and agent conversation recovery. Already-running shells keep their process
configuration until the user stops them and chooses **New shell**.

Pick up durable in-progress jobs from their saved identities and reconcile external
outcomes before retrying; never post a duplicate comment or rerun a completed action.
Overlapping local session recovery requests share one pass. Closing drains that
pass and leaves unsent jobs queued; a missing launch reply retains an uncertain
outcome and its original identity for later reconciliation. Recheck each queued
candidate before launching so work settled by another operation is not repeated.
Failure to save a recovery checkpoint must leave a visible, retryable error rather
than a stuck recovery indicator or an unhandled background failure. Do not resume
sessions before the recovery-start checkpoint is durable. If storage remains
unavailable, block new launches until recovery can be saved, retain the original
request identities, and retry without repeating sessions already confirmed restored.
Persisting an error checkpoint does not count as successful recovery: retain the
launch gate until a durable recovery retry begins. Reconstruct this gate from
saved errors or an interrupted recovering phase on service restart. Queued startup
work and background watchers must honor the same gate rather than relying only
on a checkpoint's `open` phase. Reads and recovery status remain available.
Provider watchers pause on close and reconcile on startup rather than pretending a
remote workflow was stopped. Failed restores remain visible and retryable. A host
reboot or supervisor crash cannot preserve a live local process; record its real
state and distinguish native resume from live reattachment.
Stopping must not clear the visible terminal or discard session history. Keep the
stopped view readable and scrollable, including after reopening it. Preserve complete
new-session output in private local storage with bounded, paged reads; an in-memory
tail limit is not a history retention limit. Cached tails are disposable: failure
to write a cache must not stop an otherwise recorded terminal, and stale or missing
caches must not hide committed output after restart. A stopped plain Terminal offers
**New shell** in the same toolbar, starting a new process in its saved directory
while preserving the previous recording. Disable it while that shell is running.
Share `terminal.start` with MCP and freeze each request before launch; replaying
a completed request must not start another shell or change its directory.
Earlier sessions created before full
recording can only expose the output that was actually retained.

**AGENT-07 — Status and summaries.** Prefer documented provider events/hooks for
working/waiting/completion. Observers do not answer permission prompts. A fast,
configurable Claude model can summarize bounded, redacted recent output into
3–6 words. Debounce, cache, cap cost/output, reject stale responses, and fall back
to factual status. Generated prose is never the source of lifecycle state.
Summary generation is opt-in in Settings, with a configurable model and durable
per-item, hourly and daily request limits. Default to Haiku, 60 seconds per item,
12 attempts per hour and 500 per day across the table. Failed/uncertain attempts
consume allowance; restarting must not reset it. Explain that recent output is
sent through the configured Claude account and that redaction is best effort.
Limit each helper to one tool-free turn and bounded evidence/output; keep the
cache private and exclude raw terminal evidence. Explicit edits and newer native
state must win over pending generated labels.

**Project summaries** (MAP-22) are a helper of the same kind: for each project on the Map that is not
muted (never one below), the service builds a reduced input from its dashboard (name, tier counts, Needs
me titles and reasons, Working titles with their activity summaries, open to-do titles, plot names,
pipeline counts per stage; with two or more plots each Needs me and Working row names its plot; never
terminal output, note bodies, diffs or comments; at most ~2,000 characters, lists trimmed from the end,
Needs me last) and fingerprints it without ages or times. It asks Haiku for two labelled lines (96
output tokens, thinking off, one tool-free turn, at most 60 words together): `Next:` one action for the
person naming one item of the project, and `Status:` one sentence on where it stands, per plot when
rows carry plots. The reply is parsed into `{ next, status }` (a reply without labels is a Status; each
line plain, Next ≤ 140 and Status ≤ 240 characters). **Grounding:** Next is kept only when it mentions an
item of the input, a Needs me or Working title as a case-insensitive substring or one of a title's words
of four or more letters; otherwise it is dropped and the column shows the top Needs me row instead. It
asks once the fingerprint has been unchanged for 60 s, at most once per 10 minutes per project, never
twice for the same input, from the shared allowance while leaving 4 requests to the other helpers.
`project_summaries (project_id, fingerprint, attempted_at, text, model)` keeps the latest lines as JSON
`{"next","status"}` in `text` (a plain-text row saved before reads as Status), which stays until a newer
attempt is answered; a failed or unusable answer still counts. Both lines reach the renderer in
`snapshot.projectSummaries` with their own revision. The lines only describe; tiers, counts and the rows
come from attention state.

**AGENT-07b — Background work.** A Claude item whose main turn has stopped while
its process still runs background subagents, teammates, workflows or other background
tasks stays working. Its summary names what it waits on, e.g. “Waiting on 2 subagents”
or “Waiting on 1 subagent · 1 workflow”; other kinds read “teammate(s)” or “background
task(s)”. **Background shells and Monitor watchers do not count**: they
run beside the prompt, may never end and end without any signal, so an item that left
only those behind is finished and idle like any other ended turn, and they are left out
of the “Waiting on” summary when other work is outstanding. If one of them wakes the
agent, its new turn makes the item working again. It returns to idle, “Ready for your next prompt”, with the normal
finished Needs me, at the first main-thread Stop that reports no work in flight,
not at the earlier Stop. While waiting, Claude's idle-prompt notification does not
raise Needs me and an interrupted-turn quiet period does not mark it idle. A
background subagent finishing updates the count; at zero the summary reads
“Claude is working” until Claude's own Stop after it reads the results. Scheduled
wakeups (`/loop`, cron) are not background work. The count is per process session,
survives a service restart, is discarded at SessionEnd, and no longer counts after
two hours without any hook from that process. Readiness for queued prompts is
unchanged: a quiet terminal can take a prompt while background work runs. Codex
items keep their native thread status.

A teammate is different from the other kinds: Claude lists it as running for as
long as its session lives, also while it waits for a message. Only a busy teammate
keeps the item working and is counted in “Waiting on N teammate(s)”. A teammate is
idle from Claude's TeammateIdle hook until it starts a tool again or the main
thread sends a message (`SendMessage`); the mark is matched to the listed teammate
of that name, and a mark that matches none takes one teammate off the count.
Without that hook a teammate counts while one of its tools is in flight, and for
five minutes after its last tool, after it was first listed or after the main
thread's message. When the main turn has ended and nothing but idle teammates is
outstanding, the item is ready exactly as with no background work: idle, “Ready
for your next prompt”, the finished Needs me, and Claude's idle prompt raises
Needs me again. This happens at the Stop itself, at the TeammateIdle of the last
busy teammate, or within seconds of the five minutes elapsing. A teammate that
picks up a tool afterwards returns the item to working and “Waiting on 1
teammate”, replacing an idle-prompt Needs me but never a permission prompt, a
question or an error. Rows stored before this rule are read by it unchanged.

**AGENT-07d — Busy helpers.** A working Claude item carries the number of
subagents and teammates it has busy right now as `helpers`, an optional whole number on
the node. It is plain shared state: the map draws it (VIS-03), MCP readers see it in the
snapshot, and nothing in the graph or the MCP transport knows what kind of item it belongs
to. The number is the sum of two groups, each agent counted once:

- **Background:** every background subagent still in flight and every busy teammate, by
  the rules of AGENT-07b (an idle or quiet teammate does not count).
- **Foreground:** while the main turn is active, every agent id that has sent a tool hook
  and no SubagentStop, as long as one of its tools is in flight or its last tool ended
  less than five minutes ago (the teammate quiet window). An agent already counted as a
  background task or attributed to a teammate is not counted again.

Nothing counts after two hours without any hook from the process (the AGENT-07b limit), and
foreground agents are forgotten when the main turn stops. The service writes the number
only when it changes, never per tool call, checks it again every few seconds so a quiet
window that runs out lowers it, and an absent field means none. An item that is not
working never has it: whatever sets the activity to anything else removes the field in the
same revision, so a stopped, ended, idle or asking session shows no stale count. Codex
sessions send no subagent signals and never get the field.

**Waiting on helpers.** Next to `helpers` a working Claude item carries
`waiting`, an optional `true`: its own main turn has ended, it is not waking to read a
result, and at least one helper is busy. That is the “Waiting on N subagent(s)/teammate(s)”
state of AGENT-07b seen as plain data; the map draws the item's own sheep asleep (VIS-03).
While the main turn is active, and while the item wakes after a helper finished (“Claude is
working”), the field is absent. The service writes it in the same command as `helpers`,
only when either changes, and the same rule that removes `helpers` removes it: a node that
is not working or has no helpers never has `waiting`.

**AGENT-07e — What the item's sheep is told.** Beside `helpers` and
`waiting` a node may carry, all optional and all plain data that the graph and the MCP
transport pass through without knowing the item's type:

- `pose`: `gate`, `asking`, `fallen`, `shearing`, `command` or `ended`. One value, the
  first that applies in that order. The reducer keeps it only while it can be true: `gate`
  and `asking` need `input` attention, `fallen` needs `error` attention, `shearing` and
  `command` need a working item, `ended` an item that is not working. So an answered prompt
  loses its gate in the revision that changes the attention.
- `beside`: how many background shells and watchers the session has running (the tasks
  that run beside the prompt, AGENT-07b); `tasks`: `{ done, total }` of the session's
  current task list; `bell`: the session runs on another model than it started with;
  `pen`: its working directory is inside `.claude/worktrees/`. `pose: ended` removes all
  four.
- These, with `helpers`, `waiting` and `moment`, are the item's **scene**. A command batch
  that only sets scene fields (`node.update` with nothing else) is saved and broadcast but
  keeps the workspace revision, so a pose change never makes a pending action stale. A
  change that also sets activity, attention, summary or anything else is a new revision.
- A stale map action from the desktop is applied to the newest workspace when nothing it
  names changed there apart from session status (scene, summary, activity, attention,
  indicators); otherwise it is refused with “This changed elsewhere while you were acting
  on it.” Every refused stale command is recorded in the workspace's
  `revision_conflicts` table (last 1000) with the commits that landed in between.
- `moment`: `{ kind, at }` with kind `stumble`, `bump`, `enter` or `leave`. A one-shot: the
  map plays it once when `at` is now, and nothing clears it.

For a Claude session the service derives all of it after every hook and on the settle
pass, and writes one `node.update` only when a value differs; a burst of tool hooks writes
nothing. `command` is smoothed without a timer per session: a main-thread Bash tool counts
once it has been in flight for 1.5 s, and the pose then stays until the tool has ended and
4.5 s have passed since it started, checked at the next hook or settle pass. `leave` and
`enter` are written with the helper count that fell or rose. `stumble` (a main-thread
PostToolUseFailure that is not an interrupt) and `bump` (PermissionDenied) are written at
most once every four seconds. A task list starts with the first TaskCreated, or the first
one after every task of the previous list was completed; subagents' and teammates' tasks
are not counted. The first model is the one SessionStart reports. SessionEnd sets
`ended`, as does an agent item whose session is not running; the next hook of a live
session removes it. Hooks forward ids, counts and flags only: no tool input, error text,
task subject or path leaves the session. WorktreeCreate is not registered, because Claude
Code lets that hook replace how a worktree is made. Codex sessions get `asking`, `fallen`
and `ended` from their native status and nothing else.

**AGENT-07c — Answered prompts and readiness.** Sending a prompt to an agent
(rollout validation, review findings, PR comments) types one short request line
that opens "I asked for this from the Agentic Crafting Table.", pastes the details
behind it and presses Enter. The request is typed because an agent holds text that
arrives only as a paste and waits for the person to say what to do with it. Enter
would accept an open dialog's default. An agent
therefore counts as ready only when no dialog can be showing: a running, writable
process that is idle, or at Claude's idle prompt, or whose terminal has printed
nothing for 20 seconds after an interrupted turn. A question never counts. A
permission prompt counts as answered only on evidence that it was, never because
the terminal is quiet (a dialog is quiet) or printed something (a resize repaints
it):

- a subagent finished a tool or ended after the prompt, while the main turn had
  already ended and no other known subagent or teammate could be the one asking;
  the item then returns at once to its background work or to idle; or
- the person pressed Enter, a lone Escape or a single digit in the item's
  terminal after the prompt appeared, the terminal printed something after that
  key, and it has since been quiet for 20 seconds. The item then reads “Ready for
  your next prompt” (or names its outstanding background work) and its
  “Agent needs permission” Needs me entry is withdrawn. Arrow keys, typing,
  pasted text and anything the table itself types do not count.

Without such evidence the item keeps waiting for input indefinitely. There is no
“send anyway”. Pickers say why an agent cannot take a prompt: “Waiting for you to
answer a prompt in its terminal”, “Working” or “Stopped”.

**AGENT-07a — Agent titles from activity.** Claude and Codex agent items (not plain
terminals, whose shells rarely have one goal) get a super short task title: 2–5
words, at most 32 characters, no quotes/emoji/final punctuation (e.g. “Fix cart total
rounding”). The same tool-free Haiku helper as note titles reads the bounded,
redacted recent output, titles of connected on-map items, the working directory
name and git branch. An item is named after a finished turn, or after a minute of
continuous work, only when that evidence changed, at most once per 10 minutes per
item, within the shared hourly/daily summary allowance; the model may answer KEEP
and an equivalent title is not written. Archived/Undermap items are skipped.
Automation owns a title only while it is the creation default (“Claude session”,
“Codex session”) or the last generated one (`generatedTitle` on the node). A name
typed at creation, a resumed conversation's title or any later rename is the
user's and is never replaced. **Auto-name from activity** in the item menu hands
the title back and runs once immediately (bypassing the item interval, not the
allowance); agents cannot invoke it through MCP. Commits use `node.title.generated`
with the title the request started from and are refused if it changed; a rename,
archive or setting change cancels a pending request. Settings → AI features →
**Auto-title agents** controls it and is on by default, like other AI titles.

**AGENT-08 — Skills.** Project actions can launch installed/configured AI skills
with the same context, runtime and sync guide as direct agent creation. Runs are
visible items with explicit provider/model/workspace and real execution status.
The movable inline picker discovers native skills in the selected working directory,
inherits the project folder, and accepts optional arguments. Discovery submits no
model prompt. Revalidate availability before the first launch; retries reuse the
frozen launch and resuming a conversation never invokes its skill a second time.
UI and MCP use the same discovery and launch operations. Native permissions remain
in the terminal. General-purpose agent creation still has no task requirement.

**AGENT-09 — Launch settings.** Settings exposes provider-specific native launch
arguments supported by its adapter, with Claude Remote Control and **Auto mode**
enabled by default. Auto mode lives under Settings → Items → Claude and selects
native `--permission-mode auto`; turning it off explicitly selects `default`
(manual approval), rather than inheriting a possible native auto default. Existing
explicit permission-mode arguments keep precedence; the toggle shows the effective
mode and changing it replaces only that override. Older settings gain the new
default without resetting other preferences. Read-only review jobs keep their
restricted permissions independently. Pass arguments literally,
never through a shell. Preserve host-managed session identity, model selection,
terminal transport and synchronization hooks/MCP. Show unsupported flags or remote
capability/authentication failures explicitly, including a CLI without auto support.
The provider retains native first-use
confirmation and permission behavior. Apply changed defaults to the next launch or
resume, not an already-running process; retries retain the frozen original argv.
Expose the same settings through MCP with revision checks.

**WINDOW-01 — Native window placement.** Remember the app window's last size and
position on this Mac, independently of map coordinates. Restore them before opening
the window, including valid positions on secondary displays to the left or above
the primary display. Save during move/resize and flush at close so immediate quit
does not lose the final placement. Preserve the normal rectangle while maximized,
minimized or in native full-screen. Restore maximized mode when applicable; reopen
a minimized/full-screen window visibly using its saved normal placement rather
than creating a hidden window or forcing a macOS Space change. If the display is
gone or its usable area shrank, fit the window to a current display and keep the
title bar and controls reachable. Missing/corrupt preferences use a centered default
that fits the primary display; preference write failures must not block closing or
session recovery. Keep this local state across application updates.

**SETTINGS-01 — Keep screen awake.** Add a persistent Settings toggle to keep the
screen on and inhibit idle screensaver/sleep while the app is open. Default off.
Release the assertion immediately when disabled or the app exits. Use a scoped OS
assertion, without changing global sleep preferences, defeating manual lock or
bypassing managed security policy. Reflect the setting accurately on restart.

**SETTINGS-02 — Launch environment.** Starting from Finder/Dock and resuming must
find the user's installed development tools, including Node used by native hooks.
Resolve the login shell's PATH with a bounded timeout and standard-directory
fallback; do not import shell output or unrelated environment secrets. Launch the
native CLI directly with explicit argv and retain the shell's native tool behavior.

**SETTINGS-03 — Neighborhood padding.** Add a persistent **Neighborhood padding**
control in Settings, applying to all project neighborhoods. Let users make the
enclosure tighter or more spacious, with a reset to the default of one detailed
large agent/Terminal item width (currently 240 world pixels). Padding specifies the
minimum clearance around member footprints within the rounded, pixel-stepped
enclosure (MAP-04). Validate a finite,
non-negative value through the shared settings service and expose the same setting
through MCP. Apply changes immediately to neighborhoods in overview, neighborhood and
expanded item views, without moving items, changing membership or moving the
camera. Preserve the chosen padding across restarts; older settings use the default.
Zoom scales the gap normally and must not recompute or rearrange world geometry.

**PROJECT-COLOR — Neighborhood color.** Creating a project and Project settings
offer a neighborhood base color in the shared colour picker (COLOR-PICKER): twenty
presets, the ten Minecraft-like biome presets (Grass default, Oak planks, Stone,
Diamond, Lapis, Amethyst, Redstone, Gold, Prismarine, Netherrack) then Emerald, Moss,
Ice, Quartz, Birch, Sand, Clay, Copper, Coral and Obsidian, plus Your colours and a
custom color. It is saved on the project (`color`, #rrggbb) and paints only that
neighborhood; items cannot have one. While the neighborhood style is **Biomes**
(SETTINGS-09), one of the ten biome presets also chooses that neighborhood's biome
(BIOME-01); the other presets and a custom color keep a plain fill and compute their
plot palette as a custom color does (MAP-24). Saved colors read as before.

**COLOR-PICKER — One colour picker.** The project's neighborhood color, a plot's color
(sign menu) and a note's paper (note tools, its menu's Colour row and its form) use one
picker (`apps/desktop/renderer/ui/color-picker.tsx`): square pixel swatches of the place's
presets (a radio group named for the place; arrow keys move within it, one tab stop),
**Your colours** (the last eight custom colours chosen in any picker, newest first, each
once; setting `recentColors`) and **Custom colour…**, which opens a pixel pad inline:
12 hues across (30° apart) by 8 shades down (HSL saturation 0.6, lightness 0.88 down to
0.18 in steps of 0.1), drawn as crisp cells, exposed to assistive technology as a Hue and
a Lightness slider, plus a hex field (`#rrggbb`, `#rgb`, the `#` optional; invalid input
disables Apply) with a live preview. Nothing changes until Apply (or Enter in the hex
field); Esc closes the pad and leaves the rest open. In menus and the note tools the
picker is compact: one row of presets ending in **More colours**, which shows Your colours
and Custom colour…; in a menu the row is one Up/Down stop and Left/Right moves within it.
There is no OS colour dialog.

**BIOME-01 — Neighborhood biomes.** Each of the ten biome presets is a biome: Grass is
Grassland, Oak planks Woodland, Stone Mountain, Diamond Tundra, Lapis Ocean,
Amethyst Geode, Redstone Badlands, Gold Desert, Prismarine Swamp and Netherrack
Nether. The design reference is the level
“Ground + edge growth”; weather, biome animals, shorelines and biome names in the
color picker are not part of it.

- **Ground.** The field's cells carry the biome's texture in place of one color,
  with the same four fading shades, scatter and enclosure. The texture is blended
  toward the biome's flat color by the texture strength: 62% for Quiet, 34% for
  Medium, not at all for Full. Detail is drawn in units of one sixth of the pixel
  size, so it scales with **Pixel size**.
- **Edge growth.** Small sprites stand in the fading ring, and from Medium up
  sparsely in open ground. The chance per field cell is 14% / 22% / 30% in the ring
  and 0 / 3% / 7% in open ground for Quiet / Medium / Full; the faintest band has
  none. Growth never stands under an item or within five detail units beside or
  above it (six below).
- **Stable.** Ground and growth depend only on the world cell, the biome and the
  texture strength. The same neighborhood shows the same ground on every draw, at
  every zoom and after a restart. Moving an item changes the ground only where the
  item covers or uncovers a cell and where the enclosure's edge moves with it.
- **Strength of the layer.** **Ground brightness** sets how strongly biome ground
  shows over the map (10–100%, default 24%, the strength of plain fields). At the
  default, cards, links and project titles read as they do on a plain neighborhood;
  higher values come closer to the full colors and weaken thin links on snow and
  sand. It is saved as `neighborhoodAppearance.brightness` and leaves plain fields
  alone.
- **Where the settings are.** Neighborhood style, Texture and Ground brightness sit
  in Settings → Map → Neighborhoods, outside Advanced. Reset appearance restores
  them with pixel size, fade and scatter.
- **Small detail.** When one detail unit is smaller than one device pixel, the
  field draws the biome's flat color in the plain way and no growth.
- **Plain.** A project with a custom color, a muted project (MAP-25) and every
  neighborhood in the Undermap keep the plain fill. Attachment highlights lighten a
  biome's ground as they lighten a plain field.
- **Cost.** Ground and growth are baked when the enclosure, the appearance, the
  color or the covered cells change. Panning and zooming repaint nothing.

**SETTINGS-09 — Neighborhood appearance.** In Settings → Map, add **Pixel size**
(8–96 integer world pixels; default 24), **Fade distance** (0–480 world pixels;
default 96) and **Edge scatter** (0–100%; default 0). Zero fade is a solid fill;
zero scatter retains continuous broad steps. **Reset appearance** restores these
three defaults, the style and the texture without changing padding. The same
section holds **Neighborhood style** (**Biomes**, the default, or **Plain colour**,
which draws every neighborhood as one color exactly as before biomes) and, under
it, **Texture** (**Quiet**, the default, **Medium** or **Full**; disabled while the
style is Plain colour). Persist the additive
`neighborhoodAppearance: { pixelSize, fade, scatter, style, texture }` object
(`style: 'biome' | 'plain'`, `texture: 'quiet' | 'medium' | 'full'`) through the same
revisioned settings service and MCP; older settings inherit the defaults.
Validate bounds and finite values, preserve Save/Cancel and revision conflicts,
and apply saved UI/external changes to every neighborhood immediately. Changing
material never changes graph positions, membership, padding, camera or sessions.

**SETTINGS-AI — AI features.** Settings → AI features holds Agent titles
(**Auto-title agents**), Slack titles (**Auto-title Slack messages**, on by default),
Plot names (**Name plots**, MAP-24, on by default; off keeps
local names), Project summaries (**Summarise projects**, MAP-22, on by default; writes each project's
Next and Status lines, with Next grounded in one of its items as AGENT-07 describes; off, Next is the top
Needs me row's “title — reason”, Status the counts line, and no pen glyph shows), Activity summaries (**Summarize agent and terminal
activity**, with the summary model and per-item interval as dependents) and a
separate **Request limits** section (requests per hour and per day). The limits are
shared by all of these features (project summaries leave 4 requests an hour and a day to the others, as
background standup digests do), so they stay visible and editable whenever any of them
is on (auto-titles and plot names default on) and are shown disabled, not hidden, when all are
off. The privacy caveat appears once, as a page note, and says plot names send item
titles and agent summaries only, project summaries send project, item and agent titles, Needs me
reasons and agent summaries, and Slack titles send the attached message. Settings → General holds
Keep screen awake and the closing warning.

**SETTINGS-DASHBOARDS — Project dashboards.** Settings → Map (not advanced) has
**Show project dashboards when zoomed out** (on by default), **Show below**
(25–65% zoom in 5% steps; default 65%) and **Placement** (a Centre/Top segmented
control; default Centre). A **Dashboard sections** group below them lists one checkbox
per section: Needs you, Working, To-dos, Plots, Pull requests and Tickets (disabled while
dashboards are off). All are on by default except **Pull requests** and **Tickets**.
“Pull requests” and “Tickets” are the plugin pipeline and tally lines (`pipelines`,
`tallies`), so another plugin's strip or count follows the same switch without a type
branch. Persist the additive
`mapDashboards: { enabled, belowZoom, placement: 'center' | 'top', sections: { needsYou, working, todos, plots, pipelines, tallies } }` object through
the revisioned settings service; older settings inherit the defaults (a missing
placement reads as centre; missing sections, or a missing key in them, read their
default, so settings saved before sections existed turn the PR and ticket lines off) and
out-of-range or unknown values are rejected.
Saving applies immediately to the map and the zoom-bar tick; turning dashboards
off keeps far-zoom icons and titles at every zoom.

**SETTINGS-UNDERMAP-LAYOUT — Undermap layout.** Settings → Map, section **Undermap
layout**, has one choice, **Mirror** (default) or **Classic** (additive enum
`undermapLayout`; older settings read Mirror). It is a preference saved with the
others and takes effect at once, also while you are below. Mirror computes every
position below from the map (MAP-18); Classic shows the positions stored when items
were sent and lets you drag them. Nothing is converted in
either direction: sending below writes the classic position in both layouts, so the
choice can be changed at any time without losing an arrangement. Classic is kept as
the undo for Mirror, not as a second design to extend.

**SETTINGS-DOUBLE-CLICK-WEB — Double-click opens the item on the web.** Settings →
Map, section **Opening items**, has the switch **Double-click opens the item on the
web** (off by default; additive boolean `doubleClickOpensWeb`, older settings read
off). It lives on Map because it changes how map cards and dashboard rows respond,
not how the app behaves on the Mac. When on, double-clicking a map card at any zoom
or a project dashboard's Needs you / Working row opens the item's web page (the
same plugin `webLink` as its **Open on …** menu entry) through the main-process
https-only opener, and does not open the item view, fly to it or mark it seen. So
that a double-click never first opens the view, a single pointer click on such an
item waits 300 ms before its usual action (open, or fly at far zoom); Enter and
Space act at once. A double-click on an editable title (to-dos) still edits it,
and controls inside a card keep their own double-click. Items without a web page,
and every item while the setting is off, keep today's click and double-click
behaviour. Web pages come from stored fields only: pull request (`/pull/N`), Linear
ticket (`linear.app/{workspace}/issue/{ID}`, only when the workspace key is saved),
rollout (the Actions run, or the workflow with its branch filter), Notion page
(`www.notion.so/{pageId}`), web link and bookmark (their https URL; http is not
offered), and Claude artifact (its claude.ai URL). Slack messages (their permalink
needs a timestamp transform), code reviews and workflow reviews have none.

**MAP-WEB-MIDDLE-CLICK — Middle click opens the item on the web.** Whatever the
setting above says, a middle click on an item opens its web page (the same `webLink`)
in the browser wherever the item is listed: its map card at any zoom, its Needs me
row, its to-do row (an inbox to-do opens its imported ticket URL) and its GitHub
inbox row. Nothing opens in the app and the view does not fly. An item in Needs me
is also marked seen, and an inbox pull request of someone else is marked Seen. Items
without a web page keep their middle click: a card or Needs me row in Needs me is
marked seen, anything else does nothing. Inside an open item's frame a middle click
still only marks it seen, and links keep their own middle click.

**SETTINGS-SNAP-GRID — Snap to grid (MAP-30).** Settings → Map, section **Placing
items**, has the switch **Snap to grid** (off by default; additive boolean
`snapToGrid`, older settings read off). When on, an item's centre lands on the nearest
point of an invisible 48 px grid whenever a position is decided: a card dropped after
a drag, an arrow-key nudge (which then walks whole 48 px cells, 96 with Shift), a
project dropped (its members follow by the same snapped offset), and the positions the
table chooses itself — a new or shown item's spot beside its anchor, an item surfaced
from Undermap, and the clear edge a neighbour is pushed to, which moves outward to the
next grid point so it stays clear and on the grid. A card follows the pointer freely
while dragging and snaps only on release. Nothing moves when the switch is turned on:
items already on the map keep their positions until moved. A multi-selection moved
together keeps the layout its items had, with the held item on the grid; a manual
resize keeps the item's centre. The service applies the rule for every caller (UI, MCP,
providers) from the saved setting, so a position an agent or provider gives is also
snapped while the switch is on. The intention is tidy angles: items whose centres share
the grid connect with straight or evenly angled lines.

**SETTINGS-MAP-COLLISIONS — Moving into items (MAP-13).** Settings → Map, section
**Placing items**, has **Moving into items**: **Push aside** (default; additive enum
`mapCollisions: 'shove' | 'solid'`, older settings read `shove`) or **Solid**. Push aside
keeps the MAP-13 rule that the moved item lands where it was put and the items in its
way settle at the nearest clear spot. With Solid, nothing else moves: a requested spot
that is clear is taken as it is; otherwise the moved item (a selection or a project's
members together) travels from where it was until it touches another item's 20 px
clearance and slides along it. A drag travels from where the previous frame stopped it,
so it slides along a card instead of jumping past it, and a drop commits the shown
position. Arrow keys and agent/MCP `node.move`/`nodes.move` follow the same setting.
With Snap to grid the stop moves back to the nearest clear grid point when there is one.
Resizes, restores and other placements still push aside. Items never overlap in either
mode.

**SETTINGS-AUTO-REVIEW — Automatic reviews of new pull requests.** Settings → Items →
GitHub pull request, section **Automatic reviews**, has the switch **Review new pull
requests** (off by default) and one checkbox per review agent the table has (today
Claude and Codex; Claude ticked by default; disabled while the switch is off), stored as
`autoReview { enabled, agents }`. Turning it on settles every pull request already on
the map: those are never reviewed by it. Each pull request that lands on the map while
it is on gets one direct review (the same as Trigger review ▸ that agent, with the
agent's default model) from every chosen agent, as soon as the pull request reads open;
a draft counts, one first read closed or merged is settled without a review, and no
chosen agent starts nothing. A pull request is settled by its resource, before its
reviews start, under a request id derived from the resource and agent, so a restart, a
second node of the same pull request or turning the switch off and on again never
repeats a review; pull requests added while it was off are part of the new baseline.
The service keeps its record in the code.review package's plugin storage (`auto-review`)
and checks every 15 seconds and on workspace changes. Later pushes are not reviewed
again (Review loop does that).

**SETTINGS-ITEM-DELETE — Delete in item menus.** Settings → Map, section **Removing
items**, has the switch **Delete in item menus** (off by default; additive boolean
`itemDelete`, older settings read off). When on, every item's right-click menu (map and
Undermap, single item only; not projects, links or selections) ends with a destructive
**Delete…** below a divider. It opens a submenu that is the confirmation: **Cancel**
closes the menu, **Delete permanently** (described “Provider data and sessions are kept.
This can’t be undone.”) archives and deletes the item in one revision
(`node.archive` then `node.delete`), exactly as Archive then Delete permanently in the
archive browser: its links and to-do attachments go, its resource goes when no other
node uses it, and no provider delete is ever called. Off, items leave through Archive.

**SETTINGS-TERMINAL — Terminal screen reader support and scrollback.** Settings → General, section
**Terminals**, has the switch **Screen reader support for terminals** (off by
default; additive `terminal.screenReader`, older settings read off). It turns on
xterm's screen reader mode, which keeps a live DOM copy of the visible rows and
announces output; that copy costs layout and DOM work on every redraw, which made
large agent sessions lag, so it is no longer always on. While a screen reader
runs, every terminal turns it on regardless of the switch, and the switch shows
checked and disabled with that explanation. On macOS that means VoiceOver is
running: Electron's `app.accessibilitySupportEnabled` alone is not enough,
because macOS raises it for every client of the accessibility API (window
managers, launchers, automation), which locked the copy on and made each
terminal redraw lay out the whole map. The flag and its change event gate the
VoiceOver lookup, which is repeated while the flag is up; elsewhere the flag is
the signal. The result reaches views through the preload bridge.
Saving, or the report changing, applies to open terminal and agent views
immediately without remounting the view, restarting the process or losing
scrollback. Hidden test runs pin the OS report with `ACT_TEST_ASSISTIVE_TECH`.
The same section has **Scrollback lines**: 2,000 / **5,000** (default) / 10,000 /
25,000 (additive `terminal.scrollback`; older settings read 5,000; other values
are rejected). It is the history each terminal view keeps for scrolling back; the
complete session recording is unaffected. Saving applies to open views at once:
growing keeps the current history, shrinking drops that view's oldest rows.
A freshly opened view replays only a recent tail of the recording, sized to the
chosen scrollback at 200 recorded bytes per line and bounded to 512 KiB–4 MiB
(2,000 → 512 KiB, 5,000 → about 1 MB, 10,000 → about 2 MB as before, 25,000 →
4 MiB). Agent output spends many bytes per retained line on redraws and colour, so
the tail may hold fewer lines than the scrollback; it bounds the replay cost, which
xterm pays on the renderer thread in proportion to bytes. A view that falls further
behind than this tail while hidden restarts from it, as before.

**SETTINGS-04 — New item quick choices.** Settings → Items (the parent page)
houses New item shortcuts, rather than Map. It lets users choose which item
types appear in the circular picker's first layer and their order (up to seven
shortcuts, plus All). Larger All catalogs use pages of up to eight bubbles in the
same layer; every available type remains reachable. URL-backed types share the
From URL entry (MAP-17), including its legacy shortcut projection. Persist these
preferences across restarts using stable type/plugin identifiers and the shared
revisioned settings service, also exposed through MCP. **All** appears automatically when non-project types are omitted from the ring;
it cannot be disabled while those types remain. Every available type omitted from the quick choices appears
in All; new field-based plugins appear there and URL plugins join From URL
without changing the map or picker code. Hiding a type from quick choices does not disable the plugin or
remove existing items. The preference applies to double-click, right-click New
item and connected creation through a dragged plus handle.

**SETTINGS-11 — Right-click menus.** Settings → Items (the parent page) has one
section, **Right-click menus**, for every registered item type: built-in and loaded
from plugins, sorted by name in an **Item type** select, with “· custom menu” after
the types that have one. This is the only place a menu is arranged, as “Opening an
item marks it seen” is the only place for that choice. The section lists the chosen
type's rows (MAP-27) in the order the menu draws them:

- one row per entry slot, including entries that appear only in some states (“Mark
  done / Reopen”) or while another setting is on. Each has a checkbox named
  **Show <label> in the menu**; an unticked row stays in its place, dimmed.
  Unticking the last ticked entry is refused and says “At least one entry stays in
  the menu. Show another entry first.”;
- one row per separator, drawn as a line, with **×** (Remove separator). **Add
  separator** below the list puts a new one after the row last focused, or at the
  end, and focuses it.

Every row moves by dragging its grip, or by ↑/↓ while the grip is focused (focus
stays on it and its new place is announced). There are no ↑/↓ buttons on the rows;
the keys on the grip are the way to reorder without a pointer. All rows share one
height, and a list taller than the page scrolls while a dragged row rests near the
page's top or bottom edge. Two separators in a row or one at an end are allowed as
rows; the menu folds them (MAP-27). **Reset this menu** removes the type's saved
layout, earlier order and hidden entries, and is unavailable while the menu is the
default; putting the rows back by hand also saves nothing. Changes are part of the
settings draft (SETTINGS-10), mark Items as changed and reach open menus when
saved. Agent sessions are one item type, so Claude, Codex and other providers share
one menu.

**SETTINGS-WORKING-DIRECTORY — Global default working directory.** Settings →
Items (the parent page) has **Default working directory**, unset by default. It is
part of the settings draft: type an absolute path or use **Choose…** (the native
folder dialog), and **Clear** unsets it. Saving rejects a value that is not an
existing absolute folder; a saved folder that later disappears does not block saving
other settings. New launches use it when their project has no folder (DATA-02).

**SETTINGS-05 — Local diagnostics.** Settings exposes diagnostic log file size
(1–16 MiB) and backup count (0–5), defaulting to one 1 MiB file plus two backups
per service. Apply through the same revisioned settings API and MCP. Lower limits
trim old diagnostic output, while terminal recordings and native conversations
remain preserved. Restore the last accepted limits before opening existing logs,
then synchronize saved preferences when services start or reconnect.
Offer an explicit support-report download containing versions, aggregate counts
and bounded performance measurements. Exclude account details, item/session IDs,
titles, paths, URLs, prompts, terminal output, raw errors and log contents. Never
upload a report automatically. Preserve ordinary performance-report export.

**SERVICE-HEALTH-01 — Local connection and service health.** The app and the workspace
service talk over a local socket in newline-delimited JSON frames; the service sends
every subscriber a snapshot after each commit. A subscriber names its layer
(`subscribe { after, layer: 'map' | 'below' }`) and receives the snapshot presented for
it (`presentLayer` in `src/graph/layers.ts`, shared with the desktop): on the map the
items below are left out, except those a kept node links to or a to-do holds, with the
resources and links only they use; projects, hidden and archived items stay. Below,
the whole state is sent, since Needs me, the badge, notifications and the to-do list
keep counting the map there. Both carry `layer` and `layers.below` (the number of items
below and the projects the Undermap draws). Subscribing again with another layer
replaces it and answers with that layer's snapshot. A subscriber without a layer (MCP,
older clients) and every `read` receive the whole state. The service encodes one frame
per layer in use. Only the newest snapshot waits for
a slow client: while a client's socket still has unsent data, a new snapshot replaces
the one waiting and is written when the socket drains; replies and other events are
never replaced. A client is dropped only when one frame would take its unsent data
over 8 MB, and the service writes `Local client dropped: <queued> bytes queued,
<frame> bytes frame, <event or method>` to service.log first. The service measures its
own health: event-loop lag (a one-second timer's drift; per-minute max and p95 for the
last hour, and each lag of 250 ms or more with the operations then running), the
50 slowest operations with counts per name (each RPC method and the named background
passes such as `broadcast`, `resources.poll` and `summaries.tick`), snapshots and bytes
per subscriber, coalesced snapshots, dropped clients, and memory each minute. The
read-only `diagnostics.health` call returns it and the support report includes it; it
holds operation and event names, counts and times only, never titles or content. The
app keeps its last 50 connection changes with their reasons (the socket error,
`closed`, or `subscribe failed: …`), writes each to `app.log` in the data directory,
and keeps the 20 slowest snapshot deliveries (parse plus forward to the windows).
Settings → Data & diagnostics → Support → **Service health** shows lag max and p95,
snapshots and bytes per minute, coalesced and dropped counts over the last 10 minutes,
the last disconnects with their reasons and the slowest operations, with Refresh and
a Download of the health JSON.

**SAFETY-01 — Crash and load failure.** A top-level error boundary and per-view
boundaries (terminals, plugin views) replace a blank window. A render crash or a
failed initial load shows **Couldn’t open your table**: a one-line cause, “Your
workspace data is untouched”, Try again, Open logs folder, Download support report
(the Settings → Support report) and the raw message in an Error details disclosure.
A crashed view shows its own reload control while the rest of the window keeps
working. Renderer failures append to a bounded local `renderer.log` beside the
service log in the data directory; nothing is uploaded. Disabled controls show a
not-allowed cursor, only in-flight controls (`aria-busy`) show wait, and a finished
action such as a deleted recording shows its result instead of a disabled button.

**SETTINGS-06 — Recording storage.** Keep complete terminal recordings by default.
Settings can inspect the recording database size and a paginated list, including
recordings for archived or removed session entries, with no deletion controls in
Settings. Deletion is available only under Archive → Recordings,
for an archived (or previously removed), stopped session with inline confirmation. Delete only this app's recording and
cached tail; retain the session identity, native conversation, map item, launch
deduplication and project files. Share the operation with MCP, which must require
explicit user authorization for deletion. Mark deleted history honestly in open
terminal views and across restart; a cached tail must never restore deleted output.
Deleting rows makes database space reusable; do not promise immediate file shrink
or deletion of older backups. Automatic age-based pruning remains off.

**AGENT-10 — Diagnostic session management.** Remove Sessions from the map top
bar. Settings → Data & diagnostics opens with an always-visible **Sessions**
section (Current / Ended / Archived views with counts) for inspecting local processes,
including those without map items. Current lists only starting and running
sessions (including those stopping); Ended lists unarchived exited, failed and lost
sessions, most recently ended first; Archived lists archived entries in any state.
Each view shows its first 50 entries and **Show more** adds 50. Everyday work uses
map items, Continue session and Archive. Mount/poll the session list only while
that page is visible, and each poll reads only the visible view's page plus counts
(the supervisor filters and limits in SQLite). The
session view provides per-session **Archive** and **Stop** actions. Only the
**Archived sessions** view offers **Delete entry**, with danger styling and an
inline confirm (the compatible runtime action remains `remove`). The same page
lists terminal recordings, diagnostic log limits as rows with units, and Support
actions (support report, performance measurements with a Show measurements
table, service health, SERVICE-HEALTH-01); the app version is the page header's meta. Archive hides the entry from the default list
while retaining session identity, metadata and history; an archived-sessions view
provides Restore and Delete, also reachable from the main Archive. Archive is the one home for archived things: segmented tabs Items · To-dos · Sessions · Recordings, each with its count (Sessions shows only archived entries, Recordings the recordings of archived or removed sessions). Settings → Data & diagnostics keeps live processes and storage totals and links into Archive. Delete removes
the archived entry from the managed session list without
deleting the provider's native conversation or project files. Archiving Claude also requests Stop, retaining its readable history. Other session
types retain their explicit Stop action. A running session must be stopped before
removal; the archived view retains that control while shutdown is pending. Persist archive/removal choices across
restarts and reconciliation so dismissed entries do not immediately reappear.
Expose the same operations through the shared service/MCP.

**MCP-01:** Every graph operation needed by the UI must be available to agents via
the shared command service. Keep discovery generic so adding a plugin does not
require new transport branches. Reads expose live IDs/revisions; conflicting writes
are rejected atomically. External operations have explicit runtime actions and
return actual job/session identities. Provider reconciliation supplements agent
updates so a missed MCP call cannot permanently leave the map stale.

**MCP-02 — An item and its links in one call.** `item.add` and `item.create` take
an optional `links` list (at most eight): each names `otherId`, a `kind`
(`reference`, `context` or `blocks`) and `newItemIs` — `source` (the default)
points from the new item to the other node, `target` points from the other node to
it — plus an optional `label` and `id`. The links are saved in the same command and
revision as the item under the rules of `link.save` (LINK-01, LINK-02, LINK-04):
both ends exist, no self-link, context points at an agent, cardinality and blocking
cycles hold. One invalid link refuses the whole command; nothing is created.
Without an `id` a link is *ensured*: its id is derived from the item, the partner,
the kind and the direction, so a retry or a second attempt produces the same link,
and a relationship the two items already have (aliases count as one item) is kept
instead of refused. That makes adding a provider item the map already has
idempotent for its links. With an `id` the link follows `link.save` exactly, except
that an id already used by a different link is refused rather than reassigned. This
is a shared command: the app and both MCP transports accept it.

`workspace_apply` takes either one `command` or `commands` (one to ten), never
both; a batch applies in order, atomically, in one revision under one `commandId`,
and a command an agent may not issue refuses the whole batch. In a new item's
links an agent may write `agent: true` in place of `otherId`; the bridge resolves it
to the calling agent's node from its launch binding and refuses it, with the reason,
when the session was not launched from the table. The service only ever receives
node ids. When links were requested the result adds `itemLinks`: for each such
item its node and resource, whether the resource was already on the map, and for
each link its id and whether it existed before.

`workspace_create_item` keeps its single `connection` and also takes `connections`
(the same shape; at most eight in total, each with its own id). They are saved with
the item in the attach revision, or with the agent's launch plan. When the request
resolves to an item the map already has, a connection it already holds is kept.

**A revision only where it protects something.** An agent need not read a revision
to add to the map. `expectedRevision` is optional on `workspace_apply`,
`workspace_create_item` and `workspace_run_skill`; when it is omitted the service
applies the request to the newest workspace (read, apply against that revision,
read again if another writer got there first, at most five times, then the
conflict is returned). When it is given, the rules are unchanged everywhere: a
stale revision is refused, even for a command that could have gone without one.
The reducer always checks a revision; the app always sends one.
The one exception is the user's own placement: a batch from the app (actor `user`) of only
`node.move`, `nodes.move`, `node.attach` and `node.resize` lands on the current revision
when another write got there first. A drag is the user's latest intent, and overlaps are
settled against the map it lands on, so a status update or provider sync landing during
the drag no longer drops the move. Agents' moves still need a current revision.

One table (`packages/core/revision-policy.ts`, a row and a reason per command type;
a command type without a row fails the suite) decides which commands may go
without a revision:

- Never needed: `item.add`, `item.create` (with their `links`), `project.create`,
  `attention.acknowledge` and `attention.restore` (they name the versions they acknowledge or put back),
  `node.todo.label` and `node.title.generated` (they name the title they were
  written for), `todo.context` (it sets one text on a to-do and never moves,
  completes or removes anything; TODO-11).
- Not needed while the command only adds: `link.save` with a new link id,
  `todo.save` with a new to-do id, `node.todo` with `enabled: true`, `node.attach`
  of an item that has no project.
- Not needed for the calling agent's own node: `node.update` of `summary`,
  `activity`, `attention` and `attentionNote`, and `attention.set`.
- Always needed: everything that changes, moves, hides or removes something that
  exists — `item.update`, `item.resolve`, `item.bind`, `item.convert`, other
  `node.update`, `node.move`, `nodes.move`, `node.resize`, `layout.repair`,
  `nodes.send`, `todo.send`, `todo.place`, `node.archive`, `node.below`,
  `node.surface`, `node.restore`, `node.delete`, `nodes.action`, `node.complete`,
  `node.reopen`, `link.remove`, replacing a link or a to-do, `todos.reorder`,
  `todo.archive`, `todo.restore`, `todo.remove`, `view.set`, `project.mute`.

The conditions are checked against the workspace the command is applied to, not
an earlier read. A batch may omit the revision only when every command in it may.
A command that needs one is refused without it, before anything is written, with
its name and the reason: “node.move needs expectedRevision: it overwrites
positions the user may be changing. Pass the revision from workspace_read.”
`commandId` keeps its meaning: the same id and payload replays the first result
however far the map has moved, and never applies twice; the same id with another
payload is refused. Every result carries the new revision. `workspace_settings`
keeps its own required settings revision.

**SETTINGS-07 — Item view sizes and subgroups.** Settings → Items lists a
subgroup per registered item type, with separate **Claude** and **Codex** groups.
Each expandable type has independent Width/Height preferences in screen pixels
and Reset view size. Defaults: agents/Terminals 1280 × 800,
other types 880 × 600 unless their plugin declares another default. Clamp to the
current canvas with visible map margins; resizing or changing settings never
changes stored item positions or restarts a mounted terminal. Notes and to-dos have
no expanded view. To-dos stay inline on every opening path, including connected-item
navigation, keyboard activation and overview; show no expanded-view size controls
for them (their single map footprint is configurable under VIS-05).
Browser-opening types retain their browser behavior and explain why expanded-view
sizing does not apply; their map presets remain configurable under VIS-05. Keep Claude launch arguments and Remote Control inside Claude's
subgroup, leaving its existing persisted keys and defaults intact. Shared activity
summaries and agent titles live in AI features. Saving applies all drafts atomically through the shared
revisioned settings command; Cancel discards them, and older workspaces inherit
default sizes without a reset. Plugin metadata declares expansion policy and
optional provider variants so new types appear without map/MCP branches.

**SETTINGS-09 — Simple defaults and item guidance.** Each page that has detailed
visual controls ends with its own **Advanced settings** disclosure showing how many
settings it holds: expanded-view dimensions and the entire Map bubble section
(Default map size and all Small/Medium/Large presets, dimensions and reset) on item
pages; neighborhood pixel/fade/scatter and Undermap travel on Map. Neighborhood
padding and project dashboards stay visible. Each page's disclosure starts closed
whenever Settings opens and is remembered per page while the dialog stays open;
it is not persisted. Hiding controls preserves saved values and unsaved drafts;
Save opens the disclosure that holds an invalid field and focuses it. Keep
functional controls (connections, session launch, conversation filters, shortcuts
and close behavior) visible. Every item page begins with a short explanation of
its purpose and how to create/open/use it, including Claude and Codex variants.

**SETTINGS-08 — Sidebar tree.** Replace the horizontal settings tabs with a
persistent left navigation tree and a settings pane on the right. Top-level
entries are Connections, Items, Map, Notifications, AI features, General and
Data & diagnostics. Leaves carry no bullet; only branches show a chevron at the
row's end. In forced-colours mode pixel border images fall back to a plain
system border so controls keep their edges. Items expands
to one child per registered item profile, including separate Claude and Codex
entries. Selecting a child opens its controls directly; omit the duplicate item
accordions in the content pane. Show the current page distinctly and its parent
in the item-page heading. Collapsing Items hides its navigation children without
losing the current page or drafts. Support pointer disclosure, Up/Down, Left/Right,
Home/End, type-ahead and Enter/Space, with one keyboard tab stop in the tree.
Keep drafts across pages and keep the save bar visible at the bottom. Validation
must reveal and focus an invalid field even if its page or tree branch was hidden.
The dialog is modal without a scrim: it takes focus, keeps Tab inside, makes the
rest of the workspace inert and closes on Escape (asking to discard a draft), then
returns focus to its opener. Needs me, the Connect dialog and the GitHub inbox are
non-modal but also close on Escape and return focus.
The sidebar and content scroll independently within the movable dialog, which
must fit smaller windows. All existing settings, shared commands and saved keys
remain unchanged; this is a navigation/layout change.

**SETTINGS-10 — Consistent pages and save model.** Preferences are drafts; actions
run now. Every page is a header (title matching the tree label, one purpose
sentence, optional meta such as the version), sections (small uppercase label,
optional sentence, one card of rows) and rows (label, one-sentence description,
meta line for defaults/state/validation, control on the right). On/off
behaviours are switches (`role="switch"` on a native checkbox); checkboxes only
pick items from a set. Numbers carry their unit inside the field and are checked
on blur, naming the allowed range in the row meta; sliders show a readout and a
default tick. A changed value's meta offers “Reset to <default>”. Dependent rows
are indented and disabled, not hidden, while their switch is off. Immediate
actions (Clear overlaps, test notification, provider account choice, session
control, downloads) are visibly marked or self-evident and report their result in
their own row; destructive ones use danger styling and a keyboard-first inline
confirm (focus on Keep, Escape cancels). Long help is numbered steps with
copyable commands behind a How to … link. The save bar counts unsaved changes
and names their pages, reports fields that need attention, and the tree marks
those pages (amber changed, red invalid; a collapsed Items branch shows its
children's mark). Its secondary button reads Discard with changes and Close
without; × with changes asks “Discard N changes?” (Keep editing / Discard). Rows
stack below 540 px of content width (switches stay right); at narrow windows the
tree narrows to 152 px and Items collapses when another top-level page is chosen.

## 6. Resource behavior and provider workflows

### Rollout observation

A **Rollout** item (`github.rollout`) observes GitHub Actions deployment runs,
including deployment and rollback workflows. Add it through **From URL** with an
Actions run, job or workflow URL. A job URL observes its entire run, across all
stages. A workflow URL explicitly follows its latest run (optionally a
branch filter); a run URL remains pinned across reruns.

The map item always indicates **Ongoing**, **Waiting approval**, **Failed** or
**Passed** when supported by provider evidence. Queued, cancelled, skipped,
waiting on other protection rules, no runs and unknown states stay distinct;
one successful job must never imply the whole rollout passed. Show the current
run/attempt, branch/commit, jobs and pending environments in its expanded
view, with a source link and Refresh. Poll in the backend approximately once per
minute while the app is active, including unopened items. Keep the last complete
observation and visibly mark updates paused on failure. Resume reads after
restart; archive/account disconnect pauses them. Approval, failure and completion
participate in Needs me without hiding the rollout state. Viewing a rollout does
not acknowledge it: it leaves Needs me only when marked seen, or when the rollout
continues (the provider withdraws or replaces the reason, e.g. approval granted).
The integration observes, and can approve deployment gates the signed-in account
may approve: click **Waiting approval** in the full view, or right-click the item
→ **Approve**, then **Confirm** the named environments/run. Approval re-reads the
rollout and proceeds only if the run, attempt and approvable environments still
match what was confirmed; an interrupted request is reported as uncertain, never
retried. A saved copy GitHub could not refresh keeps Approve for the gate it last saw
waiting; confirming reads the rollout again. The approve action is human-only: agent/MCP tools refuse it. Rejection,
deployments, reruns and cancellation remain on GitHub.

**Rollout validation.** The rollout's right-click menu and full view offer **Trigger
validation**, listing the agent sessions connected to the rollout, directly or
through other items, and then Start a new agent (below). An agent can take the request when it sits at its
prompt; one whose turn has ended and that only waits on background shells or watchers
counts as ready too, since those run beside the prompt. Waiting on a
subagent, teammate or workflow, an open question or a permission prompt still does not. In the full view the header's one
**Actions ▾** menu replaces the Validate ▾ button and lists **Approve and validate**,
**Approve** and **Validate**. Validate asks in one click and
**Validate with…** opens the agent list (see Validate in one click). Approve is enabled
only while a gate waits for your approval and opens the same confirmation the gate
row's Approve ▾ does (Cancel first, Confirm approval); the gate row keeps its button as
the jump target of the status chip and the timeline. Approve and validate asks for the
agent first, then confirms the approval; it approves and, once the approval request
succeeded, triggers the validation exactly as Validate would — nothing is sent when
the approval fails. An approval whose outcome is unknown (a timeout or an unconfirmed
reply, as opposed to a refusal) does not drop the validation: the view says
“Approval not confirmed yet; checking the rollout…”, re-reads the rollout on every
pushed update and on a slow poll for up to 60 seconds, sends the same validation
request to the chosen agent once the gates it tried to approve no longer wait for that
run attempt, and otherwise stops and says the approval did not go through and no
validation was requested; leaving the view ends the wait. The primary entry follows state: Approve and validate when a gate
waits and an agent is ready, Approve when a gate waits and none is, otherwise
Validate; the Actions button takes the accent as in the PR view. Disabled entries say
why underneath. The agents are those (ones that cannot take a prompt are
shown but unavailable, with the reason: “Waiting for you to answer a prompt in its
terminal”, “Working” or “Stopped”; readiness follows AGENT-07c). Hovering an agent highlights it and its connecting path on the map.
Choosing it adds a direct context connection when missing (labelled “Validation”, shown only on hover, LINK-05), records a validation with a
service-issued id per rollout (`V1`, `V2`, …) scoped to the current run, attempt and
commit, then sends the agent (once per request, journaled) the rollout context, that id
and the report contract, without approving, rerunning or cancelling anything. The
request tells the agent to let the rollout land before judging it and to keep the view
up to date meanwhile: it may watch for as long as the rollout takes, but
never idles in one long sleep. It waits at most 30 seconds per command, looks again
after each wait, and sends a progress report whenever a check changes and at least
every 2 minutes, saying what is confirmed and what it still waits for. Things that need
hours to tell, such as long-term metrics, are skipped checks with a reason and the
earliest time to check. It asks for an early answer instead of waiting
until everything is checked: “Send a first report with an interim verdict within 2 minutes
from what is checkable now; list checks that need a settled window as pending with the
earliest time; then update.” The first progress report's summary opens with that interim
verdict; the final verdict is inconclusive only when nothing that matters could be checked.

**Start a new agent.** A validation does not need an agent connected first.
Wherever agents are offered for one (the right-click menu's Trigger validation, and
Validate and Approve and validate in Actions ▾), the list ends with **Start a new
agent**; it is the only entry when no agent is connected. Validate is therefore enabled
whenever an agent is connected or a new one can start, and Approve and validate
whenever a gate waits and an agent is ready or a new one can start. The primary entry
still follows a ready connected agent. Connected agents keep their entries and reasons.
The entry is unavailable only when a new agent cannot work, and says why: “This rollout
has no run to validate yet. Refresh it and try again.”, the reason Claude cannot start
(“Claude Code is not installed. Install and sign in to the Claude CLI, then retry.”, or
what its probe reported), or “Starting an agent is not available here: native Claude
sessions are not configured.” With no agent connected, Validate and Approve and
validate show that same reason.
Choosing it makes the service start one Claude session for this validation, as it
starts review and architecture sessions: an ordinary agent item with its tools and the
table's MCP tools (not read-only, it has to report), the default Claude settings and
the model the agent form would preselect (no model choice here yet), titled
“Validate · <rollout title>”. It works in the working directory of the rollout's
project, else of the project of a pull request that discovered the rollout, else where
any launch without a project folder starts. The item is placed beside the rollout in the
rollout's project by the shared in-context placement (MAP-14) and linked in the same
commit: a context connection rollout → agent labelled “Validation” that shows only on
hover (LINK-05), and an always-drawn one from each
pull request that discovered the rollout (PR-05) to the agent, so the change is in its
context. Its opening prompt is the validation request above plus one line naming those
pull requests by title and URL; it is the session's first prompt, not pasted afterwards.
One validation (`V<n>`) is recorded with the new agent, journaled under the same request
id as any trigger: repeating the request starts neither a second session nor a second
validation. When Claude cannot be started the validation does not stay requested: it
ends inconclusive with “The new agent could not start.” and the launch error as its
summary, and an item that was already placed shows the failed start like any agent
whose session failed. A launch whose outcome is unknown keeps the validation requested
and the usual No report rule applies. The agent starts hidden, and an idle one is
retired (see Validate in one click and Retiring hidden validation agents below).
Starting one is human-only like every trigger.

**Validations per phase.** A run attempt that waits, or has waited, at a deployment
gate is validated per phase. A phase is the jobs that finished having run (not skipped,
cancelled or neutral) and that no validation of the attempt was given (`scope.jobs`).
Before a waiting gate it is named after the gate and the jobs it holds back (“before
production (apply (prod-2))”), so a rollout that gates the same environment once per
phase gets one phase per approval; at the end of the run it is the rest (“whole run”);
between gates it runs “through <last finished job>”. **Validate** and **Approve and
validate** send `phased: true`: the service scopes the request to the current phase
(focus and jobs, prompt as for Auto deploy phases), a chat validation does not answer
it, and when nothing new ran since the last phase validation it shows that one (“Showing
V2 of the last phase instead of a second validation”). A repeated request id answers as
the first did. With **Auto validate** on, a gated attempt is validated each time a gate
waits after something new ran and once more when the run ended with jobs left, each
with a request id derived from the jobs it covers, never while a validation of the
attempt is open; approving a gate therefore leads to the next phase's validation when
that phase reaches the next gate or the end. Stage rules, where configured, keep their
own per-stage rule.

**Validate in one click.** Validations run directly from the rollout view,
without connecting an agent first; the agent stays hidden on the board and can be shown
with Show validation agent. In the full view's Actions ▾,
**Validate** no longer opens the agent list: one click asks the rollout's validation agent,
an idle hidden agent started for this rollout and connected to it directly, and otherwise
starts a new one exactly as Start a new agent does (same session, prompt, model, folder,
journaled request, `V<n>`, failure handling). A reused agent gets the request as its prompt
in the lead wording (“You lead this validation…”), not the hand-off to a subagent. Every
agent the table starts for a validation, from Validate, from Approve and validate, from
**Validate with…** or from the map's Trigger validation, is created hidden (LINK-07, label
“validation agent”): placed and linked as before, with the rollout → agent “Validation”
hover link and the pull request → agent context links, but not drawn. Its reports update
the card, the view and the rollout's Needs me as before. **Validate with…** is the agent
list Validate used to open (connected agents, Start a new agent; with a covering chat
validation, Show V<n> and Re-run). **Approve and validate** opens the approval confirmation
at once and, once the approval went through, validates in one click; the unconfirmed-approval
wait is unchanged. Reuse instead of repeat still applies: while a chat validation covers the
stage, Validate shows it. Menu order: Approve and validate, Approve, Validate, Validate with….
The primary entry is Approve and validate while a gate waits for your approval (Approve when
no agent can start), otherwise Validate. Validate and Approve and validate are unavailable
only for the reasons Start a new agent is (no run, Claude cannot start, native sessions not
configured), unless a chat validation covers the stage; Validate with… is available while
any agent is connected or a new one can start. The empty verdict line reads “No validations
yet. Validate starts an agent that checks this rollout.” The newest validation card of an
agent started hidden offers **Show validation agent** while it is hidden, which puts it on
the map beside the rollout, closes the view and selects it, and **Hide validation agent**
once it is shown. The rollout's right-click menu offers Show validation agent while a hidden
validation agent is linked to it; the agent's own menu offers Hide validation agent. Hiding
never stops or archives the session.

**Retiring hidden validation agents.** Hidden validation agents must not
accumulate. On its 15-second pass, with the one workspace read it already
makes, the validation service archives a hidden agent once all its validations settled
(final, No report, or ended inconclusive at start) and it has sat idle at its prompt, with no
helper or background shell, for 15 minutes (`HIDDEN_AGENT_IDLE_MS`, the reuse window, so a
follow-up can still arrive) since its last report and since the pass first saw it so. A new
report or prompt, any work, or hiding it again starts the 15 minutes over; the clock is the
service's own and starts again after a restart. Archiving stops its session (AGENT-06).
The validations and their reports stay on the rollout, and the card still offers Show
validation agent: it brings the agent back from the archive onto the map, stopped and
resumable like any stopped agent. An agent shown on the map is never retired; hiding it
again makes it eligible again. A held agent (a question or permission prompt) is not idle
and is not retired.

**Rollout colours.** In the rollout view warm hues mean something is wrong or waits for you:
amber for a concerns verdict, a concern check, a worse metric, a stuck blocker and an approval
gate that waits for your approval; red for a failure. Work in progress (running jobs, a
running or requested validation) is blue. Selection, the Validate button, jobs blocked
behind a gate and a gate held by protection rules are neutral. A rollout with running
jobs and a validating agent therefore shows no amber, copper or red. On the map card a
concerns verdict line ("Concerns · <agent>") is Needs me amber too, unlike other provider cues.

A connected agent is asked to hand the validation to one **lead** subagent in the
background, so it stays free for other
prompts while the rollout is watched. The lead may fan out: one subagent per data source
(for example the cluster CLI, a metrics datasource or a log store), each given
the checks its source answers, and it merges what they find. Only the lead reports;
while it waits for its subagents it sends progress reports that mark the finished checks
and leave the rest pending or running, so the card's pips and “N to go” show what is
done. An agent started for the validation is that lead itself. The request's wording:

> Do not do this in your own turn. Hand this whole validation to one lead subagent
> running in the background, give it this request word for word and whatever context it
> needs, then carry on with your other work and stay free for new prompts. The lead may
> fan out: it starts one subagent per data source (for example the cluster CLI, a
> metrics datasource or a log store), gives each the checks that source answers,
> and merges what they find. Only the lead sends the reports, with
> workspace_report_validation; while it waits for its subagents it sends progress
> reports that mark the checks they finished and leave the rest pending or running. If it
> cannot reach that tool, pass its reports on as they arrive. Say in one line that the
> validation is running, and give the summary when the lead finishes.

A started agent reads instead “You lead this validation. You may fan out: start one
subagent per data source (…), give each the checks that source answers, and merge what
they find. Only you send the reports, with workspace_report_validation; while you wait
for your subagents, send progress reports that mark the checks they finished and leave
the rest pending or running.” Every request ends with “If something changes after your
final report, send a "followup" report for the same validationId with a higher sequence,
a verdict and the checks; it may change the verdict.” The agent decides which checks to run
and how to judge them; the table only schedules, carries context and stores reports.

**Request context.** Every request (Trigger validation, Start a new agent,
Auto validate) carries what the table already has, as indented JSON after the rollout
state under “Context from the table (JSON):”, so the agent does not derive it again and
no line runs long: `run` (id, attempt, commit, workflow, run URL), `stage` (the stage of a
staged run this request is for and when it finished), `pullRequests` (number, title, URL
of each pull request that discovered the rollout), `environments` (from the job names:
name, status pending/running/succeeded/failed/skipped/cancelled, when the last job
finished, and up to 20 jobs with id, name, status and conclusion), `previous` (the newest
final validation on the rollout: id, verdict, stage, summary and up to 12 checks with
their observations clipped to 240 characters, and its follow-up mark) and `component`
(the deepest folder all changed files of those pull requests share, else their top
folders, with up to 10 files and the total). Changed files come from the pull request's
read-only Changed files action through the resource cache (one minute), using the head
and base commits of its cached read; nothing is written and a read that fails or takes
over 10 seconds leaves `component` out. A run deploys everything merged since the
workflow last succeeded, not only the pull request it is named after (a run named after
#16 can also apply #12), so `merged` lists every
pull request merged since the previous successful run of the same workflow: `since` (that
run's id, commit and URL), `pullRequests` (number, title, URL; newest first, at most 30),
`commits` (how many lie between) and `truncated` when pull requests or commits were left
out. It comes from the rollout's read-only action `rollout.shipped` through the resource
cache (one minute), GET only on the rollout transport: the workflow's last ten successful
runs on the run's branch (the previous one is the newest with a lower run number), one
compare of its commit with this run's (`/compare/<base>...<head>`, the first 100
commits), each commit's pull request from its message (“Title (#123)”, or “Merge pull
request #123 from …” with the title below) and, for at most ten commits whose message
names none, GitHub's pull requests for that commit. With no earlier successful run, or a
read that fails or takes over 10 seconds, `merged` is left out. For example:

```json
{
 "run": { "id": 101, "attempt": 1, "commit": "abc1…", "workflow": "Web / Release", "url": "https://github.com/acme/app/actions/runs/101" },
 "stage": { "name": "live", "environment": "live", "finishedAt": "2026-10-06T13:20:00.000Z" },
 "pullRequests": [{ "number": 16, "title": "Batch billing exports", "url": "https://github.com/acme/app/pull/16" }],
 "environments": [
  { "name": "preview", "status": "succeeded", "finishedAt": "2026-10-06T13:00:00.000Z", "jobs": [{ "id": 1, "name": "preview / ship", "status": "completed", "conclusion": "success" }] },
  { "name": "live", "status": "succeeded", "finishedAt": "2026-10-06T13:20:00.000Z", "jobs": [{ "id": 2, "name": "live / ship", "status": "completed", "conclusion": "success" }] }
 ],
 "previous": { "validationId": "V1", "verdict": "passed", "stage": "preview", "summary": "Preview exported as intended.", "checks": [{ "id": "C1", "title": "Exports complete", "status": "passed", "observation": "Error rate unchanged." }] },
 "component": { "path": "services/api/billing", "files": ["services/api/billing/export.ts"], "total": 1 }
}
```

The agent reports with the MCP tool `workspace_report_validation` (schema
`hivemind/rollout-validation/v1`): full snapshots with a strictly increasing `sequence`, `progress` then one `final`
report with a verdict (passed, concerns, failed, inconclusive) and at least one check.
Only the agent the validation was requested from may report it (the tool uses its launch
binding and refuses without one); other agents are refused; a lower or equal sequence is
ignored. **Follow-ups and unrequested ids:** a
`followup` report on a final validation needs a verdict and a check like a final one and
a higher sequence; it replaces the report, may change the verdict and counts as that
validation's newest answer (its final time becomes the follow-up's, so it can become the
current verdict and raise or withdraw Needs me); the card tags it **Follow-up** and its
meta line reads “follow-up 14:20 · was passed” (or “2 follow-ups, last …”). A `progress`
or `final` report after the final one is still refused and names `followup`; a
`followup` on a validation that is not final yet is taken as its final report, with a
warning. A report for an id nobody requested is accepted: the validation is recorded under
that id for the reporting agent (it must be an agent on the map), about the rollout's
current run attempt, with a warning in the receipt, and the card tags it **Unrequested**
(“V7 · unrequested · first report 14:02”); the next requested id follows the highest one.
**Started from chat.** People also ask an attached agent in its chat for a
validation, so `validationId` is optional. A report without one goes to the reporting agent's newest validation of the
rollout that is still open on the current attempt (requested, running or No report, not
resolved), or for a `followup` to its newest final one; with neither, the service starts a
validation with the next id (`V<n>`) for that agent about the current run attempt and,
for a staged run, the stage it has reached (the latest stage whose environment finished
with something run and whose delay passed, however long ago, with that environment as
its scope; otherwise the whole run). The receipt names the id and asks for it in later
reports. The card tags it **Started from chat** and its meta line reads “V3 · started
from chat · live done · first report 14:02”. Only an agent on the map can start one.

**Reuse instead of repeat.** A chat validation **covers** the stage the run
has reached (or, without stages, the attempt) while it is requested or running, and for 15
minutes after its final report (or follow-up), as long as it is about the current attempt,
of that same stage and not resolved. A later stage (live after a preview chat
validation, or a delayed check 10 minutes after live) is not covered. While one covers it,
asking from the item does not start a second validation: in the full view, Validate shows
that validation instead (no menu): its card opens and scrolls into view, and a line above
the timeline reads “Showing V3, started from chat, instead of a second validation: still
running · last report 14:05.” (or “passed 14:20.”) with **Re-run** and a dismiss button.
Re-run opens the usual agent list. Whenever a validation covers the stage, the list's
prompt reads “V3, started from chat, covers live and is still running. Show it, or
re-run the validation:”, its first entry is **Show V3** and every agent entry, Start a new
agent included, describes itself as “Re-run · …”; the choices carry `rerun: "V3"`, so
picking an agent there (also from the map's Trigger validation and from Approve and
validate) asks for a second validation on purpose. A `trigger` without `rerun` while a
validation covers the stage, or with the value `attach`, sends and records nothing and
answers `{ sent: false, attached: true, validationId }` with a line the map's toast shows.
Automatic staged requests count a chat validation of a stage as covering that stage like
their own request; a run without stages was already covered by any validation of its attempt.
Agents may narrow
`scope.jobs`/`checks[].jobIds` to jobs of the validated attempt (others are dropped
with a warning) but never widen the run. Text is sanitized and clipped (summary 600,
title 200, observation 800); the summary and observations keep their paragraphs, list
lines and code blocks, while titles and recommendations become one line. More than 30 checks or 64 KB is refused, extra metrics
(4), evidence (6) and recommendations (8) are dropped with a warning, and evidence must
be https without credentials; links open externally and are never fetched. Triggering
and **Ask to report** are human-only; agents may list validations and options.

A validation is **stale** when the rollout is on another run, attempt or commit, and
**resolved** when a newer final validation of the same attempt exists, whatever jobs
either one looked at. The rollout's current verdict is therefore
the newest final, not stale validation: the header, the card and Needs me follow the
latest answer, and the older ones stay listed as resolved. A validation that never
sent a final report is resolved by a final one of the same attempt requested after it
(a higher `V<n>`) and ends as No report: it no longer shows as validating
on the card, in the header or in the jobs rail, its card says which validation answered,
and it offers no Ask to report. One requested after the newest final validation stays
under way and shows as validating. Needs me is derived
per validating agent (source `validation:<agent>`): failed → Action required (“Validation
failed”), concerns → **Validation concerns · hold the release** (“Validation found
concerns”); passed, stale or resolved validations
withdraw the entry without marking it seen; inconclusive stays quiet. A requested or
running validation whose agent stays idle for two minutes without a final report
becomes **No report**. Idle includes Claude sitting at its idle prompt (“Agent
waiting”), counted from when it got there, so a validation abandoned before a restart
ends on the first pass after it; a question or permission prompt waits on
the person and does not count. A validation that hears nothing from its agent for
15 minutes (no report since it was requested, the last report or Ask to report) also
becomes No report, whatever the agent seems to be doing, since agents report progress
at least every 2 minutes. **Ask to report** re-prompts that agent, and a late report,
progress or final, is still accepted. Validations and the rollout's transitions (attempt started, gate
waiting, gate approved by you in the app or on GitHub, run completed, one job snapshot
per attempt) are stored locally (`rollout_validations`, `rollout_events`) and survive
restarts; job starts and finishes come from job timestamps, so no GitHub requests are added.

The full view shows the state, run reference and current verdict above a
live-jobs rail and a timeline. The validations list and the timeline follow the
rollout's snapshot: a report an agent files shows in an open view as soon as the
service has stored it (the view's `update` is the signal, the periodic read only a
backstop), not on the next poll. Reading the list never waits for the service's
reconciliation pass, and a report repaints its rollout's map card before that pass
runs. The rail has an attempt switcher, jobs grouped by stage
(environment names, then the job-name prefix before “/”), running jobs with elapsed
time, the gate row with **Approve ▾** (the existing human-only approval, and the view's
only Approve: the status chip and the timeline's waiting row jump to it, or open the approval menu while the rail is folded; its menu lists
Cancel first with focus and asks again with Back focused before **Confirm approval**) and verdict or
magnifier stamps on jobs a current validation covers. Clicking a job filters the
timeline to that job and its validations across attempts; Escape clears it. The
timeline lists job, gate, attempt and run events newest first with one updating card
per validation (verdict, agent, scope, pips, blocking advice, checks with metrics and
evidence), collapses superseded attempts under a divider, and filters All, Validations,
Jobs and Problems. A card's head is the verdict badge and agent, then the summary's
first sentence in bold (when it is a short sentence of prose); with the report shown
(**Show report ▾**) the rest of the summary follows in body weight. Summaries,
observations and recommendations render as Markdown through the shared sanitizing
renderer: paragraphs, line breaks, bullet and numbered lists, bold, inline and fenced
code; links only when https without credentials (opened outside the app, others stay
text), and raw HTML shows as text. A long single paragraph with no line breaks or code
(as agents usually write) is shown one sentence per paragraph. Each check row is a
disclosure button (`aria-expanded`): collapsed it is one plain line ending in an
ellipsis with compact before → after metrics; open it is a block: status, full title,
target and method, then the observation, each metric labelled with its window,
before → after and change, and the evidence links; a skipped check labels its reason
**Skipped**. Long text wraps and nothing scrolls sideways. Concerns and failures start
open; a toggled row keeps its state across refreshes while the view is open. The
request asks agents for a one-sentence lead in the summary, observations of one or two
sentences with details as bullet lines, and comparisons in labelled metrics. The rollout map card shows the state and a jobs summary, then a
verdict that needs you, else a validation under way, else the running jobs with elapsed
time, else a passed validation. Reuse the plugin/account/cache/command infrastructure for UI and MCP.

**Validation liveness.** A validation under way (requested or running, not
stale or resolved) shows when its lead last reported and its current step: the first
sentence of the latest summary on one line (80 characters, Markdown marks dropped). The map
card's line reads “Validating · Claude · 2/5 · 2 min ago · Interim: live looks
healthy.” (“waiting for the first report” before one), and it now comes before the running
jobs line, whose count stays in the jobs summary (“2 running”). With no report for 3
minutes, counted from the last report, or from the request (or Ask to report) before the
first, the line turns amber with an alert glyph and reads “No report for 3 min” in place of
the time. The full view shows the same beside the header's running validation and under
the card's meta line (“Last report 14:05 · 2 min ago · …”, amber “No report for 4 min ·
last report 14:01 · …”). Each report stores when it arrived (`report.at`; older rows fall
back to their update time). The card follows through the service's 15-second pass and the
view re-renders on its own 3-second read when the minute or a quiet flag changes, so neither
needs a reload. A verdict that needs you still takes the card's line; the view then still
shows the re-check's liveness.

**Rollout view frame and jobs rail**. The full view runs flush to its
frame: no inner inset, panel border or hint footer. The frame bar (title, Actions, the
meta row) keeps the item's blue band, and the body uses the blue family
(`--act-blue-*` tokens) for surfaces, lines, ink and the frame's own controls instead
of the app's green, so nothing clashes with the blue frame. Semantic colours (mint
passed, amber concern, red failure, blue running) are unchanged. This is scoped to the
rollout view through its own stylesheet; the resize grip stays on top. The former
footer hints (“Click a job to filter”, “Ask an agent to validate”) appear under an empty
timeline instead; while queued, the ladder's own hint says the timeline follows.

The jobs rail folds with a **‹ / ›** button in its header (named “Fold the jobs rail” /
“Show the jobs rail”, with `aria-expanded`) or with **[** while focus is in the view and
not in a text field or menu (KEY-01; listed under Views in Controls). Folded, it is a
40 px status strip: one glyph button per job with the rail row's glyph and colour,
in stage order with a thin divider between stages, named “<job>: <state>” and labelled
beside the strip on hover and focus. Clicking a glyph filters the timeline exactly as
the row does (`aria-pressed` and a highlight on the picked one; Escape clears it).
Running, waiting and failed jobs stay visible as glyphs; the strip has no Approve
buttons, so with the rail folded the status chip and the timeline's **Go to approval ›**
open the approval menu directly, and Actions keeps Approve. The rail starts folded; opening
it is view state, not item data: it is saved per item in the workspace view (`itemViewState.<node>.jobsRail: 'open'`,
beside the item's saved view bounds), survives reload and restart, and never changes the
item or its cached provider read. Below 700 px of view width the rail folds on its own
without saving that, unless it is opened at that width; widening again returns to the
saved choice. The column width animates on fold and unfold, except under reduced motion.

**Rollout queue**. Only while
a rollout is **Queued** (active run, nothing in progress, no gates) the provider also
reads the same workflow's runs (and branch, when the item follows one) that are in
progress or waiting, plus those queued or pending with an earlier `created_at` — at most
ten, four list reads with ETags. GitHub does not expose concurrency groups, so the view
says “same workflow” rather than claiming exact queue order. Each run's PR comes from
`/commits/{sha}/pulls` and its `merged_by` from `/pulls/{n}`, cached per commit in memory
(merged PRs never change; bounded to 500 entries); a run without a PR names its actor as
the pusher. Up to three running/waiting blockers get a jobs read (finished/total, current
job) or a pending-deployments read; a blocker waiting for approval or protection rules,
or with a failed job, is **stuck** with the time since. The estimate is the median of the
workflow's last ten successful runs (cached 15 minutes), shown with “~” and hidden below
three samples or while a blocker is stuck. Failing to read any of this never fails the
observation: the ladder is simply absent. The full view's body becomes the ladder:
“N rollouts ahead of you” (or **Next up** with one running blocker), “Same workflow on
&lt;branch&gt; · you start in ~X min” (or which stuck blocker holds the queue), one rung per
run — ▶ running with progress and time left, ! stuck in amber with how long, position
for queued — with PR title and number, initials, “merged by &lt;login&gt; · &lt;time&gt; ago” and
**Open run ↗**/**Open PR ↗** (https only), and the item's own run in blue at the bottom.
The map card reads “Queued · 2 ahead · next: &lt;login&gt; #&lt;n&gt;” or “Queued · behind stuck
#&lt;n&gt; (&lt;login&gt;)”. A queued rollout counts as working, like an ongoing one; a run waiting on a gate stays idle. Queueing never raises Needs me. Each blocker seen is kept
as a `queued-behind` rollout event, so after the run starts the timeline shows one
“Queued behind #21 (octo-a), #23 (octo-b) · started after waiting 31 min”.
The dashboards' PR hover preview is not reused (it is keyed to map items); rung titles
carry a plain tooltip instead.

| ID | Type | Required behavior |
| --- | --- | --- |
| RES-01 | Pull request | URL-only creation; authenticated provider title, description, comparison summary and state inside the item. “Open pull request” opens its canonical GitHub URL directly, with state shown separately. The expanded view uses Review desk: repository/PR number in the movable frame, one content title, lifecycle/review state, compact author/diff metadata (branch details inside the description), and refresh. Conversation threads are ordered by latest activity with oldest-first replies grouped by GitHub parent identity, file/line context when available, author/date and canonical source links; bodyless approvals and other review activity are hidden by default. Settings → Items → GitHub pull request configures discussion comments, code comments/thread replies, written review feedback, bots/GitHub Actions and textless review activity. Default to human comments and replies. The map comment pill counts only unseen comments under the saved conversation filters and disappears at zero. Mark seen/unseen updates it immediately across aliases; edited comments and new replies count again. Count only known cached comments, without guessing unread totals outside bounded coverage. Keep approval/check status syncing independently of conversation visibility; retain cached content and seen receipts. A collapsed Connected reviews row above the single conversation column shows directly connected review summaries, state and revision freshness when expanded. No right-hand column. Root comments have distinct stepped cards and replies are inset. An unseen comment is marked new: a blue (info) bar on its left edge, a blue edge and a “New” chip after the author; a seen one has a quiet grey bar and a softer author name, and loses the chip. Every comment starts with a 180-code-point plain-text preview; click or keyboard expands safe full content independently of Seen. Human comments opens per-view visibility controls; persistent defaults remain in Settings. Missing or filtered code-thread parents have an explicit source link, never a fabricated root. Description is collapsed behind Show/Hide description, rendered as safe Markdown. Group the three review-launch actions under a collapsed Trigger Review button. Show discussion comments, inline code comments and review bodies with author/date, safe Markdown and sanitized HTML (including details/summary; no scripts, embedded images, events or active form fields). Comments have Copy link, Mark seen/unseen, Reply and, when linked, Fix with agent. Seen is local, persists across restart and aliases, collapses fully read threads under one Seen disclosure below unseen; edits or new replies resurface the thread. Preserve comment expansion and Seen disclosure state across unchanged polls. Replies post only on explicit submission: inline code replies stay in their root thread, discussion/review-summary replies link the original in the PR discussion. Preserve drafts during refresh. Fix prompts are explicitly sent to a selected connected idle agent, bound to this PR/comment and process; busy/stopped agents are unavailable. Journal writes/delivery before dispatch; do not automatically retry uncertain outcomes. On opening a PR after restart, immediately display its persisted description, state and comments with Seen receipts, even when the cache is expired or credentials are disconnected. Show that saved content is being refreshed and its last checked time; refresh in the background, retain content on failure, and never acknowledge newer attention from the saved preview alone. Retain saved comments when offline; large conversations explicitly show recent bounded coverage and a GitHub link. No Files/Discussion/Reviews tabs. Preserve immutable revisions for analyses. **Mark all seen:** beside “Conversation · N unseen” a button marks every comment loaded in the view as seen in one local request, filtered ones included; it shows only while one is unseen, never writes to GitHub, and a comment edited or added after the list was shown stays unseen. **Menu choices:** Merge, Change state and Show/Ship show the choices saved from their last read at once and refresh them from GitHub in the background (PR-MERGE); only the first open of an item shows “Checking …” while it reads. |
| RES-02 | Types from a plugin pack | Not part of the public app. A plugin pack may contribute a type (for example an internal ticket tracker) with its account type and views; its own documentation holds the requirements. Saved items of a pack that is not installed stay as placeholders with their data. |
| RES-03 | Notion | URL-only creation from `www.notion.so`, `*.notion.site`, `notion.com` and `app.notion.com/p/<workspace>/<slug>-<id>` links; provider title and readable page content with source link. Auth/error/loading states are explicit. **Title:** the item is named after the page's title property, read in full on the first read and again on every read that sees a new edit time, so renaming the page in Notion renames the item (and its resource) on the next poll; a page without a title is “Untitled”. As for every provider-titled type, Item settings shows the name read-only. The one exception is a web link upgraded under RES-10 whose title the person had chosen: that title is kept and later reads leave it alone, while the full view still shows the page title. **Comments:** pages are polled on the shared cadence (60 s, stretching to 10 min while unchanged; an unchanged page costs two page requests). Each read lists the page's open page-level comments plus inline discussions on blocks: up to 10 blocks already known to have discussions and the next 10 blocks of the page in turn (first 500 eligible blocks), so an inline comment on a block not yet visited appears within a few reads. Resolved discussions are not listed by Notion. Unread state is local, never written to Notion: a watermark per item (whole minute + ids of that minute) in the resource cache, surviving restarts. Comments present at the first observation are read; later comments by anyone but me are unread. “Me” is the connected integration (its bot, plus a user owner for OAuth integrations) and the IDs in Settings → Items → Notion page → Comments (“Your Notion user ID”); the Notion CLI's internal integration tokens cannot identify the person, so without that setting comments written by the person in Notion count. The map card shows the unread count with the shared comment cue, the same one a pull request uses for unseen comments (one builder, `unreadCommentsIndicator`; cue id `comments`, message glyph, blue, label “N unread comments”, which a narrow card shortens to glyph plus number; the count stays visible at the small size). Being an ordinary indicator it also is the item's far-zoom badge and its status in dashboard rows and previews. The full view's status chip reads “N unread comments” (in the meta line while Archived); both hide at zero. New unread comments raise Needs me (reason `comment`, source `notion.comments`) with “New comment” / “N new comments” once per batch; unchanged polls and restarts do not notify again. Opening the page link from the app (Open on Notion in the item menu, double-click to web, or ↗ Open in Notion in the full view) moves the watermark to that minute and clears the count, but does not withdraw Needs me: the entry stays until the person marks it seen (Seen in Needs me or Mark seen in the frame; STATE-02). Expanding the item changes neither. A later unread comment raises a new Needs me cycle. A missing Read comments capability (403) is an explicit degraded state (“Comments unavailable” in the full view, no badge); page content still loads, background polls ask again after 30 minutes and Refresh asks at once. |
| RES-04 | Linear | URL-only creation; issue identifier, provider title, status and Markdown description rendered with an established library. Support headings, emphasis, nested/task lists, links, quotes, fenced code and tables; keep code/tables horizontally scrollable inside the view. Provider HTML stays inert, task checkboxes are read-only and links use the existing browser-opening path. Compact bubble shows identifier, title and a colored workflow status label. Default small footprint is 240×64: allow a two-line title beside the icon and place the status on a separate, left-aligned row with a clear gap. Preserve manually saved sizes; shorter cards use a single-line title to prevent overlap. Right-click → Change status and clicking the current status in the full view open the ticket team’s actual workflow states, including custom states. **Linked pull requests.** The issue read asks for `attachments(first: 50) { nodes { url } }` and keeps the GitHub pull requests among them (`https://github.com/{owner}/{repo}/pull/{n}`, each once, owner and repository compared without case) as `pulls` in the cached detail. The ticket's map menu offers **Linked pull requests ▸ Add to the map** (runtime operation `linear.ticket.pulls`, human only; agents may read `options`): every listed pull request is attached as a pull request item with the default GitHub account, in the ticket's project, placed beside the ticket and linked from it (reference); one already in that project is reused, not added twice. The map flies to the first; one that cannot load is reported while the rest are added; a ticket Linear lists none on says so. Nothing is added without the click. |
| RES-05 | Slack | Label the type simply “Slack”. Accept message/thread permalinks; preserve selected message and thread-root identities, show fetched content and attribution. Reads/context do not post replies. A newly attached item is named once with a 2–5 word AI summary of its selected message (and thread root); the attempt is spent before the call, so refreshes, edits, replies, restarts and failures never regenerate it, and refresh never overwrites a generated or renamed title. Until then, or on failure, the provider title (`#channel · excerpt`) stays. |
| RES-06 | Web link | URL-only creation; detect page title with domain fallback. Activation opens a browser at the exact URL and preserves map location. Private/authenticated pages can remain links even when metadata is unavailable. A link whose URL a connected, more specific type claims is upgraded to that type (RES-10). |
| RES-07 | Terminal | Label the type simply “Terminal”. The name is optional when starting one; left empty it is “Terminal · ” and the folder’s name (just “Terminal” without a folder). Local shell with stable identity, cwd, resize/input/output and reconnect history. A reference/context gesture must never execute text as a shell command. |
| RES-08 | Review/artifact | Each run/output has its own compact item, state, originating session and explicit PR link. Completed outputs remain navigable and retain the revision actually analyzed. |
| RES-09 | Note | A sticky paper tile whose text is the card face. Create from the ring (Note, hotkey N while the ring is open) with the caret already in an unsaved tile, or by pasting plain text over the map; nothing is saved until it has text; a size given to the unsaved tile stays with it, writing goes on, and its first text saves both. A click edits with the caret where it landed; a drag past 6px moves the tile; tape and margin drag while editing. Esc, ⌘↵, blur or zooming out commit (Esc never discards); typing saves after 600 ms; ⌘Z undoes. Delete edits text while writing and archives a selected tile with Undo. Light markdown on the idle face (bold first line, lists, clickable checkboxes, code, guarded links; HTML inert); raw text while editing; no full view. Mint paper by default plus moss, ice, sky, lilac, rose, peach, sand, fog and slate, or a custom `#rrggbb` from the colour picker (COLOR-PICKER); a dark paper (slate, or a custom one dark ink would not read on) takes light ink. Agent-written notes get copper tape and a byline. A local label, then a Haiku title for mid zoom, dashboards and MCP. Supports floating/project placement, links, archive/restore/delete and agent context of saved text only; separate from to-dos. |
| RES-10 | Link upgrade | A web link (the URL fallback type) whose URL a more specific URL type claims becomes an item of that type in place, e.g. an `app.notion.com` page saved before those links were recognised. The rule is the shared URL matching of From URL and drops (`registry.conversions`), never a provider branch; exactly one claiming type is required for the automatic path. **What stays:** node id, resource id, position, size (a preset the new type lacks falls back to its default), project, links, to-do attachments, archive/done state and Needs me. **What changes:** the resource's type, its data (the type's normalized identity, so the original URL spelling is not kept) and its account binding (the provider's default connection); the old summary and status cues are cleared and the first read fills them. **Migration note:** persisted identities stay valid because the resource id is kept and only `pluginId`, `schemaVersion`, `data` and `connectionId` are rewritten by one atomic `item.convert` command; nothing is renamed, no table changes, and caches are keyed by resource id plus a fingerprint that includes the type, so the old type's snapshot is never shown for the new one. **Order:** the provider is read first and the item changes only after that read succeeds, so an unreadable page stays a working link and is asked again at the next start. **Automatic:** once at service start and when accounts change, for links on the map whose provider has an enabled account; quiet (no notice, no Needs me from the upgrade itself; the first read records existing comments as read) and idempotent (nothing to upgrade means no provider request and no workspace change). Archived and Undermap links are not upgraded automatically. **Duplicate guard:** if the provider item is already on the map under the same account, the link stays as it is. **Title:** a title the link got on its own (its saved page title, host name or a type name) is replaced by the provider title; a title that differs from the saved page title was chosen by the person and is kept; when no saved page title exists the title is not treated as chosen. **Manual:** the item menu of such a link offers “Convert to <type name>” beside Open in browser (one entry per claiming type; not in Undermap or for selections); it runs the shared `resource.convert` runtime action, available to the app and to agents under the same policy as attaching an item, and reports a missing account (“Connect … in Settings”), an unreadable page or a duplicate instead of changing anything. |

**Linear workflow updates.** Cache the available status catalogue
across items and projects, scoped to Linear account/team. Reuse it for the service
lifetime; reload if an observed current state is missing. Current issue state
continues syncing, and explicit changes validate against a fresh workflow.
**Item view header.** Expanded provider views (Linear, Notion,
Slack; the shared `mountProviderRead`) do not draw their own header. Plugins
supply data (status chip, one meta line, provider link); the host writes it into the
frame bar after the icon and title: status chip · meta ··· primary actions · ↗ Open in
{Provider} · freshness · ↻ Refresh · close. The title appears once, in the frame bar;
the reference (BIL-128, Thread · N) moves into the meta line. Long-form documents
(Notion, Linear) repeat their title in the body only when the view is wider than
900px. Freshness reads “Read 2 min ago” (full time in its tooltip) or, when a
refresh failed, an amber “Saved copy · 14:02” with one banner under the header:
“Couldn’t refresh from {Provider}. {reason} You’re reading the copy saved at 14:02.”
The header paints immediately from local data with “Reading…” and a three-line
skeleton, or with the saved snapshot when one exists. Below 640px the header
controls wrap to a second row. Bodies share a 24px inset (16px below 560px) and a
centred reading column above 1000px; empty bodies use one muted empty-state block.
The pull request full view uses the same frame bar: the PR title, a lifecycle chip
(Open, Draft, Merged, Closed), the meta line “#42 · owner/repo · ✓ Approved · 1 file
+24 −6 · updated …”, then one **Actions ▾** menu button (it replaces a
row of five buttons). The menu lists Review, Show/Ship and Merge, a rule, then the
state actions (PR-STATE) Convert to draft or Ready for review, and Close… or Reopen.
One entry is marked primary by state: Merge when approved, Review when a review is
still required, and the Actions button takes the same accent. A disabled entry says
why underneath. Picking an entry does what its button did; a menu it opens (merge
methods, tags, the close confirmation) anchors at the Actions button and returns
focus there. Views with one or two header actions keep their buttons and fold them
behind More actions (⋯) only when the row is tight. Description is a disclosure like Connected reviews.
Left of Actions sits one checkbox, **Auto validate**, on by default for
every PR and stored per PR as `autoValidate: false` in its data when unchecked (a
missing value reads on; the box applies at once, no Save). While it is on, every
rollout this PR discovers (PR-05: the deploy runs that follow its merge) is validated
without a click: when such a rollout first shows a run attempt that no validation
covers (same run, attempt and commit), the service triggers a validation exactly as
**Validate** in one click would: the rollout's own validation agent — its idle hidden
validation agent asked again, else a new one started hidden (Validate in one click,
Retiring hidden validation agents) — never an agent connected to the rollout, so the
agent a person is working with is left alone. Only while Claude cannot start a session
here (not installed, not signed in, the starter unavailable) does a ready connected
agent take the request instead, preferring one connected through this PR, and the
direct connection is then added like a manual trigger; with none ready either, the
service tries again on each of its reconcile ticks until the run completes, then gives
up for that attempt. While **Auto deploy** is armed on a PR, Auto validate leaves the
rollouts that PR discovered to it: Auto deploy asks for its own validation at each step
it waits on, so asking here too would validate every stage twice (another PR with Auto
validate on, and no armed Auto deploy, still counts). One automatic validation per attempt (per phase for a gated run, see Validations per phase), journaled like a user
trigger, and listed as “automatic” in the rollout's validations. Unchecking stops
future automatic triggers and cancels nothing running.
Agents still cannot trigger (human-only rule); the checkbox is the person's standing
instruction.

**Staged runs.** A run of a staged workflow is validated once per stage instead of
once per attempt, for example when its preview environment finishes and 10 minutes
after its live environment finished, each with its own id (the next `V<n>` of the rollout) and no click in between;
it gets no whole-run validation when its attempt starts. Which workflows are staged is a
setting of the rollout package (Settings → Items → Rollout → **Rollout stage rules**,
stored as `settings.plugins["github.rollout"].stageRules`), empty by default, so out of
the box every workflow keeps the one validation per attempt above. It is a JSON list of
rules, validated with zod when settings are saved (a draft that does not parse is
refused with the first problem, such as “stage rules at 0.workflow: workflow must be a
valid regular expression”). A rule has an `id`, a `workflow` regular expression matched
case-insensitively against the workflow's name (or the run's name for a rollout pinned
to a run) and up to ten `stages`, each a `key`, an `environment`, an optional
`delayMinutes` and an optional `focus`. The service reads the setting on every pass; the
renderer never sees the rules. For example:

```json
[{ "id": "web-release", "workflow": "^release$", "stages": [
  { "key": "preview", "environment": "preview" },
  { "key": "live", "environment": "live", "delayMinutes": 10 }
] }]
```

Environments come from the job names as in the jobs rail (`preview / …` → preview,
`live / …` → live). A stage is due once every job of its environment
completed with at least one that ran (not all skipped or cancelled; a failed stage is
validated too), plus its delay, counted from the last job's `completed_at`. Only the
latest due stage is asked for: one that falls due while an earlier one waits replaces it,
and a stage nobody could take within an hour of falling due is left alone, so a restart
hours later asks nothing. A stage is asked for when Auto validate is on for a pull
request that discovered the rollout and no validation of the attempt is still requested
or running (and not resolved); otherwise each reconcile pass looks again. It goes to the
rollout's validation agent like the whole-run case: the idle hidden agent that validated
the earlier stages is asked again (it keeps their context), else a new one starts hidden
with the stage in its scope and prompt; only while Claude cannot start a session does a
ready connected agent take it (the agent of the attempt's latest validation first, then
one connected through that pull request, then any), and without one the pass waits. A stage counts as covered by its own request
(a request id derived from rollout, run, attempt, commit and stage, so it is sent once
across passes and restarts, and a delayed stage's time comes from the stored job snapshot) or by
a validation a person requested after it fell due. A stage's focus defaults to its
environment, or “live, 10 minutes after it finished” with a delay; its card label
is “preview done” without a delay and “live +10 min” with one, and is stored with
the validation. With the example rule, the request says “focus: preview” or
“focus: live, 10 minutes after it finished”, adds “The table
asks for one validation per stage of this rollout, each with its own id: preview;
live, 10 minutes after it finished. Earlier validations stay final and
on the table; the newest final report is in the context below. Judge this stage, and say
what changed since that report.”, and scopes the validation to that environment, so the
rail stamps its jobs. The card's meta line reads “V2 · automatic · live +10 min ·
requested 14:05” (“preview done” for the first stage). Earlier ids stay final and listed;
the resolution rule is unchanged, so a newer final validation answers an older open one.

**Done sync.** A Linear state of type completed or canceled
checks the item's to-do and Mark done on every alias; moving back to another state
reopens it. This mirrors only an observed change, so a poll that still sees the
old state never undoes a local check awaiting its write. Checking the to-do (overlay,
dashboard, Mark done, batch or agent `node.complete`) moves the issue to the team's
first completed state by position, recording the previous state; unchecking returns
to that state, else the first started, else the first unstarted one. Nothing is
written when Linear is already done/open. The write re-reads the issue and workflow,
is never retried, and a refused or unconfirmed write reverts the local check and
shows the error (unconfirmed: refresh reconciles). Tickets without a bound Linear
account complete locally. Show its label in the default compact
240×48 bubble; very small/zoomed-out forms retain a colored status icon. Map items
refresh in the background about once a minute, including unopened items, with
account cooldown and archive handling. Retain known state with an Updates paused
cue when reads fail. Opening or dismissing a status menu only reads; selecting a
new state explicitly updates Linear. Mark the current choice and prevent duplicate
submission while pending. Menus support keyboard navigation, Escape and outside
click dismissal. Use confirmed provider responses to update aliases and cache;
preserve title identity, position, connections and local task state. Reject stale
choices, another account/team/item, and archived issues before writing. A timeout
or lost confirmation must report uncertainty and must not automatically repeat a
write after reconnect/restart. The same actions are available through generic
plugin/MCP dispatch. Read-only credentials remain usable for viewing; updates
require issue-write permission. Live mutation acceptance requires human supervision.

Saving/reading notes needs no network access. Title generation uses the signed-in
Claude CLI, bounded note text and an isolated tool-free turn. Failure or unavailable allowance retains the useful local label and never
loses or blocks the note. A changed body gets a fresh title; unchanged text is not
repeatedly sent. Late responses cannot overwrite newer text, explicit title edits,
archived/deleted items or shutdown state. Their body is saved through the
same validated item commands used by agents; each text save names the text it
replaces. If another writer changes a note while you type, keep the draft and caret,
pause saving and show a copper strip with Compare and Keep mine rather than silently
replacing either text. Agents read saved text only, never a draft. The host records
the agent that last changed the text (`data.writer`, never taken from command data)
and drops it when a person rewrites the text. A generated title arriving alone must
not invalidate a text draft. Note is in the default creation ring; saved quick-picker
preferences are kept as they are. Notes keep `workspace.note`, `data.text` and the
small/medium/large ids; schema v2 adds optional `data.paper` and `data.writer`
through a migration that changes no data.

**PR-01 — Assignment ingestion.** Discover open PRs assigned to the connected user,
not a second “Assigned to me” UI category. Auto-attach only when repository mapping
identifies exactly one project; otherwise show a floating item through Needs me. Initially infer repository mapping
from already attached PRs for that account: exactly one visible project must match.
Merge with existing provider identities. Only marking the item seen (Needs me Seen
or the frame's Mark seen) acknowledges the visible Needs me entry (STATE-02); opening
it does not, unless the type is checked under “Opening an item marks it seen”. The view no longer sends the assignment-cycle receipt (`resource.viewed`
remains for compatibility). Repeated syncs/new commits do not unread
it; reassignment after unassignment starts a new unseen cycle. Partial sync failures
must not clear assignments. Closing/unassigning clears that attention reason only. Verify previously assigned
PRs absent from discovery individually before treating absence as unassignment;
permission or partial-read failures preserve prior attention. Keep independent
provider/workflow reasons so source reconciliation cannot clear unrelated reasons;
the explicit item-level Seen/Mark seen action acknowledges all observed reasons. Respect
archive/delete: an item deliberately deleted during one assignment cycle remains
deleted until reassignment begins a new cycle. Settings exposes sync status and
manual refresh; normal polling runs once per minute while the workspace is open.

**PR-REWORK — An agent reworking an item.** An agent about to change an existing item
(pushing fixes to a pull request, rewriting a note) sets `node.rework { id, note }` with
what it changes (≤200 characters; the guide asks for ≤60) and keeps it current; it
clears it with `note: null` when done or abandoned. The shared agent guide asks for
this (guide v2026-10-22.1). While a note is set every node of the item is working
(mint, counted as working in dashboards and plots) and provider status cannot take it
out of that state: a provider `node.update` keeps `activity: working` and the poll does
not rewrite activity for it. Clearing it sets the item idle, and the next provider read
restores its own state. The command is revision-free, belongs to items (a project is
refused), and the MCP fills `by` with the calling session's node. A pull request's view
shows **Reworking · <note> · <agent title>** as a status line above the description,
with **Mark as completed manually**, which clears the note (the agent is not stopped).
When an agent clears its own note (the clearing carries `by`; the MCP fills it), the
item enters Needs me as **My turn** with “Reworked: <note>” (attention source `rework`,
once per rework); a clear by hand raises nothing, and a new note takes it back out.
Item views receive it through `observeRework` and `clearRework`. The same guide asks
agents to save a `blocks` link between pull requests that depend on each other, the
one that must merge first as source.

**PR-05 — Background PR updates.** Poll visible attached PR resources once per
minute while the workspace is open, independently of assignment discovery and
expanded views. Update title, open/draft/closed/merged state, discussion and inline
review-comment counts, and latest review outcome. Show compact colored indicators
on the item and current status in its expanded view. Approval adds an independent
“Pull request approved” Needs me reason (note “PR approved”), acknowledged by Seen/Mark seen like
other reasons. **Checks failing** is a PR status: a ready (non-draft) open PR whose
current head commit has a failing check (failure, timed out, action required or
startup failure; cancelled, skipped and pending never fail) shows a red cross
“Checks failing” ahead of its review outcome (queued, merged and closed still win)
and raises a “Checks failing” Needs me reason once per head commit: a new failing
head is unread again, an unchanged one stays seen, and passing checks clear it.
When the branch has required checks only those count; otherwise every check does.
The check rollup comes with the fixed merge-queue GraphQL read of open PRs, so it
adds no request per poll; merged and closed PRs read no checks. Unchanged polls and restarts do not re-alert; approval following
withdrawal/dismissal or changes requested starts a new unread cycle. Determine
review outcome from each reviewer's latest decisive review (comment-only reviews
must not undo an approval); changes requested takes priority. “Approved” denotes
review approval, not satisfaction of all branch-protection or merge requirements.
An open PR in GitHub's merge queue shows “Queued” ahead of its review outcome
(merged/closed still win); queue membership comes from one fixed read-only GraphQL
query. Queuing clears the approval reason; leaving the queue while still approved
starts a new unread approval cycle. Closing/merging clears only this approval reason.
For six hours after a PR merges, each poll also reads the workflow runs of its
merge commit and adds deploy-like ones (push/workflow_run runs named or filed as
deploy, rollout, release, apply or CD, or waiting on a gate) as Rollout items in
the PR's project, beside it and linked from it. Each run is added once; deleting
it keeps it deleted. Discovery is best-effort and never makes PR status stale. Aliases share observations; no
archived-only resource is polled. Errors retain last known content/attention,
visibly mark it stale, and honor rate-limit backoff. Ordinary tests use fixtures;
no remote write is needed for polling.

**PR-MERGE — Merge from the menu and the full view.** Right-click Merge and the
full view's Merge button share one two-step confirmation: the options action reads
one fixed GraphQL query (PR node ID, state, draft, head OID, base branch,
`mergeStateStatus`, merge-queue flags and the repository's allowed/default methods)
and shows a prompt naming the PR number, title, base branch and short head SHA
with the choices. Merging is **best effort**: GitHub decides, so the
prompt warns rather than refuses when GitHub reports the PR closed, a draft, already
queued, conflicting (“GitHub reports merge conflicts.”), blocked (“Required reviews or
checks are not satisfied.”), out of date (without a queue), still computing or with
failing non-required checks. If the base branch has a merge queue the only choice is
“Add to merge queue”; otherwise the allowed methods among Squash and merge, Create a
merge commit and Rebase and merge, the viewer's default first (all three when GitHub
reports none allowed). Only an already merged PR is refused. GitHub gets time to answer:
each API read may take 60 s, each write 120 s and a `gh` call 60 s; a provider action
(the write and its refresh) may run 180 s in the service, and the app waits 200 s for
its reply. A caller that runs out of time reads “GitHub took too long to answer. Try
again.”; a write that times out stays outcome-unknown. The full view's Merge stays
clickable for closed, draft, queued, stale and saved-copy content, its title saying
GitHub may decline (e.g. “Draft — GitHub may decline”); it is disabled only without
content or once merged. The full view's Merge entry sits in the Actions menu.
**The full view merges in one click**: Merge reads the options and applies
the first one at once, without a menu: the viewer's default method, or Add to merge
queue on a queued base branch. Only a blocked-by warning (BLOCK-01) still opens the
menu, where Cancel is first with focus and picking a “… anyway” method merges. In the map
context menu the question (“Merge #42 … into main at aaaaaaa?”) is the confirmation and
picking a method under it merges; Escape or Cancel backs out without a request. The rollout Approve submenu keeps
its second step: Cancel first, and a picked choice expands into “…? This can’t be
undone from here.” with **Back** and **Confirm** while the other choices are disabled.
Confirming sends, without re-reading, exactly one fixed
`mergePullRequest` (with the PR node ID and the `expectedHeadOid` the options were
loaded for, which GitHub enforces) or `enqueuePullRequest` mutation, never
retried. GraphQL errors become a bounded, sanitized decline (“GitHub declined the
merge: …”); interrupted or
unconfirmed replies are outcome-unknown (“Check the PR before trying again.”). Success
returns the refreshed snapshot (Merged or Queued). **Saved choices:** the Merge, Change
state and Show/Ship options are saved per pull request item (not per repository: the
prompt, the head SHA and node ID they carry back and the blockers belong to that PR).
A menu opened again shows the saved choices at once, with blocker warnings applied
as of now, and reads GitHub again in the background; when that read differs the
entries are replaced in place (a confirmation in progress goes back to the list only
if the entries changed), and a failed read keeps the saved ones. A choice may
therefore be outdated: GitHub then declines it, as above. Any write on the item
(merge, state change, Show/Ship, whether it succeeds, fails or stays unconfirmed)
forgets its saved choices first, so the next menu reads GitHub before showing them. In the full view, a failure to load or apply Merge,
Show/Ship or a state change (including GitHub's decline) appears in the view's notice
and stays through background reads until the next such action or Refresh. The PR transport allows only
those GraphQL documents with validated variables; no other write becomes reachable.
The merge is `humanOnly`: agents may read the options over MCP but cannot merge.
When the PR has unresolved blockers (LINK-04) the prompt starts with “Blocked by
#64 Thumbnail refresh loop (open).” and every choice reads “… anyway” (e.g. “Squash
and merge anyway”); the chosen option carries the acknowledged blockers, and a
merge request without them, or with a blocker added since, is refused (“Blocked
by …. Reopen the menu and choose an option marked “anyway” to go ahead.”).
Show/Ship and other actions are unaffected.

**PR-SHOW-SHIP — Tag the title [show] or [ship].** Opt-in: Settings → Items →
GitHub pull request → Title tags → Show/Ship, off for new installs (installs that
used it before the setting keep it on). While off, the menu group, the view button
and the actions are absent. Following the Ship/Show/Ask convention, right-click Show/Ship and the full view's Show/Ship button (next to
Merge; it reads Ship or Show when the title is tagged) share one choice menu. The
options action reads the PR over REST and prompts with the current title; each
choice shows the title it produces. An untagged title offers [show] and [ship]
(the view menu adds Cancel); a tagged one marks its tag as current and offers the other and
Remove tag. Tags are recognised case-insensitively at the start of the title, and
tolerated at the end; any change removes every leading/trailing tag and writes the
new one as a `[show] `/`[ship] ` prefix, so tags never stack. Choosing the current tag
is a no-op without a write. Tagging is best effort: a closed or merged PR adds
“GitHub reports it is closed.” (or merged) to the prompt, and the view's button stays
clickable for closed, merged, stale and saved-copy content with a “GitHub may decline”
title. A result that would be empty or exceed GitHub's 256-character title limit is
a disabled choice. Confirming sends, without re-reading, exactly one
`PATCH /repos/{owner}/{repo}/pulls/{number}` with body `{ "title": … }` built from
the title the options were loaded for, never retried. A 422 is a decline; an interrupted reply or one whose title differs from the
request is outcome-unknown (“GitHub may have renamed it. Check the PR before trying
again.”). Success returns the refreshed snapshot, so the map card follows the new
provider title. The PR transport accepts PATCH only for that path with exactly a
non-empty `title` of at most 256 characters. The action is `humanOnly`.

**PR-AUTO-DEPLOY — Ship it and see it through.** **Auto deploy** in the PR view's
Actions ▾ (after Merge) and in the PR's right-click menu arms one auto deploy for the
pull request. The menu asks “Deploy #42 automatically?” and its one entry, **Start auto
deploy**, asks again in place: “Auto deploy #42 “Batch exports”?” with what will happen
(“Tags it [ship], merges it into main once ready (an agent fixes failing CI, twice at
most), validates every rollout phase and approves the next one only after a pass. Any
doubt halts.”; without Show/Ship turned on it starts “Merges it …” and the title is left
alone), Back and **Start auto deploy**. A closed pull request offers the entry disabled with
the reason; a merged one does too (“Already merged.”) unless a rollout its merge discovered is
on the map and still running (see “From here” below). Arming is the person's standing consent for the service to
write and to spend agent tokens for this one pull request; it is human-only, while agents
may read its status (`github.rollout.autoDeploy`, operations `status` and `options`).
Arming an armed pull request keeps the running one. While armed the menu instead offers
**Stop auto deploy** (“Nothing further is tagged, merged or approved. A write already
sent is not undone.”).

The service, not the renderer, then works through the steps, once per pass (15 seconds,
and after workspace changes), and records each in a persisted record (the rollout
package's plugin storage, collection `auto-deploy`, keyed by the pull request's resource (or,
for a rollout armed from here with no pull request on the map, by the rollout's resource),
so aliases share it and it survives restarts; no table or migration):

1. **Tag.** With Show/Ship on and the title not tagged [ship], one PR-SHOW-SHIP write
   (`pr.showShip`, value `ship`) with the title it read.
2. **Wait until mergeable.** The read-only `pr.mergeReadiness` action reads the same fixed
   GraphQL merge-options query, which also carries `reviewDecision` and the head commit's
   check rollup (`commits(last: 1) { … statusCheckRollup { state } }`; a rollup of another
   commit counts as pending), at most once a minute. Pending checks or an UNKNOWN merge
   state wait (“waiting for checks”); GitHub may report BLOCKED for a while after checks
   pass, so BLOCKED waits too, for up to 10 minutes.
3. **Fix CI.** Failing checks send one request per failing head commit to an agent: the
   agent of the previous fix or another ready agent connected to the pull request gets it
   as a prompt; otherwise a new Claude session starts beside the pull request (titled “Fix
   CI · <title>”, in its project's folder, linked to it, not hidden). The request names the
   pull request, its branch, the head commit and the failing checks, and asks to fix the
   cause and push to the same branch without skipping checks, merging, approving,
   retitling or closing. A new head's checks are then waited for. At most two attempts.
4. **Merge** with one PR-MERGE write (`pr.merge`) at the head it read: the viewer's default
   method, or Add to merge queue on a queued base branch (blockers, LINK-04, are not
   acknowledged, so GitHub's or the table's refusal halts it). In the queue it waits.
5. **Follow the rollouts** the merge discovers (PR-05). Phases: with a stage rule for the
   workflow (Staged runs), each stage is a phase, validated once its environment finished
   and its `delayMinutes` passed (“waiting out live · 7 min”); without one, each set of
   deployment gates that waits after something ran is a phase boundary, and the whole run
   is validated once more when it finishes. A gate is told apart by its environments and
   the jobs it holds back (`gate:<environment ids>@<waiting job ids>`), so a phased rollout
   that gates the same environment before every phase has one boundary per phase, each
   validated after the phase before it (“validating before production (apply-prod-phase-2 /
   apply (region-2))”) and approved on its own. A rollout without gates is one phase,
   validated once at the end. A gate waiting before anything ran is approved without a
   validation.
6. **Validate** each phase exactly as Trigger validation does (journaled request,
   `V<n>`, hidden validation agent rules, reuse instead of repeat): the rollout's validation
   agent (Validate in one click), which starts hidden when there is none; an agent connected
   to the rollout or this pull request is never asked. Each request is
   scoped to its phase, not the whole run: the trigger carries `phase { focus, jobs }`,
   the phase's label and the completed jobs no earlier validation of the rollout was
   given (`scope.focus`, `scope.jobs`), and the prompt says so (“one validation per
   approval phase … this one covers before production (…): judge what these jobs
   deployed: …; earlier phases were validated separately and stay final”). A newer final
   validation of the same attempt answers for it.
7. **Approve** the waiting gates the signed-in account may approve, only after every phase
   before them passed, with one rollout Approve write (`rollout.approve`) after re-reading
   the approval options; gates that changed are read again on the next pass. A gate only
   someone else may approve is waited on.
8. **Done** once every followed rollout finished successfully and its last phase passed.

Each write is sent exactly once and never retried: its request id is derived from the
record and the step, the record is saved as `sending` before it goes out, and its outcome
is read from the job journal. After a restart a `sending` write the journal confirms
counts as sent, one the journal never recorded was never sent and is decided again, and
anything else (interrupted, outcome unknown) halts. A validation request whose reply was
lost is asked again with the same journaled request, which never sends twice.

**Any doubt halts.** The record ends `halted` with a reason, raises Needs me (“Action
required”, note “Auto deploy halted”, source `auto-deploy`) on the pull request and writes
nothing more; nothing is rolled back. It halts when: a validation fails, finds concerns, is
inconclusive, sends no report or has no verdict within an hour; checks still fail after
two fix attempts, or a fixing agent pushes no new commit within 45 minutes; a required
review is missing or changes were requested (only a person can resolve that); the branch
has merge conflicts, is out of date without a merge queue, or stays blocked; the pull
request is a draft or closed; GitHub or the table
declines a write; a write's or a fix request's outcome is unknown; no agent can be asked
(none ready and Claude cannot start, or a validation request fails); a deploy run or job
fails or is cancelled; no deploy run appears within 30 minutes of the merge. Waiting is not
doubt: pending checks, the merge queue, running jobs and a gate someone else approves wait.
Done raises “Finished · ready to view” (note “Auto deploy done”). Stop ends it without
Needs me; so does taking the pull request out of the merge queue after auto deploy queued it,
which counts as a person stopping it, and requeueing it by hand does not arm it again. Arming
again starts a new record and withdraws the old reason.

The PR view shows a status line under the frame bar while a record exists (not after
Stop): “Auto deploy · waiting for checks”, “· fixing CI (1/2)”, “· merging”, “· in the merge
queue”, “· waiting for the deploy run”, “· deploying live”, “· waiting out live · 7 min”,
“· validating preview”, “· approving live”, “· live waits for another approver”, “· done”
or “· halted: <reason>” (amber), with **Stop** while armed; the Actions entry reads “Auto
deploy · on”. A rollout the record follows shows the phase track (below) under its frame
bar. Auto validate (below) is unchanged and may validate the same rollout; auto deploy
follows its own requests. Live GitHub writes and real agent sessions under auto deploy
require human supervision; tests use fixtures only.

**From here.** A rollout that is already running can be handed to auto deploy: the rollout
view's Actions ▾ (after Validate with…, behind a rule) and the rollout card's right-click
menu offer **Auto deploy from here…**, and a merged pull request's Auto deploy entry offers
**Auto deploy its rollout** (“run #1842”) or **Auto deploy its N rollouts** while a rollout its
merge discovered is on the map and running. Each asks in place, “Auto deploy run #1842 from
here?”, with two choices, the first checked: **Validate what shipped first** (“Phases with no
passing validation are validated before the next gate.”) and **Start from the next phase**
(“What already deployed counts as accepted; only phases that finish from now on are
validated.”). Under them the plan for the checked one, one line per phase that ran or waits at
its gate (“preview · V1 passed at 14:09 · counts”, “staging · deployed 14:12 · validate now”
or “· counts as accepted, not validated” in amber, “production · approve after staging
passes, then validate once deployed” or “· approve now, then validate once deployed”), and a
foot line (“One validation (staging) before production. Validates production after it
deploys. Any doubt halts.”). The entry is disabled with a reason on a run that finished
(“Already deployed.”), failed or was cancelled (“The run failed. Re-run it on GitHub
first.”) or has not started (“Waiting for the deploy run.”); while a record follows the
rollout it reads **Stop auto deploy** (the menu says “Under auto deploy from #418 · <step>”).
`set` takes `from: 'here'` and `catchUp: 'validate' | 'accept'` (default `validate`); arming is
human-only as before. When a pull request on the map discovered the rollout the record is that
pull request's, armed after its merge (`mergedAt` is the arm time) with `takeover { at,
catchUp, rolloutNodeIds, counts }`: it follows only the named rollouts and never tags or
merges. Otherwise (a push or dispatch) the record is keyed by the rollout's resource
(`rolloutResourceId`, `rolloutNodeId`, no pull request fields), Needs me goes on the rollout and
the view has no Open pull request. Records stay `version: 1`; the new fields are optional, so
records saved before read unchanged. At arm time every passing, current validation of the
attempt scoped to jobs (same run attempt, not stale, not resolved) counts for those jobs;
with `validate` a phase already due that they cover in full counts as passed and every other
due phase is validated before any gate is approved, scoped to what no counted validation
covered; with `accept` whatever else deployed is recorded as accepted (“accepted when armed”)
and every phase already due as passed. Phases that finish later are validated as usual. Gates
a person approved before arming stay approved; nothing is approved twice.

**Phase track.** While an armed or halted record follows a rollout the rollout view shows a
band in the sunken blue under the verdict line (once it is done or stopped, the rollout's own track
below takes its place). Its top line: the auto glyph, **Auto deploy** · the
step (the status line without its prefix) · “Then: approve canary” (or validate <phase>, deploy
<phase>, done) in faint, **Stop** while armed, **Auto deploy again…** after a halt (the same
confirm) and **Open #418** when a pull request owns the record; amber when halted. Then one 22 × 10 px pip per phase (filled mint: deployed and validated, or nothing to
check; mint outline: deployed only; blue: deploying or validating; amber: concerns), a 4 px
bar before each gated phase (mint approved, blue auto deploy, amber you), the current one
outlined, and “3 of 8 deployed · 1 validated”; a pip click scrolls the lane to its phase.
The lane: phase cells 138 px wide (name and state glyph; “deployed 14:12”, “deploying · 1 of
2” or “not started”; a check line “V1 passed · counts”, “V2 validating”, “V2 concerns”,
“accepted when armed”, “validate next”, “validate later” or “no check needed”), joined by →
or a 62 px gate join (“✓ you / approved”, “✓ auto / approved”, “▦ auto / after V3”, “▦ auto /
approving”, “▦ you / waiting”, “▦ other / waits for another approver”). Two or more deployed
and validated phases before the current one fold into one mint cell (“2 phases ✓ / build →
preview / V1 passed”). The lane scrolls sideways only (scroll snap, an edge fade only on a side
with more), keeps the current phase centred on each update unless the person scrolled it in
the last 10 seconds, and keeps the cell width in narrow views. Phases come from the record and
the rollout (`phaseTrack`, `AUTO_DEPLOY_OPERATION status` on a rollout returns `track`, `next`
and `events`): with a stage rule its stages in order; otherwise the build and setup jobs before
the first deployment as one phase that needs no check, then one phase per environment (by job
name) with a new phase at every gate, so an environment that gates several phases has one
phase each (“production · phase-2”); a rollout without gates or rule is one phase, “whole
run”. A gate is known as a gate once it held the attempt (current gates, gate events, the
record's approvals); a later phase of an environment never seen at a gate shows a plain join
until it reaches one. In the jobs rail a gate auto deploy will approve reads “Auto deploy
approves after V3 passes” or “Auto deploy approves now” (blue, auto glyph) with no Approve
button, and a gate it approved “approved 14:38 by auto deploy”. The timeline gets auto
deploy's own entries from the record (armed, with what counted or that what deployed counts as
accepted; each validation requested; each approval sent; halted with its reason; done;
stopped), with the auto glyph on a faint blue wash (amber when halted), counted under All and
Validations (a halt under Problems too).

**Phase track on every rollout.** A rollout with two or more phases shows the track whether or not auto
deploy follows it; one with a single phase (no stage rule and no gate) shows none. Without an armed or
halted record (none, Stop, or done) the track has no top line, sits under the verdict line, where
Auto deploy's track sits, and reads the rollout alone: `AUTO_DEPLOY_OPERATION status` on a
rollout returns `track` with `plain: true` (and `autoValidate: true` when a pull request on the map
that discovered it keeps Auto validate on). A phase's check is the newest validation of the current
run attempt that is not stale and covers the phase (scoped to its jobs, to its environment via the
stage of the name, or to the whole run, which covers the last phase that had run when it was
requested); a request a later final validation resolved does not count, so a newer passing re-check
replaces concerns. Gates: held and approvable “▦ you / waiting” (amber), held and not approvable
“▦ other / waits for another approver”, ran “✓ approved / 14:21” (mint; the time of the app's
recorded approval of that environment, used once per phase in order, else the first job of the phase
starting; “on GitHub” without either), not reached “▦ you / later” (faint, dashed line; its pip bar
in the line colour). Check lines: “V2 passed”, “V3 validating”, “V2 concerns”, “V2 failed”, “no check
needed”; a deployed phase with none reads “not validated”, amber while the gate after it waits; a
phase not reached reads “Auto validate later” when Auto validate covers the rollout, else “no
validation yet”. Current: the held gate, else the running phase, else the phase being validated,
else (run finished) none, and the fold covers what passed. Under an armed or halted record nothing
changes: its step line on top, the track under the verdict line. A click (or Enter/Space) on a phase
cell, under auto deploy too, filters the jobs rail and the timeline to that phase in place of a job
filter (a toolbar chip names it, “Esc clears the phase filter”); the timeline keeps the phase's job
entries, validations covering one of its jobs and gate entries of its environment. Clicking the cell
again, Esc or a job click clears it; a pip click filters to its phase and scrolls the lane to it.

**Phase pips on the map card.** At large card size (map size presets may set `presentationPips`;
the rollout's large one does) the card draws one row under its title: a 12 × 8 px pip per phase
(same states and colours as the track's, the phase the rollout is at outlined), a 3 px bar before each
gated phase and the count (“3 of 6 deployed · 1 validated”, wrapping under the pips when it does not
fit; the row's accessible name). No lane, no labels, not clickable. The rollout's presentation
computes them from the rollout as last read, its validations and gate events with the stage rules
(`PresentationHooks.pips`, saved on the node as `pips { pips: { tone, style }[], label }` with
`node.update`, `null` clears); the renderer does no grouping. The card's pips never read auto
deploy's record.

**PR-REVIEW-LOOP — Review until clean.** **Review loop** in the PR view's Actions ▾ (after
Review) and in the PR's right-click menu (after Trigger review) arms one review loop for the
pull request. The menu asks “Review loop on #42” and offers **Up to 3 rounds** (default,
first), then 1, 2, 4 and 5; picking one asks again in place: “Start a review loop on #42?”
with “Reviewer: Claude · opus. Fixer: Claude · impl. Up to 3 reviews and 3 fix requests.
The fixer pushes to <branch>. Nothing is merged or approved.”, Back and **Start review
loop**. The reviewer is the Claude direct review default (PR-02; the operation also takes a
provider and model); the fixer named is a ready agent connected to the pull request, else
“new agent in <project>”. A merged or closed pull request, or a workspace without direct
reviews, offers the rounds disabled with the reason. Arming is the person's standing consent
to run up to that many reviews and to spend agent tokens on fixes for this one pull request;
it is human-only, while agents may read it (`review.loop`, operations `status` and
`options`). Arming an armed pull request keeps the running loop. While armed the menu
instead offers **Stop review loop** (“No further reviews or fix requests are sent. Work
already sent is not undone.”).

The service runs it, once per pass (15 seconds, and after workspace changes), with one
persisted record per pull request (the code.review package's plugin storage, collection
`review-loop`, keyed by the pull request's resource; no table or migration):

1. **Reviewing n.** A direct review (PR-02, same provider and model every round, a new one-off
   session each round) of the pull request's current head. Each round is an ordinary review
   item; round 1 is linked from the pull request as usual, every later round from the review
   of the round before (label “Round n”, title “Claude review · #42 · round n”). From round
   2 on the review prompt says which round it is, lists the findings earlier rounds reported
   fixed (asking to check that each fix holds) and the ones the person ignored (asking not to
   raise them again). Every round reviews the whole pull request.
2. **Triage.** Blocking findings are open bugs of severity critical or high and every finding
   of kind security, minus ignored ones: ignored in this review, or the same finding ignored
   in an earlier round of the loop. None: **clean**. Some and n below the limit: fixing. Some
   at the limit: **out of rounds**.
3. **Fixing n.** Exactly the blocking findings go to the fixer through the send-findings path
   (PR-02a: queued delivery until the agent is idle, journaled), with “Review loop round n of
   N” and the branch in the message and the instruction not to merge, approve or close. The
   loop keeps one fixer: a ready agent connected to the review or its pull request (the same
   order as the triage desk's recipients), else a new agent of the review's provider in the
   project's working directory (arming is consent to start it); later rounds send to the same
   agent and link it to their review when it is not connected yet. Medium, low, hardening and
   question findings are never sent.
4. **Waiting.** Once the fixer reported fixes (`workspace_report_review_fixes`) and the pull
   request's head moved to a new commit, round n+1 starts; until then the loop waits
   (“· Claude · impl is fixing 2”, then “· waiting for Claude · impl to push”).

A finding's fingerprint is its kind, its first file and its title without case, spacing or
punctuation. A blocking finding that matches one an earlier round of the loop reported fixed
is shown “seen in R<k>” and sent again once; when that fingerprint comes back once more the
loop halts.

Each review and each fix request is started once: request ids derive from the loop and the
round, the record is saved before either goes out, a review request the review engine never
journaled is asked again with the same id (which the engine runs at most once), and a fix
request whose send was never journaled is sent with its recorded id. A delivery the findings
path marks unconfirmed is never sent again.

**Halts** end the record `halted` with a reason, raise Needs me (“Action required”, note
“Review loop halted”, source `review-loop`) on the pull request and send nothing more; nothing
is reverted. It halts when: out of rounds with blocking findings open; a finding fixed earlier
comes back the second time; the fixer reported nothing within 45 minutes of the request, or
reported fixes but pushed no new commit within 45 minutes; a review fails, cannot start, is
removed, or returns text instead of findings; the pull request is closed, merged or no longer
on the map; the fixer is archived, removed or sent to the Undermap, or its request failed or
was cancelled; no agent can fix (none ready and no working directory); a send's outcome is
unknown. Clean raises “Finished” (note “Review loop clean”). Stop ends it without Needs me;
arming again starts a new record. Ignoring a finding while the loop runs counts at the next
triage. Only direct reviews (Claude, Codex) take part; workflow `/review` runs do not, and
the loop is independent of Auto deploy.

The PR view shows a status line under the frame bar while a record exists (not after Stop):
“Review loop · reviewing (round 1 of 3)”, “· round 2 of 3 · Claude · impl is fixing 2”, “·
waiting for Claude · impl to push”, “· clean after 2 rounds · 3 medium, 2 low left for you”,
“· halted: out of rounds · 1 high still open” or “· halted: Totals drift came back after
being fixed” (halted in amber), with **Open round N** and **Stop** while armed; the Actions
entry reads “Review loop · on”. A review that is a round of a loop shows, above its title in
the triage desk, “Part of a review loop on #42” and a round strip R1 … RN: its own round
marked current, earlier and later rounds that ran open their review, rounds not run yet
disabled. On the map the rounds form a chain of links; there is no new item type. Live
reviews and agent fixes under a review loop require human supervision; tests use fixtures
only.

**PR-STATE — Close, reopen and toggle draft.** Right-click **Change state** and the
full view's state buttons share one choice menu (`pr.state.options` →
`pr.state`). The options read the same fixed GraphQL merge-options query (node ID,
state, draft) and prompt “Change #42 “…” on GitHub?”: an open PR offers **Convert
to draft** and **Close pull request…**, a draft **Mark ready for review** and
**Close pull request…**, a closed (unmerged) PR **Reopen pull request**; merged PRs
are refused (“Merged pull requests can’t be closed, reopened or converted to a
draft.”). Draft/ready and reopen apply when picked. Close asks again in place:
“Close #42 “…”? You can reopen it later.” with an optional **Comment (optional)**
field (focused, up to 60,000 characters), Back (Cancel when opened from its own
button) and **Close pull request**. The view shows **Convert to draft** or **Ready
for review** and **Close…** or **Reopen** after Merge, each opening that menu narrowed
to its one transition (Close… opens straight into the confirmation); merged PRs
show neither. The buttons follow the PR's saved state and stay clickable while it is
stale or a saved copy (their title says the state may be out of date). Applying
sends without re-reading, so GitHub decides: for a close with a non-blank comment,
first posts it as one issue comment (`POST …/issues/{number}/comments`), then sends
`PATCH /repos/{owner}/{repo}/pulls/{number}` with exactly `{ "state": "closed" }`
(reopen: `"open"`); draft/ready sends exactly one fixed
`convertPullRequestToDraft`/`markPullRequestReadyForReview` mutation with the node
ID. Nothing is retried. A blank comment posts nothing. A 403 that is not a rate
limit reads “This GitHub account doesn’t have permission to change this pull
request. Check its repository access.”; 422 and GraphQL errors are a bounded,
sanitized decline (“GitHub declined to convert it to a draft: …”); interrupted or
unconfirmed replies are outcome-unknown. If the comment was posted but the close
failed, the error starts “Your comment was posted, but GitHub did not close the
pull request.” Errors show in the view's banner or the map's error toast; success
returns the refreshed snapshot. The PR transport accepts only those PATCH bodies
and mutations. `pr.state` is `humanOnly`: agents may read the options over MCP but
cannot apply them.

**PR-OPTIMISTIC — The expected result at once.** Merge, Add to merge
queue, Show/Ship and every state change (ready, draft, close, reopen) show their
expected result as soon as the person confirms, from the map's right-click menu or the
full view alike; the menu closes at once and the write continues in the background with
all the semantics above (one request, never retried, the 403/422/rate-limit mapping,
outcome-unknown, the refresh after it). Each such action declares `optimistic(snapshot,
input)` on its definition: from the saved read it returns the expected snapshot, a
pending label (“Merged · confirming”, “Queued · confirming”, “Closed · confirming”,
“Tagged [ship] · confirming”), a subject for notices (“Merge of #42”) and `landed(read)`,
whether a later read shows the change (true), contradicts it (false) or cannot tell.
The workspace service applies it generically, with no PR branch in graph or MCP code:
- While the change is pending, the service shows it everywhere the item appears: its
  reads (`pending` set), workspace snapshots (card title, label, cues and dashboards)
  and a fourth card cue **Confirming** (clock, in the in-flight colour). The saved graph
  and background observers keep the provider's last read. The full view's chip reads
  “Merged · confirming” with a dashed in-flight border, and its buttons follow the
  expected state (Merge disabled once merged, Ship/Show, Reopen).
- While the write is in flight, reads and polls of that item do not reach the provider,
  so a poll that reads before the write lands cannot take the change back. A second
  change to the same item is refused until the first settles (“The last change to this
  item is still being confirmed. Try again once it settles.”).
- A successful write whose refresh shows the change drops the mark. A refusal, or a
  later read that contradicts an unconfirmed write, takes the change back: the item
  returns to its read state, Needs me gets an Asking me entry from source
  `action:<item type>` noted “Merge of #42 didn’t go through” (cleared when a later
  change to the item is confirmed), the map shows an error toast with Open that stays
  until dismissed, and the item's reads carry the reason for 15 minutes, which the full
  view shows as its action notice: “Merge of #42 didn’t go through: GitHub declined the
  merge: …”, or “…: the next read from GitHub doesn’t show it.”
- An outcome-unknown write, or a successful one whose refresh cannot tell yet, keeps
  the mark; every 15-second poll tick then refreshes the item until a read settles it.
- Pending changes are saved with the item. After a restart the change shows as still
  confirming (never a bare Merged) and the first poll settles it; the write is never
  sent again. A change no read can settle within 30 minutes is taken back with “Merge
  of #42 couldn’t be confirmed. Check it before trying again.”
Agents cannot apply these actions (`humanOnly`); MCP workspace reads include the same
overlay, so an agent sees a person's pending change marked Confirming. The GitHub inbox
lists its own search results and updates on its next refresh.

Choice options may declare their own confirmation (`confirm: { prompt, note,
action, text? }`): picking one asks again in place, in the map submenu and in view
menus, with an optional text field whose non-blank value is sent as
`input[text.field]`. Unlike `irreversible`, it applies per option and does not
claim the change cannot be undone.

**PR-02 — Direct reviews.** Provide Codex review (Astra default, selectable) and
Claude review (Opus default, selectable). Resolve available native model IDs at
runtime and report unsupported choices. Each starts a one-off analysis session
with a captured complete comparison and produces a separate review item. Opening
an active request reuses it; an intentional later rerun creates a new one. Direct
reviews do not edit code, merge, approve, or publish review comments by default.
A finished review opens as structured findings (PR-02a); output that does not
match the findings schema, and reviews from before it, open as rendered Markdown
(Codex's last-message file, or Claude's print output without terminal control
sequences). The native run stays available as **Run log**.
The review item and its reference link from the PR appear on the map as soon as
the request is reserved (models, source freeze and deduplication done), before the
slow repository fetch/comparison. Until the session starts it shows its phase
(Fetching and comparing the PR… → Starting Claude/Codex…) with elapsed time, and
the launch attaches the session to that same item in the same commit. A repeated
trigger while it prepares reveals the same item. Recovery after a restart reuses
it; if it was archived, deleted or sent to the Undermap meanwhile, nothing launches.
A failed preparation keeps the item with attention error, the safe error message
and **Retry review**, which prepares a new request on the same item; the item is
archived and deleted like any other.
**PR-02a — Review findings.** Both direct reviews request one JSON object
(`hivemind/review-findings/v1`: summary, findings, checked, tests) through the
CLI's structured output when its help lists it (Claude `--output-format
stream-json --verbose --json-schema`, read from the final `result` event's
`structured_output`; Codex `--output-schema` beside `--output-last-message`),
otherwise as one fenced json block. Findings have an id (F1…), a kind (bug, hardening,
security, question), a severity for bugs (critical, high, medium, low), a separate
verification level (verified, partial, unverified) with note, repository-relative
locations with lines, and when/why/fix/details. The service validates, strips
control characters and clamps sizes (titles 300, verification notes 800, summary
600 characters), cutting at a word boundary with an ellipsis; anything else stays readable as Markdown with
the reason and **Retry as findings**, which reruns the review on the same item.
The full view is the triage desk (minimum width 750 px). Review items of every kind (code review,
workflow review) use the pixel magnifier icon, tinted by provider (Claude orange,
Codex blue, workflow neutral) on the map, the frame, pickers and the PR's
Connected reviews. Rollouts likewise show their own glyph, the pixel **rocket** tinted
in the rollout's blue, everywhere a type icon appears; only pull requests and review runs carry
the GitHub brand mark, so a rollout never looks like a PR. The expanded frame's title bar carries the model, the PR link,
a run-state chip (Reviewing / Completed / Ended with an error; time, duration and
base → reviewed head in its tooltip) and the Findings / Run log tabs; plugin views
render such controls through the generic `frameToolbar` slot. Below it the desk
keeps only a summary block (PR title and verdict/summary) with a disclosure
toggle; it collapses to one line on the first click or key in the list or detail
(not on hover or scroll), and the choice is kept per item for the session. Then
filter chips with counts; a list with severity meter or kind pictogram,
verification, first location and state (titles clamp to two lines there, never in
the detail); the focused finding's severity, qualifier, full title, verification,
Where/When/Why it matters/Suggested fix, history and actions in one scroll
container; and notes (checked, tests). The bottom help bar starts with “Select
findings to have an agent fix them” and the keys, plus finish time, duration and
revisions when there is room. Location chips open the file at the reviewed head on
GitHub. The Run log shows Claude's event stream as a readable transcript
(progress text, tool calls, errors, result summary) with the raw terminal one click
away; Codex and text runs show the native terminal.
A finding already sent or queued to an agent shows a copper send flag in place of its
checkbox (tooltip “Sent to <agent>” / “Queued for <agent>”) and a dimmed title;
select-all and ⌘A skip it. A sent one can still be picked again with Space or the
detail's **Select to send again**; a queued one cannot be selected until its send is
cancelled.
Keyboard: ↑/↓ focus, Space select, Shift+↑/↓ extend, ⌘A all in filter, Enter
opens the confirm step (and sends from it), 1–9 filter chips, Escape closes the
menu or confirm step then clears the selection. The selection count, breakdown and
Clear sit in the list header. Sending uses a floating split button in a strip
reserved below the detail (never covering content): the main part (“Send 2 to
Claude · impl”) is disabled with a tooltip until something is selected, and opens
the confirm step with the recipient, optional note, To fix / Context summary and
Preview message — sending is always two deliberate steps. The chevron opens a
keyboard-navigable menu: **Run in new agent** (starts a native agent of the
review's provider in the project's working directory, linked to the review, and
queues the findings until it is ready; disabled with the reason when the project
has no working directory) and the connected agents, choosing one sets the main
button's target. Existing recipients are only agents linked to the review or to
its PR (not through other items, not archived or in the Undermap), suggested
direct before via-PR and idle before working. A send result appears as a
dismissible notice above the button with View message, Open agent and, while
queued, Cancel send. The agent receives the full review as context
and the explicit list of findings to fix, with PR/branch/revision information and
the instruction to report fixes; it is told to push, open PRs or merge only when
that is already its workflow. An agent linked only through the PR gets a direct
context link. Idle agents receive it at once; working or stopped agents, and ones
held at a prompt in their terminal (shown as “Needs you”), get it
queued (durable in SQLite) and delivered when they become idle (AGENT-07c); queued sends can
be cancelled and fail visibly if the agent is archived, removed or sent to the
Undermap. Deliveries are journaled: an interrupted one is marked unconfirmed and
never pasted again. Finding states are open → queued → sent → fixed; the agent the
finding was sent to reports fixes with `workspace_report_review_fixes` (finding
ids, optional commit and note). The person can **Ignore** any finding and **Stop
ignoring** it, or **Reopen** one an agent reported fixed. An ignored finding is
stored as status `fixed` set by actor `user` (the stored value, the `mark`
operation's `status: "fixed"` argument and MCP names are unchanged); the latest
event's actor decides the wording. It reads “Ignored” in its row and detail,
“Ignored by you” / “No longer ignored by you” in its history and “N ignored” in
the roll-ups, and never as fixed or sent; `list` also returns the ignored finding
ids. Only an agent's report reads “Fixed” / “Fixed in <commit>” / “Fixed by
<agent>”. Sending, cancelling and overrides are human-only: MCP refuses them. Once
every finding that was delivered to an agent is fixed (reported by the agent, or
ignored by a person), the review item is marked done (`node.complete`, once; a person
may reopen it). Findings never sent do not hold it back, and a review with nothing sent
is never completed this way. The
map card (medium size) shows one pip per finding (solid open, hollow sent/queued,
striped fixed or ignored), counts by severity/kind and progress (queued · sent ·
fixed · ignored); critical or high bugs raise Needs me once
per run. A run that found nothing is a result, not a request: its card shows the
cue **No findings** (green check, stage done) in place of the summary and its
“Review ready” entry leaves Needs me; a later run with findings takes the cue away
again. A result that is only text (no output, an error) keeps the entry. The PR's
Connected reviews shows the same mix and progress. A text
review can be sent whole. A finished review's header has **Copy whole report**
(right of the title, also while the summary is collapsed): for findings it copies
one Markdown document — the PR title, repository/number/URL and reviewed head,
the summary, every finding most severe first regardless of the filter, each in
the per-finding Copy as Markdown format followed by its current state (Open,
Queued for / Sent to / Fixed by <agent>, Ignored), then the checked areas and the
tests note; for a text review it copies the saved Markdown unchanged. Like the
per-finding button it reads “Copied” for a moment, and a refused clipboard write
leaves it unchanged. A running review has no such button. The Needs me list and completion notices show no type
icons. There is no dismiss state, no split between agents and
no findings list on the PR view.

Freeze the initiating PR independently of the currently open view: request,
comparison, prompt, project and result link retain that source while navigating
or preparing simultaneous reviews. Desktop requests assert the clicked resource
identity; mismatched captures or source changes during revision retries fail
before launch instead of silently retargeting the review.

Each review or architecture request checks the PR out into
`comparisons/<requestId>/repository` (objects hardlinked from the shared
`git-cache`). Once an hour old, with no queued, running or uncertain job naming it
and no session running in that folder, the checkout and its `comparison.json` are
removed (checked every minute, at most every 30 minutes, only while background work
is allowed; never the cache). The request and result Markdown stay. A later request
on the same comparison captures the checkout again from the cache.

**PR-03 — Workflow review.** A third action posts exactly `/review` and watches the
repository's supported workflow. Persist trigger/run/job/result identities and
link the actual report. Reconcile uncertain POST outcomes before retrying. A green
job without a report is not completion; unrelated or ambiguous concurrent runs
must never be adopted. Watching retains its durable identity across closure and resumes reconciliation on
startup; closing the app does not cancel the remote workflow. The workflow file, its
review job and an optional failure text are settings, globally and per repository
(defaults `.github/workflows/review.yml`, job `review`, none); each request keeps
the values it started with. Tracking has two tiers, checked on the default-branch
workflow file before posting. **Exact**:
a top-level `run-name` carrying the trigger comment ID binds the run to that comment and
is preferred. **Timed**: without that run-name, the workflow must still run on new
`issue_comment` events and have exactly one review job with steps; the run is the
only `issue_comment` run whose review job started within ten seconds before to
three minutes after the trigger comment. Runs that skip the job do not count; runs still
deciding block adoption. A second started run, or another `/review` comment on the PR in
that window, fails as ambiguous with a link to the workflow runs; no candidate times out.
The report is the bot comment linking the adopted run, posted after the trigger, and is
accepted only once the window has closed. The review view labels timed tracking “matched
by time”. Any other workflow is unsupported with a specific reason and offers no post.

**PR-04 — Architecture explanation.** **Explain architecture** is one PR action
(context menu → Explain architecture → Claude, and Review → Explain architecture in
the PR view, beside the local reviews) on the shared
`pr.architecture` runtime action. It saves the isolated comparison (source account,
project, base tip, merge base and head) and then starts one read-only Claude session
next to the PR, connected from it, whose prompt asks for a components overview and
flow diagram published once as a private Claude artifact. Requests for the same
comparison reuse the saved capture and focus the live session instead of launching
again. Status distinguishes pending, prepared, launching, launched and failed;
reopening never restarts a launch. Agents may prepare and read status; launching is a
person's action. The resulting artifact is attached by CLAUDE-ARTIFACT, never by
parsing terminal or PR text, and never by labelling a local file as an artifact.
The first real publication is a supervised acceptance gate.

**CLAUDE-ARTIFACT — Claude artifacts on the map.** A `claude.artifact` item holds a
private claude.ai page: `https://claude.ai/code/artifact/<uuid>` or
`https://claude.ai/artifact/<id>` (exact host, https only, validated id; anything else
is a Web link). From URL, paste and drop create it; the same artifact URL always
resolves to the same item. When a table-managed Claude session publishes with its
Artifact tool, the session hook adds the card below that agent, linked from it and from
its source PR (an architecture run's PR, or the one PR the agent is connected to), with
the session and, for architecture runs, the head revision. The title is the publishing
call's title, else the published page's `<title>`, else `Claude artifact · <id prefix>`;
a person's rename is kept. The card is the host's to add: the agent guide tells agents not to add an artifact they published, an agent that adds it anyway is answered with the existing card (MAP-14) instead of a second one, and a publication seen after the agent added the artifact itself reuses that card. The app never fetches the page (it needs the user's claude.ai
sign-in): clicking opens a small panel with title, link, provenance and **Open in
browser**, and the menu offers **Open on claude.ai**; both use the system browser.

**MAP-SELECT — Multiple items.** Shift-click toggles items in a selection;
Shift-left-drag on empty map selects a rectangle, also while a rail panel such as
Needs me or the Controls card stays open beside the map; a modal dialog blocks it. Drag any selected item to move
all selected items with their relative positions intact. Project moves include
members once; group movement retains membership. Escape or a plain background
click clears selection. Shared right-click actions apply atomically to the
selection; omit single-item settings. A plugin menu group may name a selection
form (`selection: { label, children }`): when every selected item has the group,
the selection menu offers it under that label with those children only, and a pick
runs the child once per item, each with its own toast and Open action. Pull requests
offer **Review selection ▸ Claude / Codex / Claude + Codex** this way (one review per
PR and provider with the provider's default model, the existing per-PR de-duplication;
`/review` is not offered for a selection because it posts to GitHub). A group child may
name other children of its group in `runs`: a pick then starts each of them as if it
had been picked, each with its own toast and Open action, for one item or once per
selected item. A pull request's **Trigger review** offers **Claude + Codex** this way
(`runs: ['review.claude', 'review.codex']`), between Codex and /review.

## 7. To-dos

**TODO-01:** Support to-do items on the map and a movable left overlay. Checklist
rows offer Archive instead of Remove. Keep text, completion and attachments when
archiving; restore/delete them only from Archive. Editing an archived checklist
must not implicitly restore it. Overlay
rows are one line with small linked-item indicators on the right. Attach existing
items/projects by drag-and-drop from the map. A compact link button in the
overlay header opens an on-demand keyboard-accessible item/project selector, then
lets you choose an existing to-do or create one. Hide the selector until requested;
omit the old “Attach any item or project” text and top “To-do 3” control. A single linked-item indicator takes you directly
to that item on the map, without opening its full view. Multiple links widen the
overlay into a separate linked-items area; keep to-do rows one line and never
insert a reference list into a row. Selecting a reference returns to the normal
overlay width and reveals it on the map. Keep detachment accessible for both
single and multiple references. Archived/unavailable references explain why
they cannot be revealed rather than silently opening nothing.

The overlay has a bottom-right pixel resize grip. Drag adjusts width and height;
arrow keys resize by 10 pixels (Shift: 40), Home restores defaults and Escape
cancels the active resize. Keep it within the viewport, retain scrolling, remember
preferred bounds across restart, and preserve its 40-pixel collapsed icon. Resizing
must not move graph items or trigger auto-hide. Linked-item areas still expand
beside the task rows.

**TODO-02 (TODO-12):** The list sorts by when, not where; a
to-do's project is a small chip on its row in the project's neighbourhood colour,
and a row without a project has none. A map to-do's project is its membership; a
free-standing checklist row has a project only if all its attached references
resolve to one unambiguous project. **Group by project** in the sheet header (off
by default, remembered per view like other view preferences) splits Next and Later
into project sub-groups again, No project last. Project moves, lifecycle changes
and completion update the same underlying records, not copied tasks.

**TODO-03:** The overlay title is a plain label; the list closes by the rail sheet's
shared X (MAP-21), not a control of its own. Row actions (detach, archive) form one cluster of
pixel icon buttons with tooltips, shown on row hover or focus; the attachment
chip shows the item on the map. The add button is a pixel control that lights up
when the draft is non-empty, and an empty list explains how to add a to-do. Auto-hide is on by default: pointer
exit collapses after a short grace period, and resting the pointer on its
persistent icon for about 250 ms reopens it; a pointer that keeps moving along the
rail opens nothing. Every rail slot uses the same click: click opens and pins
(auto-hide off, pinned plate shown), clicking the pinned open slot closes it and
turns auto-hide back on; keep the list open after pointer exit while pinned. The pin is not
remembered: after a reload or restart the list is closed and unpinned like every other rail tool,
and any way of closing it also unpins it (MAP-21).
Collapsed width is only the icon box, with a quick animation. Preserve position,
draft text and scroll. Do not collapse during an active drag or text/keyboard
interaction; pointer activity ends keyboard navigation protection without
interrupting an active editor. Reduced-motion preferences are respected.

**KEY-01 — Workspace shortcuts.** T toggles the to-do overlay open/closed. Use a
shared catalog/dispatcher so more shortcuts can be added without independent
ad-hoc key listeners. Ignore consumed/repeated/composing events and unmatched
modifier combinations. Text inputs, selects, editable content, terminals, dialogs,
menus and active drags retain their keys. Shortcuts are scoped to this app view,
not registered globally with macOS. Provide accessible shortcut labels and focus
navigation for keyboard-opened controls.

**TODO-04 — Click to edit text.** A single click on a to-do's title edits its
text directly in place, both on its map bubble and in the to-do overlay. Do not
open an expanded item view or separate editing panel for this action. Enter or
leaving the field commits the change; Escape cancels and restores the original
text. Apply normal title validation, retaining the draft with a visible error if
saving fails. Save through the shared commands so map and overlay show the same
value after reload, preserving identity, position, membership, links and completion.
Distinguish clicking text from holding/dragging the item: a drag must not start an
edit, and text selection/input during editing must not move the map or item.
Keep completion/link controls independent, provide keyboard access to editing, and
prevent overlay auto-collapse while its text editor is active.

**TODO-05 — Simple task rows.** To-dos contain task text only, with no Notes field
in creation, settings or agent-facing discovery/context. Keep historical saved
notes untouched for compatibility, but do not surface or inject them. Use an empty
checkbox for unfinished tasks and a checked box when done, including map bubbles
and linked-item indicators. Completed to-do bubbles retain visible, editable task
text in a shorter shaded row rather than becoming icon-only. Their connections
remain hidden until hover/focus; reopening restores the normal row. Other item
types retain their existing compact done appearance. On a map to-do card the
checkbox is a real control (`role="checkbox"`, `aria-checked`, named “Mark done” /
“Mark not done”, 29 world-px target over the 23 px glyph): clicking it or pressing
Space while it has focus marks the item done or reopens it with the same
`node.complete`/`node.reopen` command as the context menu, without selecting,
opening, editing or dragging the card. Types opt in with
`appearance.completionToggle`; at icon-only far zoom the glyph is not a control
(MAP-23 click-to-fly applies).

**TODO-06 — Existing items as tasks (TODO-12).** Linear offers
Turn into todo and Remove from to-dos. Keep the original ticket, provider identity,
view, links and project. One row per ticket under Linear's own name: the row shows
the ticket's title without its identifier, an identifier chip that shows the item
on the map, and its Linear state as a read-only chip from what the app already
reads. Ticking the row is the list's own (`todoDoneAt`): it moves the row to Done
and never writes to Linear, and the map card is not marked done. When Linear
reports the ticket done (RES-04) the row ticks itself and can only be reopened on
the map. The generated Haiku action title is no longer created or shown; labels
saved earlier stay stored, unused. Provider titles remain read-only in the
overlay. Archive hides it, restore returns it, and removing it from the list never
deletes or archives the ticket.

**TODO-07 — Manual order (TODO-12).** Drag a row by its grip
anywhere: within Next or Later, between Next, Later and Done, and from the From
Linear inbox into Next or Later. While dragging, the row already shows at its
prospective position (Done highlights as a whole); save only on drop; a cancelled
drag, or one that leaves the list, restores the saved order. On a focused row
Alt+↑/↓ (and plain ↑/↓ on its grip) move it within its group; with Group by
project on, past its neighbours of the same project. Order survives edits,
completion, archive/restore and restart; moving a task in this list never changes
its project. Project heading grips are gone; project groups keep the projects'
saved order and No project remains last.

**TODO-08 — Drag tasks onto the map.** A row's drag grip also places the task on
the map at the drop location, from any group. Existing map/provider items move
without duplication, as if dragged there on the map: while the row is over the map
the item itself follows the pointer with collision placement and the target
neighbourhood highlights (“Move to …”); a drop inside another project's
neighbourhood transfers it, and a drop in empty space or its own neighbourhood
keeps its project (a floating item near an outline attaches, as on the map).
List-only tasks show a dashed ghost of a to-do at the pointer (“Add to …” or
“Place on the map”) and become a single map to-do, retaining text, completion,
order and attached-item links; a neighbourhood drop assigns that project, an
outside drop makes it floating. Items under the pointer never take the drop as
text. The overlay continues showing that map task. An item that went to Undermap
meanwhile is refused with “This item is in Undermap. Bring it back to show it
here.” Invalid/cancelled drops preserve the original task.

**TODO-09 — From Linear inbox for assigned tickets (TODO-12).** Every open Linear ticket assigned to a connected account whose status
the settings select (state type triage, backlog, unstarted or started; most
recently updated first, at most 100) waits in the **From Linear** inbox at the top
of the to-do list instead of becoming a to-do. The inbox appears only while it has
tickets, is folded to its count by default (Show / Hide), and is not in any
project: nothing is placed on the map, Needs me is never raised, and the rail
badge does not count it. Each ticket shows Linear's title, an identifier chip that
opens the ticket in the browser, its Linear state chip and, if it has one, its
project chip, with **Next**, **Later** and **✕ (Not for me)** buttons; there is no
checkbox. Taking it (a button, N or L on the focused row, or dragging it into Next
or Later) makes it a to-do there. Ticking a ticket through a command takes it into
Next and completes it; a person's edit of one takes it into Next. **Not for me**
hides it, with Undo, until the ticket changes: a different title or Linear state,
or an assignment change (it leaves the list and returns). A settings change is not
a change of the ticket. The ticket travels with the taken to-do as a pending
attachment and becomes a Linear ticket item linked to the to-do when the to-do is
placed (TODO-10 or a TODO-08 map drop); that to-do then follows the ticket's Done
(RES-04).

The import reads on app start, about every two minutes, when its setting is turned
on, and on a manual provider refresh (Settings → Connections, `connections.refresh`).
It is one fixed read-only query through the Linear allowlist and uses the account's
request budget. The query asks for state types and priorities by name from two fixed
lists, never by exclusion, so completed, canceled and duplicate tickets and any
state type Linear adds later are not requested, and the client drops them again
when a page contains one; a rate limit or failed read is recorded silently, delays the next
read (a provider cooldown also holds back a manual refresh) and changes nothing.
One to-do per ticket, ever: a per-connection ledger remembers every ticket handled
in its current assignment. No to-do is created when the ticket already exists
anywhere as a Linear item (any project, done, archived, Undermap; by issue id under
any account, by identifier for the same or an unbound account) or as an imported
to-do, and none is created again after the to-do was sent to a project, archived or
deleted from the archive. A changed Linear title or state updates every ticket in
the inbox and the ticket a taken to-do still carries; a taken to-do keeps a title
the person changed. When a ticket leaves the list (unassigned, completed,
canceled, marked duplicate, or left out by a status or priority the settings no
longer select) and it still waits in the inbox untaken, it is removed without a
trace; a dismissed one goes too when the ticket itself left, and is held while
only the settings left it out. A taken or sent to-do stays as it is. Removal does
not distinguish completed from unassigned: it costs no extra read, so a taken
to-do that is still list-only does not tick itself; a ticket on the map mirrors
Done through RES-04 and the to-do placed with it follows. A ticket removed this
way comes back to the inbox when it returns to the list (reassigned, reopened, or
its status selected again). A to-do the person deleted from the archive stays
dismissed while its ticket is assigned and through any change of the settings; it
is forgotten only when the ticket itself leaves the list under unchanged settings.
Only a list cut off at the 100-ticket cap adds tickets but removes none; a
narrower selection is a complete list.

**Settings → Items → Linear ticket → Assigned tickets** has “Show my assigned
Linear tickets in the to-do inbox”, on by default. Turning it off stops the reads
and leaves every existing to-do and inbox ticket alone. Under it, unavailable while
the switch is off:
**Ticket statuses that go to the inbox** with the checkboxes Triage, Backlog, Todo and
In progress (Linear's state types triage, backlog, unstarted, started), all checked
by default, also for settings saved before the choice existed; completed, canceled
and duplicate are not offered and are refused when saved. With none checked nothing
is imported, existing to-dos stay, and the row says so. **Minimum priority** is Any
(default), “Urgent, High and Medium” or “Urgent and High”; tickets without a
priority are imported only with Any. Saving a changed selection reads at once. While no Linear account is connected the section
shows a “Linear is not connected” row pointing at Connections; nothing else reports
the missing connection.

**TODO-10 — Send to project.** Right-clicking any to-do row in the list offers
**Send to project ▸** with the map's projects in to-do-list order; the map menu of
a to-do card or of an item kept in the to-do list offers the same move as **Move to
project ▸** (MAP-26), its only such entry. Archived projects and
projects in Undermap are left out; the project a map to-do is already in is checked
and unavailable; with no project the submenu says so. Sending moves the to-do and
its attached items (linked items on the map; projects, archived items and items in
Undermap stay) into the project as one block: items that shared the to-do's project
keep their layout around it, the rest stack below it, and the block lands on the
first clear spot beside the project's items (right, below, left, above, stepping
outward) or on an empty project's anchor, never inside another neighbourhood and
without moving anything else. Links are kept. A list-only to-do becomes a map to-do
there; from the inbox this also creates the ticket item, read from Linear at once
(sending is a way of taking it). Dragging a row onto a project group in the list
no longer sends it: with Group by project on, a row stays in its own
project's group. From the list the camera does not move; from a card the view follows (MAP-26). The
shared `todo.send` command does the list's part for the app and for agents through
`workspace_apply`, with the same block placement as `nodes.send`.

**TODO-11 — Context.** Every to-do can carry context: plain text
an agent or the person writes for whoever picks the to-do up later. It belongs to
the to-do, not to its writer, and stays when the agent that wrote it is stopped,
archived or deleted, when the to-do is reordered, completed, archived or sent to a
project (TODO-10). Up to 8,000 characters; control characters are removed, line
breaks and tabs kept; Markdown is kept as text and never rendered; empty means
none. Checklist to-dos keep it on the to-do (`context`, `contextBy`, `contextAt`),
map to-dos on their node (`todoContext`, `todoContextBy`, `todoContextAt`), and a
list-only to-do that becomes a map to-do takes it along; data saved before this
reads as no context. The host records who last wrote it (user or agent, with the
agent's id and its title at that moment) and when; a caller cannot set either.

Agents write it through `workspace_apply`: `todo.save` takes `context` (a save
without it keeps what is there, an empty one clears it), and `todo.context`
`{ id, context, mode }` sets it on an existing to-do, where `id` is a to-do id or
`map:<nodeId>`, `replace` overwrites and `append` adds the text after a blank
line. An append that would pass the limit is refused and changes nothing.
`todo.context` needs no `expectedRevision`. Agents read it in `workspace_read`,
and `agent.context` lists, under `todoContext`, the context of every to-do
attached to the requesting node. The guide asks agents to leave the reasoning,
links and next steps there.

In the list the context is hidden. A row whose to-do has context shows one small
pixel glyph with the tooltip “Has context · written by <who> <when>”; clicking
it, or **Show context** in the row menu, opens the text under the row: plain,
wrapped, selectable, scrolling inside a fixed maximum height, with “written by
<who> · <when>” beneath. **Edit** turns it into a text field with Save and Cancel
(Escape cancels, Cmd/Ctrl+Enter saves); the list does not auto-hide while it is
open for editing (TODO-04). **Clear** asks once, in place, before removing it.
The row menu offers Show context / Hide context, Add context… when there is none,
and Clear context. Everything is reachable by keyboard and named for assistive
technology; reduced-motion preferences are respected. The text never appears in
the collapsed row, on the map card, in Needs me, in notifications, in search or
in logs.

**TODO-12 — Next and Later.**
The to-do sheet shows, top to bottom: **From Linear** (TODO-09; only while it has
tickets, folded to its count), **Next**, **Later** and **Done** (folded to its
count; Show / Fold). Each heading shows its count; the header says “N next · M
later”, and the rail badge counts only the tickets waiting in From Linear to be
taken (not Next; tickets marked Not for me do not count, and an empty inbox shows no
badge). A new to-do from the
list, the map or an agent goes last in Next. The project is a chip on the row
(TODO-02), in one fixed column at the row's right edge so projects line up down the
list (a row without a project keeps the column empty); links and attachments sit
just left of it, and the title takes the rest and truncates. Group by project
restores project groups inside Next and Later, whose rows drop the column.

Rows move freely (TODO-07). Keys on a focused row: **N** to Next, **L** to Later,
**Space** done / not done, **Alt+↑/↓** within its group; fields, editors, menus and
the context panel keep their keys (KEY-01), and the keys never reach the workspace
shortcuts (N is Needs me elsewhere). Moving between Next and Later never changes a
row's project; reopening a done row returns it to its horizon where it was.

Done gets out of the way: ticking moves the row into Done with an **Undo** toast.
Done rows go to Archive automatically, the same way Archive works from the list
(restorable; an item kept in the list only leaves the list), a number of days after
they were ticked or last touched, whichever is later. **Settings → Items → To-do →
To-do list** has “Move done to-dos to Archive after” with 1 day, 3 days (default),
7 days or Never. Done shows newest first and says when its rows go.

Next has a soft limit: above five open rows it says “Next is getting long.” with
**Move the oldest to Later**, which moves the row untouched longest (among rows
touched together, the lowest) to the top of Later. There is no hard stop.

Later ages: a row in Later that no person has edited, moved, ticked or given
context for 30 days shows its age as a small chip (“34d”). The Later heading's
menu offers **Archive rows untouched for 30 days**. Provider imports and the
service's own sweeps never count as a touch.

Agents file with `todo.save`'s optional `horizon` (`next`, the default for a new
to-do, or `later`); a save without it keeps where the to-do is. `todo.move { id,
horizon: next|later|done, index? }` moves or ticks a to-do and `workspace_read`
shows each to-do's horizon; tickets imported from Linear read as `inbox` until
taken. Existing identifiers and commands keep working; `todos.reorder` accepts the
rows of one group.

Schema 25 files a workspace saved before this once: every open to-do goes to Next
in the order the grouped list showed it (Triage first, then projects in list order,
then No project); a Triage to-do still exactly as imported waits in the inbox; a
touched one becomes a Next to-do; done rows go to Done, keep their completion time
and count their wait for Archive from the upgrade. Nothing is deleted.

**STANDUP-01 — Standup report.** On (`STANDUP_ENABLED` in `packages/core/standup.ts`; off
removes the Actions slot, the Settings section and background digests).
The rail's **Actions** slot (MAP-21, above Settings, key 6) opens the item menu with one
entry, **Standup report…**, which opens a floating panel like Settings. The report tells
what the person did, written in the first person, as stories: a short title, 1–4
one-sentence bullets (what was looked into, found, changed, where it stands) and evidence chips under them. A
chip shows its item on the map when it is there (also below), else opens its URL with
the app's external-link opening.

**Ranges.** Exactly three, in local whole days: **1 day** (yesterday and today so far),
**7 days** (the seven days before today and today so far) and **Last week** (default;
Monday 00:00 to Monday 00:00 of the previous calendar week). Midnights come from the
calendar, so a DST change keeps whole days.

**Background.** Closing the panel does not stop the report: the service finishes it, and
the panel says so while it runs ("You can close this panel: the report keeps going and is
here when you come back."). Reopening picks up the run still going, or the report finished
today, with its range and rewrite instruction, instead of asking again. Choosing another
range or rewriting starts a new report as before.

**Shape and detail.** Done · Blocked · This week (default) or By project, which groups
stories by project and keeps This week last. Brief shows a title and one bullet. **This
week** is an outlook of what is still open (ongoing stories, my open PRs waiting for
review, review requests, open to-dos, reminders due this week, items that need my
decision) and is left out entirely when nothing is open. Each story has a checkbox;
**Copy for Slack** (primary) and **Copy Markdown** copy only ticked stories in the shape
and detail shown: a heading, group headings, a blank line between stories, one bullet
per line and the evidence as Slack `<url|label>` or Markdown `[label](url)` links.

**Digests.** A digest is stored per (agent session, local day) and per (PR, local day it
changed) with its text, evidence, model, input fingerprint and time (schema 24). Claude
Haiku writes 3–4 lines (asked / found / changed / state; a longer answer keeps its first six
lines, each at most 300 characters, rather than being lost) from one day of a Claude
conversation on the table: my prompts, Claude's text replies, tool names and short tool
errors, never thinking or raw tool output; secrets are redacted before sending and again
before storing, and the input is capped at 24,000 characters (the day's first lines and
its latest). PRs I authored or reviewed in the range are read from GitHub with GETs only
(search, the PR, its commits and files), including PRs never on the map; merged-by comes
from the PR. Codex conversations are not read; the report says so when the table has
Codex items. Transcript text never reaches the renderer. Unchanged input is never
digested again; a failed attempt is retried after six hours at the earliest.

**When.** In the background every five minutes, one conversation day at a time for the
14 days before today, then yesterday's PRs once a day; background digests leave four
requests of the hourly and daily allowance to the other AI helpers. Opening the report
digests what is missing or changed in the range, today included, four at a time (pull
requests too), showing what it reads (“Reading 2 conversations…”). A first 7-day report
of about 80 digests takes about three minutes.

**Composition.** One Claude Sonnet call per open, range change or rewrite returns JSON
(`stories`, `outlook`; validated), at most 12 stories and 8 outlook entries; its input
holds up to 200,000 characters, so a full week's digests and facts fit, and only past that
are the oldest digests left out (the report says how many). A story longer than the panel
shows (title, bullets, evidence) is shortened, never the whole report lost. A story citing an evidence id that was not in the
input is dropped and the report says how many; no story is shown without evidence.
Reports are cached by range, digests, facts, instruction and model. A rewrite
instruction (at most 500 characters) composes again from the same inputs.

**Facts and AI off.** Stored facts go in as evidence without a model call: to-dos done in
the range (checklist to-dos record `doneAt` from now on; map to-dos use `completedAt`),
open to-dos, reminders due this week, finished rollout validations, review findings
fixed or reopened, Linear tickets on the table, my open PRs from the GitHub inbox cache
and items that need my decision. **Settings → AI features → Standup digests** (on by
default) governs every standup model call. Background digests count in the shared request
limits and leave headroom for titles and summaries; a report I ask for spends from its own
allowance, **Standup report requests** (default 150 per report: one digest per unread
conversation or PR day, plus the report). When it is off, the allowance is spent, or Claude fails, the report lists the facts in the same
groups without bullets and states why. MCP does not expose the report.

## 8. Extensibility and delivery criteria

**EXT-01:** A resource plugin provides versioned definition/schema, appearance,
creation/URL recognition, relationship capacity, optional context/actions,
backend connector and frontend views. A new plugin can use default views and
forms. No edits to graph, project, command or MCP transport logic are required.

**EXT-02:** Credentials stay in the backend/OS credential store. Missing or newer
plugins preserve their saved records with an unavailable placeholder. Migrations
must be explicit and tested. Run declared forward data migrations in the sole
workspace writer before serving commands, with a private backup and atomic batch
per plugin. Preserve resource/node IDs, account bindings, links, layout and jobs.
Invalid results or provider identity collisions leave the original records intact
and unavailable; missing migration paths and downgrades never rewrite data.
Plugins are trusted code with the same host services as built-in item types.
Load bundled packages and packages the user installed from git: each pinned to a
commit, approved by the user per package and commit, verified before loading, and
declaring its surface in `act-plugin.json` (item types, account types, runtime
operations, MCP tools, settings, contributions to other types, guide text, styles).
A package registers nothing it did not declare, and its identifiers stay in its
namespace unless listed as legacy ids. Agents can never install, update, enable or
remove plugins.

**EXT-03:** Settings → Plugins installs a package from a git URL and ref with the
user's own git. A release is `act-plugin.json`, a prebuilt `dist/` and
`act-plugin.integrity.json` (sha256 per file) committed on the tag; nothing runs
before approval. The review names the exact commit and lists what the package adds;
approval is "Trust and install" for that commit only, and every update shows the
replaced build and the change in contributions and asks again. Every released file
is verified at install and on every load; any mismatch, incompatible API range,
identifier clash, throwing or slow (over 5 s) activation turns only that package
off with its reason, and its items stay as placeholders. Repeated runtime failures
pause a package for a few minutes. Turn off, roll back to one of three kept
builds (offline), remove (code deleted; items, links and settings kept) and
reinstall apply by restarting the workspace service and reloading the window,
without stopping sessions. A development folder can be approved and loaded in place
without an integrity file, labelled Development. Trust is full: installed code has
the app's access, so consent and pinning are the only safeguards.

**EXT-04:** A package may ship settings presets: values for another package's
declared settings. Each preset (by id) applies once per workspace when its package
loads (the service start after install, turn on or update, or any later start that
has not applied it yet), to each target setting that is unset or still at its
declared default. A value the person changed is never overwritten, and a preset is
never applied twice, even if the person later sets a value back to its default. A
preset whose target package is not loaded waits for a start where it is; values its
target refuses are skipped and logged. Removing the package leaves the applied
values. Workspaces that got a preset under the earlier rule (settings saved before
package settings existed) do not get it again.

**EXT-05:** An install link `act://plugins/install?source=<git URL>&ref=<tag or
commit>` opens the app (bringing the window forward), Settings → Plugins with
the install-from-git form filled in, and starts the normal fetch and review. The
link never installs: the review (commit, integrity, what the package adds, the
trusted-code notice) still needs the person's explicit approval. Only
`plugins/install` is accepted, the source must be an `https://`, `ssh://` or
`git@host:path` repository the install form accepts (no local paths, no
credentials), the ref is optional and checked like the form's ref, and the link
may carry nothing else; anything else is refused with a visible notice. The link is
handled by the desktop app only; agents and MCP cannot trigger it.

**UPDATE-01 — Updates follow release tags.** A release is a tag `vX.Y.Z` of the public
repository; `package.json` carries the same version and the app reports it. The workspace
service looks up the app's newest release tag (the GitHub tags API, without credentials)
and, for every git-installed plugin pack, the newest tag of its source (`git ls-remote
--tags` with the person's git) once a day while **Settings → General → Check for updates
daily** is on (default on); **Check now** looks at once. A test run never reaches the
network: it reads the tags URL the test names, or nothing. The window shows a newer
release as an info notice in the notice corner, "<name> vX.Y.Z is available", until the
person opens it or closes it; a closed notice stays closed for that version only
(`view.dismissedUpdates`), a newer tag is offered again. For the app the notice opens
Settings → General, whose About section shows the running version, the newest release,
when it was checked or why it could not be, and the update command; for a pack it opens
Settings → Plugins with the pack's source and new tag filled in for the usual review.
Nothing is downloaded or installed by the check. `npm run update` in a checkout refuses
while the app runs or tracked files have local changes, fetches tags, checks out the
newest release (detached), then `npm ci`, `npm run package`, `npm run install:local`;
`--dry-run` prints the plan. Builds without a release version (`dev`) are never offered
an update.
When a newer release is available and the app runs from the checkout it was installed into
(`<checkout>/release/mac-arm64/Agentic Crafting Table.app`, with `.git` and this `package.json`),
**Check now** becomes **Update and restart**, and the notice reads “Update from Settings → General”.
It first asks the person's login shell for `node` and its PATH; without them it does not quit and
says why in About. Then it quits through the normal close path (the warning about active sessions,
Cancel leaves nothing running); only after both services have drained it starts
`scripts/update-restart.mjs` from the checkout with that node, detached, logging to
`logs/update-restart.log` in the app data folder; if it cannot start, the failure is noted and the
app relaunches. The script waits until nothing runs from the installed or staged app (2 minutes at
most), runs `npm run update` with its usual refusals, rebuilds and installs when an earlier run left
the checkout on the release without installing it, and succeeds only when the installed app carries
that version; then it opens the app. A failure is written to
`update-failure.json` in the app data folder; Settings → About shows it as an alert until a later check
succeeds, which deletes the file.

**QUALITY-01:** The same validation controls UI, MCP and provider-originated writes.
Persist before announcing success. No duplicated processes/comments on uncertain
retries. Test genuine pointer/keyboard flows, persistence and process boundaries,
not only helpers or screenshots. Offline operation retains local work and exposes
stale provider observations without fabricating current status.

Local installation preserves the installed app directory's identity and workspace
data. Record update intent before replacing Contents, refuse concurrent installers
and live app/service processes, and recover interrupted replacement on retry before
validating installed metadata. Retain the prior build; a completed activation stays
installed. Recovery must also work without a staged build and refuse unfamiliar
or redirected files instead of guessing which backup to restore.
An identical verified app must not create another installed copy or rollback build.
Compare contents, executable modes and symlink targets rather than version alone.
Capture that inventory before verifying the staged app and confirm verification
did not change it. Before activation, compare the private copied bundle with the
same inventory; a concurrent source rebuild or altered copy must abort before
replacing the installed app. Preserve earlier rollback copies and permit retry
after staging is stable. Recheck that the app is stopped after the copy comparison.
Before staging a changed build, require enough available destination-volume space
for its copy and filesystem overhead; refuse clearly without deleting backups.
Interrupted-install recovery runs before this capacity check.

Explicit offline backups preserve the graph, recordings, recovery checkpoints and
owned launch/review files together. Refuse live service/session owners; verify
committed SQLite data, versions, file hashes and paths before preparing a separate
recovery copy. Never overwrite the current profile or resume work during copy
preparation. Keep native conversations, credentials and IPC tokens outside the
bundle. Recovery activation at the original path is an explicit operator step;
normal startup recovery may resume saved sessions afterward. See
[workspace backups](workspace-backups.md) for scope and remaining acceptance.

**QUALITY-02 — Performance diagnostics and regression gates.** Keep bounded,
local timing/count measurements for foreground terminal frame intervals, renderer
stalls, output reads and xterm consumption, resize fitting, input delivery and
unnecessary rendering. Settings exposes current measurements, reset, slow-budget
indicators and a downloadable report with no terminal content, prompts, paths or
session identities. No remote telemetry is required.
Delivery diagnostics include the unread recording chunk count after consumption
and sequence gaps. A quiet or caught-up terminal is not proof that a provider has
finished its response; do not auto-submit, interrupt, retry or declare completion
because output stops. Preserve partial output for inspection and continuation.
Use repeatable synthetic workloads through the real desktop/PTY path to establish a baseline, fix measured
bottlenecks and gate regressions in normal CI. Cover sustained ANSI updates,
multi-megabyte bursts, input-to-visible-echo latency, history replay, idle/hidden
views, and terminal/session continuity. Track reports on successful and failed CI
runs; document budgets, fixture and hardware with the evidence. Measurements are
diagnostic evidence, not a claim that every native CLI workload is equally fast.

**QUALITY-03 — Unobtrusive automated checks.** Isolated Electron tests, including
packaged smoke tests and session restarts, run with hidden windows by default.
They must not steal desktop focus or add a macOS Dock entry. Preserve screenshot,
keyboard/pointer, terminal and performance coverage; provide an explicit visible
debugging mode. Normal app launches retain their window and Dock behavior.

A requirement is met by the production app, not by the HTML reference simulating
its outcome.
