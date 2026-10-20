import type { ResourcePluginRegistry } from './registry.ts';
import type { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ServicePluginRuntime } from './service-runtime.ts';
import type { ServicePluginOptions } from './service-runtime.ts';
import { createPluginPackageRegistry } from './builtins.ts';
import { bundledServiceModules } from './bundled/service.generated.ts';

/** Backend composition root: every bundled package's service entry, activated through ServiceHost. */
export function createServicePlugins(registry: ResourcePluginRegistry, options: Omit<ServicePluginOptions, 'registry'> = {}) {
  return new ServicePluginRuntime(createPluginPackageRegistry(), { ...options, registry }).activate(bundledServiceModules);
}

export function createResourcePluginHost(registry: ResourcePluginRegistry, connections?: ProviderConnections, paths: { dataDirectory?: string; socketDirectory?: string } = {}) {
  return createServicePlugins(registry, { connections, paths }).host;
}
