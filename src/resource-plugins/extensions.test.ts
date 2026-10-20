import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { defineResourcePlugin, fieldDefaults, validateCreationFields } from './define.ts';
import { MemoryStore, WorkspaceControl } from '../../packages/core/control.ts';
import { ResourcePluginHost } from './host.ts';
import { presentResource, ResourceViewRegistry } from './views.ts';
import { createResourcePluginHost } from './catalog.server.ts';
import type { ResourceSnapshot, ResourceViewServices } from './types.ts';
import { registryFromDescriptions } from './describe.client.ts';
import { mapSizeProfile, resolveMapSize, mapSizeLimits } from '../../packages/core/item-map-sizes.ts';

const build = defineResourcePlugin({
  id: 'custom.build', apiVersion: 1, schemaVersion: 3, name: 'Build run', icon: 'workflow',
  preferredView: 'focus', creation: { label: 'Track build' },
  fields: {
    number: { label: 'Build number', kind: 'number', required: true, integer: true, min: 1 },
    environment: { label: 'Environment', kind: 'select', required: true, options: ['preview', 'production'] },
  },
});

test('project directory defaults work for new plugin fields without overwriting explicit or saved values', async () => {
  const fields = { folder: { label: 'Working directory', kind: 'directory' as const, required: true, fromProject: 'workingDirectory' as const }, other: { label: 'Output folder', kind: 'directory' as const } };
  const plugin = defineResourcePlugin({ ...build, id: 'custom.local', fields, validateData: undefined });
  const registry = createResourcePluginRegistry([plugin]), control = new WorkspaceControl(new MemoryStore(), registry);
  const client = registryFromDescriptions(registry.describe()).get(plugin.id)!;
  assert.deepEqual(fieldDefaults(client.fields, { workingDirectory: '/project' }), { folder: '/project' });
  assert.deepEqual(fieldDefaults(fields, { workingDirectory: '/project' }, { folder: '/chosen' }), { folder: '/chosen' });
  assert.deepEqual(fieldDefaults(fields, undefined), {});
  assert.equal(validateCreationFields(fields, {}), true); // Creator resolves the project default.
  assert.equal(validateCreationFields(fields, { folder: '' }), false);
  await control.apply({ type: 'project.create', id: 'p', title: 'Project', workingDirectory: '/project', position: { x: 0, y: 0 } }, 0);
  const command = { commandId: 'create', expectedRevision: 1, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'one', resourceId: 'r', pluginId: plugin.id, title: 'Local item', data: {}, projectId: 'p', position: { x: 300, y: 0 } }] };
  await control.dispatch(command);
  await control.apply({ type: 'node.update', id: 'p', workingDirectory: '/changed' }, 2);
  assert.equal((await control.dispatch(command)).replayed, true);
  assert.equal((await control.read()).resources[0].data.folder, '/project');
  await control.apply({ type: 'item.add', id: 'two', resourceId: 'r2', pluginId: plugin.id, title: 'Override', data: { folder: '/chosen' }, projectId: 'p', position: { x: 600, y: 0 } }, 3);
  assert.equal((await control.read()).resources[1].data.folder, '/chosen');
  await assert.rejects(control.apply({ type: 'item.add', id: 'floating', resourceId: 'r3', pluginId: plugin.id, title: 'Missing directory', data: {}, position: { x: 900, y: 0 } }, 4), /invalid/);
});

test('plugin map sizes survive discovery and reject undeclared fields without host branches', () => {
  const plugin = { ...build, mapSizes: { defaultSize: 'small' as const, sizes: {
    small: { width: 120, height: 48, summaryLines: 0, description: 'Build title.' },
    medium: { width: 260, height: 104, summaryLines: 1, fields: ['environment'], fieldLines: 1, description: 'Build status and environment.' },
  } } };
  const registry = createResourcePluginRegistry([plugin]);
  const client = registryFromDescriptions(registry.describe());
  const record = registry.createRecord(build.id, 'build', { title: 'Build', data: { number: 42, environment: 'preview' } });
  assert.deepEqual(resolveMapSize({ mapSize: 'medium' }, record, client.get(build.id)), resolveMapSize({ mapSize: 'medium' }, record, registry.get(build.id)));
  assert.deepEqual(mapSizeProfile(client.get(build.id)).sizes.medium?.fields, ['environment']);
  assert.throws(() => createResourcePluginRegistry([{ ...plugin, mapSizes: { defaultSize: 'large', sizes: plugin.mapSizes.sizes } }]), /supported default/);
  assert.throws(() => createResourcePluginRegistry([{ ...plugin, mapSizes: { defaultSize: 'small', sizes: { small: { ...plugin.mapSizes.sizes.small, fields: ['privateUndeclaredField'] } } } }]), /Invalid map/);
  assert.equal(mapSizeLimits({ width: 120, height: 80, summaryLines: 1, description: 'Native narrow plugin.' }).minWidth, 120);
});

test('new types share creation, data schemas, defaults and validation without core edits', () => {
  const registry = createResourcePluginRegistry([build]);
  const description = registry.creationTypes().find(p => p.id === build.id)!;
  assert.equal(description.creation?.label, 'Track build');
  assert.deepEqual(description.dataSchema?.required, ['number', 'environment']);
  assert.equal(JSON.stringify(description).includes('validateData'), false);
  assert.equal(registry.creationTypes().some(p => p.id === 'code.review'), false);
  const draft = { title: '  Preview build 42  ', data: { number: 42, environment: 'preview' } };
  const resource = registry.createRecord(build.id, 'resource-build', draft);
  assert.equal(resource.schemaVersion, 3);
  assert.equal(resource.title, 'Preview build 42');
  draft.data.number = 99;
  assert.equal(resource.data.number, 42);
  assert.deepEqual(presentResource(registry, resource).appearance, { size: 'small', tone: 'neutral', shape: 'rounded' });
  assert.throws(() => registry.createRecord(build.id, 'invalid', { title: 'Invalid', data: { number: 0, environment: 'preview' } }), /invalid/);
  assert.throws(() => registry.createRecord(build.id, 'invalid', { title: 'Invalid', data: { number: 1, environment: 'unknown' } }), /invalid/);
  assert.throws(() => registry.createRecord('code.review', 'review', { title: 'Review', data: {} }), /provider/);
});

test('connectors dispatch advertised actions and context, validate input, and honor abort', async () => {
  const registry = createResourcePluginRegistry([build]);
  const resource = registry.createRecord(build.id, 'build', { title: 'Build', data: { number: 42, environment: 'preview' } });
  const host = new ResourcePluginHost(registry);
  let calls = 0;
  host.register(build.id, {
    async load() { return { activity: 'working', attention: 'none', connection: 'connected', label: 'Building', observedAt: new Date().toISOString() }; },
    actions: () => [{ id: 'retry', label: 'Retry', inputFields: { clean: { label: 'Clean build', kind: 'boolean', required: true } } }],
    async execute(item, action, signal, input) { calls++; assert.equal(item.id, resource.id); return { action, clean: input!.clean }; },
    async getContext(item) { return { resourceId: item.id, title: item.title, content: 'Build 42 in preview' }; },
  });
  const signal = new AbortController().signal;
  assert.equal((await host.load(resource, signal)).activity, 'working');
  assert.deepEqual(host.actions(resource, signal)[0].inputSchema?.required, ['clean']);
  assert.equal((await host.getContext(resource, signal)).content, 'Build 42 in preview');
  await assert.rejects(host.execute(resource, 'not-advertised', {}, signal), /not available/);
  await assert.rejects(host.execute(resource, 'retry', { clean: 'yes' }, signal), /invalid/);
  assert.equal(calls, 0);
  assert.deepEqual(await host.execute(resource, 'retry', { clean: false }, signal), { action: 'retry', clean: false });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(host.execute(resource, 'retry', { clean: true }, cancelled.signal), /abort/i);
  assert.equal(calls, 1);
  assert.throws(() => host.watch(resource, () => {}, signal), /subscriptions/);
  assert.throws(() => host.register(build.id, { async load() { throw Error(); } }), /already registered/);
});

test('custom views and generic fallback share lifecycle without owning the session', () => {
  const registry = createResourcePluginRegistry([build]);
  const resource = registry.createRecord(build.id, 'build', { title: 'Build', data: { number: 42, environment: 'preview' } });
  const views = new ResourceViewRegistry(registry);
  const container = {} as HTMLElement; // These test mounts have no DOM dependency.
  const services: ResourceViewServices = { openResource() {}, async runAction() {}, attachTerminal() { throw new Error('No session attachment requested'); } };
  let mounts = 0, updates = 0, disposed = 0, fallbackCalls = 0;
  views.register(build.id, { mountDetail(element, item, supplied) {
    assert.equal(element, container); assert.equal(item.id, resource.id); assert.equal(supplied, services);
    mounts++;
    return { update() { updates++; }, dispose() { disposed++; } };
  } });
  const fallback = (_container: HTMLElement, item: ReturnType<typeof presentResource>) => {
    fallbackCalls++;
    assert.equal(item.title, 'Build');
    return { update() {}, dispose() {} };
  };
  const detail = views.mount('detail', container, resource, services, fallback);
  detail.update({ activity: 'working' } as ResourceSnapshot);
  detail.dispose(); detail.dispose(); detail.update({ activity: 'complete' } as ResourceSnapshot);
  assert.deepEqual({ mounts, updates, disposed }, { mounts: 1, updates: 1, disposed: 1 });
  views.mount('node', container, resource, services, fallback); // Optional custom node view absent.
  for (const changed of [{ ...resource, pluginId: 'missing.type' }, { ...resource, schemaVersion: 8 }]) {
    const before = structuredClone(changed);
    assert.equal(presentResource(registry, changed).available, false);
    views.mount('detail', container, changed, services, fallback);
    assert.deepEqual(changed, before);
  }
  assert.equal(fallbackCalls, 3);
  assert.equal(mounts, 1);
});

test('bookmark example is functional without credentials or URL fetching', async () => {
  const registry = createResourcePluginRegistry();
  const host = createResourcePluginHost(registry);
  const resource = registry.createRecord('web.bookmark', 'reference', { title: 'Design notes', data: { url: 'https://example.com/design', notes: 'Billing requirements' } });
  const signal = new AbortController().signal;
  assert.equal((await host.load(resource, signal)).activity, 'idle');
  assert.equal((await host.getContext(resource, signal)).content, 'Billing requirements');
  assert.deepEqual(await host.execute(resource, 'reference', {}, signal), { text: 'Design notes: https://example.com/design' });
  assert.throws(() => registry.createRecord('web.bookmark', 'unsafe', { title: 'URL', data: { url: 'javascript:alert(1)' } }), /invalid/);
  const missing = { ...resource, pluginId: 'missing.plugin' };
  assert.throws(() => host.load(missing, signal), /not installed/);
  assert.deepEqual(resource.data, { url: 'https://example.com/design', notes: 'Billing requirements' });
});
