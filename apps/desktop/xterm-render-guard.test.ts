import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixInverseContrast, guardHiddenXterm } from './xterm-render-guard.ts';
test('the hidden-render workaround applies only to the verified xterm release and fails on upgrades', async () => {
  const source = await readFile(new URL('../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url), 'utf8');
  const patched = guardHiddenXterm(source);
  assert.equal(patched.split('if(!this._element.getClientRects().length)return;').length, 2);
  assert.throws(() => guardHiddenXterm(source + '\n'), /Review the hidden xterm render guard/);
});
test('the DOM renderer checks reverse-video default text against the colour it draws', async () => {
  const source = guardHiddenXterm(await readFile(new URL('../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url), 'utf8'));
  const patched = fixInverseContrast(source);
  assert.equal(patched.split('this._applyMinimumContrast(f,it,fi?p.background:p.foreground,x,tt,Qi)').length, 2);
  assert.throws(() => fixInverseContrast(patched), /Expected one xterm DOM default-foreground contrast check/);
});
