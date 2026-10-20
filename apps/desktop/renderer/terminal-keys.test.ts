import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalKey } from './terminal-keys.ts';

function fixture() {
  const sent: string[] = [];
  const terminal = { options: { disableStdin: false, ignoreBracketedPasteMode: false }, modes: { bracketedPasteMode: true }, paste: (s: string) => sent.push(`paste:${s}`), input: (s: string) => sent.push(s) };
  const event = (fields: Partial<KeyboardEvent> = {}) => ({ type: 'keydown', key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, preventDefault() {}, stopPropagation() {}, ...fields }) as KeyboardEvent;
  return { sent, terminal: terminal as Parameters<typeof terminalKey>[0], event };
}
test('Shift+Enter inserts literal newline through paste without emitting a submit key', () => {
  const { terminal, event, sent } = fixture();
  assert.equal(terminalKey(terminal, event()), false);
  assert.deepEqual(sent, ['paste:\n']);
  terminalKey(terminal, event({ type: 'keypress' })); terminalKey(terminal, event({ type: 'keyup' }));
  assert.equal(sent.length, 1);
});
test('without bracketed paste Shift+Enter reports a distinct key, and read-only consumes it without input', () => {
  const { terminal, event, sent } = fixture();
  terminal.options.ignoreBracketedPasteMode = true;
  terminalKey(terminal, event()); assert.deepEqual(sent, ['\x1b[13;2u']);
  terminal.options.disableStdin = true; terminalKey(terminal, event()); assert.equal(sent.length, 1);
});
test('agent input sends the native Shift+Enter key even when bracketed paste is enabled', () => {
  const { terminal, event, sent } = fixture();
  terminalKey(terminal, event(), true);
  assert.deepEqual(sent, ['\x1b[13;2u']);
  terminal.options.disableStdin = true;
  terminalKey(terminal, event(), true);
  assert.equal(sent.length, 1);
});
test('Enter, composition and other modifier combinations retain native key processing', () => {
  const { terminal, event, sent } = fixture();
  for (const fields of [{ shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { key: 'a' }]) assert.equal(terminalKey(terminal, event(fields)), true);
  assert.deepEqual(sent, []);
});
