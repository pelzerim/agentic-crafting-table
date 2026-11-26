import test from 'node:test';
import assert from 'node:assert/strict';
import { findStep, isFindKey, terminalKey } from './terminal-keys.ts';

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

test('the find key is ⌘F on macOS; elsewhere Ctrl+Shift+F in every terminal and Ctrl+F in an agent', () => {
  const key = (fields: Partial<KeyboardEvent>) => ({ key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...fields }) as KeyboardEvent;
  assert.equal(isFindKey(key({ metaKey: true }), false, true), true, '⌘F on macOS');
  assert.equal(isFindKey(key({ ctrlKey: true }), true, true), false, 'Ctrl+F on macOS stays forward-char');
  assert.equal(isFindKey(key({ ctrlKey: true }), true, false), true, 'Ctrl+F in an agent');
  assert.equal(isFindKey(key({ ctrlKey: true }), false, false), false, 'a shell keeps Ctrl+F');
  assert.equal(isFindKey(key({ key: 'F', ctrlKey: true, shiftKey: true }), false, false), true, 'Ctrl+Shift+F in a shell');
  assert.equal(isFindKey(key({ ctrlKey: true, altKey: true }), true, false), false);
  assert.equal(isFindKey(key({}), true, false), false, 'plain F types');
});

test('Ctrl+F in an agent opens find on Linux and Windows instead of reaching the process', () => {
  const { terminal, event, sent } = fixture();
  if (/Mac/.test(navigator.platform)) return;
  let opened = 0;
  const ctrlF = { key: 'f', ctrlKey: true, shiftKey: false, keyCode: 70 };
  assert.equal(terminalKey(terminal, event(ctrlF), true, () => opened++), false);
  assert.equal(opened, 1);
  assert.equal(terminalKey(terminal, event(ctrlF), false, () => opened++), true, 'a shell gets Ctrl+F');
  assert.equal(terminalKey(terminal, event({ ...ctrlF, key: 'F', shiftKey: true }), false, () => opened++), false);
  assert.equal(opened, 2); assert.deepEqual(sent, []);
});

test('the find bar steps with Enter, the arrows, F3 and the platform Find Next key', () => {
  const key = (key: string, fields: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...fields }) as KeyboardEvent;
  for (const mac of [true, false]) {
    assert.equal(findStep(key('Enter'), mac), 'next'); assert.equal(findStep(key('Enter', { shiftKey: true }), mac), 'previous');
    assert.equal(findStep(key('ArrowDown'), mac), 'next'); assert.equal(findStep(key('ArrowUp'), mac), 'previous');
    assert.equal(findStep(key('F3'), mac), 'next'); assert.equal(findStep(key('F3', { shiftKey: true }), mac), 'previous');
    assert.equal(findStep(key('g', { metaKey: true }), mac), 'next'); assert.equal(findStep(key('G', { metaKey: true, shiftKey: true }), mac), 'previous');
    assert.equal(findStep(key('g'), mac), undefined); assert.equal(findStep(key('ArrowDown', { shiftKey: true }), mac), undefined, 'Shift+arrow selects text');
    assert.equal(findStep(key('Enter', { altKey: true }), mac), undefined);
  }
  assert.equal(findStep(key('g', { ctrlKey: true }), false), 'next'); assert.equal(findStep(key('G', { ctrlKey: true, shiftKey: true }), false), 'previous');
  assert.equal(findStep(key('g', { ctrlKey: true }), true), undefined, 'Ctrl+G is not Find Next on macOS');
});
