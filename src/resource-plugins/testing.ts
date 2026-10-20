/** Test-only authoring entry point. Never import this from a production catalog. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject, ResourcePluginDefinition } from './types.ts';
import { ResourcePluginRegistry } from './registry.ts';
import { registryFromDescriptions } from './describe.client.ts';
import { presentResource } from './views.ts';
import { WorkspaceControl, MemoryStore } from '../../packages/core/control.ts';

export function resourcePluginContract(plugin: ResourcePluginDefinition, fixtures: { valid: JsonObject; invalid: JsonObject[] }) {
  test(`${plugin.id}: shared definition, UI/MCP description, commands, persistence and unavailable-record contract`, async () => {
    const registry = new ResourcePluginRegistry(); registry.register(plugin);
    const descriptions = JSON.parse(JSON.stringify(registry.describe())), rendererRegistry = registryFromDescriptions(descriptions);
    assert.equal(descriptions[0].migrations, undefined, 'executable migrations must never reach a renderer/MCP description');
    const store = new MemoryStore(), control = new WorkspaceControl(store, registry);
    const actor = { kind: 'user' as const, id: 'plugin-contract' };
    await control.dispatch({ commandId: 'create', expectedRevision: 0, actor, commands: [
      { type: 'project.create', id: 'project', title: 'Fixture project', position: { x: 0, y: 0 } },
      { type: 'item.create', id: 'item', projectId: 'project', position: { x: 300, y: 0 }, resource: { id: 'resource', pluginId: plugin.id, schemaVersion: plugin.schemaVersion, title: 'Fixture item', data: fixtures.valid } },
    ] });
    const created = await control.read(), resource = created.resources[0];
    assert.equal(registry.resolve(resource).available, true); assert.equal(rendererRegistry.resolve(resource).available, true);
    assert.equal(presentResource(rendererRegistry, resource).typeName, plugin.name);
    const reloaded = new WorkspaceControl(new MemoryStore(JSON.parse(JSON.stringify(created))), registry);
    assert.deepEqual(await reloaded.read(), created, 'round-trip must preserve all resource and map identity');
    for (const invalid of fixtures.invalid) {
      await assert.rejects(control.dispatch({ commandId: 'invalid', expectedRevision: created.revision, actor, commands: [{ type: 'item.update', id: 'item', data: invalid }] }));
      assert.deepEqual(await control.read(), created, 'invalid data must be rejected atomically');
    }
    await control.dispatch({ commandId: 'alias', expectedRevision: created.revision, actor, commands: [
      { type: 'item.create', id: 'second', position: { x: 600, y: 0 }, resource: { ...resource, id: 'second-resource' } },
      { type: 'link.save', link: { id: 'reference', sourceId: 'item', targetId: 'project', kind: 'reference' } },
      { type: 'todo.save', todo: { id: 'todo', title: 'Track item', nodeIds: ['item'] } },
      { type: 'node.archive', id: 'item' },
    ] });
    const archived = await control.read(); assert.ok(archived.nodes.find(n => n.id === 'item')!.archivedAt);
    assert.equal(archived.resources.length, registry.identity(resource) ? 1 : 2, 'provider identity deduplicates resources, never map aliases');
    await control.dispatch({ commandId: 'restore', expectedRevision: archived.revision, actor, commands: [{ type: 'node.restore', id: 'item' }] });
    const restored = await control.read(); assert.equal(restored.links[0].id, 'reference'); assert.equal(restored.todos[0].nodeIds[0], 'item');
    const missing = new ResourcePluginRegistry(), newer = { ...resource, schemaVersion: plugin.schemaVersion + 1 };
    assert.equal(presentResource(missing, resource).available, false); assert.equal(registry.resolve(newer).available, false);
    assert.deepEqual(missing.resolve(resource).resource, resource); assert.deepEqual(registry.resolve(newer).resource, newer);
  });
}

export function resourceConnectorContract(plugin: ResourcePluginDefinition, fixtures: {
  valid: JsonObject;
  connector(): import('./types.ts').ResourcePluginConnector;
  actions?: Record<string, JsonObject>;
}) {
  test(`${plugin.id}: shared connector dispatch, action schema, context and cancellation contract (fixtures only)`, async () => {
    const { ResourcePluginHost } = await import('./host.ts');
    const registry = new ResourcePluginRegistry(); registry.register(plugin); const host = new ResourcePluginHost(registry);
    host.register(plugin.id, fixtures.connector());
    const resource = { id: 'contract-resource', pluginId: plugin.id, schemaVersion: plugin.schemaVersion, title: 'Fixture title', ...(plugin.connectionProvider ? { connectionId: 'fixture-account' } : {}), data: structuredClone(fixtures.valid) }, before = structuredClone(resource);
    const signal = AbortSignal.timeout(3000), snapshot = await host.load(resource, signal);
    assert.ok(['working', 'idle', 'complete', 'unknown'].includes(snapshot.activity)); assert.ok(['none', 'input', 'review', 'error'].includes(snapshot.attention));
    assert.equal(snapshot.connection, 'connected'); assert.equal(typeof snapshot.label, 'string'); assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
    const actions = host.actions(resource, signal); assert.equal(new Set(actions.map(action => action.id)).size, actions.length);
    assert.deepEqual(actions.map(action => action.id).sort(), Object.keys(fixtures.actions ?? {}).sort(), 'provide a fixture for every advertised connector action');
    for (const action of actions) {
      await host.execute(resource, action.id, fixtures.actions![action.id], signal);
      if (action.inputFields && Object.keys(action.inputFields).length) await assert.rejects(host.execute(resource, action.id, Object.fromEntries(Object.keys(action.inputFields).map(key => [key, null])), signal), /invalid/);
    }
    await assert.rejects(host.execute(resource, 'unadvertised', {}, signal), /not available/);
    if (host.capabilities(plugin.id).context) {
      const context = await host.getContext(resource, signal); assert.equal(context.resourceId, resource.id); assert.ok(context.title.trim()); assert.equal(typeof context.content, 'string');
      assert.ok(context.content.length <= 200_000, 'context must be bounded before aggregation');
    }
    assert.deepEqual(resource, before, 'connector reads must not mutate the saved record');
    for (const [field, definition] of Object.entries(plugin.creation?.fields ?? plugin.fields ?? {})) {
      if (definition.optionsSource !== 'resource.options') continue;
      const result = await host.creationOptions(plugin.id, field, {}, signal);
      assert.ok(Array.isArray(result.options)); assert.ok(!result.default || result.options.includes(result.default));
      assert.equal(new Set(result.options).size, result.options.length);
      await assert.rejects(async () => host.creationOptions(plugin.id, field, {}, AbortSignal.abort()), { name: 'AbortError' });
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(async () => host.load(resource, controller.signal), { name: 'AbortError' });
    await assert.rejects(host.execute(resource, 'unadvertised', {}, controller.signal), { name: 'AbortError' });
  });
}
