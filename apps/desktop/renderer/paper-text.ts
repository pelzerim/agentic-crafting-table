/** A replacement of `from..to` with `insert`, then the selection to restore. */
export interface TextChange { from: number; to: number; insert: string; start: number; end: number }

const space = (char: string) => /\s/.test(char);

/** Maps a caret in rendered text back to the source: `prefix` is the rendered text
 * before the caret and `next` the first visible character after it. Markdown syntax
 * never renders, so it is skipped; a caret at a gap lands just before the next word. */
export function sourceOffset(source: string, prefix: string, next: string | undefined): number {
  const visible = Array.from(prefix).filter(char => !space(char));
  const atGap = !visible.length || space(Array.from(prefix).at(-1)!);
  let matched = 0, offset = 0;
  for (const char of source) {
    if (matched === visible.length) {
      if (!atGap) return offset;
      if (next === undefined || char === next) return offset;
    } else if (!space(char) && char === visible[matched]) matched++;
    offset += char.length;
  }
  return source.length;
}

function lineRange(text: string, start: number, end: number) {
  const from = text.lastIndexOf('\n', start - 1) + 1, after = text.indexOf('\n', end);
  return { from, to: after < 0 ? text.length : after };
}

const TASK = /^(\s*)[-*+] \[[ xX]\] /, BULLET = /^(\s*)[-*+] /, LIST = /^\s*(?:[-*+]|\d+[.)])\s/;

/** ⌘⇧7: every touched line becomes a checklist item, or stops being one when all are. */
export function toggleChecklist(text: string, start: number, end: number): TextChange {
  const { from, to } = lineRange(text, start, end), lines = text.slice(from, to).split('\n');
  const removing = lines.every(line => TASK.test(line));
  let cursor = from, startShift = 0, endShift = 0;
  const changed = lines.map(line => {
    const next = removing ? line.replace(TASK, '$1') : TASK.test(line) ? line : BULLET.test(line) ? line.replace(BULLET, '$1- [ ] ') : line.replace(/^(\s*)/, '$1- [ ] ');
    const shift = next.length - line.length;
    if (cursor <= start) startShift += shift;
    if (cursor <= end) endShift += shift;
    cursor += line.length + 1;
    return next;
  });
  const clamp = (value: number, shift: number) => Math.max(from, value + shift);
  return { from, to, insert: changed.join('\n'), start: clamp(start, startShift), end: clamp(end, endShift) };
}

/** Tab and ⇧Tab on list lines; elsewhere they leave the note so focus is never trapped. */
export function indentList(text: string, start: number, end: number, outdent: boolean): TextChange | undefined {
  const { from, to } = lineRange(text, start, end), lines = text.slice(from, to).split('\n');
  if (!lines.every(line => LIST.test(line))) return;
  if (outdent && !lines.some(line => line.startsWith(' '))) return;
  let cursor = from, startShift = 0, endShift = 0;
  const changed = lines.map(line => {
    const next = outdent ? line.replace(/^ {1,2}/, '') : `  ${line}`, shift = next.length - line.length;
    if (cursor <= start) startShift += shift;
    if (cursor <= end) endShift += shift;
    cursor += line.length + 1;
    return next;
  });
  return { from, to, insert: changed.join('\n'), start: Math.max(from, start + startShift), end: Math.max(from, end + endShift) };
}

/** ⌘B and ⌘I wrap the selection in `**` or `_`. */
export function wrapSelection(text: string, start: number, end: number, marker: string): TextChange {
  return { from: start, to: end, insert: marker + text.slice(start, end) + marker, start: start + marker.length, end: end + marker.length };
}

/** Task lines in source order, as GFM renders their checkboxes; fenced code holds none. */
function taskLines(text: string) {
  const found: { start: number; mark: number; done: boolean }[] = [];
  let fenced = false, start = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const match = /^(\s*[-*+] \[)([ xX])\] /.exec(line);
      if (match) found.push({ start, mark: start + match[1].length, done: match[2] !== ' ' });
    }
    start += line.length + 1;
  }
  return found;
}

/** Ticking the `index`-th rendered checkbox flips the same `[ ]` in the source. */
export function toggleTask(text: string, index: number) {
  const task = taskLines(text)[index];
  return task ? text.slice(0, task.mark) + (task.done ? ' ' : 'x') + text.slice(task.mark + 1) : text;
}

export function taskProgress(text: string) {
  const tasks = taskLines(text);
  return { done: tasks.filter(task => task.done).length, total: tasks.length };
}

/** Applies a change as one native edit, so ⌘Z undoes it like typing. */
export function applyTextChange(editor: HTMLTextAreaElement, change: TextChange) {
  editor.focus();
  editor.setSelectionRange(change.from, change.to);
  const document = editor.ownerDocument;
  if (!(change.insert ? document.execCommand('insertText', false, change.insert) : document.execCommand('delete'))) {
    editor.setRangeText(change.insert, change.from, change.to, 'end');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  editor.setSelectionRange(change.start, change.end);
}
