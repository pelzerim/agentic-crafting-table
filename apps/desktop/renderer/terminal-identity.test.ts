import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTerminalIdentity } from './terminal-identity.ts';
import { terminalIdentity } from '../../../packages/session-runtime/terminal-identity.ts';

function parser() {
  const handlers: { id: { prefix?: string; intermediates?: string; final: string }; callback: (params: (number | number[])[]) => boolean | Promise<boolean> }[] = [];
  let disposed = 0;
  return { handlers, disposed: () => disposed, registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, callback: (params: (number | number[])[]) => boolean | Promise<boolean>) { handlers.push({ id, callback }); return { dispose() { disposed++; } }; } };
}

test('the terminal names its emulator and version when a CLI asks with XTVERSION', () => {
  const sent: string[] = [], host = parser();
  const binding = bindTerminalIdentity({ parser: host }, data => sent.push(data));
  assert.deepEqual(host.handlers[0].id, { prefix: '>', final: 'q' });
  assert.equal(host.handlers[0].callback([0]), true);
  assert.equal(host.handlers[0].callback([]), true);
  assert.deepEqual(sent, [`\x1bP>|${terminalIdentity}\x1b\\`, `\x1bP>|${terminalIdentity}\x1b\\`]);
  // Other parameters are not a version query; leave them to xterm's own handling.
  assert.equal(host.handlers[0].callback([1]), false);
  assert.equal(sent.length, 2);
  binding.dispose();
  assert.equal(host.disposed(), host.handlers.length);
});

test('pixel mouse reports are declined, every other mode query stays with the terminal', () => {
  const sent: string[] = [], host = parser();
  bindTerminalIdentity({ parser: host }, data => sent.push(data));
  const query = host.handlers.find(handler => handler.id.prefix === '?' && handler.id.intermediates === '$' && handler.id.final === 'p');
  assert.ok(query, 'DECRQM for private modes is handled');
  assert.equal(query.callback([1016]), true);
  assert.deepEqual(sent, ['\x1b[?1016;0$y']);
  for (const mode of [2026, 1006, 1000, 25]) assert.equal(query.callback([mode]), false);
  assert.equal(sent.length, 1);
});
