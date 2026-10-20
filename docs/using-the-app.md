# Using the app

The day-to-day guide: creating things on the map, agents and terminals, moving
work around, and the settings you will meet first. The [specification](specification.md)
is the complete reference.

## Creating items

Double-click empty board space or right-click → **New item**. Choose Project from
the picker outside an existing neighborhood. Right-click an existing item to edit
its details.

Choose **All → Note** and enter just the text. It saves immediately; Claude Haiku
generates a short title in the background, with a local text label as fallback.
Notes are smaller than to-dos. Click their icon to read them or choose **Edit note**;
resizing the map bubble reveals more saved text. Hover only highlights items.
Notes can link to agents as context and can be pinned to the quick ring in Settings.

Drag a browser link or URL text onto the map to open **From URL** with the link
prefilled. It uses the drop location and project; confirm attachment in the form.
To watch a rollout, choose **From URL** and paste a GitHub Actions run, job or
workflow link. Run/job links watch the whole run; workflow links follow its latest
run. Rollout items sync roughly every minute and show ongoing, approval, failed
or passed state directly on the map. Open one for its jobs and pending
environments. Connect GitHub in Settings first; this feature only reads results.

## Terminals

Choose Terminal, give it a title and working directory (prefilled from its project),
then click its bubble for the real shell. **Shift+Enter** adds a newline; **Enter**
submits. Hover a terminal link to highlight it, then click for **Copy link** or
**Open in browser**. These actions also work in stopped output. A stopped Terminal
offers **New shell** in its saved folder while retaining ordinary scrollback; there
is no separate History player. Terminals use your normal shell configuration,
plugins, history and key bindings. They stay stopped after app close; choose
**New shell** to start again. Startup commands are not replayed; recordings are retained.

## Agents

Choose Agent session and its provider to start Claude or Codex in a local folder;
the project summary and table synchronization guide are supplied automatically.
The selected provider CLI must already be installed and signed in. Its native
trust/permission prompts appear in the terminal. Resume / reconnect attaches to a
running process or resumes the saved native conversation after it ends. The
creation form also has Continue Session to browse native conversations across
folders on this computer.

A new general-purpose Claude session receives current project → items → connected
subitems context and opens with a short **What next** list. It suggests relevant
work, such as following up on a PR's linked review, then waits for your choice.
Resuming a conversation keeps its existing work rather than repeating this opening.
See [native Claude support](native-claude.md) and [native Codex support](native-codex.md).

Claude **Auto mode** and Remote Control default on. Change them in **Settings →
Items → Claude** for the next new or resumed session. Turning Auto mode off selects
manual approval; read-only PR review sessions keep their separate restrictions.

Double-click empty space inside a project → **Run skill** in the radial picker
to discover installed skills, choose a model and launch a tracked native run.
Right-click → New item opens the same picker. A dragged + also connects the new
skill agent to its source. See [project skills](native-skills.md) for the shared
MCP operations, retry behavior and explicit live-provider smoke test.

Enable **Settings → AI features → Activity summaries** for short Haiku-generated
labels, with restart-safe request limits. This sends redacted recent output through
your Claude account; it is off by default. **Auto-title agents** (on by default)
gives Claude and Codex items a 2–5 word Haiku title from their activity until you
rename them; see [activity summaries](activity-summaries.md).

## Moving things around

Drag an item into another project's neighborhood and release when **Move to NAME**
appears to transfer it. Links and running sessions stay intact. Dropping on empty
map space keeps its current project; Item settings can make it floating.

Dragging previews collision clearance: the held item stays under the pointer and
other cards move to clear space. Project members move together; keyboard and
agent/MCP movement commands use the same placement rules.

Drag an item's bottom-right pixel grip to resize its map bubble and level of
detail. Each type keeps its own dimensions and useful tiers; to-dos stay
Small-only. Configure preset dimensions and defaults in **Settings → Items → [type]**
under that page's **Advanced settings** disclosure. Expanded content dimensions
remain separate. See the [size/content matrix](item-map-sizes.md).

Opening an item keeps its original bubble and connections on the map. Drag the
expanded view by its heading to move it around the window without moving the
item. Closing animates back to its map bubble. Open-view positions are remembered
per item for this window; terminal sessions stay mounted when moving/reopening.
Drag the expanded view's bottom-right grip to resize it independently. Its size
is remembered for this window too. Arrow keys on the grip adjust size; Home or
double-click restores that item's type default without resizing other items.

## Neighborhoods and plots

Neighborhoods use broad bands of fading pixels that stretch around their items,
without an outline. **Settings → Map** sets neighborhood padding; its **Advanced
settings** disclosure adjusts pixel size, fade distance and edge scatter. The
default is 24 px blocks with a continuous edge.

Three or more items sitting close together in a project form a **plot**: a lighter
patch with a signpost carrying a short name (from the title helper when **Name plots**
is on). Click the sign to select its items, drag it to move them, double-click to
rename; far-zoom dashboards list plots.

## Sessions, archive and closing

Item/project menus contain settings and lifecycle actions only; Archive and Clear
overlaps are also in Settings → Map.

Settings → Data & diagnostics → Sessions lists running processes, including ones
removed from the map, and lets you stop them explicitly. Archive/Restore controls
list visibility; Delete is available only under **Archived sessions**, for stopped
entries, while retaining recordings and native conversations. Items, projects and
checklist to-dos must also be archived first; open **Archive** to restore or delete them.

Closing warns before stopping active sessions and records recovery intent; startup
resumes supported conversations and reconciles unfinished work. Data belongs to
Electron's stable local user-data directory. Credentials stay outside the renderer.
The window remembers its size and position across restarts and updates, fitting
back onto an available display when your monitor setup changes.

## macOS notifications

Settings → Notifications controls Needs me alerts and completion announcements.
The default is background only; choose Always or Off, and toggle sound and each
category separately. Click a banner to return to ACT/the item. Opening an item
leaves it in Needs me until you mark it seen; under “Opening an item marks it seen”
on the same page, check the item types that should be marked seen as soon as you
open them. Use Send test notification to check macOS permissions and Focus settings.
ACT must remain open. Native delivery is separate from the always-available in-app alerts.
