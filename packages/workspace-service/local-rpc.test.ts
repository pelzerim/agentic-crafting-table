import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LocalRpcClient, serveLocal } from './local-rpc.ts';
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
