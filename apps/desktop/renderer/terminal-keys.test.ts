import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalKey } from './terminal-keys.ts';

function fixture() {
  const sent: string[] = [];
  const terminal = { options: { disableStdin: false, ignoreBracketedPasteMode: false }, modes: { bracketedPasteMode: true, mouseTrackingMode: 'none' as string }, hasSelection: () => false, paste: (s: string) => sent.push(`paste:${s}`), input: (s: string) => sent.push(s) };
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
test('Cmd+C reaches a mouse-owning agent as super+c, and stays native for shells, other mouse apps or a terminal selection', () => {
  const { terminal, event, sent } = fixture();
  const cmdC = { key: 'c', metaKey: true, shiftKey: false, keyCode: 67 };
  assert.equal(terminalKey(terminal, event(cmdC), true), true);
  (terminal.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'drag';
  assert.equal(terminalKey(terminal, event(cmdC)), true, 'vim or tmux in a plain terminal never gets the bytes');
  assert.equal(terminalKey(terminal, event(cmdC), true), false);
  terminalKey(terminal, event({ ...cmdC, type: 'keyup' }), true);
  assert.deepEqual(sent, ['\x1b[99;9u']);
  terminal.hasSelection = () => true;
  assert.equal(terminalKey(terminal, event(cmdC), true), true);
  assert.equal(sent.length, 1);
});
test('Cmd+Backspace, Cmd+Left and Cmd+Right send the line-editing control keys once', () => {
  const { terminal, event, sent } = fixture();
  for (const key of ['Backspace', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(terminalKey(terminal, event({ key, metaKey: true, shiftKey: false })), false);
    terminalKey(terminal, event({ key, metaKey: true, shiftKey: false, type: 'keyup' }));
  }
  assert.deepEqual(sent, ['\x15', '\x01', '\x05']);
  sent.length = 0; (terminal.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'drag';
  for (const key of ['Backspace', 'ArrowLeft', 'ArrowRight', 'c']) for (const composing of [{ isComposing: true }, { keyCode: 229 }]) assert.equal(terminalKey(terminal, event({ key, metaKey: true, shiftKey: false, ...composing }), true), true, `${key} stays with the IME`);
  assert.deepEqual(sent, [], 'a composition sends nothing to the terminal');
});
test('Cmd+F opens the find bar instead of reaching the terminal, and plain F still types', () => {
  const { terminal, event, sent } = fixture();
  let opened = 0;
  const cmdF = { key: 'f', metaKey: true, shiftKey: false, keyCode: 70 };
  assert.equal(terminalKey(terminal, event(cmdF), true, () => opened++), false);
  terminalKey(terminal, event({ ...cmdF, type: 'keyup' }), false, () => opened++);
  assert.equal(opened, 1);
  assert.equal(terminalKey(terminal, event({ key: 'f', shiftKey: false, keyCode: 70 }), false, () => opened++), true);
  assert.deepEqual(sent, []); assert.equal(opened, 1);
});

test('the cut key is taken only when something was cut, and modified keys stay keys', () => {
  const { terminal } = fixture(), key = (init: Record<string, unknown>) => { const calls: string[] = []; const event = { type: 'keydown', key: 'x', keyCode: 88, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => calls.push('prevent'), stopPropagation: () => {}, ...init } as unknown as KeyboardEvent; return { event, calls }; };
  const mac = /Mac/.test(navigator.platform), cutKey = mac ? { metaKey: true } : { ctrlKey: true }, otherKey = mac ? { ctrlKey: true } : { metaKey: true };
  const notACut = () => { throw new Error('not a cut'); };
  const pressed = key(cutKey), taken = terminalKey(terminal, pressed.event, true, undefined, false, () => true);
  assert.equal(taken, false); assert.deepEqual(pressed.calls, ['prevent']);
  assert.equal(terminalKey(terminal, key(cutKey).event, true, undefined, false, () => false), true, 'nothing selected: xterm sends the key');
  assert.equal(terminalKey(terminal, key(otherKey).event, true, undefined, false, notACut), true, 'the other platform\'s modifier stays a key');
  assert.equal(terminalKey(terminal, key({ ...cutKey, shiftKey: true }).event, true, undefined, false, notACut), true);
  assert.equal(terminalKey(terminal, key({ ...cutKey, type: 'keyup' }).event, true, undefined, false, notACut), true);
});
