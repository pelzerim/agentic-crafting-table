import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { MAX_RECENT_DIRECTORIES } from '../core/working-directories.ts';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'craft-recent-')));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function folders(root: string, count: number) {
  const paths = Array.from({ length: count }, (_, index) => join(root, `folder-${index}`));
  for (const path of paths) await mkdir(path);
  return paths;
}

test('recent directories are most recent first, distinct and capped', () => fixture(async directory => {
  const clock = { now: 1_000 }, store = new SqliteStore(join(directory, 'workspace.sqlite'), { now: () => clock.now });
  try {
    const paths = await folders(directory, MAX_RECENT_DIRECTORIES + 2);
    assert.deepEqual(store.recentDirectories(), []);
    for (const path of paths) { store.recordDirectory(path); clock.now += 10; }
    assert.equal(MAX_RECENT_DIRECTORIES, 10);
    assert.deepEqual(store.recentDirectories(), paths.slice(2).reverse());
    store.recordDirectory(paths[5]);
    assert.deepEqual(store.recentDirectories(), [paths[5], ...paths.slice(2).reverse().filter(path => path !== paths[5])]);
    store.recordDirectory(paths[5]);
    assert.equal(store.recentDirectories().filter(path => path === paths[5]).length, 1);
  } finally { store.close(); }
}));

test('recording within the same millisecond still moves the path to the front', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'workspace.sqlite'), { now: () => 5 });
  try {
    const [first, second] = await folders(directory, 2);
    store.recordDirectory(first); store.recordDirectory(second); store.recordDirectory(first);
    assert.deepEqual(store.recentDirectories(), [first, second]);
  } finally { store.close(); }
}));

test('recent directories are stored by real path and ignore relative or missing paths', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    const [real] = await folders(directory, 1), alias = join(directory, 'alias');
    await symlink(real, alias);
    store.recordDirectory(alias); store.recordDirectory(real);
    store.recordDirectory('relative/path'); store.recordDirectory(join(directory, 'never-created'));
    assert.deepEqual(store.recentDirectories(), [real]);
  } finally { store.close(); }
}));

test('directories that no longer exist are dropped when listing', () => fixture(async directory => {
  const clock = { now: 1 }, store = new SqliteStore(join(directory, 'workspace.sqlite'), { now: () => clock.now++ });
  try {
    const [kept, removed] = await folders(directory, 2);
    store.recordDirectory(kept); store.recordDirectory(removed);
    await rm(removed, { recursive: true });
    assert.deepEqual(store.recentDirectories(), [kept]);
    await mkdir(removed);
    assert.deepEqual(store.recentDirectories(), [kept]);
  } finally { store.close(); }
}));

test('recent directories survive a restart', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite'), clock = { now: 1 };
  let store = new SqliteStore(file, { now: () => clock.now++ });
  const paths = await folders(directory, 3);
  for (const path of paths) store.recordDirectory(path);
  store.close();
  store = new SqliteStore(file, { now: () => clock.now++ });
  try { assert.deepEqual(store.recentDirectories(), [...paths].reverse()); } finally { store.close(); }
}));

test('the service lists recent directories as plain paths', () => fixture(async directory => {
  const data = join(directory, 'data'), service = await startWorkspaceService(data), client = await connectWorkspace(data);
  try {
    const [path] = await folders(directory, 1);
    assert.deepEqual(await client.call('directories.recent'), []);
    service.store.recordDirectory(path);
    assert.deepEqual(await client.call('directories.recent'), [path]);
  } finally { client.close(); await service.close(); }
}));
