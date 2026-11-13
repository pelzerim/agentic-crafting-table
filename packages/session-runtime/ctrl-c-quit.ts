/** Claude Code and Codex quit on a second Ctrl+C; they do so at once, so a later exit has another cause. */
export const CTRL_C_QUIT_MS = 2000;

/** The control byte, or the CSI u form a keyboard protocol sends. */
const CTRL_C = /^(?:\x03|\x1b\[99;5(?::\d+)*u)$/;
/** Replies the terminal sends for the program: mouse, focus, cursor position and colour reports. */
const REPORTS = /^(?:\x1b\[<\d+;\d+;\d+[mM]|\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

/** Tells whether a process quit on a Ctrl+C the person typed: the last key before the exit was
 * Ctrl+C, pressed just before it. `/exit` or anything else typed after the press is a choice to quit. */
export function ctrlCQuit() {
  let last: { ctrlC: boolean; at: number } | undefined;
  return {
    typed(data: string, at: number) { if (!REPORTS.test(data)) last = { ctrlC: CTRL_C.test(data), at }; },
    quit(at: number) { return Boolean(last?.ctrlC && at - last.at < CTRL_C_QUIT_MS); },
  };
}
