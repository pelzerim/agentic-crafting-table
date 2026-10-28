# Changelog

Releases are Git tags (`vX.Y.Z`); `npm run update` moves a checkout to the newest one.

## Unreleased

### Needs me
- **Close and mark seen**: an open item in Needs me has a close X with a check beside Mark seen. It marks the item seen and closes it; **⌘E** does the same, also from inside a terminal.

### Terminals
- In a terminal, **⌘⌫** deletes to the start of the line and **⌘←** / **⌘→** move to its start and end, as in iTerm2 and Terminal.app.
- **⌘C** copies in an agent session that captures the mouse, such as Claude Code, when the terminal has no selection of its own. Other terminal apps never receive it.
- **⌘F** finds text in a terminal: matches highlight as you type, Enter and Shift+Enter step through them, Esc closes the bar.

### Map
- Shift-drag selects a rectangle of items while Needs me is held open beside the map.
- **Resize the Projects panel** from its top-left corner; the size is kept.
- **Fold** each project and plot in the Projects panel with its chevron; folds are kept.
- **Filters** in the Projects panel: untick **Needs me** to list every item of each project by plot, and switch off **Agents**, **PRs**, **Rollouts**, **Tickets**, **Notes** or **Other** to hide that kind.
- The Projects panel **stays open while an item is open** and beside Needs me, and **M** toggles it there too. An item row opens that item in place of the open one; a project or plot row closes it and flies there.
- **Pin the Projects panel** to keep it open across Esc, row clicks and relaunch, beside To-dos, Reminders, the GitHub inbox and the Controls card. M closes it and unpins.

### Updates
- **Update and restart**: when a newer release is out and the app runs from its checkout, Settings → General → About offers it in place of Check now. The app quits as usual, builds and installs the newest release, and reopens; a failed update is shown there on the next launch.

## 0.6.0 — 2026-10-27

### Map
- **Move to plot**: right-click an item or a selection for **Move to plot ▸** with the project's plots and **New plot**. The chosen items are pinned in that plot: they stay its members wherever they sit, neighbours may still join and leave, and one pinned member keeps the plot alive. A pinned plot's sign carries a pin glyph; **Remove from plot** unpins. Items from several projects, or an item in no project, get **Items in one project only**.
- **One colour picker** for a project's neighbourhood colour, a plot's colour and a note's paper: pixel swatches, **Your colours** (the last eight custom colours you chose anywhere) and **Custom colour…**, which opens a hue/shade pad and a hex field in the app instead of the system dialog. Twenty neighbourhood presets (Emerald, Moss, Ice, Quartz, Birch, Sand, Clay, Copper, Coral and Obsidian join the ten biomes), ten note papers (moss, ice, sky, lilac, rose, peach, sand, fog and slate beside mint; a dark paper takes light ink), and a plot or paper may be any `#rrggbb`.
- **Project column**: a project row says each fact once. The rows are what waits on you (asking, my turn, with the reason and age), the lines the summary model wrote, and one meta line with open to-dos and working agents; colour is spent only on what waits, and the folded icon shows a count only for asking or my turn. Needs me rows are grouped by plot when two or more plots have them.

### Pull requests
- A pull request's **Merge**, **State** and **Show / Ship** menus open at once from their last answer and refresh in the background; an outdated pick fails on its own and the menu reads live next time.

### Rollouts
- An acknowledged validation alert is no longer raised again on every rollout pass, which pinned the local service and left the app **Reconnecting** on quit.

### Local service
- **Local service disconnected** no longer comes and goes on large workspaces: when the window is slow to take a snapshot only the newest one waits, and the service never drops the window for a backlog of older ones.
- Settings → Data & diagnostics → Support → **Service health**: timer lag, the slowest operations, snapshots and bytes per window, drops and memory per minute, with a download for a support report.
- Review checkouts are removed once their review is finished (about 750 MB each; a disk had run full on 46 of them). Reports and the git cache stay, and a review opened again rebuilds its checkout from the cache.
- Listing jobs no longer decodes every saved job on every poll.

### Speed
- The window receives only the map's items: Undermap items, their links and records stay in the local service until you go below, so a board with hundreds of items below no longer decodes and compares them on every change (one fixture's snapshot went from 309 KB to under 1 KB).
- Items under a muted cover are not rendered until you peek, and the pull requests of a muted project are read at the slowest polling step; unmuting reads them at once.

## 0.5.0 — 2026-10-26

### Map
- **Project column**: the bottom-right corner shows one icon per project that is not muted, in the project's colour with its most urgent state and a count (◆ asking, ▲ my turn, ✦ working). **M** unfolds it into a row per project with counts, a summary line and that project's Needs me rows; clicking a project flies to it, clicking a row centres the item. Quiet projects fold into one line. The minimap remains available through the `mapCorner` setting.
- **Summarise projects** (Settings → AI features, on by default): each project's summary line is one or two sentences from the summary model, refreshed only when the project changes and at most every 10 minutes per project; off, the line shows plain counts. The daily request limit shared by all AI features is now 500.
- The zoom bar sits in the bottom-left corner, right of the tool rail.

### Speed
- A change to one item no longer re-renders every card on the map: a snapshot keeps every unchanged item, and a card is re-measured only when its own item, record or presentation changed. On a 200-item board one change rendered 5,040 cards and now renders 11.

## 0.4.0 — 2026-10-26

### Map
- **Moving into items** (Settings → Map → Placing items): **Push aside** (the default) moves other items out of the way as before; **Solid** stops a dragged item at the items in its way and lets it slide along them. Items never overlap in either mode, with the grid on or off.
- A right click while a sidebar panel is open only closes the panel; it no longer also opens the map menu.
- Actions on the map no longer fail with **Revision conflict** while agents are busy. An agent's animation (pose, helpers, background tasks) no longer counts as a change to the map, and an action that raced with another change is applied to the newest map when nothing it acts on changed. Otherwise it says **This changed elsewhere while you were acting on it**.

### Reviews
- A finding sent to an agent shows a send flag instead of its checkbox in the findings list. **Select all** skips it, and **Select to send again** picks it once more.

### Rollouts
- **Approve**, merge and other GitHub writes no longer end in **The operation was aborted due to timeout** after 10 seconds; they get the service's own time limits.

### Speed
- The local service no longer stalls for up to 0.7 s on every rollout pass, so **Local service disconnected** no longer comes and goes on large workspaces.
- Reading the workspace is cached, and a save writes only what changed (about half the time per save).
- Saved commands no longer keep a copy of the whole workspace; the database shrinks (about half on a large one) the first time this version opens it.

## 0.3.0 — 2026-10-25

### Map
- **Note badges**: a note of one or two words (up to 12 characters) connected to items shows as a paper tab on each of them, and beside their names in Needs me and dashboards. A badge has its note's colour; right-click it (or the note) for **Colour** and **Show as ▸ Note / Badge** (a badge takes up to 24 characters). Agents see badges in `workspace_read` and are told how to use them.
- A plot's sign menu has **Move plot to ▸** another project or **No project**, and **Send plot to Undermap**. A moved plot keeps its layout, name and color.
- An agent's macOS notification and its card, when large, quote the last line it ended its turn on.
- **Delete in item menus** (Settings → Map → Removing items, off by default): an item's menu ends in **Delete…**, which removes it for good after **Delete permanently**. Provider data and sessions are kept.

### Standup report
- The **standup report** is back under Actions (key 6). A full week now works: every day's conversations and pull requests reach the report, read four at a time (a first 7-day report takes about three minutes), and one long story no longer costs the whole report.

### Reviews
- **Automatic reviews** (Settings → Items → GitHub pull request, off by default): every pull request that lands on the map afterwards gets a review from each chosen agent (Claude, Codex or both), drafts included.
- A review is marked done once every finding sent to an agent is fixed.
- **Trigger review ▸ Claude + Codex** starts a Claude and a Codex review at the same time; Review selection offers it too.

### Agents
- A pull request an agent is reworking shows as working, with **Reworking · what · agent** above its description and **Mark as completed manually**. When the agent finishes, the pull request enters Needs me as My turn. The agent guide asks agents to keep that note current, and to link pull requests that depend on each other as blocking.

### Rollouts
- A rollout started by a pull request with **Auto deploy** on is no longer validated twice per stage: Auto validate leaves it to Auto deploy.
- Taking a pull request out of the merge queue stops its **Auto deploy** quietly instead of halting it with a Needs me.

## 0.2.0 — 2026-10-21

### Updates
- A daily check reads the release tags of the app and of installed plugin packs. A newer release shows as a notice until it is opened or dismissed for that version.
- Settings → General → About shows the versions, a **Check now** button and the daily-check switch.
- `npm run update` moves a checkout to the newest release tag and installs it. It refuses while the app runs or the checkout has local changes.

### Map
- **Snap to grid** (Settings → Map → Placing items, off by default): an item's centre lands on an invisible 48 px grid when it is dropped, nudged with the arrow keys, or placed by the table, so connections run straight or at even angles.
- Pull request cards show their number (`#48`) as a tag in their status row, the way Linear cards show `BIL-128`.
- **Review selection ▸ Claude / Codex**: select several pull requests and start one review for each from the selection menu.
- The tool rail, its sheets, the Undermap portal and the breadcrumb slide off their edges while an item view covers them, and return when it closes.
- Right-clicking a rail tool (Needs me, To-dos, GitHub inbox, Reminders) holds it open through Escape, map clicks and opening items. A lock on its slot shows the hold; right-clicking again releases it.

### Needs me
- An agent's row quotes the last line it ended its turn on (secrets redacted, two lines at most) instead of “Ready for your next prompt”.
- Every group (Asking me, My turn, Finished, Earlier) folds from its heading; folds are remembered on this Mac.
- **Close and keep in Needs me** on every item frame: close an item you opened from Needs me without marking it seen.

### Agents
- **Stop session** moved into the agent's Session menu; plain terminals keep their Stop button.

### Reviews
- A review that found nothing shows a green **No findings** check on its card and leaves Needs me.

### Rollouts
- Automatic validations (Auto validate, staged runs, Auto deploy) go to the rollout's own hidden validation agent instead of an agent you are working with. A connected agent is asked only while Claude cannot start a session.
- Multi-phase rollouts are validated per phase: each gate that waits after something new ran gets its own validation, and so does the rest of the run when it ends. Approving a gate therefore leads to the next phase's validation.
- **Validate** and **Approve and validate** scope the validation to the phase that just ran, and are no longer answered by an earlier validation started from chat.

### Linear
- **Linked pull requests ▸ Add to the map** on a ticket adds every GitHub pull request linked to it, beside the ticket and connected to it.

### Docs
- A new demo in the README.

## 0.1.0 — 2026-10-20

- Initial public release.
