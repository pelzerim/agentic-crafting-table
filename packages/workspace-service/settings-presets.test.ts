import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from './sqlite-store.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';

const defaults = () => createResourcePluginRegistry().pluginSettings()['github.review-run'];
const preset = { id: 'acme.review-workflow', packageId: 'github.review-run', values: { workflowPath: '.github/workflows/acme-review.yml', jobName: 'acme-review' } };
const saved = (store: SqliteStore) => store.readSettings().value.plugins['github.review-run'];
const write = (store: SqliteStore, values: Record<string, unknown>) => {
  const current = store.readSettings();
  store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, plugins: { ...current.value.plugins, 'github.review-run': { ...defaults(), ...values } } } });
};
async function withStore(work: (open: () => SqliteStore, file: string) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-presets-')), file = join(directory, 'workspace.sqlite'), opened: SqliteStore[] = [];
  try { await work(() => { const store = new SqliteStore(file); opened.push(store); return store; }, file); }
  finally { for (const store of opened) { try { store.close(); } catch { /* Already closed. */ } } await rm(directory, { recursive: true, force: true }); }
}

test('a preset applies once to a fresh workspace that has never saved settings', () => withStore(open => {
  const store = open();
  assert.equal(store.applySettingsPreset(preset, defaults()), true);
  assert.deepEqual(saved(store), preset.values);
  assert.equal(store.applySettingsPreset({ ...preset, values: { ...preset.values, jobName: 'other' } }, defaults()), false, 'a preset id applies once');
  assert.equal(saved(store).jobName, 'acme-review');
}));

test('a preset fills only settings still at their declared defaults and keeps what the person changed', () => withStore(open => {
  const store = open();
  write(store, { jobName: 'my-review', failureText: 'mine' });
  store.applySettingsPreset({ ...preset, values: { ...preset.values, failureText: 'acme failure' } }, defaults());
  assert.deepEqual(saved(store), { ...defaults(), workflowPath: preset.values.workflowPath, jobName: 'my-review', failureText: 'mine' });
}));

test('a value set back to its default after the preset applied is not overwritten again', () => withStore(open => {
  const store = open();
  store.applySettingsPreset(preset, defaults());
  write(store, { workflowPath: defaults().workflowPath });
  store.applySettingsPreset(preset, defaults());
  assert.equal(saved(store).workflowPath, defaults().workflowPath);
}));

test('a preset whose target package is not known yet waits and applies once it appears', () => withStore(open => {
  const store = open();
  assert.equal(store.applySettingsPreset(preset, undefined), false);
  assert.equal(saved(store), undefined, 'nothing is written while the target is unknown');
  assert.equal(store.applySettingsPreset(preset, defaults()), true);
  assert.deepEqual(saved(store), preset.values);
}));

test('a preset already applied under the former rule is not applied again; one recorded as skipped applies now', () => withStore((open, file) => {
  let store = open();
  write(store, { workflowPath: '.github/workflows/former.yml' });
  store.close();
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, 1, ?)').run(`settings-preset:${preset.id}`, JSON.stringify({ applied: true }));
  db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, 1, ?)').run('settings-preset:acme.skipped', JSON.stringify({ applied: false }));
  db.close();
  store = open();
  write(store, { workflowPath: defaults().workflowPath });
  assert.equal(store.applySettingsPreset(preset, defaults()), false);
  assert.equal(saved(store).workflowPath, defaults().workflowPath);
  assert.equal(store.applySettingsPreset({ ...preset, id: 'acme.skipped' }, defaults()), true, 'a fresh workspace the former rule skipped gets the preset once');
  assert.equal(saved(store).jobName, 'acme-review');
  assert.equal(store.applySettingsPreset({ ...preset, id: 'acme.skipped', values: { jobName: 'again' } }, defaults()), false);
}));
