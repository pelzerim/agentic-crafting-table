# Text editor item: plan

Status: planned 2026-11-09, in progress since 2026-11-10. Tracked as TEXT-EDITOR-01 in [todos](todos.md).

A new item type, `workspace.text`, that edits a file on disk with code highlighting and Markdown preview.
Use existing libraries only; reimplement nothing. The editor keeps what CodeMirror ships by default,
autocomplete included; nothing is switched off by hand.

## Decisions

- **Storage:** a file on disk. The item record holds only `path` (absolute) and an optional `language`. The
  workspace database never holds the file content.
- **Content:** each item has a language. When `language` is unset, it is detected from the file name with
  CodeMirror's `LanguageDescription.matchFilename`. A Markdown file has a preview; a code file shows its
  highlighted source.
- **Layout:** one pane in the open item, with an Edit/Preview toggle in the view header. This keeps the
  one-open-item rule.

## Libraries

| Need | Library | Notes |
| --- | --- | --- |
| Editor and highlighting | CodeMirror 6: `codemirror` (`basicSetup`), `@codemirror/state`, `view`, `language`, `lang-markdown`, `language-data` | `basicSetup` is the stock editor: history, search, bracket matching and closing, folding, line numbers, autocomplete. |
| Markdown preview | `marked` + DOMPurify, through `renderMarkdown` in `src/resource-plugins/markdown-view.ts` | Already bundled and sanitised. |
| Highlighting in the preview | `@lezer/highlight` `highlightCode` + `classHighlighter` | Same grammars as the editor, so both colour code the same way. |

Not chosen:
- **Monaco:** about 5 MB, with a language service the item does not need.
- **TipTap / Milkdown:** they edit rendered text (WYSIWYG), not source.
- **highlight.js / Shiki:** a second highlighter that would colour code differently from the editor.

**Editor setup:** `basicSetup` from the `codemirror` package, plus:
- `markdown({ codeLanguages: languages })`, or the file's own language;
- `syntaxHighlighting(classHighlighter)`, so the colours come from the design tokens.

## Service connector (`connector.ts`)

File I/O stays in the service, never in the renderer. The views reach the four actions below through
`resource.action`. Each answers with a `state`, so an expected condition is data and not an error.

**`read` action**
- Returns `{ state: 'present', text, version, modifiedAt, size }`. `version` is the sha256 of the content, so a
  file that was touched without a change keeps its version.
- A file that is not there returns `{ state: 'missing' }`.
- Returns `{ state: 'refused', reason }` for binary content (not UTF-8, or holding a NUL byte), a file over
  2 MB, a path that is not a regular file, a path that is not absolute and a file the service may not read.

**`excerpt` action**
- Returns `{ state: 'present', text, complete, modifiedAt, size }` with the first lines of the file: at most 60
  lines and 6,000 characters, ended at a line end. A first line longer than that is cut. `complete` says
  whether the excerpt is the whole file. The map card reads this, so a large file never crosses to the
  renderer for a card.
- Missing and refused files answer as for `read`.

**`write` action**
- Takes `{ text, path, baseVersion }` and writes only while the file on disk still has `baseVersion`. Without
  a `baseVersion` it writes only while there is no file, and creates the folders above it.
- `path` is the item's path as the caller read the text from it. An action is resolved against the item's
  path at the time it runs, so a write that arrives after the item was pointed at another file is refused
  with "The item now edits another file". `read`, `excerpt` and `stat` take the same `path` and are refused
  the same way; only `write` must name it.
- Otherwise it returns `{ state: 'conflict', disk }`, where `disk` is what `read` returns now.
- Writes go to a temporary file beside the original that is then renamed over it, so a crash cannot leave a
  partial file. The file's mode is kept, and a symbolic link keeps pointing at its file. A link that points at
  no file gets its file where it points, folders above it included. A path behind more than 16 such links is
  refused with "Too many links to follow".
- In a folder that takes no new files there can be no temporary file, so an existing file is written in
  place: over from its start, then cut to length. A crash during that write can leave a mix of old and new
  text. Creating a file there is refused.
- A file whose mode does not let the service write it is refused with "No permission to write the file". The
  rename would otherwise replace it, because a rename only needs a writable folder.
- Marked `actsForPerson`: the open item saves, and agent tools save only while Settings → General → Agents may act for you is on (MCP-ACT-01).

**`stat` action**
- Returns `{ state: 'present', modifiedAt, size }` from the file's metadata, without reading the content.

**Outside changes**
- The service has no channel that pushes to an open view, so the connector does not watch the file. The open
  view asks `stat` when it becomes active, when the window gets focus and every two seconds while it is
  active, and calls `read` when the modification time or size differs from its last read.
- A missing file shows a "File missing" status.

**Saved snapshot**
- `load` returns the path as the label and, for a missing or refused file, the reason as the error. It never
  holds the content, because the snapshot is saved in the workspace database.

**Nothing the host saves holds the content**
- The host saves two more things a connector returns: the result of a read-only action asked through
  `resource.content` (a cache row), and the context it hands to agents (a job row). `read` and `excerpt` are
  marked `uncached`, so the host runs them on every ask and saves nothing. `getContext` returns the path and
  the file's state, without the text.
- `packages/workspace-service/text-file-content.test.ts` reads a file through the service and then looks
  for its text in every file of the workspace folder.

**Other entry points**
- `getContext`: gives agents the path and the file's state. An agent reads the content at the path, or
  through the `read` and `excerpt` actions.
- `matchInput`: an absolute path is offered as this item type. The map uses it for a pasted path and a
  dropped file, see Creation.
- A path may start with `~`, which stands for the home directory.

## Creation

- "Add text file" shows two fields: File and Language.
- File is a new field kind, `file`: a typed path beside a "Choose file…" button that opens the native file
  picker (`chooseFile` on the bridge). The kind belongs to item forms; a plugin settings section refuses it,
  like `directory`.
- The path is absolute or starts with `~/`, is one line and does not end at a folder. The same rule checks
  the form, saved data and agent input.
- A typed path that does not exist yet is created on the first save.
- Language is free text and optional. It is only for a file whose name does not tell its language.
- The Name field is optional: `creation.titleFromPath` names the path field, and an item whose name is left
  empty is called after that file. This is a declared option, so the form has no branch for this item type.
- `matchInput` offers a pasted path as a text file named after the file. A line that starts with `//` or
  `/*` is not offered, because that is a comment.

**Pasted path, dropped file**
- A path pasted on the map, or a file dropped on it from the file manager, opens the "Add text file" form at
  that point with File filled in. Nothing is created until the form is submitted.
- The form opens only while a file is at the path. A path with no file, a folder and text that only looks
  like a path (`/review the change`) stay what they were: pasted text becomes a note, a dropped folder does
  nothing.
- The service decides. `plugins.discover` answers `fileCandidates` beside `urlCandidates`: the item types
  whose match fills a field of kind `file` (`registry.matchFile`), kept only while the path is a regular file
  (`existingFileCandidates`). The renderer never touches the file system and has no branch for this item type.
- When several item types take the same file, none is offered; a choice between them is not built.
- Pasted text of several lines or over 4,096 characters is never asked about.
- A drop of several files takes the first. The path of a dropped file comes from the preload script
  (`pathForFile` on the bridge); a file that is not on disk has none.

## Open view (`views.ts`, `editor.ts`)

`views.ts` holds the frame and the file's state and imports no CodeMirror. `editor.ts` holds CodeMirror and
is loaded with `import()` when a text file is first opened.

**Header**
- The item's name, then the saved path and the language ("Plain text" when none is known). "Unsaved" follows
  while edits wait for a save.
- The status reads "File missing", the reason a file is refused, or "Not saved: …" after a failed save.
- "Reveal in Finder" shows the file in the system file manager, selected. The view names the path; the main
  process expands a leading `~`, takes only one absolute path and asks the system (`revealFile` on the bridge,
  an optional view service of the same name). The button is not offered while the file is missing.

**Edit/Preview toggle**
- Every file opens in Preview. The mode is remembered per item in its view state.
- **Markdown file:** the preview is rendered with `renderMarkdown`.
  - Then the code of each `pre > code` block is replaced with `highlightCode` spans (`highlight.ts`). This
    runs after DOMPurify and writes only text and `span` elements, so the sanitiser's allow-list stays the same.
  - The sanitiser removes the `language-*` class, so each block takes the language its fence names in the
    source, read with `marked`'s lexer in the same order. A fence names a language by name, alias or file
    extension; a block without a known language stays plain.
  - A click on the rendered text switches to Edit with the caret where the click was. The place comes from
    `sourceOffsetOfPreviewText` (`preview-position.ts`): the lines of the preview's texts are looked for in
    the source one after the other up to the clicked line, so a text that occurs twice is found at its own
    occurrence, and a quoted or indented paragraph is found line by line. A text shorter than three
    characters (a table cell, a token of a code block) is taken only when it is found within 120 characters
    of the text before it, and never in a line that shows no text of its own (the row under a table's
    header, the line under a heading, a rule). A text is also found where the source writes its
    punctuation with a backslash or writes one of `&` `<` `>` `"` `'` as its entity: the source is read
    once into the form the preview shows, with the place of each character, and each line is looked for
    as plain text in that form and in the source as it is. Where both hold it at the same place the first
    is taken, so a text that ends in `&` ends after `&amp;`. A line is looked for in the 1,024 characters
    after the last text found, then four times as far each time it is not there, and in the second form
    only up to where the first holds it; a short text is looked for within its 120 characters only. A
    click in a file of 1.5 to 2 MB with 20,000 paragraphs takes 10 to 30 ms, with an entity or a backslash
    in every paragraph too. A clicked line the source holds in neither way (a numbered
    entity, `&nbsp;`) puts the caret at the end of the last text found before it. A clicked line found
    only before the texts ahead of it is taken there. When the source holds none of the preview's texts
    the caret is not moved.
  - Limits, each of which puts the caret near the click and not on it:
    - A text ahead of the click that the source holds in neither way at its own place, and as shown
      further down, moves the search past the clicked text; the caret then goes to a later occurrence of it.
    - An image is shown as the link text “Image: ” and its alternative text, which the source does not
      hold. A short text after an image on the same line can be found inside the image's alternative text
      or address.
    - A line the source holds in neither way is looked for up to the end of the file, so a file whose
      lines mostly hold such an entity is slow to click in: 0.3 s for 5,000 such lines in 230 KB.
    - A table row whose cells hold only dashes is taken for the row under the header, so a click on such
      a cell goes to the end of the last text found before it.
  - A click on a link, a button, a checkbox or a `summary` does what it did. A press that moves the pointer
    more than 4 px selects text and does not switch, and neither does a click with a modifier key held
    (Shift extends the selection), so text can still be copied from the preview.
  - The first click of a double click switches at once, so its second press lands in the editor, on other
    text than was clicked. The view keeps that press from the editor (a press counted second or later,
    within 4 px of the click that opened the editor, the third press of a triple click too), so the caret
    stays where the first click put it. A word of the preview is therefore selected by dragging, not by a
    double click.
  - Not established: whether a press on the preview's scroll bar counts as a click on the text. The test
    browser draws scroll bars over the text and takes no press on them.
- **Code file:** the preview is the highlighted, read-only CodeMirror view. Edit makes it writable. A click
  in it does not switch to Edit.
- Prose (Markdown and files without a known language) wraps long lines; code does not.

**Saving**
- The package has one setting, **Save automatically** (`settings.ts`, Settings → Items → Text file → Saving,
  on by default). The view reads it through `observePreferences` and writes nothing unasked before it has
  arrived.
- On: 600 ms after the last keystroke, on ⌘S, when switching to Preview, when the window loses focus and when
  the item closes. Off: only ⌘S.
- Each save while the item is open calls the connector's `write` with the last known version.
- A file with Windows line endings keeps them. A file that mixes both kinds gets Unix line endings on its
  first edit.

**Outside changes**
- With no unsaved edits, the editor reloads quietly. Only the changed span is replaced, so the scroll
  position stays, and the reload is not an undo step.
- With unsaved edits, a quiet bar reads "Changed on disk" (or "Deleted on disk") with Reload and Keep mine.
  "Keep mine" writes against the new `baseVersion`. Undoing the edits back to the saved text closes the bar
  and takes the disk's text, as if there had been no edits.

**Closing with edits that are not on disk**
- The host asks the view before it closes (`MountedResourceView.confirmClose`): on Esc and the close button,
  when another item takes its place, on travel to the other map layer (`ViewCloseGate` in the renderer) and
  on Quit (`apps/desktop/quit-question.ts`, asked by `lifecycle.ts` after the session warning and before
  anything stops). A reveal of an Undermap item travels first and reveals only when the travel arrived, so a
  view that keeps the person on the map is asked once.
- With Save automatically on, the view answers by saving over whatever the disk holds (`saveOverDisk`): an
  open "Changed on disk" decision is taken as Keep mine and a deleted file is written again. Only a save that
  does not reach the disk asks, with the reason: "Not saved: … Really close?". Edits typed while the closing
  save runs are saved by another save, until the text is on disk, a save fails or the file changes on disk
  again.
- The decision is `CloseQuestion` (`close-question.ts`), which knows no DOM: the view gives it the file and a
  prompt to show, hide and switch off. One closing save runs and one question is open at a time: whoever asks
  meanwhile gets the same answer. A view that is closed anyway while its closing save runs is not asked when
  the save ends. While the answer the person chose runs, the buttons are off and Cancel is ignored.
- A save or a read still running after five seconds is not waited for any longer. Service calls have no time
  limit of their own, so without this a disk that does not answer would keep the view, and a quit, from
  closing. A shown view then asks "Not saved: the save has not finished. Really close?"; a view that is not
  shown agrees, and its edits are lost at quit when that write never lands.
- Until the settings have been read the view acts as with Save automatically off: nothing is written without
  ⌘S, and a close with unsaved edits asks. A host that never delivers settings stays that way; a host without
  `observePreferences` gets the default, on.
- With it off, unsaved edits ask "Unsaved, really close?". The prompt is a bar in the view with Cancel, Close
  without saving and Save and close; Esc is Cancel. Save and close writes over a change on disk and keeps the
  bar with the reason when the save fails.
- A view that is not shown cannot ask, and agrees. A view is not asked at all when its item is archived or
  deleted or its path is edited. For those cases the file state outlives the view: `OpenTextFiles`
  (`open-file.ts`) holds one `OpenTextFile` per item and path for the window. A closing view hands its file
  over; with Save automatically on the file is saved over the disk, and it is kept while it still has unsaved
  edits.
- The next view of the item takes the kept file back with its edits, its decision and its error and checks the
  disk. It writes nothing by itself; with Save automatically on the view saves it once the setting has
  arrived. A view opened while the closing save is still writing takes the same file, so its first check runs
  after that save and never shows the text from before it.
- Editing the item's path closes the view of the old path. Its closing save names the old path and is
  refused, so the edits reach neither file; they stay kept for the old path and come back when the item
  points at it again.
- Kept edits live in the renderer only. They are gone when the app quits or the window reloads.

**Missing file**
- The view says "File missing" with the path and offers "Create file". Nothing is created before that.

**Keys and marks**
- Escape closes the item, as everywhere. While the editor has a completion list or its search panel open, the
  editor is marked `data-owns-escape`, so Escape closes that first.
- Completions show no icons: CodeMirror's are symbol characters, and icons here are pixel glyphs.
- CodeMirror draws its fold marks, its folded-code mark and the search panel's close button as characters. The
  stylesheet hides each character and draws a pixel glyph in its place (`chevron`, `chevron-right`, `more`,
  `close`), from masks `editor.ts` sets on the editor. The stock setup itself is unchanged.

## Map card

`map-card.ts` is the type's map view (`mountNode`). The host draws it at the map sizes whose preset sets
`nodeView`.

**Sizes**
- Small, the default: the file name.
- Medium: the file name and the path.
- Large: the file name and the start of the file. File content is on the map only where the person chose
  this size.

**Large card**
- A Markdown file shows the rendered start of the file, with its code blocks coloured.
- A code file shows its first lines, highlighted. A file without a known language shows them plain.
- The text fades out where the card ends, like a note.
- A missing file reads "File missing"; a refused file reads the reason.
- The text comes from the connector's `excerpt` action. It is kept in memory and never saved.
- The card is not interactive: a click on it opens the item.

**Outside changes**
- The card asks `stat` every five seconds while the window is visible, when the window gets focus and when
  the item's saved snapshot changes. It reads the excerpt again only when the modification time or size differ.

**Loading**
- `map-card.ts` imports no CodeMirror. The grammars (`language.ts`, `highlight.ts`) are loaded with `import()`
  when the first large card shows a file.

## Styles and bundle

**Colours**
- Highlighted code uses the `tok-*` classes, mapped to new token roles in `docs/design-tokens.md`: keyword,
  string, comment, number, type and heading.
- Each role gets a light and a dark value.
- New hex values go only in the token definitions, never in component CSS.

**Bundle size**
- The renderer build splits code, so the editor is not in `app.js`. Measured on 2026-11-10 by following the
  imports of the built `dist/renderer/app.js`, before the editor view (2b90bb8b) and with it:

| Loaded | Before | With the editor view |
| --- | --- | --- |
| At start: `app.js` and the chunks it imports statically | 3,714,928 bytes in 1 file | 3,711,065 bytes in 3 files (`marked` is now a chunk the editor shares) |
| At start: `app.css` | 456,420 bytes | 463,393 bytes |
| When a text file is first opened | nothing | 1,201,345 bytes in 7 files: the editor, CodeMirror, and the Markdown, HTML, CSS and JavaScript modes that Markdown needs |
| On first use of another language | nothing | that language's chunk; all lazy chunks together are 124 files, 2,641,671 bytes |

With the map card the start is 3,716,262 bytes in 4 files and `app.css` is 465,000 bytes.

## Tests

Write each test failing first.

**Connector unit tests**
- Read and write round-trip.
- A stale `baseVersion` returns a conflict.
- Binary and oversized files are refused.
- A missing file reports "File missing", is created by the first write and is not recreated against an old version.
- `stat` reports an outside change without reading the content.
- An excerpt ends at a line end within its limits and never splits a character.
- A write keeps the file's mode, leaves no temporary file and follows a symbolic link.
- The saved snapshot never holds the content.

**Creation unit tests**
- A path is matched as a file by the item type whose `file` field it fills, and a URL by none
  (`definition.test.ts`).
- A file, also under `~`, is offered; an absent file, a folder, slash text and a URL are not
  (`packages/workspace-service/file-candidates.test.ts`).

**View unit tests**
- The language is detected from the file extension.
- The language of each code block of a Markdown source, and code split into `tok-*` runs by a fence's language
  name or by the file's language (`highlight.test.ts`).
- In the e2e file: a fenced block is coloured in the preview, raw HTML and the content of a block stay inert text.

**E2E (`tests/e2e/text-editor.spec.ts`)**
- Add an item for a temporary `.md` file, edit it, and check that the file on disk changed.
- An outside write shows up in the editor.
- The conflict bar appears while there are unsaved edits.
- A `.ts` file is highlighted.
- The fold marks, the folded-code mark and the search panel's close button are drawn as pixel glyphs.
- "Reveal in Finder" hands the file's path to the main process and is hidden for a missing file. The fixture
  records the path; it never opens Finder.
- A pasted path of a file and a dropped file open the form with the path filled in, and the item is created
  on submit; a pasted path with no file and a pasted folder path become notes.
- A large card shows the first lines of a code file in its colours and follows a change and a removal on disk;
  a small card shows no content; the saved workspace state holds no file text.
- A large card shows the start of a Markdown file rendered, with raw HTML as text.

**Docs**
- An item-type entry in `docs/specification.md`, and a CHANGELOG entry.

## Order

One commit per step:

1. Add the dependencies.
2. Connector and its tests.
3. Definition and plugin glue: `act-plugin.json`, `plugin.ts`, `renderer.ts`, an entry in
   `bundled/plugins.json`, then run `node scripts/bundled-plugins.mjs`.
4. Editor view.
5. Preview highlighting.
6. Map card.
7. Colour tokens.
8. E2E tests, then the spec and CHANGELOG.

## Risks

- The service gets write access to any path the user gives it. This matches how terminals already use the
  user's working folders.
- An outside change shows up to two seconds late in the open view and up to five seconds late on a large card,
  because the views ask instead of being told.
- A close that cannot ask still keeps edits in memory only: the item is archived or deleted, or its path is
  edited, while it has edits that Save automatically could not write or, with the setting off, did not write.
  They are back when the item is opened again with the same path, nothing on the map says they exist, and
  quitting the app loses them.
- With Save automatically on, a close writes over a change another program made since the editor read the
  file, without asking. The person who wants to decide answers the "Changed on disk" bar before closing, or
  turns the setting off.
- A view whose prompt is open keeps Quit waiting without a limit. A second Quit does nothing until the
  prompt is answered.
- Notes still lose an edit typed in the 600 ms before Quit (QUIT-SAVE-PENDING-01 in `todos.md`); the quit
  question is there for them to answer.
- A save replaces the file with a new one of the same mode. Extended attributes, an access control list and
  another owner are not carried over, and other hard links to the file keep the old content.
- Between the version check and the rename, an outside write to the same file can be lost. The window is a few
  milliseconds; closing it would need a lock other programs do not honour.
