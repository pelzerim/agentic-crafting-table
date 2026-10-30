const restorable = new Set([1, 6, 7, 25, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);
const alternate = new Set([47, 1047, 1049]);
const enabledByDefault = new Set([7, 25]);
const control = /\x1b(?:\[\?([\d;]*)([hl])|\[(\d*(?:;\d*)?)r|\[!p|([=>c]))/g;

/**
 * Tracks the terminal modes that skipped output leaves behind, so a replay that
 * starts later can restore input encoding, cursor visibility, screen buffer and
 * scroll region before its first byte.
 */
export class TerminalModes {
  private modes = new Map<number, boolean>();
  private screen?: number;
  private region = '';
  private keypad = false;
  private carry = '';
  scan(text: string) {
    const data = this.carry + text;
    let consumed = 0;
    for (const match of data.matchAll(control)) {
      consumed = match.index + match[0].length;
      const [, privateModes, action, region, single] = match;
      if (privateModes !== undefined) {
        for (const value of privateModes.split(';').map(Number)) {
          if (alternate.has(value)) this.screen = action === 'h' ? value : undefined;
          else if (restorable.has(value)) this.modes.set(value, action === 'h');
        }
      } else if (region !== undefined) this.region = region;
      else if (single === '=') this.keypad = true;
      else if (single === '>') this.keypad = false;
      else if (single === 'c') { this.modes.clear(); this.screen = undefined; this.region = ''; this.keypad = false; }
      else { for (const value of [1, 6, 7, 25, 66]) this.modes.delete(value); this.region = ''; this.keypad = false; }
    }
    const escape = data.lastIndexOf('\x1b');
    this.carry = escape >= consumed && data.length - escape < 32 ? data.slice(escape) : '';
  }
  clone() {
    const copy = new TerminalModes();
    Object.assign(copy, this, { modes: new Map(this.modes) });
    return copy;
  }
  prefix() {
    let text = this.screen ? `\x1b[?${this.screen}h` : '';
    for (const [mode, enabled] of [...this.modes].sort(([a], [b]) => a - b)) {
      if (enabled !== enabledByDefault.has(mode)) text += `\x1b[?${mode}${enabled ? 'h' : 'l'}`;
    }
    if (this.region && this.region !== ';') text += `\x1b[${this.region}r`;
    if (this.keypad) text += '\x1b=';
    return text;
  }
}

const reset = /\x1bc|\x1b\[[23]J|\x1b\[\?(?:47|1047|1049)[hl]/;

/** Earliest point in a window where replay can begin without depending on its earlier screen: a full reset, else a whole
 * line, else the next escape sequence. */
export function restartOffset(text: string) {
  const boundary = text.search(reset);
  if (boundary >= 0) return boundary;
  const line = text.indexOf('\n');
  if (line >= 0 && line + 1 < text.length) return line + 1;
  // A screen drawn by cursor moves has no lines: begin at its next escape sequence, never inside one.
  const escape = text.indexOf('\x1b');
  return escape > 0 ? escape : 0;
}
