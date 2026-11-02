import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { listenOnEndpoint, localEndpoint, prepareEndpointDirectory, removeEndpoint } from './local-endpoint.ts';

const posixOnly = { skip: process.platform === 'win32' };
test('an endpoint is stable for its key and separate between keys', () => {
  assert.deepEqual(localEndpoint('one'), localEndpoint('one'));
  assert.notEqual(localEndpoint('one').path, localEndpoint('two').path);
});

test('listening replaces a stale endpoint, keeps it private, and removal frees it', posixOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-endpoint-')), path = join(root, 'service.sock'), server = createServer();
  try {
    await writeFile(path, 'stale');
    await listenOnEndpoint(server, path);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const client = connect(path);
    await once(client, 'connect');
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeEndpoint(path);
    await assert.rejects(lstat(path), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an endpoint directory is made private, and a link in its place is refused', posixOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-endpoint-')), directory = join(root, 'real'), link = join(root, 'link');
  try {
    await mkdir(directory, { mode: 0o755 });
    prepareEndpointDirectory(directory);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    await symlink(directory, link);
    assert.throws(() => prepareEndpointDirectory(link), /invalid owner/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Windows endpoint is a named pipe with no directory to prepare', () => {
  const endpoint = localEndpoint('abc', 'win32');
  assert.equal(endpoint.directory, '');
  assert.match(endpoint.path, /^\\\\\.\\pipe\\agent-crafting-table-.+-abc$/);
  prepareEndpointDirectory(endpoint.directory);
  removeEndpoint(endpoint.path);
});

test('a named pipe accepts a connection and stops when closed', { skip: process.platform !== 'win32' }, async () => {
  const { path } = localEndpoint(`test-${process.pid}`), server = createServer(socket => socket.end('ready'));
  await listenOnEndpoint(server, path);
  try {
    const client = connect(path), [data] = await once(client, 'data') as [Buffer];
    assert.equal(String(data), 'ready');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
