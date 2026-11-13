import type { Terminal } from '@xterm/xterm';

const CMD_LINE_KEYS: Record<string, string> = { Backspace: '\x15', ArrowLeft: '\x01', ArrowRight: '\x05' };

/** Agents interpret the modified key themselves. Shell line editors receive a
 * bracketed newline so neither line executes until ordinary Enter. */
export function terminalKey(terminal: Pick<Terminal, 'options' | 'paste' | 'input' | 'hasSelection'> & { modes: Pick<Terminal['modes'], 'bracketedPasteMode' | 'mouseTrackingMode'> }, event: KeyboardEvent, agent = false, find?: () => void, browserPaste = false, cut?: () => boolean) {
  // An IME composition keeps every key.
  if (event.isComposing || event.keyCode === 229) return true;
  if (event.key === 'f' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    event.preventDefault(); event.stopPropagation();
    if (event.type === 'keydown') find?.();
    return false;
  }
  // An agent TUI that owns the mouse keeps its own selection and reads Cmd+C as a CSI u super+c key; other apps would misread those bytes.
  if (agent && event.key === 'c' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && terminal.modes.mouseTrackingMode !== 'none' && !terminal.hasSelection()) {
    event.preventDefault(); event.stopPropagation();
    if (event.type === 'keydown' && !terminal.options.disableStdin) terminal.input('\x1b[99;9u', true);
    return false;
  }
  // Ctrl+X on macOS and Cmd+X elsewhere stay what they are; without a selection so does the cut key, a prefix in shells and agents.
  const cutKey = /Mac/.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (cut && cutKey && event.type === 'keydown' && event.key.toLowerCase() === 'x' && !event.altKey && !event.shiftKey && cut()) {
    event.preventDefault(); event.stopPropagation();
    return false;
  }
  // Sending Ctrl+V as a key would make the agent read the desktop clipboard itself, which fails on text.
  // Left uncancelled, the browser pastes instead; the terminal's paste handling takes it from there.
  if (browserPaste && !terminal.options.disableStdin && event.type === 'keydown' && event.key.toLowerCase() === 'v' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    event.stopPropagation();
    return false;
  }
  // Line-editing Cmd keys send what iTerm2 and Terminal.app send.
  const lineKey = CMD_LINE_KEYS[event.key];
  if (lineKey && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    event.preventDefault(); event.stopPropagation();
    if (event.type === 'keydown' && !terminal.options.disableStdin) terminal.input(lineKey, true);
    return false;
  }
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return true;
  event.preventDefault(); event.stopPropagation();
  if (event.type === 'keydown' && !terminal.options.disableStdin) {
    if (!agent && terminal.modes.bracketedPasteMode && !terminal.options.ignoreBracketedPasteMode) terminal.paste('\n');
    else terminal.input('\x1b[13;2u', true);
  }
  return false;
}
