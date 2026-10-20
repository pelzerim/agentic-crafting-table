import type { Terminal } from '@xterm/xterm';

/** Agents interpret the modified key themselves. Shell line editors receive a
 * bracketed newline so neither line executes until ordinary Enter. */
export function terminalKey(terminal: Pick<Terminal, 'options' | 'paste' | 'input'> & { modes: Pick<Terminal['modes'], 'bracketedPasteMode'> }, event: KeyboardEvent, nativeShiftEnter = false) {
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return true;
  event.preventDefault(); event.stopPropagation();
  if (event.type === 'keydown' && !terminal.options.disableStdin) {
    if (!nativeShiftEnter && terminal.modes.bracketedPasteMode && !terminal.options.ignoreBracketedPasteMode) terminal.paste('\n');
    else terminal.input('\x1b[13;2u', true);
  }
  return false;
}
