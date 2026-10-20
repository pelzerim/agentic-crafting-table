import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guardHiddenXterm } from './xterm-render-guard.ts';
test('the hidden-render workaround applies only to the verified xterm release and fails on upgrades', async () => {
  const source = await readFile(new URL('../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url), 'utf8');
  const patched = guardHiddenXterm(source);
  assert.equal(patched.split('if(!this._element.getClientRects().length)return;').length, 2);
  assert.throws(() => guardHiddenXterm(source + '\n'), /Review the hidden xterm render guard/);
});
