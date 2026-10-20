import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeProviderConnections, ProviderConnections } from './connections.ts';
import { createServicePlugins } from '../../src/resource-plugins/catalog.server.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';

test('account types come from their packages and keep the established Settings order', () => {
  const connections = nativeProviderConnections(() => []);
  assert.deepEqual(connections.describe().map(provider => provider.id), ['github'], 'the host provides only the shared GitHub account');
  createServicePlugins(createResourcePluginRegistry(), { connections, accountTypes: connections });
  assert.deepEqual(connections.describe().map(provider => provider.id), ['github', 'notion', 'linear', 'slack']);
  assert.equal('order' in connections.describe()[0], false, 'ordering is not part of the provider description');
});

test('a registered account type is resolvable; duplicates are refused', () => {
  const connections = new ProviderConnections(() => [{ id: 'one', providerId: 'acme', account: 'me', enabled: true, isDefault: true }], []);
  assert.throws(() => connections.resolve('acme'), /not installed/);
  connections.register({ id: 'acme', name: 'Acme', setupHint: 'Sign in', order: 5, accounts: async () => [] });
  assert.equal(connections.resolve('acme').account, 'me');
  assert.throws(() => connections.register({ id: 'acme', name: 'Acme', setupHint: '', accounts: async () => [] }), /already registered/);
});
