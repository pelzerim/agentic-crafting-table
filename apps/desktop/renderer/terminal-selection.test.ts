import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiDrag, dragIsEditable, dragText } from './terminal-selection.ts';

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

test('a drag over rows joins them without the composer indent or trailing cells', () => {
  assert.equal(dragText(buffer('› first line   ', '  second line  ', '  third line'), { start: { col: 3, row: 1 }, end: { col: 8, row: 3 } }), 'first line\nsecond line\nthird');
});

test('only a drag that ended on the cursor row can be deleted', () => {
  const drag = { start: { col: 9, row: 37 }, end: { col: 14, row: 37 } };
  assert.equal(dragIsEditable({ cursorY: 36 }, drag), true);
  assert.equal(dragIsEditable({ cursorY: 36 }, { start: { col: 10, row: 5 }, end: { col: 30, row: 5 } }), false, 'transcript');
});
