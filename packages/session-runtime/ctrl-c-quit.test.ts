import test from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_C_QUIT_MS, ctrlCQuit } from './ctrl-c-quit.ts';

test('an exit right after a typed Ctrl+C is a Ctrl+C quit, in either encoding', () => {
  for (const key of ['\x03', '\x1b[99;5u']) {
    const keys = ctrlCQuit();
    keys.typed('hello', 1000); keys.typed(key, 2000);
    assert.equal(keys.quit(2010), true, JSON.stringify(key));
    assert.equal(keys.quit(2000 + CTRL_C_QUIT_MS), false, 'an exit long after the press has another cause');
  }
});

test('an exit after something else was typed is not a Ctrl+C quit', () => {
  const keys = ctrlCQuit();
  assert.equal(keys.quit(0), false, 'nothing typed');
  keys.typed('\x03', 1000); keys.typed('/exit\r', 1200);
  assert.equal(keys.quit(1300), false, '/exit after a Ctrl+C still quits');
});

test('mouse, focus, cursor and colour reports are not typing', () => {
  const keys = ctrlCQuit();
  keys.typed('\x03', 1000);
  for (const report of ['\x1b[<35;10;5M', '\x1b[<0;3;4m\x1b[<0;3;4M', '\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b]11;rgb:0000/0000/0000\x1b\\']) keys.typed(report, 1100);
  assert.equal(keys.quit(1200), true);
});
