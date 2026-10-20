import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginPackageRegistry } from './packages.ts';
import { ServicePluginRuntime } from './service-runtime.ts';
import { ResourceViewRegistry } from './views.ts';
import { defineResourcePlugin } from './define.ts';
import { registryFromDescriptions } from './describe.client.ts';
import type { ActionContribution, ViewContribution } from '../../packages/plugin-sdk/host.ts';
import type { ResourceAction, ResourceViewServices } from './types.ts';

const widget = defineResourcePlugin({ id: 'acme.widget', apiVersion: 1, schemaVersion: 1, name: 'Widget', icon: 'box', preferredView: 'inspector', fields: { name: { label: 'Name', kind: 'text', required: true } } });
const resource = { id: 'r', pluginId: 'acme.widget', schemaVersion: 1, title: 'Widget', data: { name: 'One' } };
const signal = () => AbortSignal.timeout(1000);
function packages() {
  const registry = new PluginPackageRegistry();
  registry.register({ manifest: { id: 'acme', name: 'Acme', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'plugin.ts', service: 'service.ts' }, contributes: { itemTypes: ['acme.widget'] } }, module: { definitions: [widget] } });
  registry.register({ manifest: { id: 'tags', name: 'Tags', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'plugin.ts', service: 'service.ts' }, contributes: { actionContributions: { 'acme.widget': ['tags.options', 'tags.apply'] } } },
    module: { actionMenus: [{ targetTypeId: 'acme.widget', groups: [{ id: 'tags', label: 'Tags', children: [], choices: { load: 'tags.options', apply: 'tags.apply' } }] }] } });
  return registry;
}

test('another package adds declared actions to a type without replacing its own; execution routes to the contributor', async () => {
  const registry = packages(), calls: string[] = [];
  let own: ResourceAction[] = [{ id: 'own', label: 'Own' }];
  let offered: ResourceAction[] = [{ id: 'tags.options', label: 'Tag options', readOnly: true }, { id: 'tags.apply', label: 'Apply tag', humanOnly: true, inputFields: { value: { label: 'Tag', kind: 'text' as const, required: true } } }];
  const tags: ActionContribution = { actions: () => offered, execute: async (_resource, actionId, _signal, input) => { calls.push(`${actionId}:${JSON.stringify(input)}`); return { ok: actionId }; } };
  const runtime = new ServicePluginRuntime(registry, { registry: registry.types }).activate({
    acme: { activate(host) { host.connector('acme.widget', { load: async () => ({ activity: 'idle', attention: 'none', connection: 'connected', label: 'Ready', observedAt: new Date(0).toISOString() }), actions: () => own, execute: async () => 'own' }); } },
    tags: { activate(host) { host.contributeActions('acme.widget', tags); } },
  });
  const host = runtime.host;
  assert.deepEqual(host.actions(resource, signal()).map(action => action.id), ['own', 'tags.options', 'tags.apply']);
  assert.equal(host.actions(resource, signal()).find(action => action.id === 'tags.apply')?.humanOnly, true);
  assert.deepEqual(await host.execute(resource, 'tags.options', {}, signal()), { ok: 'tags.options' });
  assert.equal(await host.execute(resource, 'own', {}, signal()), 'own');
  await assert.rejects(host.execute(resource, 'tags.apply', {}, signal()), /Action input is invalid/);
  assert.deepEqual(calls, ['tags.options:{}']);
  own = [{ id: 'own', label: 'Own' }, { id: 'tags.options', label: 'Already provided' }];
  assert.throws(() => host.actions(resource, signal()), /tags cannot replace the action tags\.options/);
  own = [{ id: 'own', label: 'Own' }];
  offered = [{ id: 'tags.secret', label: 'Undeclared' }];
  assert.throws(() => host.actions(resource, signal()), /tags offers an undeclared action: tags\.secret/);
  offered = [];
  assert.deepEqual(host.actions(resource, signal()).map(action => action.id), ['own'], 'a contribution may offer nothing, e.g. while its setting is off');
  const [description] = registry.types.describe();
  assert.deepEqual(description.contextMenu?.map(group => group.id), ['tags']);
  assert.deepEqual(registryFromDescriptions(JSON.parse(JSON.stringify(registry.types.describe()))).get('acme.widget')?.contextMenu?.map(group => group.id), ['tags'], 'the renderer receives contributed menus');
});

test('view contributions reach the target type views through their services', () => {
  const registry = packages(), views = new ResourceViewRegistry(registry.types), seen: (readonly ViewContribution[] | undefined)[] = [];
  const contribution: ViewContribution = { headerAction: () => ({ element: {} as HTMLElement, update() {} }) };
  views.register('acme.widget', { mountDetail(_container, _resource, services) { seen.push(services.viewContributions); return { update() {}, dispose() {} }; } });
  views.contribute('acme.widget', contribution);
  views.mount('detail', {} as HTMLElement, resource, { runAction: async () => null, openResource() {}, attachTerminal: () => ({ dispose() {} }) } as ResourceViewServices, () => ({ update() {}, dispose() {} }));
  assert.deepEqual(seen, [[contribution]]);
  assert.throws(() => views.contribute('other.type', contribution), /Register the item definition first/);
});
