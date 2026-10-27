import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LocalRpcClient, serveLocal } from './local-rpc.ts';
import type { RpcPeer } from './local-rpc.ts';
import { prepareWorkspace } from './paths.ts';
import { serializeError } from './protocol.ts';

test('transport loss preserves its cause while all pending calls retain uncertain-outcome semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-rpc-cause-')), paths = prepareWorkspace(directory);
  let release!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  const server = await serveLocal(paths.socket, paths.secret, () => reply);
  const socket = createConnection(paths.socket), client = new LocalRpcClient(socket, paths.secret);
  try {
    await once(socket, 'connect');
    const cause = Object.freeze(Object.assign(new Error('Fixture transport failure'), { code: 'ECONNRESET' }));
    const disconnected = once(client, 'disconnected');
    const pending = ['read', 'apply'].map(method => assert.rejects(client.call(method), error => {
      assert.equal((error as NodeJS.ErrnoException).code, 'CONNECTION_LOST');
      assert.equal((error as Error).cause, cause);
      assert.notEqual(error, cause);
      assert.deepEqual(serializeError(error), { code: 'CONNECTION_LOST', message: cause.message });
      return true;
    }));
    socket.destroy(cause);
    await Promise.all(pending);
    assert.equal((await disconnected)[0], cause);
    assert.equal(cause.code, 'ECONNRESET');
    await assert.rejects(client.call('read'), { code: 'CONNECTION_LOST' });
  } finally { release(); client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a provider action outlives the ordinary request timeout; other requests still time out at 15 s', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-rpc-timeout-')), paths = prepareWorkspace(directory);
  let release!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  const server = await serveLocal(paths.socket, paths.secret, () => reply);
  const socket = createConnection(paths.socket), client = new LocalRpcClient(socket, paths.secret);
  try {
    await once(socket, 'connect');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const failed: { read?: NodeJS.ErrnoException; action?: NodeJS.ErrnoException } = {};
    client.call('read').catch(error => { failed.read = error; });
    client.call('runtime.run').catch(error => { failed.action = error; });
    t.mock.timers.tick(16_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed.read?.code, 'TIMEOUT');
    assert.equal(failed.action?.code, undefined);
    t.mock.timers.tick(180_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed.action?.code, undefined);
    t.mock.timers.tick(30_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed.action?.code, 'TIMEOUT');
  } finally { t.mock.timers.reset(); release(); client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

async function rawPeer(t: TestContext, handle: Parameters<typeof serveLocal>[2], options?: Parameters<typeof serveLocal>[3]) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-rpc-frames-')), paths = prepareWorkspace(directory);
  const server = await serveLocal(paths.socket, paths.secret, handle, options);
  const socket = createConnection(paths.socket); await once(socket, 'connect');
  socket.setEncoding('utf8');
  t.after(async () => { socket.destroy(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (id: string, method: string) => socket.write(JSON.stringify({ id, token: paths.secret, method }) + '\n');
  return { socket, request };
}

function frames(socket: Socket) {
  const received: { id?: string; event?: string; data?: { n: number }; result?: { method: string } }[] = [];
  let buffer = '';
  socket.on('data', (data: string) => {
    buffer += data; let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) { received.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
  });
  return received;
}

async function until(condition: () => boolean, timeoutMs = 5000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a subscriber that stops reading gets only the newest snapshot once it drains and is never dropped; replies are never coalesced', async t => {
  let peer!: RpcPeer;
  const coalesced: string[] = [], dropped: unknown[] = [];
  const { socket, request } = await rawPeer(t, (method, _args, from) => { peer = from; return { method }; },
    { observer: { coalesced: (_peer, label) => coalesced.push(label), dropped: (_peer, drop) => dropped.push(drop) } });
  const received = frames(socket);
  request('subscribe', 'subscribe');
  await until(() => received.length === 1);
  socket.pause();
  const padding = 'x'.repeat(1024 * 1024);
  for (let n = 0; n < 20; n++) peer.notify('snapshot', { n, padding });
  request('first', 'first'); request('second', 'second');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(coalesced.length >= 15, `coalesced ${coalesced.length}`);
  assert.ok(coalesced.every(label => label === 'snapshot'));
  socket.resume();
  await until(() => received.some(frame => frame.event === 'snapshot' && frame.data?.n === 19) && received.filter(frame => frame.id).length === 3);
  const snapshots = received.filter(frame => frame.event === 'snapshot').map(frame => frame.data?.n);
  assert.equal(snapshots.at(-1), 19);
  assert.equal(snapshots.length + coalesced.length, 20);
  assert.deepEqual(received.filter(frame => frame.id).map(frame => frame.result?.method), ['subscribe', 'first', 'second']);
  assert.equal(socket.destroyed, false); assert.deepEqual(dropped, []);
});

test('a single frame over the limit drops the client with one stderr line', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => { lines.push(line); });
  const { socket, request } = await rawPeer(t, method => method === 'large' ? 'x'.repeat(9 * 1024 * 1024) : {});
  socket.resume();
  const closed = once(socket, 'close');
  request('large', 'large');
  await closed;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Local client dropped: \d+ bytes queued, \d{7,} bytes frame, large$/);
});
