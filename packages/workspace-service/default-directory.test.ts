import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';

async function fixture(run: (directory: string, store: SqliteStore) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'craft-default-directory-')));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await run(directory, store); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
const save = (store: SqliteStore, change: Record<string, unknown>) => {
  const current = store.readSettings();
  return store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, ...change } });
};

test('the global default working directory is unset by default and survives a restart', () => fixture(async (directory, store) => {
  assert.equal(store.readSettings().value.defaultWorkingDirectory, '');
  const folder = join(directory, 'code'); await mkdir(folder);
  save(store, { defaultWorkingDirectory: folder });
  const reopened = new SqliteStore(store.file);
  try { assert.equal(reopened.readSettings().value.defaultWorkingDirectory, folder); } finally { reopened.close(); }
}));

test('the global default must be an existing absolute folder and can be cleared', () => fixture(async (directory, store) => {
  const folder = join(directory, 'code'); await mkdir(folder);
  assert.throws(() => save(store, { defaultWorkingDirectory: 'relative/code' }), /existing folder/);
  assert.throws(() => save(store, { defaultWorkingDirectory: join(directory, 'missing') }), /existing folder/);
  assert.throws(() => save(store, { defaultWorkingDirectory: store.file }), /existing folder/);
  save(store, { defaultWorkingDirectory: folder });
  assert.equal(save(store, { defaultWorkingDirectory: '' }).value.defaultWorkingDirectory, '');
}));

test('a saved default that later disappears does not block saving other settings', () => fixture(async (directory, store) => {
  const folder = join(directory, 'code'); await mkdir(folder);
  save(store, { defaultWorkingDirectory: folder });
  await rm(folder, { recursive: true });
  assert.equal(save(store, { keepAwake: true }).value.keepAwake, true);
}));
