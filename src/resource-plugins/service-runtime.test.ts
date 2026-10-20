import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginPackageRegistry } from './packages.ts';
import { ServicePluginRuntime } from './service-runtime.ts';
import { ResourcePluginHost } from './host.ts';
import { defineResourcePlugin } from './define.ts';
import { hasResourceMapPresentation, presentationAttention, resourceMapIndicators } from '../../packages/workspace-service/resource-presentation.ts';
import type { ServiceModule, WorkspaceServices } from '../../packages/plugin-sdk/host.ts';
import type { ResourceSnapshot } from './types.ts';
import type { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';

const widget = defineResourcePlugin({ id: 'acme.widget', apiVersion: 1, schemaVersion: 1, name: 'Widget', icon: 'box', preferredView: 'inspector', fields: { name: { label: 'Name', kind: 'text', required: true } } });
const manifest = { id: 'acme', name: 'Acme', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'plugin.ts', service: 'service.ts' },
  contributes: { itemTypes: ['acme.widget'], runtimeOperations: ['acme.sync'] } };
const packages = () => { const registry = new PluginPackageRegistry(); registry.register({ manifest, module: { definitions: [widget], runtimeOperations: [{ id: 'acme.sync' }] } }); return registry; };
const resource = { id: 'r', pluginId: 'acme.widget', schemaVersion: 1, title: 'Widget', data: { name: 'One' } };
const snapshot: ResourceSnapshot = { activity: 'idle', attention: 'none', connection: 'connected', label: 'Ready', observedAt: new Date(0).toISOString(), indicators: [{ id: 'provider', label: 'From provider', icon: 'check', tone: 'neutral' }] };

test('a package registers connectors, presentation and operations only for what its manifest declares', async () => {
  const registry = packages(), events: string[] = [];
  const service: ServiceModule = { activate(host) {
    assert.throws(() => host.connector('other.widget', { load: async () => snapshot }), /did not declare item type other\.widget/);
    assert.throws(() => host.runtimeOperation('acme.undeclared', () => null), /did not declare runtime operation/);
    assert.throws(() => host.connectionProvider({ id: 'acme', name: 'Acme', setupHint: '', accounts: async () => [] }), /did not declare account type acme/);
    assert.throws(() => host.contributeActions('acme.widget', { actions: () => [], execute: async () => null }), /did not declare actions/);
    host.connector('acme.widget', { load: async () => snapshot });
    host.presentation('acme.widget', {
      indicators: () => [{ id: 'local', label: 'Local overlay', icon: 'clock' as const, tone: 'blue' as const }],
      attention: () => ({ source: 'acme.local', reason: 'comment', note: 'New note' }),
    });
    host.onWorkspace(workspace => {
      events.push(`ready:${typeof workspace.storage.put}`);
      host.runtimeOperation('acme.sync', context => `synced ${context.nodeId}`);
      return { observe: () => events.push('observe'), start: () => events.push('start'), pause: () => { events.push('pause'); }, close: () => { events.push('close'); } };
    });
  } };
  const runtime = new ServicePluginRuntime(registry, { registry: registry.types }).activate({ acme: service });
  assert.equal(runtime.host.capabilities('acme.widget').load, true);
  const store = {} as SqliteStore;
  assert.equal(hasResourceMapPresentation(runtime.host, resource), true);
  assert.deepEqual(resourceMapIndicators(runtime.host, resource, snapshot, store), [{ id: 'local', label: 'Local overlay', icon: 'clock' as const, tone: 'blue' as const }]);
  assert.deepEqual(presentationAttention(runtime.host, resource, snapshot, store), { source: 'acme.local', reason: 'comment', note: 'New note' });
  assert.equal(runtime.operation('acme.sync'), undefined, 'workspace hooks run only once the workspace starts');
  runtime.startWorkspace(() => ({ storage: { put() {} } }) as unknown as WorkspaceServices);
  assert.equal(await runtime.operation('acme.sync')!.handler({ nodeId: 'n', arguments: {}, signal: AbortSignal.timeout(1000), execute: work => work() }), 'synced n');
  runtime.observe(); runtime.start(); await runtime.pause(); await runtime.close();
  assert.deepEqual(events, ['ready:function', 'observe', 'start', 'pause', 'close']);
  assert.throws(() => runtime.registerOperation('host', 'acme.sync', () => null), /already handled/);
});

test('without the package type the service entry does not activate; an injected host keeps its own registrations', () => {
  const registry = packages();
  let activations = 0;
  const service: ServiceModule = { activate(host) { activations++; host.presentation('acme.widget', { indicators: () => [] }); host.connector('acme.widget', { load: async () => snapshot }); } };
  new ServicePluginRuntime(registry, { registry: new PluginPackageRegistry().types }).activate({ acme: service });
  assert.equal(activations, 0);
  const injected = new ResourcePluginHost(registry.types), own = { indicators: () => [{ id: 'fixture', label: 'Fixture', icon: 'check' as const, tone: 'neutral' as const }] };
  injected.present('acme.widget', own);
  const runtime = new ServicePluginRuntime(registry, { registry: registry.types, host: injected, connections: {} as never }).activate({ acme: { activate(host) { assert.equal(host.connections, undefined); service.activate(host); } } });
  assert.equal(activations, 1);
  assert.equal(runtime.host, injected);
  assert.equal(injected.presentation('acme.widget'), own);
  assert.equal(injected.capabilities('acme.widget').load, false, 'connectors come from the injected host');
});
