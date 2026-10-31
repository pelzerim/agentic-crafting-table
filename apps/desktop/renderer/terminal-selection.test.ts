import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiDrag, dragIsEditable, dragText, lineDeletion } from './terminal-selection.ts';

const press = (col: number, row: number) => `\x1b[<0;${col};${row}M`, move = (col: number, row: number) => `\x1b[<32;${col};${row}M`, release = (col: number, row: number) => `\x1b[<0;${col};${row}m`;
const dragged = (...reports: string[]) => { const drag = new TuiDrag(); for (const report of reports) drag.input(report); return drag; };

test('a left drag is remembered from its press to where it was released', () => {
  assert.deepEqual(dragged(press(9, 37), move(12, 37), move(14, 37), release(14, 37)).selection, { start: { col: 9, row: 37 }, end: { col: 14, row: 37 } });
  assert.deepEqual(dragged(press(9, 37), move(14, 37), `\x1b[<32;14;37M\x1b[<0;14;37m`).selection?.end, { col: 14, row: 37 }, 'reports can share a write');
});

test('a click, a wheel, another button or a new press leaves no old drag', () => {
  assert.equal(dragged(press(9, 37), release(9, 37)).selection, undefined);
  assert.equal(dragged(press(1, 1), move(5, 1), release(5, 1), '\x1b[<64;5;1M').selection, undefined);
  assert.equal(dragged('\x1b[<2;1;1M', '\x1b[<34;5;1M', '\x1b[<2;5;1m').selection, undefined);
  assert.equal(dragged(press(1, 1), move(5, 1), release(5, 1), press(2, 2)).selection, undefined);
});

test('typing ends the selection, also when it arrives with a report', () => {
  assert.equal(dragged(press(1, 1), move(5, 1), release(5, 1), 'a').selection, undefined);
  assert.equal(dragged(press(1, 1), move(5, 1), release(5, 1), `${press(1, 1)}a`).selection, undefined);
});

const buffer = (...lines: string[]) => ({ viewportY: 0, getLine: (row: number) => lines[row] === undefined ? undefined : { translateToString: (_trim?: boolean, start = 0, end?: number) => lines[row].slice(start, end) } }) as never;

test('the text comes from the dragged cells, in either direction', () => {
  const lines = buffer('› hello brave world');
  assert.equal(dragText(lines, { start: { col: 9, row: 1 }, end: { col: 14, row: 1 } }), 'brave');
  assert.equal(dragText(lines, { start: { col: 14, row: 1 }, end: { col: 9, row: 1 } }), 'brave');
});

test('a TUI that includes the cell under the pointer copies what it deletes, spaces too', () => {
  const lines = buffer('❯ hello brave world');
  assert.equal(dragText(lines, { start: { col: 9, row: 1 }, end: { col: 14, row: 1 } }, true), 'brave ');
  assert.equal(dragText(lines, { start: { col: 13, row: 1 }, end: { col: 9, row: 1 } }, true), 'brave');
});

test('a drag over rows joins them without the composer indent or trailing cells', () => {
  assert.equal(dragText(buffer('› first line   ', '  second line  ', '  third line'), { start: { col: 3, row: 1 }, end: { col: 8, row: 3 } }), 'first line\nsecond line\nthird');
});

test('only a drag that ended on the cursor row can be deleted', () => {
  const drag = { start: { col: 9, row: 37 }, end: { col: 14, row: 37 } };
  assert.equal(dragIsEditable({ cursorY: 36 }, drag), true);
  assert.equal(dragIsEditable({ cursorY: 36 }, { start: { col: 10, row: 5 }, end: { col: 30, row: 5 } }), false, 'transcript');
});

const edited = (text: string, cursorX: number, cursorY = 0) => ({ baseY: 0, cursorX, cursorY, getLine: () => ({ translateToString: (_trim?: boolean, start = 0, end?: number) => text.slice(start, end) }) }) as never;
const range = (startX: number, endX: number, y = 0) => ({ start: { x: startX, y }, end: { x: endX, y } });
const keys = { left: 'L', right: 'R' };

test('a selection on the edited line is reached by arrows and erased', () => {
  assert.equal(lineDeletion(edited('$ echo hello brave world', 24), range(13, 18), 'brave', keys), 'LLLLLL\x7f\x7f\x7f\x7f\x7f');
  assert.equal(lineDeletion(edited('$ echo hello brave world', 2), range(13, 18), 'brave', keys), 'RRRRRRRRRRRRRRRR\x7f\x7f\x7f\x7f\x7f');
  assert.equal(lineDeletion(edited('$ echo brave', 12), range(7, 12), 'brave', keys), '\x7f\x7f\x7f\x7f\x7f', 'the cursor is already there');
});

test('keys count characters, so emoji take one press each', () => {
  assert.equal(lineDeletion(edited('😀😀', 2), range(0, 2), '😀😀', keys), '\x7f\x7f');
  assert.equal(lineDeletion(edited('ab😀', 4), range(0, 2), 'ab', keys), 'L\x7f\x7f');
});

test('a selection off the edited line cannot be removed', () => {
  assert.equal(lineDeletion(edited('output', 0, 3), range(0, 6, 1), 'output', keys), undefined);
  assert.equal(lineDeletion(edited('prompt', 0, 3), { start: { x: 0, y: 2 }, end: { x: 3, y: 3 } }, 'x', keys), undefined, 'starts on an earlier row');
  assert.equal(lineDeletion({ ...(edited('prompt', 2, 3) as object), baseY: 10 } as never, range(0, 2, 13), 'pr', keys), '\x7f\x7f', 'rows count from the top of the scrollback');
});

