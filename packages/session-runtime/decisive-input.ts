const PASTE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g;
const SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\r/g;
const ENTER_KEY = '\x1b[13u', ESCAPE_KEY = '\x1b[27u';

/** Whether keys typed into a terminal could have answered a dialog an agent CLI
 * shows: Enter, a lone Escape, or a single digit (Claude's dialogs take 1/2/3).
 * Typing, arrow keys, Alt+Enter, pasted text and the terminal's own replies to
 * the program (cursor, colour, focus and mouse reports) decide nothing. */
export function isDecisiveInput(data: string) {
  if (data === '\x1b' || data === ESCAPE_KEY) return true;
  const typed = data.replace(PASTE, '').replace(SEQUENCE, sequence => sequence === ENTER_KEY ? '\r' : '');
  return typed.includes('\r') || /^[0-9]$/.test(typed);
}
