import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { registryFromDescriptions } from '../../src/resource-plugins/describe.client.ts';
import { migratePluginResources } from './plugin-migrations.ts';
import type { ResourceDataMigration } from '../../src/resource-plugins/types.ts';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { resourcePluginContract } from '../../src/resource-plugins/testing.ts';

const old = defineResourcePlugin({ id: 'example.research', apiVersion: 1, schemaVersion: 1, name: 'Research', icon: 'file', preferredView: 'focus', creation: { label: 'Add research' }, providerIdentity: data => String(data.text), fields: { text: { label: 'Text', kind: 'text', required: true } } });
const upgrades: ResourceDataMigration[] = [{ fromVersion: 1, toVersion: 2, migrate: data => ({ content: data.text }) }, { fromVersion: 2, toVersion: 3, migrate: data => ({ ...data, format: 'plain' }) }];
const current = defineResourcePlugin({ ...old, validateData: undefined, schemaVersion: 3, providerIdentity: data => String(data.content), fields: { content: { label: 'Content', kind: 'text', required: true }, format: { label: 'Format', kind: 'select', required: true, options: ['plain'] } }, migrations: upgrades });
const registry = (plugin = current) => { const registry = new ResourcePluginRegistry(); registry.register(plugin); return registry; };
resourcePluginContract(current, { valid: { content: 'Study', format: 'plain' }, invalid: [{ text: 'Legacy' }, { content: 'Study', format: 'html' }] });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'act-plugin-upgrade-')), path = join(directory, 'workspace.sqlite');
  const store = new SqliteStore(path), control = new WorkspaceControl(store, registry(old));
  await control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Study', summary: 'Keep this', position: { x: 1, y: 2 } },
    { type: 'item.add', id: 'one', resourceId: 'r1', pluginId: old.id, title: 'First', projectId: 'project', position: { x: 400, y: 100 }, data: { text: 'First record' } },
    { type: 'item.add', id: 'two', resourceId: 'r2', pluginId: old.id, title: 'Second', projectId: 'project', position: { x: 700, y: 100 }, data: { text: 'Second record' } },
    { type: 'item.add', id: 'alias', resourceId: 'unused-alias-resource', pluginId: old.id, title: 'Alias', position: { x: 1000, y: 100 }, data: { text: 'First record' } },
    { type: 'link.save', link: { id: 'edge', sourceId: 'one', targetId: 'two', kind: 'reference' } },
    { type: 'todo.save', todo: { id: 'todo', title: 'Read both', nodeIds: ['one', 'two'] } },
    { type: 'node.archive', id: 'two' },
  ] });
  await store.writeView('main', { mode: 'workspace', camera: { x: 10, y: 20, zoom: .7 } });
  store.enqueueJob('fixture-job', { action: 'fixture', nodeId: 'one', arguments: {} });
  return { directory, path, store, control, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('chained trusted upgrades are atomic, backed up and preserve projects, links, aliases, archive, camera and jobs', async () => {
  const f = await setup();
  try {
    const before = await f.store.read(), previousJobs = f.store.listJobs(), reg = registry();
    const report = await migratePluginResources(f.store, reg); assert.equal(report[0].status, 'upgraded'); assert.equal(report[0].count, 2);
    const after = await f.store.read(); assert.deepEqual(after.nodes, before.nodes); assert.deepEqual(after.links, before.links); assert.deepEqual(after.todos, before.todos); assert.deepEqual(after.view, before.view);
    assert.deepEqual(after.resources.map(r => [r.id, r.title, r.schemaVersion, r.data]), [['r1', 'First', 3, { content: 'First record', format: 'plain' }], ['r2', 'Second', 3, { content: 'Second record', format: 'plain' }]]);
    assert.deepEqual(f.store.listJobs(), previousJobs); assert.equal((await f.store.readView('main')).camera!.zoom, .7);
    const backupPath = join(f.directory, report[0].backup!); assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const backup = new SqliteStore(backupPath); try { assert.deepEqual(await backup.read(), before); } finally { backup.close(); }
    assert.deepEqual(await migratePluginResources(f.store, reg), []); assert.deepEqual(await f.store.read(), after);
    const serialized = JSON.stringify(reg.describe()); assert.equal(serialized.includes('migrate'), false); assert.equal(registryFromDescriptions(JSON.parse(serialized)).resolve(after.resources[0]).available, true);
  } finally { await f.close(); }
});

test('a later bad record or invalid migration result rolls the whole plugin back and exposes a safe unavailable reason', async () => {
  for (const migrate of [((data) => { data.text = 'mutated local copy'; throw new Error('PRIVATE record value'); }), (() => ({ content: 4, format: 'plain' }))] satisfies ResourceDataMigration['migrate'][]) {
    const f = await setup();
    try {
      const before = await f.store.read(), reg = registry({ ...current, migrations: [{ fromVersion: 1, toVersion: 3, migrate: data => data.text === 'Second record' ? migrate(data) : { content: data.text, format: 'plain' } }] });
      const report = await migratePluginResources(f.store, reg); assert.equal(report[0].status, 'failed'); assert.deepEqual(await f.store.read(), before);
      const ui = registryFromDescriptions(JSON.parse(JSON.stringify(reg.describe()))), resolved = ui.resolve(before.resources[0]);
      assert.equal(resolved.available, false); if (!resolved.available) assert.match(resolved.reason, /Original records are preserved/);
      assert.equal(JSON.stringify(report).includes('PRIVATE'), false); assert.equal(JSON.stringify(reg.describe()).includes('PRIVATE'), false);
      assert.equal((await migratePluginResources(f.store, registry()))[0].status, 'upgraded');
    } finally { await f.close(); }
  }
});

test('missing plugins, missing migration steps and plugin downgrade preserve records until a compatible plugin returns', async () => {
  const f = await setup();
  try {
    const original = await f.store.read(); const missing = new ResourcePluginRegistry();
    assert.deepEqual(await migratePluginResources(f.store, missing), []); assert.deepEqual(await f.store.read(), original);
    assert.deepEqual(await migratePluginResources(f.store, registry({ ...current, migrations: [upgrades[0]] })), []); assert.deepEqual(await f.store.read(), original);
    await migratePluginResources(f.store, registry()); const upgraded = await f.store.read();
    assert.deepEqual(await migratePluginResources(f.store, registry(old)), []); assert.deepEqual(await f.store.read(), upgraded);
    assert.equal(registry(old).resolve(upgraded.resources[0]).available, false); assert.equal(registry().resolve(upgraded.resources[0]).available, true);
  } finally { await f.close(); }
});

test('upgrade identity collisions reject the whole batch instead of silently merging map resources', async () => {
  const f = await setup();
  try {
    const before = await f.store.read(); const reg = registry({ ...current, providerIdentity: () => 'same-provider-record' });
    assert.equal((await migratePluginResources(f.store, reg))[0].status, 'failed'); assert.deepEqual(await f.store.read(), before);
  } finally { await f.close(); }
});

test('invalid, reverse and ambiguous migration steps are rejected before registration', () => {
  for (const migrations of [[{ fromVersion: 2, toVersion: 1, migrate: data => data }], [{ fromVersion: 1, toVersion: 4, migrate: data => data }], [upgrades[0], upgrades[0]] ] satisfies ResourceDataMigration[][]) assert.throws(() => registry({ ...current, migrations }), /unique increasing/);
});

test('production service upgrades before exposing UI/MCP state and reopens with removed or older plugins intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-plugin-service-')); let service = await startWorkspaceService(directory, registry(old), undefined, {});
  try {
    await service.control.dispatch({ commandId: 'create', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: [{ type: 'item.add', id: 'item', resourceId: 'resource', pluginId: old.id, title: 'From MCP', position: { x: 1, y: 2 }, data: { text: 'Saved content' } }] });
    await service.close(); service = await startWorkspaceService(directory, registry(), undefined, {});
    let client = await connectWorkspace(directory);
    try { const state = await client.call<{ state: { resources: { id: string; schemaVersion: number; data: unknown }[] } }>('read'); assert.equal(state.state.resources[0].schemaVersion, 3); assert.deepEqual(state.state.resources[0].data, { content: 'Saved content', format: 'plain' }); } finally { client.close(); }
    const upgraded = await service.control.read(); await service.close(); service = await startWorkspaceService(directory, new ResourcePluginRegistry(), undefined, {});
    assert.deepEqual(await service.control.read(), upgraded);
    await service.close(); service = await startWorkspaceService(directory, registry(old), undefined, {});
    assert.deepEqual(await service.control.read(), upgraded);
    await service.close(); service = await startWorkspaceService(directory, registry(), undefined, {});
    assert.deepEqual(await service.control.read(), upgraded);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a SQLite failure during resource replacement rolls back graph rows and leaves a restorable backup', async () => {
  const f = await setup(); const database = new DatabaseSync(f.path);
  try {
    database.exec("CREATE TRIGGER reject_upgrade BEFORE INSERT ON resources WHEN json_extract(NEW.body, '$.schemaVersion') = 3 BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;");
    const before = await f.store.snapshot(), report = await migratePluginResources(f.store, registry());
    assert.equal(report[0].status, 'failed'); assert.ok(report[0].backup); assert.deepEqual(await f.store.snapshot(), before);
    database.exec('DROP TRIGGER reject_upgrade'); assert.equal((await migratePluginResources(f.store, registry()))[0].status, 'upgraded');
  } finally { database.close(); await f.close(); }
});
