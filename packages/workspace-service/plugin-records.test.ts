import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrations, PLUGIN_STORAGE_BYTES } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plugin-records-'));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('plugin records are namespaced per package and ordered by ordinal, then key', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'records.sqlite'), { now: () => 1000 });
  try {
    const acme = store.pluginStorage('acme'), other = store.pluginStorage('other');
    acme.put('runs', 'b', { state: 'queued' }, { ordinal: 2 });
    acme.put('runs', 'a', { state: 'running' }, { ordinal: 2 });
    acme.put('runs', 'c', ['first'], { ordinal: 1 });
    acme.put('notes', 'only', 'text');
    other.put('runs', 'a', 'unrelated');
    assert.deepEqual(acme.list('runs').map(record => record.key), ['c', 'a', 'b']);
    assert.deepEqual(acme.get('runs', 'a'), { key: 'a', value: { state: 'running' }, ordinal: 2, updatedAt: 1000 });
    assert.deepEqual(acme.list('runs', { limit: 1, after: { ordinal: 1, key: 'c' } }).map(record => record.key), ['a']);
    assert.deepEqual(acme.list('notes'), [{ key: 'only', value: 'text', updatedAt: 1000 }]);
    assert.equal(other.get('runs', 'a')?.value, 'unrelated');
    assert.equal(acme.delete('runs', 'a'), true); assert.equal(acme.delete('runs', 'a'), false);
    assert.equal(acme.get('runs', 'a'), undefined);
  } finally { store.close(); }
}));

test('plugin storage rejects invalid names, oversized rows and writes beyond its quota', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'limits.sqlite'));
  try {
    const storage = store.pluginStorage('acme');
    assert.throws(() => store.pluginStorage('Not An Id'), /package id/);
    assert.throws(() => storage.put('Bad Collection', 'k', 1), /collection/);
    assert.throws(() => storage.put('runs', '', 1), /key/);
    assert.throws(() => storage.put('runs', 'big', 'x'.repeat(1024 * 1024 + 1)), /too large/);
    const chunk = 'x'.repeat(1024 * 1024 - 64);
    for (let index = 0; index < PLUGIN_STORAGE_BYTES / (1024 * 1024) - 1; index++) storage.put('bulk', `row-${index}`, chunk);
    assert.throws(() => { storage.put('bulk', 'one-more', chunk); storage.put('bulk', 'and-another', chunk); }, /storage limit/);
    assert.doesNotThrow(() => storage.put('bulk', 'row-0', 'smaller'), 'replacing a row frees its previous size');
  } finally { store.close(); }
}));

test('a plugin transaction commits together or not at all', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'transaction.sqlite'));
  try {
    const storage = store.pluginStorage('acme');
    assert.throws(() => storage.transaction(() => { storage.put('runs', 'a', 1); throw new Error('stop'); }), /stop/);
    assert.equal(storage.get('runs', 'a'), undefined);
    storage.transaction(() => { storage.put('runs', 'a', 1); storage.transaction(() => storage.put('runs', 'b', 2)); });
    assert.deepEqual(storage.list('runs').map(record => record.value), [1, 2]);
  } finally { store.close(); }
}));

test('the plugin_records upgrade keeps existing data, backs up first and survives reopening', () => fixture(async directory => {
  const file = join(directory, 'upgrade.sqlite');
  let store = new SqliteStore(file);
  await new WorkspaceControl(store).apply({ type: 'project.create', id: 'kept', title: 'Kept', position: { x: 0, y: 0 } }, 0);
  const before = await store.read(); store.close();
  const before19 = migrations.findIndex(migration => migration.includes('plugin_records'));
  const old = new DatabaseSync(file); old.exec(`DROP TABLE plugin_records; PRAGMA user_version = ${before19};`); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes(`backup-v${before19}-`)); assert.deepEqual(await store.read(), before);
    store.pluginStorage('acme').put('runs', 'a', { saved: true });
  } finally { store.close(); }
  store = new SqliteStore(file);
  try { assert.deepEqual(store.pluginStorage('acme').get('runs', 'a')?.value, { saved: true }); } finally { store.close(); }
}));
