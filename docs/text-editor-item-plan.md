# Text editor item: plan (not started)

Status: planned 2026-11-09, not implemented. Tracked as TEXT-EDITOR-01 in [todos](todos.md).

A new item type, `workspace.text`, that edits a file on disk with code highlighting and Markdown preview.
No autocomplete. Use existing libraries only; reimplement nothing.

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
| Editor and highlighting | CodeMirror 6: `@codemirror/state`, `view`, `commands`, `language`, `lang-markdown`, `language-data` | Modular; it adds no autocomplete unless that package is included. |
| Markdown preview | `marked` + DOMPurify, through `renderMarkdown` in `src/resource-plugins/markdown-view.ts` | Already bundled and sanitised. |
| Highlighting in the preview | `@lezer/highlight` `highlightCode` + `classHighlighter` | Same grammars as the editor, so both colour code the same way. |

Not chosen:
- **Monaco:** about 5 MB, and its IntelliSense is hard to turn off fully.
- **TipTap / Milkdown:** they edit rendered text (WYSIWYG), not source.
- **highlight.js / Shiki:** a second highlighter that would colour code differently from the editor.

**No autocomplete:** build the editor from an explicit list of extensions, not `basicSetup`:
- `history` and the default keymap;
- line numbers and the active-line highlight;
- `bracketMatching`;
- `markdown({ codeLanguages: languages })`, or the file's own language;
- `syntaxHighlighting(classHighlighter)`.

`@codemirror/autocomplete` is never installed.

## Service connector (`connector.ts`)

File I/O stays in the service, never in the renderer.

**`read` action**
- Returns `{ text, version }`, where `version` is the file's mtime plus a sha256 of its content.
- Refuses binary files (content that is not UTF-8), files over about 2 MB, and paths that are not regular files.

**`write` action**
- Takes `{ text, baseVersion }` and writes only if the file on disk still has `baseVersion`.
- Otherwise it returns `conflict` with the text now on disk.
- Writes go to a temporary file that is then renamed over the original, so a crash cannot leave a partial file.

**Status subscription**
- An `fs.watch` on the file pushes changes to the view.
- macOS can report one change twice, or report a rename instead of a change. Debounce events and check the file
  again before acting.
- A missing file shows a "File missing" status.

**Other entry points**
- `getContext`: gives agents the path and the content.
- `matchInput`: pasting or dropping an absolute path onto the map creates the item.

## Creation

- "Add text file" opens a picker. Check how the `directory` field kind opens its dialog; this may need a new
  `kind: 'file'`.
- A typed path that does not exist yet is created on the first save.

## Open view (`views.ts`)

**Header**
- File name, language, and a link that reveals the file in Finder.

**Edit/Preview toggle**
- **Markdown file:** Preview by default.
  - Rendered with `renderMarkdown`.
  - Then each `pre > code.language-*` in the sanitised result has its text replaced with `highlightCode` spans.
  - This runs after DOMPurify, so the sanitiser's allow-list stays the same.
- **Code file:** the preview is the highlighted, read-only CodeMirror view. Edit makes it writable.

**Saving**
- Debounced while typing, on ⌘S, and when leaving the item. Each save calls the connector's `write` with the
  last known version.

**Outside changes**
- With no unsaved edits, the editor reloads quietly.
- With unsaved edits, a quiet bar reads "Changed on disk: Reload / Keep mine". "Keep mine" writes against the
  new `baseVersion`.

## Map card

- A Markdown file shows the rendered start of the file, faded at the bottom like a note.
- A code file shows its first lines, highlighted.
- The text comes from the connector's snapshot. It is kept in memory and never saved.

## Styles and bundle

**Colours**
- Highlighted code uses the `tok-*` classes, mapped to new token roles in `docs/design-tokens.md`: keyword,
  string, comment, number, type and heading.
- Each role gets a light and a dark value.
- New hex values go only in the token definitions, never in component CSS.

**Bundle size**
- `language-data` loads languages with dynamic `import()`.
- If the esbuild setup does not split code, import a fixed set of languages instead: ts/js, json, yaml,
  python, go, sql, shell, css, html and markdown. That adds about 300–400 KB.

## Tests

Write each test failing first.

**Connector unit tests**
- Read and write round-trip.
- A stale `baseVersion` returns a conflict.
- Binary and oversized files are refused.
- A missing file reports "File missing".
- The watcher fires on an outside change.

**View unit tests**
- The language is detected from the file extension.
- The editor's extensions include no autocomplete.
- A fenced ```` ```ts ```` block is highlighted into `tok-*` spans in the preview.
- Raw HTML stays inert text.

**E2E (`tests/e2e/text-editor.spec.ts`)**
- Add an item for a temporary `.md` file, edit it, and check that the file on disk changed.
- An outside write shows up in the editor.
- The conflict bar appears while there are unsaved edits.
- A `.ts` file is highlighted.
- No `.cm-tooltip-autocomplete` element appears.

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
- File watching on macOS is unreliable. Debounce events and check the file again before acting.
