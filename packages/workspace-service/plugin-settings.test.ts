import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsSchema } from '../core/settings.ts';
import { SqliteStore } from './sqlite-store.ts';
import { createPluginPackageRegistry } from '../../src/resource-plugins/builtins.ts';
import { ServicePluginRuntime } from '../../src/resource-plugins/service-runtime.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';

const widget = defineResourcePlugin({ id: 'acme.widget', apiVersion: 1, schemaVersion: 1, name: 'Widget', icon: 'box', preferredView: 'inspector', fields: {} });
const packages = createPluginPackageRegistry();
packages.register({ manifest: { id: 'acme', name: 'Acme', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'plugin.ts' }, contributes: { itemTypes: ['acme.widget'], settingsPages: ['acme.widget'] } },
  module: { definitions: [widget], settings: { typeId: 'acme.widget', label: 'Acme sync', fields: { interval: { label: 'Interval', kind: 'number', integer: true, min: 1, max: 60, default: 5 }, mode: { label: 'Mode', kind: 'select', options: ['fast', 'safe'], default: 'safe' } } } } });

test('package settings live under settings.plugins and default to empty', () => {
  assert.deepEqual(settingsSchema.parse({}).plugins, {});
  assert.deepEqual(settingsSchema.parse({ plugins: { acme: { interval: 3 } } }).plugins, { acme: { interval: 3 } });
  assert.equal(settingsSchema.safeParse({ plugins: { 'Not An Id': {} } }).success, false);
});

test('saving validates registered package settings and keeps settings of packages that are not installed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plugin-settings-')), store = new SqliteStore(join(directory, 'settings.sqlite'));
  try {
    const types = packages.types, current = store.readSettings();
    assert.throws(() => store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, plugins: { acme: { interval: 0 } } } }, types), /Acme sync settings are invalid/);
    assert.throws(() => store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, plugins: { acme: { mode: 'reckless' } } } }, types), /invalid/);
    const saved = store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, plugins: { acme: { interval: 10 }, removed: { kept: true } } } }, types);
    assert.deepEqual(store.readSettings().value.plugins, { acme: { interval: 10 }, removed: { kept: true } });
    assert.deepEqual(types.pluginSettings(saved.value.plugins).acme, { interval: 10, mode: 'safe' });
    let seen: unknown;
    new ServicePluginRuntime(packages, { registry: types, settings: () => store.readSettings().value.plugins }).activate({ acme: { activate(host) { seen = host.settings(); } } });
    assert.deepEqual(seen, { interval: 10, mode: 'safe' }, 'a service entry reads its own settings with defaults');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
