import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProviderAccount, providerConnectionsSchema } from './connections.ts';
import { ProviderConnections } from '../provider-runtime/connections.ts';
import { SqliteStore } from '../workspace-service/sqlite-store.ts';

test('default account changes preserve older bindings; disconnect/reconnect retains stable IDs', async () => {
  let connections = selectProviderAccount([], 'github', 'first', 'connection-one'), calls = 0;
  const before = structuredClone(connections);
  const providers = new ProviderConnections(() => connections, [{ id: 'github', name: 'GitHub', setupHint: 'Sign in', async accounts() { calls++; return [{ id: 'first', label: 'First', active: true, available: true, credentialSource: 'keyring' }]; } }]);
  assert.deepEqual(providers.describe(), [{ id: 'github', name: 'GitHub', setupHint: 'Sign in' }]); assert.equal(calls, 0);
  assert.equal(providers.resolve('github').id, 'connection-one');
  connections = selectProviderAccount(connections, 'github', 'second', 'connection-two');
  assert.deepEqual(before, [{ id: 'connection-one', providerId: 'github', account: 'first', enabled: true, isDefault: true }]);
  assert.equal(providers.resolve('github').account, 'second'); assert.equal(providers.resolve('github', 'connection-one').account, 'first');
  connections = selectProviderAccount(connections, 'github', undefined, 'unused');
  assert.throws(() => providers.resolve('github'), /Connect GitHub/); assert.throws(() => providers.resolve('github', 'connection-one'), /Connect GitHub/);
  connections = selectProviderAccount(connections, 'github', 'first', 'must-not-replace-id');
  assert.equal(providers.resolve('github').id, 'connection-one'); assert.equal(connections.length, 2);
  assert.throws(() => providers.resolve('github', 'unknown'), /Connect GitHub/);
  assert.throws(() => providers.resolve('uninstalled'), /not installed/);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(providers.accounts('github', cancelled.signal), { name: 'AbortError' }); assert.equal(calls, 0);
  assert.equal((await providers.accounts('github', new AbortController().signal))[0].id, 'first'); assert.equal(calls, 1);
});

test('connection preferences reject duplicate or disabled defaults and persist independently of graph data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-provider-preferences-')), file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file);
  try {
    const initial = store.readSettings(); assert.deepEqual(initial.value.connections, []);
    const connections = selectProviderAccount([], 'github', 'reviewer', 'connection');
    for (const invalid of [[...connections, { ...connections[0], id: 'other' }], [{ ...connections[0], enabled: false }], [...connections, { ...connections[0], id: 'other', account: 'other' }]]) assert.equal(providerConnectionsSchema.safeParse(invalid).success, false);
    const graph = await store.read();
    const saved = store.writeSettings({ expectedRevision: initial.revision, value: { ...initial.value, connections } });
    assert.throws(() => store.writeSettings({ expectedRevision: initial.revision, value: initial.value }), /changed elsewhere/);
    store.close(); store = new SqliteStore(file);
    assert.deepEqual(store.readSettings(), saved); assert.deepEqual(await store.read(), graph);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('provider labels stay separate from opaque account identity and survive reselection', () => {
  const account = JSON.stringify(['work', '2'.repeat(32)]), one = selectProviderAccount([], 'notion', account, 'stable', 'Team workspace');
  assert.equal(one[0].label, 'Team workspace'); assert.equal(one[0].account, account);
  const two = selectProviderAccount(one, 'notion', account, 'unused', 'Renamed workspace'); assert.equal(two[0].id, 'stable'); assert.equal(two[0].label, 'Renamed workspace');
  assert.equal(selectProviderAccount(two, 'notion', account, 'unused')[0].label, 'Renamed workspace');
});
