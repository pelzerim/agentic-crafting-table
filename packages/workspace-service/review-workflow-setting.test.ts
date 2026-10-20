import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrations } from './sqlite-store.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { DEFAULT_WORKFLOW_REVIEW_CONTRACT, workflowReviewContract } from '../../src/pull-requests/workflow-contract.ts';
import { nativeWorkflowSources } from '../provider-runtime/workflow-sources.ts';
import { ProviderConnections } from '../provider-runtime/connections.ts';

const contract = (store: SqliteStore, repository = 'acme/app') => workflowReviewContract(createResourcePluginRegistry().pluginSettings(store.readSettings().value.plugins)['github.review-run'], repository);
const preset = { id: 'team.review-workflow', packageId: 'github.review-run', values: { workflowPath: '.github/workflows/team-review.yml', jobName: 'team-review', failureText: 'team review did not complete', reportMarker: '^Result:' } };
const defaults = () => createResourcePluginRegistry().pluginSettings()['github.review-run'];

test('the /review contract has neutral defaults; a package preset applies once to fresh and upgraded workspaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-workflow-'));
  try {
    const fresh = new SqliteStore(join(directory, 'fresh.sqlite'));
    try {
      fresh.migrateSettingsDefaults();
      assert.deepEqual(contract(fresh), DEFAULT_WORKFLOW_REVIEW_CONTRACT, 'without a preset a new workspace keeps the neutral contract');
      fresh.applySettingsPreset(preset, defaults());
      assert.deepEqual(contract(fresh), preset.values, 'a new workspace takes the preset');
    } finally { fresh.close(); }
    const file = join(directory, 'existing.sqlite');
    let store = new SqliteStore(file);
    const initial = store.readSettings(); store.writeSettings({ expectedRevision: initial.revision, value: { ...initial.value, keepAwake: true } }); store.close();
    const old = new DatabaseSync(file); old.exec(`PRAGMA user_version = ${migrations.findIndex(migration => migration.includes('settings:before-plugin-settings'))}`); old.close();
    store = new SqliteStore(file);
    try {
      store.migrateSettingsDefaults();
      assert.deepEqual(contract(store), DEFAULT_WORKFLOW_REVIEW_CONTRACT, 'an upgraded workspace starts from the defaults too');
      const saved = store.readSettings();
      store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, plugins: { ...saved.value.plugins, 'github.review-run': { ...defaults(), jobName: 'custom-review' } } } });
      store.applySettingsPreset(preset, defaults());
      assert.deepEqual(contract(store), { ...preset.values, jobName: 'custom-review' }, 'values left at their defaults take the preset; changed ones stay');
      store.applySettingsPreset({ ...preset, values: { ...preset.values, workflowPath: '.github/workflows/other.yml' } }, defaults());
      assert.equal(contract(store).workflowPath, preset.values.workflowPath, 'a preset applies once');
      const current = store.readSettings(), plugins = current.value.plugins;
      store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, plugins: { ...plugins, 'github.review-run': { ...plugins['github.review-run'], repositories: 'acme/docs | .github/workflows/docs-review.yml | docs' } } } });
      assert.deepEqual(contract(store, 'acme/docs'), { ...preset.values, workflowPath: '.github/workflows/docs-review.yml', jobName: 'docs' });
      const invalid = store.readSettings();
      assert.throws(() => store.writeSettings({ expectedRevision: invalid.revision, value: { ...invalid.value, plugins: { ...invalid.value.plugins, 'github.review-run': { workflowPath: 'review.yml' } } } }), /\/review workflow settings are invalid/);
    } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a workflow review freezes the contract for its repository when it starts; requests journaled without one use the current settings', () => {
  const connections = new ProviderConnections(() => [{ id: 'gh', providerId: 'github', account: 'me', enabled: true, isDefault: true }], [{ id: 'github', name: 'GitHub', setupHint: '', accounts: async () => [] }]);
  const asked: string[] = [];
  const source = nativeWorkflowSources(connections, repository => { asked.push(repository); return { ...preset.values }; })['github.pull-request'];
  const binding = source.freeze({ id: 'r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', connectionId: 'gh', data: { owner: 'Acme', repo: 'App', number: 7 } });
  assert.deepEqual(asked, ['Acme/App']);
  assert.deepEqual(binding.contract, preset.values);
  const journaled = { ...binding }; delete journaled.contract;
  const client = source.client(journaled) as unknown as { contract: unknown };
  assert.deepEqual(client.contract, preset.values); assert.deepEqual(asked, ['Acme/App', 'Acme/App']);
});
