import test from 'node:test';
import assert from 'node:assert/strict';
import { isDecisiveInput } from './decisive-input.ts';

test('Enter, a lone Escape and a single digit can answer a dialog', () => {
  for (const data of ['\r', 'yes\r', '\x1b', '1', '2', '9', '\x1b[27u', '\x1b[13u', '\x1b[B\r'])
    assert.equal(isDecisiveInput(data), true, JSON.stringify(data));
});

test('typing, navigation, pastes and terminal replies answer nothing', () => {
  for (const data of ['', 'y', 'hello', '12', 'a1', '\t', ' ', '\x7f', '\x03', '\n',
    '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1bOA', '\x1b[1;5C', '\x1b[H', '\x1b[3~', '\x1b[Z',
    '\x1b\r', '\x1b[13;2u',
    '\x1b[200~line one\rline two\r\x1b[201~', '\x1b[200~1\x1b[201~', '\x1b[200~unfinished paste\r',
    '\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
  ]) assert.equal(isDecisiveInput(data), false, JSON.stringify(data));
});
