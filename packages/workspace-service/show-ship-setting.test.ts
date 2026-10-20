import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrations } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { githubPullRequestConnector } from '../../src/resource-plugins/items/github-pull-request/connector.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { enabledMenuGroups } from '../core/context-menu.ts';
import { pluginSettingsValues } from '../../src/resource-plugins/describe.client.ts';

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-show-ship-setting-'));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const showShip = (store: SqliteStore) => createResourcePluginRegistry().pluginSettings(store.readSettings().value.plugins)['github.pull-request']?.showShip;

test('Show/Ship is an opt-in pull request setting: off by default, its menu and actions follow it', async () => {
  const registry = createResourcePluginRegistry(), pull = registry.describe().find(type => type.id === 'github.pull-request')!;
  assert.deepEqual(pull.settingsSections?.map(section => [section.owner, section.fields.showShip?.kind, section.fields.showShip?.default]), [['github.pull-request', 'boolean', false]]);
  const menu = (saved: Record<string, Record<string, boolean>>) => enabledMenuGroups(pull.contextMenu, pluginSettingsValues([pull], saved)).map(group => group.id);
  assert.deepEqual(menu({}), ['review', 'reviewLoop', 'architecture', 'merge', 'autoDeploy', 'state']);
  assert.deepEqual(menu({ 'github.pull-request': { showShip: true } }), ['review', 'reviewLoop', 'architecture', 'merge', 'autoDeploy', 'state', 'showShip']);
  let enabled = false;
  const f = githubFixture(), host = new ResourcePluginHost(registry);
  host.register('github.pull-request', githubPullRequestConnector(() => f.client, { showShip: () => enabled }));
  const resource = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', connectionId: 'fixture', data: { owner: 'fixture', repo: 'billing', number: 42 } };
  const ids = () => host.actions(resource, AbortSignal.timeout(1000)).map(action => action.id);
  assert.equal(ids().some(id => id.startsWith('pr.showShip')), false);
  await assert.rejects(host.execute(resource, 'pr.showShip.options', {}, AbortSignal.timeout(1000)), /Action is not available: pr\.showShip\.options/);
  enabled = true;
  assert.deepEqual(ids().filter(id => id.startsWith('pr.showShip')), ['pr.showShip.options', 'pr.showShip']);
});

const downgrade = (file: string) => { const db = new DatabaseSync(file); db.exec(`PRAGMA user_version = ${migrations.findIndex(migration => migration.includes('settings:before-plugin-settings'))}`); db.close(); };

test('settings saved before the option existed keep Show/Ship on after the upgrade; otherwise it starts off', () => fixture(async directory => {
  const configured = join(directory, 'configured.sqlite'), unsaved = join(directory, 'unsaved.sqlite'), empty = join(directory, 'empty.sqlite');
  let store = new SqliteStore(configured);
  const initial = store.readSettings(), saved = store.writeSettings({ expectedRevision: initial.revision, value: { ...initial.value, keepAwake: true } });
  store.close(); downgrade(configured);
  store = new SqliteStore(configured);
  try {
    assert.deepEqual(store.readSettings(), saved, 'the schema upgrade itself leaves settings alone');
    store.migrateSettingsDefaults();
    const upgraded = store.readSettings();
    assert.equal(showShip(store), true); assert.ok(upgraded.revision > saved.revision);
    assert.deepEqual({ ...upgraded.value, plugins: {} }, { ...saved.value, plugins: {} }, 'other settings are unchanged');
    const off = store.writeSettings({ expectedRevision: upgraded.revision, value: { ...upgraded.value, plugins: { 'github.pull-request': { showShip: false } } } });
    store.close(); store = new SqliteStore(configured); store.migrateSettingsDefaults();
    assert.deepEqual(store.readSettings(), off, 'turning it off afterwards is kept');
  } finally { store.close(); }
  store = new SqliteStore(unsaved);
  await new WorkspaceControl(store).apply({ type: 'project.create', id: 'p', title: 'Project', position: { x: 0, y: 0 } }, 0);
  store.close(); downgrade(unsaved);
  store = new SqliteStore(unsaved);
  try { store.migrateSettingsDefaults(); assert.equal(showShip(store), false); assert.equal(store.readSettings().revision, 0, 'an upgrade without saved settings writes none'); } finally { store.close(); }
  store = new SqliteStore(empty);
  try {
    store.migrateSettingsDefaults();
    assert.equal(showShip(store), false);
    assert.equal(store.readSettings().revision, 0, 'a new workspace writes no settings');
  } finally { store.close(); }
}));
