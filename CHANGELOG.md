# Changelog

Releases are Git tags (`vX.Y.Z`); `npm run update` moves a checkout to the newest one. Entries contributed by others name
their pull request and author.

## Unreleased

### Agents
- **Session commands**: `/new`, `/clear`, `/fork`, `/branch` and `/resume` typed in a Claude or Codex terminal now follow the CLI on the map. New and forked conversations open in their own session beside the item, `/resume` goes to the item that holds the conversation, and the session view moves with you. The item where you typed keeps its conversation. (#9, @timohuovinen)

## 0.11.0 — 2026-10-30

### Agents
- **Codex defaults**: new Codex sessions and reviews start on the newest Sol model the installed CLI offers, at high effort. The version comes from the catalog, so a newer Sol needs no update here; a catalog without Sol uses Codex's own default. Resumed conversations keep their model and effort. (#5, @timohuovinen)
- **Paste in Codex**: Ctrl+V no longer shows "no image on clipboard" before text arrives. Text of any size pastes at once, and a screenshot attaches as an image, through Ctrl+V, Ctrl+Shift+V or the Edit menu. (#5, @timohuovinen)
- **Rename from the open view**: click an agent session's title in its open view to edit it; Enter saves the new name and Escape keeps the old one. A typed name is yours, so automatic agent titles leave it alone. (#5, @timohuovinen)
- **Provider buttons**: the new agent form chooses Claude or Codex with square logo buttons, Codex cards show the Codex mark, and the generic Agent session entry is 🤖. (#5, @timohuovinen)
- **Codex status**: a resumed Codex session no longer stays on "Resuming Codex…" until its first turn, and recovery no longer fails on it. A status an agent sets on its own item stays until Codex's status changes. A resume no longer adds another copy of the guide to the conversation. A stopped launch no longer reads as a failure, and an error from Codex itself no longer reads as a disconnect. (#5, @timohuovinen)
- **Launch errors**: a Codex update no longer breaks launches until restart, a slow launch no longer reports a false failure, a deleted folder gets a plain message, and a launch that is too long is refused before its item appears. (#5, @timohuovinen)

### Terminals
- **Right click in an open view**: Settings → General → Mouse behavior chooses whether a right click closes an open agent or terminal view anywhere, as before, or only outside it. (#5, @timohuovinen)
- Review findings longer than 64 KiB now reach the agent instead of failing. (#5, @timohuovinen)
- Reopening a long Codex or Claude session redraws its screen at once, instead of showing stray colour codes until new output arrives.

### Map
- **Move the map with an item open**: drag, scroll or pinch the board around an open item to look at what is next to it. The item stays where it is and keeps its own scrolling, and Back leaves the map where you moved it. (#3, @shiini2)
- **Order the Projects panel**: drag a project row, or a plot header within its project, to where you want it; a line shows where it lands and Esc cancels. Alt+↑ and Alt+↓ move the focused row. The order is saved, new projects and plots appear on top, and the folded column's icons follow it. (#3, @shiini2)
- **Where an item lives**: an open item names its project and plot above its title; click either to close the item and fly there. **Show on map**, the crosshair beside the close X, closes the item and centres the map on it. The trail at the top left now reads Project / Plot / Item. (#3, @shiini2)
- **Projects panel type**: project rows are larger and bold, plot headers are small upper-case labels, and item rows sit indented in regular weight with their reasons and states smaller, so the panel reads as a tree. (#3, @shiini2)
- With Solid collisions and Snap to grid, a dropped item stays where the drag showed it, instead of jumping back toward where it came from.
- A note shown as a badge goes to the Undermap with the items it badges, once none of them stays on the map.

### Appearance
- **Light mode.** Settings → General → Appearance chooses **System** (default: follows macOS and switches with it), Light or Dark. Cards, panels, settings, the map, the terminal and its ⌘F highlights all have light colours; amber still means Needs me. On System, test launches stay dark unless `ACT_TEST_APPEARANCE` pins light. (#4, @MegaMaddin)

### Pull requests
- **Merge when ready**: while GitHub cannot merge a pull request yet (reviews or checks missing, still checking), Merge offers “… when ready” through GitHub’s auto-merge, or “Add to merge queue when ready”. The card shows it, Cancel merge when ready turns it off, and Auto deploy waits for GitHub instead of merging again.
- **Copy URL** on Slack messages (their permalink), code reviews and workflow reviews (their pull request).

### Rollouts
- The phase track keeps build → dev → staging → production in order when a staging job finishes after production waits at its gate, and its cells widen to show a phase’s full name.
- When Auto deploy cannot request a validation, its halt message keeps the reason instead of cutting it off after a long list of jobs.

## 0.10.0 — 2026-10-29

### Platform
- **Linux** (x64 and arm64, tested on Ubuntu 26.04): `npm run dev`, `npm run package`, `npm run install:local` and `npm run update` work from the same checkout. The installer adds a desktop entry, so the app appears in the launcher and opens `act://` install links. `npm run sandbox:linux` writes the AppArmor profile that Ubuntu 23.10 and later require before Electron's sandbox can start; see [On Linux](docs/setup.md#on-linux). (#2, @timohuovinen)
- Linear and Slack read their token from the Secret Service keyring on Linux (`secret-tool`), and Settings → Connections shows the matching `secret-tool store` command. (#2, @timohuovinen)

### Agents
- **Claude's recap**: when Claude Code writes a recap of a session while you are away, Needs me and the agent's large card show it instead of the last line, and project summaries take it into account. A new prompt clears it.
- The table no longer keeps reconnecting with many agents open: each agent's connection to the table's tools now asks for what it needs instead of receiving every change to the whole workspace.
- **Explain architecture** no longer stops at Claude Code's "Do you trust this folder?": the app's own comparisons folder is marked trusted once, the way answering Yes does.

### Map
- Clicking an item in Needs me first centres the map on it at the current zoom, then opens it.
- A project title moves the project only from its title plate; the space beside it pans the map. Hovering the plate shows a grip, a grab cursor and an edge in the project's colour.

### Rollouts
- A finished rollout's open view has a purple **Send to Undermap** X at its top right.

### Map
- **Move the map with an item open**: drag, scroll or pinch the board around an open item to look at what is next to it. The item stays where it is and keeps its own scrolling, and Back leaves the map where you moved it.
- **Order the Projects panel**: drag a project row, or a plot header within its project, to where you want it; a line shows where it lands and Esc cancels. Alt+↑ and Alt+↓ move the focused row. The order is saved, new projects and plots appear on top, and the folded column's icons follow it.
- **Where an item lives**: an open item names its project and plot above its title; click either to close the item and fly there. The trail at the top left now reads Project / Plot / Item.
- **Projects panel type**: project rows are larger and bold, plot headers are small upper-case labels, and item rows sit indented in regular weight with their reasons and states smaller, so the panel reads as a tree.

## 0.9.0 — 2026-10-28

### Rollouts
- The phase track groups a rollout without stage rules by stage: parallel jobs whose ids interleave no longer become a phase each. Build jobs of every stage (`staging-build`, `prod-build`) count as build, `dev` is a stage, and `phase-N` labels split a stage into its phases, so a run of 24 jobs reads build → dev → staging → production · phase-1.

### Plugins
- A plugin pack may preset the **working animal** (sheep or raccoon) for the workspaces it is installed in: once, and only while the setting still has its default, so a choice made in Settings → Map stays. Plugin API 1.3.0.

## 0.8.0 — 2026-10-28

### Rollouts
- **Auto deploy from here**: a rollout that is already running can be handed to Auto deploy from its Actions ▾ or its right-click menu on the map, and a merged pull request offers **Auto deploy its rollout** while a rollout of its merge still runs. The confirm asks what happens to the phases that already deployed: **Validate what shipped first** (the default; a passing validation that already covers a phase counts) or **Start from the next phase**, with a plan per phase. A rollout of a push with no pull request on the map can be taken over too.
- **Phase track**: every rollout of two or more phases shows a row of pips (“4 of 8 deployed · 3 validated”) and a lane of phase cells under the verdict line: what deployed, which validation covers it, and who opens each gate (you, Auto deploy after a pass, or approved). The lane scrolls sideways with the current phase centred, folds the deployed and validated phases into one cell, and leaves your own scrolling alone for 10 seconds. Under Auto deploy it carries Auto deploy's step, what comes next and **Stop**.
- Clicking a phase filters the jobs rail and the timeline to it; click again or press Esc to clear.
- A gate Auto deploy will open says **Auto deploy approves after V2 passes** instead of waiting for you, and Auto deploy's own steps (what it asked to validate, what it approved, why it stopped) appear in the timeline.

### Map
- The large rollout card shows its phase pips and count.

## 0.7.0 — 2026-10-28

### Needs me
- **Close and mark seen**: an open item in Needs me has a close X with a check beside Mark seen. It marks the item seen and closes it; **⌘E** does the same, also from inside a terminal. (#1, @shiini2)

### Terminals
- In a terminal, **⌘⌫** deletes to the start of the line and **⌘←** / **⌘→** move to its start and end, as in iTerm2 and Terminal.app. (#1, @shiini2)
- **⌘C** copies in an agent session that captures the mouse, such as Claude Code, when the terminal has no selection of its own. Other terminal apps never receive it. (#1, @shiini2)
- **⌘F** finds text in a terminal: matches highlight as you type, Enter and Shift+Enter step through them, Esc closes the bar. (#1, @shiini2)

### Map
- Shift-drag selects a rectangle of items while Needs me is held open beside the map. (#1, @shiini2)
- **Resize the Projects panel** from its top-left corner; the size is kept. (#1, @shiini2)
- **Fold** each project and plot in the Projects panel with its chevron; folds are kept. (#1, @shiini2)
- **Filters** in the Projects panel: untick **Needs me** to list every item of each project by plot, and switch off **Agents**, **PRs**, **Rollouts**, **Tickets**, **Notes** or **Other** to hide that kind. (#1, @shiini2)
- The Projects panel **stays open while an item is open** and beside Needs me, and **M** toggles it there too. An item row opens that item in place of the open one; a project or plot row closes it and flies there. (#1, @shiini2)
- **Pin the Projects panel** to keep it open across Esc, row clicks and relaunch, beside To-dos, Reminders, the GitHub inbox and the Controls card. M closes it and unpins. (#1, @shiini2)

### Updates
- **Update and restart**: when a newer release is out and the app runs from its checkout, Settings → General → About offers it in place of Check now. The app quits as usual, builds and installs the newest release, and reopens; a failed update is shown there on the next launch. (#1, @shiini2)

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
