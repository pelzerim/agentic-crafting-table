# Changelog

Releases are Git tags (`vX.Y.Z`); `npm run update` moves a checkout to the newest one.

## Unreleased

### Map
- **Note badges**: a note of one or two words (up to 12 characters) connected to items shows as a paper tab on each of them, and beside their names in Needs me and dashboards. A badge has its note's colour; right-click it (or the note) for **Colour** and **Show as ▸ Note / Badge** (a badge takes up to 24 characters). Agents see badges in `workspace_read` and are told how to use them.
- A plot's sign menu has **Move plot to ▸** another project or **No project**, and **Send plot to Undermap**. A moved plot keeps its layout, name and color.
- An agent's macOS notification and its card, when large, quote the last line it ended its turn on.
- **Delete in item menus** (Settings → Map → Removing items, off by default): an item's menu ends in **Delete…**, which removes it for good after **Delete permanently**. Provider data and sessions are kept.

### Reviews
- **Automatic reviews** (Settings → Items → GitHub pull request, off by default): every pull request that lands on the map afterwards gets a review from each chosen agent (Claude, Codex or both), drafts included.
- A review is marked done once every finding sent to an agent is fixed.
- **Trigger review ▸ Claude + Codex** starts a Claude and a Codex review at the same time; Review selection offers it too.

### Agents
- A pull request an agent is reworking shows as working, with **Reworking · what · agent** above its description and **Mark as completed manually**. When the agent finishes, the pull request enters Needs me as My turn. The agent guide asks agents to keep that note current, and to link pull requests that depend on each other as blocking.

### Rollouts
- A rollout started by a pull request with **Auto deploy** on is no longer validated twice per stage: Auto validate leaves it to Auto deploy.

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
