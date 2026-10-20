import { PLUGIN_API } from '../../packages/plugin-sdk/manifest.ts';
import type {
  PluginLifecycle, RuntimeOperationHandler, RuntimeOperationOptions, ServiceHost, ServiceModule, WorkspaceServices,
} from '../../packages/plugin-sdk/host.ts';
import type { ConnectionAdapter, ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ResourcePluginHost } from './host.ts';
import { guardPlugin, pluginFailure, withTimeout } from './plugin-guard.ts';
import type { PluginBreaker } from './plugin-guard.ts';
import type { PluginPackageRegistry } from './packages.ts';
import type { ResourcePluginRegistry } from './registry.ts';
import type { JsonObject } from './types.ts';

export interface ServicePluginOptions {
  /** The item types this service runs; packages whose types are all absent stay inactive. */
  registry: ResourcePluginRegistry;
  connections?: ProviderConnections;
  /** A host supplied by the caller already holds its connectors (fixtures). Packages then get
   * no connections and add only their registrations that need none. */
  host?: ResourcePluginHost;
  /** Connection providers are registered here unless the caller supplied its own connections. */
  accountTypes?: { register(adapter: ConnectionAdapter): void };
  paths?: { dataDirectory?: string; socketDirectory?: string };
  settings?: () => Readonly<Record<string, JsonObject>>;
}

/** Service side of the plugin host: activates package service modules through ServiceHost
 * and keeps what they register for the workspace service to consult. */
export class ServicePluginRuntime {
  readonly host: ResourcePluginHost;
  private readonly operations = new Map<string, { owner: string; handler: RuntimeOperationHandler; options: RuntimeOperationOptions }>();
  private readonly ready: { owner: string; ready: (workspace: WorkspaceServices) => PluginLifecycle | void }[] = [];
  private readonly lifecycles: PluginLifecycle[] = [];
  private readonly packages: PluginPackageRegistry;
  private readonly options: ServicePluginOptions;
  private started = false;

  constructor(packages: PluginPackageRegistry, options: ServicePluginOptions) {
    this.packages = packages; this.options = options;
    this.host = options.host ?? new ResourcePluginHost(options.registry);
  }

  activate(modules: Readonly<Record<string, ServiceModule>>) {
    for (const entry of this.packages.list()) {
      const module = modules[entry.manifest.id];
      if (!module) continue;
      const types = entry.manifest.contributes.itemTypes;
      if (types.length && !types.some(id => this.options.registry.get(id))) continue;
      module.activate(this.serviceHost(entry.manifest.id));
    }
    return this;
  }

  /** Activates installed packages one at a time. Registrations are held back until `activate`
   * finishes within `timeoutMs`, so a package that throws or hangs registers nothing. Everything a
   * package registers runs behind its breaker; hooks the host calls during its own work fail quietly. */
  async activateIsolated(modules: Readonly<Record<string, ServiceModule>>, options: { timeoutMs: number; breaker(pluginId: string): PluginBreaker; failed(pluginId: string, reason: string): void }) {
    for (const entry of this.packages.list()) {
      const pluginId = entry.manifest.id, module = modules[pluginId];
      if (!module) continue;
      const real = this.serviceHost(pluginId), breaker = options.breaker(pluginId), staged: (() => void)[] = [];
      let active = false;
      const later = (apply: () => void) => { if (active) apply(); else staged.push(apply); };
      const guard = <T extends object>(value: T, mode?: 'quiet') => guardPlugin(value, breaker, mode);
      const host: ServiceHost = {
        api: real.api, pluginId, paths: real.paths, connections: real.connections, settings: () => real.settings(),
        connector: (typeId, connector) => { later(() => real.connector(typeId, guard(connector))); },
        contributeActions: (targetTypeId, contribution) => { later(() => real.contributeActions(targetTypeId, guard(contribution))); },
        connectionProvider: adapter => { later(() => real.connectionProvider(guard(adapter))); },
        presentation: (typeId, hooks) => { later(() => real.presentation(typeId, guard(hooks, 'quiet'))); },
        runtimeOperation: (id, handler, operationOptions) => { later(() => real.runtimeOperation(id, guard({ handler }).handler, operationOptions)); },
        onClose: close => { later(() => real.onClose(guard({ close }, 'quiet').close)); },
        onWorkspace: ready => {
          later(() => real.onWorkspace(services => {
            const lifecycle = guard({ ready }, 'quiet').ready(services);
            return lifecycle ? guard(lifecycle, 'quiet') : undefined;
          }));
        },
      };
      try {
        await withTimeout(Promise.resolve().then(() => module.activate(host)), options.timeoutMs, `Its service code did not start within ${options.timeoutMs / 1000} s.`);
        for (const apply of staged) apply();
        active = true;
      } catch (error) { options.failed(pluginId, pluginFailure(error)); }
    }
    return this;
  }

  private serviceHost(pluginId: string): ServiceHost {
    const manifest = this.packages.get(pluginId)!.manifest, contributes = manifest.contributes, injected = Boolean(this.options.host);
    const declared = (kind: string, list: readonly string[], id: string) => { if (!list.includes(id)) throw new Error(`Plugin ${pluginId} did not declare ${kind} ${id} in act-plugin.json`); };
    return {
      api: PLUGIN_API, pluginId, paths: { ...this.options.paths }, connections: injected ? undefined : this.options.connections,
      connector: (typeId, connector) => {
        declared('item type', contributes.itemTypes, typeId);
        if (!injected && this.options.registry.get(typeId)) this.host.register(typeId, connector);
      },
      contributeActions: (targetTypeId, contribution) => {
        const actionIds = contributes.actionContributions[targetTypeId];
        if (!actionIds) throw new Error(`Plugin ${pluginId} did not declare actions for ${targetTypeId} in act-plugin.json`);
        if (this.options.registry.get(targetTypeId)) this.host.contribute(targetTypeId, pluginId, actionIds, contribution);
      },
      connectionProvider: adapter => {
        declared('account type', contributes.accountTypes, adapter.id);
        this.options.accountTypes?.register(adapter);
      },
      presentation: (typeId, hooks) => {
        declared('item type', contributes.itemTypes, typeId);
        if (this.options.registry.get(typeId) && !(injected && this.host.presentation(typeId))) this.host.present(typeId, hooks);
      },
      runtimeOperation: (id, handler, options = {}) => {
        declared('runtime operation', contributes.runtimeOperations, id);
        this.registerOperation(pluginId, id, handler, options);
      },
      settings: () => this.options.registry.pluginSettings(this.options.settings?.() ?? {})[pluginId] ?? {},
      onClose: close => this.host.onClose(close),
      onWorkspace: ready => {
        if (this.started) throw new Error('Register workspace hooks while activating');
        this.ready.push({ owner: pluginId, ready });
      },
    };
  }

  /** Host-owned operations go through the same table as plugin operations. */
  registerOperation(owner: string, id: string, handler: RuntimeOperationHandler, options: RuntimeOperationOptions = {}) {
    if (this.operations.has(id)) throw new Error(`Runtime operation already handled: ${id}`);
    this.operations.set(id, { owner, handler, options });
  }
  operation(id: string) { return this.operations.get(id); }

  /** Hands the started workspace to packages that asked for it; returns their lifecycle hooks. */
  startWorkspace(services: (pluginId: string) => WorkspaceServices) {
    if (this.started) throw new Error('Plugin workspace hooks already started');
    this.started = true;
    for (const { owner, ready } of this.ready) { const lifecycle = ready(services(owner)); if (lifecycle) this.lifecycles.push(lifecycle); }
  }
  observe() { for (const lifecycle of this.lifecycles) lifecycle.observe?.(); }
  start() { for (const lifecycle of this.lifecycles) lifecycle.start?.(); }
  async pause() { for (const lifecycle of this.lifecycles) await lifecycle.pause?.(); }
  async close() { for (const lifecycle of this.lifecycles) await lifecycle.close?.(); }
}
