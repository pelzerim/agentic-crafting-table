import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { SqliteStore, migrations } from './sqlite-store.ts';
import { DatabaseSync } from 'node:sqlite';
import { PluginStore } from './plugin-store.ts';
import { loadBuilds } from './plugin-loader.ts';
import { samplePluginRepository } from '../../tests/fixtures/plugin-repo.ts';
import { agentRuntimeRefusal, runtimeOperationDeclarations } from '../core/runtime.ts';
import { buildAgentToolContext } from '../../src/agents/tool-context.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { createPluginPackageRegistry, useInstalledPackages } from '../../src/resource-plugins/builtins.ts';
import { BREAKER_FAILURES, PluginBreaker, guardPlugin } from '../../src/resource-plugins/plugin-guard.ts';

const sample = resolve(import.meta.dirname, '../../tests/fixtures/plugins/sample');
const options = { assignments: [], pluginTimeoutMs: 400 };

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plugin-loader-'));
  try { await work(directory); } finally { useInstalledPackages([]); await rm(directory, { recursive: true, force: true }); }
}
/** Approves a package with the store the service will read, outside the running service. */
async function approve(directory: string, work: (plugins: PluginStore) => Promise<unknown>) {
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { return await work(new PluginStore(directory, store)); } finally { store.close(); }
}
/** A development copy of the sample package whose service entry is replaced. */
function variant(directory: string, name: string, service: string, manifest: Record<string, unknown> = {}) {
  const folder = join(directory, name);
  cpSync(sample, folder, { recursive: true });
  writeFileSync(join(folder, 'dist/service.mjs'), service);
  writeFileSync(join(folder, 'act-plugin.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(sample, 'act-plugin.json'), 'utf8')), ...manifest }));
  return folder;
}
const addCard = { commandId: 'card', expectedRevision: 0, actor: { kind: 'user' as const, id: 'test' }, commands: [{ type: 'item.add' as const, id: 'card', resourceId: 'card-resource', pluginId: 'sample.card', title: 'Kept card', position: { x: 0, y: 0 }, data: { text: 'keep me' } }] };

test('an installed package registers exactly like a bundled one: type, connector, operation, guide and agent policy', () => fixture(async directory => {
  const repository = await samplePluginRepository(directory);
  await approve(directory, async plugins => plugins.install({ id: 'sample', commit: (await plugins.prepare({ url: repository.url, ref: 'v1.0.0' })).commit }));
  const service = await startWorkspaceService(directory, undefined, undefined, options), client = await connectWorkspace(directory);
  try {
    assert.ok(service.control.registry.get('sample.card'));
    assert.ok(createPluginPackageRegistry().get('sample'), 'other registries in the process see the package');
    await service.control.dispatch(addCard);
    const read = await client.call<{ label: string; detail?: { text?: string } }>('runtime.run', { action: 'resource.read', nodeId: 'card' });
    assert.deepEqual([read.label, read.detail], ['Sample card', { text: 'keep me' }]);
    assert.deepEqual(await client.call('runtime.run', { action: 'sample.echo', nodeId: 'card', arguments: { hello: 'world' } }), { echo: { hello: 'world' }, plugin: 'sample' });
    assert.ok(runtimeOperationDeclarations().some(operation => operation.id === 'sample.echo'));
    assert.equal(agentRuntimeRefusal({ action: 'sample.echo', arguments: {} }), humanOnlyMessage);
    assert.match(buildAgentToolContext().prompt, /Sample cards hold one line of text\./);
    const loaded = await client.call<{ plugins: { id: string; dev: boolean; css: string[] }[] }>('plugins.loaded');
    assert.deepEqual(loaded.plugins.map(plugin => [plugin.id, plugin.dev, plugin.css]), [['sample', false, ['dist/renderer.css']]]);
    const status = await client.call<{ installed: { id: string; running?: unknown }[]; restartRequired: boolean }>('plugins.installed');
    assert.ok(status.installed[0].running); assert.equal(status.restartRequired, false);
    const discovered = await client.call<{ packages: { id: string; running: boolean }[] }>('plugins.discover', {});
    assert.deepEqual(discovered.packages.map(entry => [entry.id, entry.running]), [['sample', true]]);
  } finally { client.close(); await service.close(); }
}));

test('a throwing or hanging activation turns only that package off, with a reason, and keeps its items as placeholders', () => fixture(async directory => {
  const throwing = variant(directory, 'throwing', `export default { activate() { throw new Error('boom at start'); } };`);
  await approve(directory, async plugins => { await plugins.prepareFolder(throwing); return plugins.install({ id: 'sample', commit: 'dev' }); });
  let service = await startWorkspaceService(directory, undefined, undefined, options);
  try {
    assert.equal(service.control.registry.get('sample.card'), undefined);
    assert.equal(createPluginPackageRegistry().get('sample'), undefined);
    assert.ok(service.control.registry.get('workspace.note'), 'bundled packages are unaffected');
  } finally { await service.close(); }
  let lock = await approve(directory, async plugins => plugins.get('sample'));
  assert.deepEqual([(lock as any).enabled, (lock as any).failure.reason], [false, 'boom at start']);
  const hanging = variant(directory, 'hanging', `export default { activate() { return new Promise(() => {}); } };`);
  await approve(directory, async plugins => { await plugins.prepareFolder(hanging); return plugins.install({ id: 'sample', commit: 'dev' }); });
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try {
    const resource = { id: 'r', pluginId: 'sample.card', schemaVersion: 1, title: 'Card', data: { text: 'x' } };
    const resolved = service.control.registry.resolve(resource);
    assert.equal(resolved.available, false);
    assert.match(resolved.available ? '' : resolved.reason, /Sample cards could not load and is turned off\. Its items are kept\. Its service code did not start within 0\.4 s\./);
  } finally { await service.close(); }
  lock = await approve(directory, async plugins => plugins.get('sample'));
  assert.match((lock as any).failure.reason, /did not start within/);
}));

test('an incompatible API range or changed file after install is refused at load', () => fixture(async directory => {
  const failures = (await loadBuilds([{ id: 'sample', commit: 'dev', dev: true, root: variant(directory, 'future', 'export default { activate() {} };', { apiRange: '^2.0.0' }) }], { service: true })).failures;
  assert.match(failures[0].reason, /needs plugin API \^2\.0\.0; this app provides 1\.3\.0/);
  const repository = await samplePluginRepository(directory);
  const installed = await approve(directory, async plugins => plugins.install({ id: 'sample', commit: (await plugins.prepare({ url: repository.url, ref: 'v1.0.0' })).commit })) as { current: { commit: string } };
  writeFileSync(join(directory, 'plugins/store/sample', installed.current.commit, 'dist/definitions.mjs'), 'export default { definitions: [] };');
  const service = await startWorkspaceService(directory, undefined, undefined, options);
  try { assert.equal(service.control.registry.get('sample.card'), undefined); } finally { await service.close(); }
  const lock = await approve(directory, async plugins => plugins.get('sample'));
  assert.match((lock as any).failure.reason, /changed: dist\/definitions\.mjs/);
}));

test('removing a package keeps its items as placeholders and reinstalling brings them back unchanged', () => fixture(async directory => {
  const repository = await samplePluginRepository(directory);
  await approve(directory, async plugins => plugins.install({ id: 'sample', commit: (await plugins.prepare({ url: repository.url, ref: 'v1.0.0' })).commit }));
  let service = await startWorkspaceService(directory, undefined, undefined, options);
  await service.control.dispatch(addCard);
  const before = await service.control.read();
  await service.close();
  await approve(directory, async plugins => plugins.remove('sample'));
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try {
    const state = await service.control.read(), resolved = service.control.registry.resolve(state.resources[0]);
    assert.deepEqual(state.resources, before.resources); assert.deepEqual(state.nodes, before.nodes);
    assert.equal(resolved.available, false);
    assert.match(resolved.available ? '' : resolved.reason, /Sample cards was removed\. Its items are kept/);
  } finally { await service.close(); }
  await approve(directory, async plugins => plugins.install({ id: 'sample', commit: (await plugins.prepare({ url: repository.url, ref: 'v1.0.0' })).commit }));
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try {
    const state = await service.control.read();
    assert.equal(service.control.registry.resolve(state.resources[0]).available, true);
    assert.deepEqual(state.resources, before.resources);
  } finally { await service.close(); }
}));

test('a package settings preset applies at startup to settings saved before package settings existed', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite'), saved = new SqliteStore(file);
  const initial = saved.readSettings(); saved.writeSettings({ expectedRevision: initial.revision, value: { ...initial.value, keepAwake: true } }); saved.close();
  const old = new DatabaseSync(file); old.exec(`PRAGMA user_version = ${migrations.findIndex(migration => migration.includes('settings:before-plugin-settings'))}`); old.close();
  const values = { workflowPath: '.github/workflows/team-review.yml', jobName: 'team-review', failureText: 'team review did not complete' };
  const folder = variant(directory, 'preset', 'export default { activate() {} };', { contributes: { ...JSON.parse(readFileSync(join(sample, 'act-plugin.json'), 'utf8')).contributes, settingsPresets: ['sample.review-workflow'] } });
  const definitions = readFileSync(join(folder, 'dist/definitions.mjs'), 'utf8').replace('agentGuide:', `settingsPresets: [{ id: 'sample.review-workflow', packageId: 'github.review-run', values: ${JSON.stringify(values)} }],\n  agentGuide:`);
  writeFileSync(join(folder, 'dist/definitions.mjs'), definitions);
  await approve(directory, async plugins => { const candidate = await plugins.prepareFolder(folder); assert.ok(candidate.changes.added.includes('Preset for another package’s settings sample.review-workflow')); return plugins.install({ id: 'sample', commit: 'dev' }); });
  const service = await startWorkspaceService(directory, undefined, undefined, options);
  try {
    assert.deepEqual(service.store.readSettings().value.plugins['github.review-run'], values);
  } finally { await service.close(); }
}));

/** The sample package with one settings preset for the built-in /review settings. */
function presetVariant(directory: string, values: Record<string, unknown>, name = 'preset', packageId = 'github.review-run') {
  const folder = variant(directory, name, 'export default { activate() {} };', { contributes: { ...JSON.parse(readFileSync(join(sample, 'act-plugin.json'), 'utf8')).contributes, settingsPresets: ['sample.review-workflow'] } });
  const definitions = readFileSync(join(folder, 'dist/definitions.mjs'), 'utf8').replace('agentGuide:', `settingsPresets: [{ id: 'sample.review-workflow', packageId: '${packageId}', values: ${JSON.stringify(values)} }],\n  agentGuide:`);
  writeFileSync(join(folder, 'dist/definitions.mjs'), definitions);
  return folder;
}

test('a package settings preset applies when the package first loads in a fresh workspace, once, and its values stay after removal', () => fixture(async directory => {
  const values = { workflowPath: '.github/workflows/team-review.yml', jobName: 'team-review' };
  let service = await startWorkspaceService(directory, undefined, undefined, options);
  const before = service.store.readSettings().value.plugins['github.review-run'];
  await service.close();
  assert.equal(before, undefined, 'a fresh workspace has no /review settings');
  await approve(directory, async plugins => { await plugins.prepareFolder(presetVariant(directory, values)); return plugins.install({ id: 'sample', commit: 'dev' }); });
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try { assert.deepEqual(service.store.readSettings().value.plugins['github.review-run'], values); } finally { await service.close(); }
  await approve(directory, async plugins => { await plugins.prepareFolder(presetVariant(directory, { ...values, jobName: 'changed-preset' }, 'preset-2')); return plugins.install({ id: 'sample', commit: 'dev' }); });
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try { assert.equal(service.store.readSettings().value.plugins['github.review-run'].jobName, 'team-review', 'an update does not apply the same preset id again'); } finally { await service.close(); }
  await approve(directory, async plugins => plugins.remove('sample'));
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try { assert.deepEqual(service.store.readSettings().value.plugins['github.review-run'], values, 'removing the package leaves the applied values'); } finally { await service.close(); }
}));

test('a package preset for the app sets the working animal when the package first loads', () => fixture(async directory => {
  let service = await startWorkspaceService(directory, undefined, undefined, options);
  assert.equal(service.store.readSettings().value.workingMark.animal, 'sheep');
  await service.close();
  await approve(directory, async plugins => { await plugins.prepareFolder(presetVariant(directory, { workingMark: { animal: 'raccoon', helpers: 'kits' } }, 'app-preset', 'app')); return plugins.install({ id: 'sample', commit: 'dev' }); });
  service = await startWorkspaceService(directory, undefined, undefined, options);
  try { assert.deepEqual(service.store.readSettings().value.workingMark, { animal: 'raccoon', helpers: 'kits' }); } finally { await service.close(); }
}));

test('the breaker pauses a package after repeated failures, ignores cancellations and recovers after a success', async () => {
  let now = 0;
  const breaker = new PluginBreaker('acme', () => now);
  let fail = true;
  const connector = guardPlugin({ async load() { if (fail) throw new Error('provider down'); return 'ok'; } }, breaker);
  const quiet = guardPlugin({ observe() { throw new Error('observer bug'); } }, breaker, 'quiet');
  const aborted = guardPlugin({ async load() { throw Object.assign(new Error('stopped'), { name: 'AbortError' }); } }, breaker);
  for (let index = 0; index < 5; index++) await assert.rejects(aborted.load(), /stopped/);
  assert.equal(breaker.status.paused, false, 'cancellations are not failures');
  for (let index = 0; index < BREAKER_FAILURES - 1; index++) await assert.rejects(connector.load(), /provider down/);
  assert.equal(quiet.observe(), undefined);
  assert.deepEqual(breaker.status, { paused: true, until: 5 * 60_000, reason: 'observer bug' });
  await assert.rejects(async () => connector.load(), /paused after 10 failures in a row/);
  now = 5 * 60_000 + 1; fail = false;
  assert.equal(await connector.load(), 'ok');
  assert.equal(breaker.status.paused, false);
});

test('agent-facing MCP code has no path that installs, updates or enables plugins', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../mcp/service-server.ts'), 'utf8');
  for (const method of ['plugins.prepare', 'plugins.prepareFolder', 'plugins.install', 'plugins.enable', 'plugins.rollback', 'plugins.remove']) assert.equal(source.includes(`'${method}'`), false, method);
});

test('an installed package can register runtime operations after activation, e.g. when the workspace is ready', () => fixture(async directory => {
  const late = variant(directory, 'late', `export default { activate(host) {
    host.connector('sample.card', { async load() { return { activity: 'idle', attention: 'none', connection: 'connected', label: 'Sample card', observedAt: new Date().toISOString() }; } });
    host.onWorkspace(() => { host.runtimeOperation('sample.echo', context => ({ late: context.arguments })); });
  } };`);
  await approve(directory, async plugins => { await plugins.prepareFolder(late); return plugins.install({ id: 'sample', commit: 'dev' }); });
  const service = await startWorkspaceService(directory, undefined, undefined, options), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch(addCard);
    assert.deepEqual(await client.call('runtime.run', { action: 'sample.echo', nodeId: 'card', arguments: { ok: 1 } }), { late: { ok: 1 } });
  } finally { client.close(); await service.close(); }
}));
