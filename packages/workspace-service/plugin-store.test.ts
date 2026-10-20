import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, cpSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseGitSource } from './plugin-source.ts';
import { PluginStore } from './plugin-store.ts';
import { SqliteStore, migrations } from './sqlite-store.ts';
import { readPluginLock } from './plugin-lock.ts';
import { samplePluginRepository, sampleManifest } from '../../tests/fixtures/plugin-repo.ts';

async function fixture(work: (directory: string, store: SqliteStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plugin-store-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await work(directory, store); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('git sources accept https, ssh, scp-like and local repositories with a safe ref', () => {
  assert.deepEqual(parseGitSource({ url: ' https://github.com/example/my-plugin-pack.git ', ref: 'v1.2.0' }), { url: 'https://github.com/example/my-plugin-pack.git', ref: 'v1.2.0' });
  assert.deepEqual(parseGitSource({ url: 'git@github.com:example/my-plugin-pack.git' }), { url: 'git@github.com:example/my-plugin-pack.git', ref: 'HEAD' });
  assert.equal(parseGitSource({ url: 'ssh://git@example.com:2222/acme/plugins.git', ref: 'release/1.x' }).ref, 'release/1.x');
  assert.equal(parseGitSource({ url: 'file:///Users/me/plugins.git', ref: 'a'.repeat(40) }).url, 'file:///Users/me/plugins.git');
  assert.equal(parseGitSource({ url: '/Users/me/plugins.git' }).url, '/Users/me/plugins.git');
  for (const url of ['http://example.com/p.git', 'git://example.com/p.git', 'ext::sh -c touch% /tmp/x', '-oProxyCommand=touch /tmp/x', 'https://user:token@github.com/a/b.git', 'https://token@github.com/a/b.git', 'file://host/share/p.git', 'relative/path', 'https://exa mple.com/a', ''])
    assert.throws(() => parseGitSource({ url }), Error, url);
  for (const ref of ['--upload-pack=touch', 'a..b', 'main@{1}', 'refs/heads/', 'x.lock', 'with space', 'a//b'])
    assert.throws(() => parseGitSource({ url: 'https://github.com/a/b.git', ref }), /branch, tag or commit/, ref);
});

test('installing pins the resolved commit, verifies the release and records the approval in the lock', () => fixture(async (directory, store) => {
  const repository = await samplePluginRepository(directory), plugins = new PluginStore(directory, store, { now: () => new Date('2026-10-01T12:00:00Z') });
  const candidate = await plugins.prepare({ url: repository.url, ref: 'v1.0.0' });
  const commit = readFileSync(join(directory, 'sample-plugin.git/refs/tags/v1.0.0'), 'utf8').trim();
  assert.equal(candidate.commit, commit); assert.equal(candidate.id, 'sample'); assert.equal(candidate.version, '1.0.0'); assert.equal(candidate.dev, false);
  assert.deepEqual(candidate.contributes.itemTypes, ['sample.card']); assert.deepEqual(candidate.code, { service: true, renderer: true });
  assert.ok(candidate.changes.added.includes('Item type sample.card')); assert.equal(candidate.installed, undefined);
  assert.equal(plugins.list().length, 0, 'fetching alone installs nothing');
  await assert.rejects(plugins.install({ id: 'sample', commit: 'f'.repeat(40) }), /Fetch this plugin again/);
  const installed = await plugins.install({ id: 'sample', commit });
  assert.equal(installed.current.commit, commit); assert.equal(installed.current.approvedAt, '2026-10-01T12:00:00.000Z'); assert.equal(installed.enabled, true);
  assert.deepEqual(Object.keys(installed.current.integrity!), ['act-plugin.json', 'dist/definitions.mjs', 'dist/renderer.css', 'dist/renderer.mjs', 'dist/service.mjs']);
  const root = plugins.releaseRoot(installed, installed.current);
  assert.equal(root, join(directory, 'plugins/store/sample', commit));
  assert.ok(existsSync(join(root, 'dist/renderer.mjs'))); assert.equal(existsSync(join(root, 'src')), false);
  assert.deepEqual(readPluginLock(store).plugins, [installed]);
  assert.equal('pluginLock' in store.readSettings().value, false, 'the lock is not part of the settings document');
}));

test('a release whose files do not match its integrity file is refused and nothing is stored', () => fixture(async (directory, store) => {
  const repository = await samplePluginRepository(directory), plugins = new PluginStore(directory, store);
  const tampered = await repository.release('v1.0.1', { 'dist/renderer.mjs': 'export default { activate() { globalThis.stolen = true; } };\n' }, { pack: false });
  await assert.rejects(plugins.prepare({ url: repository.url, ref: 'v1.0.1' }), /changed: dist\/renderer\.mjs/);
  assert.equal(existsSync(join(directory, 'plugins/store/sample', tampered)), false);
  repository.commit('v1.0.2', { 'act-plugin.integrity.json': '{}' });
  await assert.rejects(plugins.prepare({ url: repository.url, ref: 'v1.0.2' }), /must be \{ "algorithm": "sha256"/);
  await assert.rejects(plugins.prepare({ url: repository.url, ref: 'v9' }), /v9 was not found/);
  assert.equal(plugins.list().length, 0);
}));

test('updates show what changed, keep the previous build for rollback, and roll back without the network', () => fixture(async (directory, store) => {
  const repository = await samplePluginRepository(directory), plugins = new PluginStore(directory, store);
  const first = (await plugins.prepare({ url: repository.url, ref: 'v1.0.0' })).commit;
  await plugins.install({ id: 'sample', commit: first });
  const second = await repository.release('v1.1.0', { 'act-plugin.json': sampleManifest('1.1.0', { contributes: { itemTypes: ['sample.card'], runtimeOperations: ['sample.echo'], agentGuide: ['sample.guide'], css: [] } }) });
  const update = await plugins.prepare({ url: repository.url, ref: 'v1.1.0' });
  assert.equal(update.commit, second); assert.deepEqual(update.installed, { commit: first, version: '1.0.0', removed: false });
  assert.deepEqual(update.changes, { added: [], removed: ['Stylesheet dist/renderer.css'] });
  assert.equal(plugins.get('sample')!.current.commit, first, 'preparing an update changes nothing until it is approved');
  const updated = await plugins.install({ id: 'sample', commit: second });
  assert.equal(updated.current.version, '1.1.0'); assert.deepEqual(updated.previous.map(release => release.commit), [first]);
  renameSync(join(directory, 'sample-plugin.git'), join(directory, 'moved.git'));
  const rolledBack = await plugins.rollback('sample', first);
  assert.equal(rolledBack.current.commit, first); assert.deepEqual(rolledBack.previous.map(release => release.commit), [second]);
  const offline = await plugins.prepare({ url: repository.url, ref: 'v1.1.0' });
  assert.ok(offline.offline, 'an unreachable remote falls back to the cached repository'); assert.equal(offline.commit, second);
  writeFileSync(join(plugins.releaseRoot(rolledBack, rolledBack.previous[0]), 'dist/service.mjs'), 'tampered');
  await assert.rejects(plugins.rollback('sample', second), /do not match their integrity record/);
}));

test('removing keeps the source for reinstalling; disabling and load failures are recorded', () => fixture(async (directory, store) => {
  const repository = await samplePluginRepository(directory), plugins = new PluginStore(directory, store);
  const commit = (await plugins.prepare({ url: repository.url, ref: 'v1.0.0' })).commit;
  await plugins.install({ id: 'sample', commit });
  assert.equal(plugins.setEnabled('sample', false).enabled, false);
  plugins.recordFailure('sample', 'Activation did not finish within 5 s.');
  assert.equal(plugins.get('sample')!.failure?.reason, 'Activation did not finish within 5 s.');
  const enabled = plugins.setEnabled('sample', true);
  assert.equal(enabled.enabled, true); assert.equal(enabled.failure, undefined);
  const removed = plugins.remove('sample');
  assert.equal(removed.removed, true); assert.equal(removed.enabled, false); assert.deepEqual(removed.source, { kind: 'git', url: repository.url, ref: 'v1.0.0' });
  assert.equal(existsSync(join(directory, 'plugins/store/sample')), false);
  assert.throws(() => plugins.setEnabled('sample', true), /Reinstall/);
  const again = await plugins.prepare({ url: removed.source.kind === 'git' ? removed.source.url : '', ref: 'v1.0.0' });
  assert.deepEqual(again.installed, { commit, version: '1.0.0', removed: true });
  const reinstalled = await plugins.install({ id: 'sample', commit });
  assert.equal(reinstalled.removed, false); assert.equal(reinstalled.enabled, true);
}));

test('development folders load in place, and built-in package ids or item types cannot be taken', () => fixture(async (directory, store) => {
  const plugins = new PluginStore(directory, store), folder = join(directory, 'dev-plugin');
  cpSync(join(import.meta.dirname, '../../tests/fixtures/plugins/sample'), folder, { recursive: true });
  const candidate = await plugins.prepareFolder(folder);
  assert.equal(candidate.dev, true); assert.equal(candidate.commit, 'dev');
  const installed = await plugins.install({ id: 'sample', commit: 'dev' });
  assert.deepEqual(installed.source, { kind: 'folder', path: candidate.source.kind === 'folder' ? candidate.source.path : '' });
  assert.equal(installed.current.integrity, undefined); assert.equal(plugins.releaseRoot(installed, installed.current), candidate.source.kind === 'folder' ? candidate.source.path : '');
  await assert.rejects(plugins.prepareFolder('relative'), /Choose a plugin folder/);
  writeFileSync(join(folder, 'act-plugin.json'), JSON.stringify({ id: 'web.link', name: 'Shadow', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'dist/definitions.mjs' }, contributes: { itemTypes: ['web.link'] } }));
  await assert.rejects(plugins.prepareFolder(folder), /conflicts with the built-in plugin web\.link/);
  writeFileSync(join(folder, 'act-plugin.json'), sampleManifest('1.0.0', { entries: { definitions: 'dist/missing.mjs' } }));
  await assert.rejects(plugins.prepareFolder(folder), /dist\/missing\.mjs, which does not exist/);
}));

test('the plugin lock table is added to existing workspaces without touching their data', () => fixture(async directory => {
  const file = join(directory, 'existing.sqlite');
  let store = new SqliteStore(file);
  await store.update(state => ({ ...state, nodes: [{ id: 'project', title: 'Kept', position: { x: 0, y: 0 } }] } as typeof state));
  store.close();
  const before = migrations.findIndex(migration => migration.includes('plugin_lock'));
  const old = new DatabaseSync(file); old.exec(`DROP TABLE plugin_lock; PRAGMA user_version = ${before};`); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile && existsSync(store.backupFile), 'the upgrade backs up first');
    assert.deepEqual(store.pluginLock(), []);
    store.writePluginLock('acme', { id: 'acme' });
    assert.deepEqual(readPluginLock(store), { plugins: [], unreadable: ['acme'] });
    assert.equal((await store.read()).nodes[0].title, 'Kept');
  } finally { store.close(); }
}));
