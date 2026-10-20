import app from '../../package.json' with { type: 'json' };

/** XTVERSION name: the app, as a terminal program names itself, not the
 * emulator library inside it. Claude keys a wheel profile made for VS Code on
 * the name `xterm.js`: no acceleration and a drain that throttles fast
 * gestures to a few rows per frame and then jumps. Under its own name the app
 * gets the profile Claude uses in native terminals. */
export const terminalIdentity = `${app.build.productName}(${app.version})`;
export const versionReply = `\x1bP>|${terminalIdentity}\x1b\\`;
export const modeReply = (mode: number, status: number) => `\x1b[?${mode};${status}$y`;

/** A CLI that learns pixel mouse reports are available switches to them and
 * needs the cell size to find the row under the pointer. The cell-size report
 * is whole pixels while the app's cells are fractional, so the mode is declined
 * and coordinates stay exact cells. */
export const PIXEL_MOUSE = 1016;
const SYNCHRONIZED_OUTPUT = 2026;

const PROBE = /\x1b\[(?:>0?q|\?(\d+)\$p|0?c)/g;
const SEQUENCE_START = /\x1b(?:\[[0-?]*[ -/]*)?$/;

/** A CLI probes its terminal once, at startup. The emulator lives in a view, and
 * an agent started without one (app start, background launch) would hear nothing
 * and keep its unknown-terminal behaviour for the life of the process. This gives
 * the answers the app's emulator gives, for the supervisor to send while no view
 * is watching the session. */
export class HeadlessTerminal {
  private carry = '';
  feed(data: string) {
    const text = this.carry + data;
    let replies = '';
    for (const match of text.matchAll(PROBE)) {
      if (match[0].endsWith('q')) replies += versionReply;
      else if (match[0].endsWith('c')) replies += '\x1b[?1;2c';
      else if (Number(match[1]) === SYNCHRONIZED_OUTPUT) replies += modeReply(SYNCHRONIZED_OUTPUT, 2);
      else if (Number(match[1]) === PIXEL_MOUSE) replies += modeReply(PIXEL_MOUSE, 0);
    }
    const partial = SEQUENCE_START.exec(text.slice(-16));
    this.carry = partial ? partial[0] : '';
    return replies;
  }
}
