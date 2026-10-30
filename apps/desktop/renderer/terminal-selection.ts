import type { Terminal } from '@xterm/xterm';

export interface TerminalCell { col: number; row: number }
export interface TerminalDrag { start: TerminalCell; end: TerminalCell }

const MOUSE_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** The last drag a TUI that owns the mouse received. Only the TUI knows its selection, so the
 * reports xterm sends it are the one record of what was selected; any other input ends it. */
export class TuiDrag {
  private press?: TerminalCell;
  private last?: TerminalCell;
  private finished?: TerminalDrag;
  input(data: string) {
    const reports = [...data.matchAll(MOUSE_REPORT)];
    if (!reports.length || reports.map(report => report[0]).join('') !== data) { this.clear(); return; }
    for (const [, code, col, row, state] of reports) {
      const button = Number(code), cell = { col: Number(col), row: Number(row) };
      if (button >= 64 || (button & 3) !== 0) { this.clear(); continue; }
      if (state === 'm') {
        const end = this.press && (button & 32 ? this.last : cell);
        if (this.press && end && (end.col !== this.press.col || end.row !== this.press.row)) this.finished = { start: this.press, end };
        this.press = this.last = undefined;
      } else if (button & 32) this.last = cell;
      else { this.press = cell; this.last = undefined; this.finished = undefined; }
    }
  }
  get selection() { return this.finished; }
  clear() { this.press = this.last = this.finished = undefined; }
}

type Buffer = Pick<Terminal['buffer']['active'], 'viewportY' | 'getLine'>;

/** The text a drag covered, in reading order. Later rows drop the composer's indent. */
export function dragText(buffer: Buffer, drag: TerminalDrag) {
  const [first, last] = drag.start.row < drag.end.row || (drag.start.row === drag.end.row && drag.start.col <= drag.end.col) ? [drag.start, drag.end] : [drag.end, drag.start];
  const rows: string[] = [];
  for (let row = first.row; row <= last.row; row++) {
    const text = buffer.getLine(buffer.viewportY + row - 1)?.translateToString(true, row === first.row ? first.col - 1 : 0, row === last.row ? last.col - 1 : undefined) ?? '';
    rows.push(row === first.row ? text.trimEnd() : text.trim());
  }
  return rows.join('\n');
}

/** A drag in the composer moves the TUI's cursor onto the row where it ended; a drag in the
 * transcript leaves the cursor in the composer, where a delete would hit unselected text. */
export const dragIsEditable = (buffer: Pick<Terminal['buffer']['active'], 'cursorY'>, drag: TerminalDrag) => buffer.cursorY + 1 === drag.end.row;
