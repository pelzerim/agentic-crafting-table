import { prComments } from './pr-comments.ts';
import { GitHubInbox } from './github-inbox.ts';
import { GitHubClient } from '../provider-runtime/github.ts';
import { githubTransport } from '../provider-runtime/github-transport.ts';
import { useValidatorStore, withBudgetLines } from '../provider-runtime/request-budget.ts';
import { pluginDiscoverySchema } from '../../src/resource-plugins/url-input.ts';
import { migratePluginResources } from './plugin-migrations.ts';
import { savedSessionsSchema, creationOptionsSchema } from '../session-runtime/saved-sessions.ts';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WorkspaceControl } from '../core/control.ts';
import type { CommandResult, WorkspaceState } from '../core/control.ts';
import { revisionGuard } from '../core/revision-policy.ts';
import { applyAtHead } from './apply-at-head.ts';
import { SqliteStore } from './sqlite-store.ts';
import { prepareWorkspace } from './paths.ts';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, serializeError } from './protocol.ts';
import type { ResponseFrame } from './protocol.ts';
import { FrameWriter, encodeFrame } from './local-rpc.ts';
import type { EncodedFrame } from './local-rpc.ts';
import { presentLayer } from '../../src/graph/layers.ts';
import type { MapLayer } from '../../src/graph/layers.ts';
import { ServiceHealth } from './service-health.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { SessionCoordinator } from './sessions.ts';
import type { RuntimeOptions } from '../session-runtime/client.ts';
import { placedRequest, resourceCreateSchema } from '../core/resource-creation.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import { validateCreationFields } from '../../src/resource-plugins/define.ts';
import { createServicePlugins } from '../../src/resource-plugins/catalog.server.ts';
import { runtimeTransportSchema } from '../core/runtime.ts';
import { PluginStore } from './plugin-store.ts';
import { pluginRequestSchemas } from '../core/plugin-requests.ts';
import { ACTIVATION_TIMEOUT_MS, buildSource, loadBuilds } from './plugin-loader.ts';
import type { LoadedPackage } from './plugin-loader.ts';
import { pluginStatuses, pluginUnavailableReason } from './plugin-status.ts';
import { PluginBreaker } from '../../src/resource-plugins/plugin-guard.ts';
import { createPluginPackageRegistry, useInstalledPackages } from '../../src/resource-plugins/builtins.ts';
import * as z from 'zod/v4';
import type { RuntimeOperationContext, RuntimeOperationHandler, RuntimeOperationOptions } from '../plugin-sdk/host.ts';
import { AgentContextCoordinator } from './agent-context.ts';
import { AgentCoordinator } from './agents.ts';
import type { HostedAgents } from './agents.ts';
import { agentProvider } from './agent-providers.ts';
import { WorkspaceLifecycle } from './lifecycle.ts';
import { managedSessionsSchema, manageSessionSchema, sessionIdSchema, sessionPageSchema } from '../session-runtime/protocol.ts';
import type { SessionRecord } from '../session-runtime/protocol.ts';
import { ItemTitles } from './item-titles.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { ActivitySummaries } from './activity-summaries.ts';
import { AgentTitles } from './agent-titles.ts';
import { AttachTitles } from './attach-titles.ts';
import { Plots } from './plots.ts';
import { ProjectSummaries } from './project-summaries.ts';
import { Reminders } from './reminders.ts';
import type { ReminderClockOptions } from './reminders.ts';
import { reminderDoneSchema, reminderSaveSchema, reminderSnoozeSchema } from '../core/reminders.ts';
import { nativeProviderConnections } from '../provider-runtime/connections.ts';
import { providerAccountsSchema, providerRefreshSchema, providerSelectSchema, selectProviderAccount } from '../core/connections.ts';
import { ResourceCoordinator } from './resources.ts';
import type { ProviderConnections } from '../provider-runtime/connections.ts';
import type { ProviderConnection } from '../core/connections.ts';
import type { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { AssignmentCoordinator } from './assignments.ts';
import type { AssignmentAdapter } from './assignments.ts';
import { WorkflowReviewCoordinator } from './workflow-reviews.ts';
import { nativeWorkflowSources } from '../provider-runtime/workflow-sources.ts';
import { workflowReviewContract } from '../../src/pull-requests/workflow-contract.ts';
import type { WorkflowSource } from '../provider-runtime/workflow-sources.ts';
import { ReviewCoordinator } from './reviews.ts';
import { ReviewFindingsCoordinator } from './review-findings.ts';
import { AutoReviews } from './auto-review.ts';
import { ReviewLoops } from './review-loop.ts';
import type { ReviewRuntime } from './reviews.ts';
import { nativeReviewSources } from '../provider-runtime/review-sources.ts';
import type { ReviewSource } from '../provider-runtime/review-sources.ts';
import { githubAssignmentAdapter } from '../provider-runtime/github-assignments.ts';
import { publishLogPolicy } from '../core/log-policy.ts';
import { supportReport } from '../diagnostics/support-report.ts';
import { recordingsSchema, deleteRecordingSchema } from '../session-runtime/protocol.ts';
import { ArchitectureRequests } from './architecture-requests.ts';
import { TriageCoordinator } from './triage.ts';
import { TodoSweeper } from './todo-sweeper.ts';
import { ComparisonPruner } from './comparison-pruning.ts';
import type { TriageAdapter } from './triage.ts';
import { linearTriageAdapter } from '../provider-runtime/linear-triage.ts';
import { StandupReports } from './standup.ts';
import { UpdateChecker, tagsSource } from './updates.ts';
import type { UpdateCheckerOptions } from './updates.ts';
import { STANDUP_ENABLED } from '../core/standup.ts';

/** Each package's settings presets, once per workspace, when the package loads; a preset whose target
 * package is not loaded waits for a later start, and one its target refuses is skipped and logged. */
function applySettingsPresets(store: SqliteStore, registry: ResourcePluginRegistry) {
  const packages = createPluginPackageRegistry();
  for (const preset of packages.settingsPresets()) {
    try { if (packages.checkSettingsPreset(preset)) store.applySettingsPreset(preset, registry.pluginSettings()[preset.packageId]); }
    catch (error) { console.error(`Settings preset ${preset.id} of ${preset.owner} was not applied: ${(error as Error).message}`); }
  }
}

const mapLayer = (value: unknown): MapLayer | undefined => {
  if (value === undefined || value === 'map' || value === 'below') return value;
  throw new Error('Unknown map layer');
};

export async function startWorkspaceService(directory: string, registry?: ResourcePluginRegistry, runtimeOptions?: RuntimeOptions, providers?: { titleClient?: ActivitySummaryClient; connections?: ProviderConnections; host?(registry: ResourcePluginRegistry): ResourcePluginHost; assignments?: AssignmentAdapter[]; triage?: { adapters: TriageAdapter[]; connections?: () => ProviderConnection[] }; reviews?: Record<string, ReviewSource>; workflows?: Record<string, WorkflowSource>; reviewRuntime?: ReviewRuntime; inboxClient?(connection: ProviderConnection): GitHubClient; pluginTimeoutMs?: number; reminderClock?: ReminderClockOptions; todoClock?: () => number; updates?: Partial<UpdateCheckerOptions> }) {
  const paths = prepareWorkspace(directory), instanceId = randomUUID();
  const store = new SqliteStore(paths.database);
  // Installed packages load before the registry is built so they register exactly like bundled ones.
  const pluginStore = new PluginStore(paths.dataDirectory, store);
  const installed = await loadBuilds(pluginStore.list().filter(plugin => plugin.enabled && !plugin.removed).map(plugin => buildSource(pluginStore, plugin)), { service: true, timeoutMs: providers?.pluginTimeoutMs });
  let running: LoadedPackage[] = installed.loaded;
  const loadFailures = [...installed.failures];
  useInstalledPackages(running);
  const control = new WorkspaceControl(store, registry);
  const connections = providers?.connections ?? nativeProviderConnections(() => store.readSettings().value.connections);
  const servicePlugins = createServicePlugins(control.registry, { connections, host: providers?.host?.(control.registry), accountTypes: providers?.connections ? undefined : connections, paths: { dataDirectory: paths.dataDirectory, socketDirectory: paths.socketDirectory }, settings: () => store.readSettings().value.plugins });
  const breakers = new Map(running.map(pkg => [pkg.build.id, new PluginBreaker(pkg.build.id)]));
  await servicePlugins.activateIsolated(Object.fromEntries(running.flatMap(pkg => pkg.service ? [[pkg.build.id, pkg.service]] : [])), {
    timeoutMs: providers?.pluginTimeoutMs ?? ACTIVATION_TIMEOUT_MS, breaker: id => breakers.get(id)!,
    failed: (id, reason) => {
      loadFailures.push({ id, reason });
      control.registry.withdraw(id, running.find(pkg => pkg.build.id === id)?.manifest.contributes.itemTypes ?? [], reason);
      running = running.filter(pkg => pkg.build.id !== id); useInstalledPackages(running);
    },
  });
  for (const plugin of pluginStore.list()) {
    const failure = loadFailures.find(entry => entry.id === plugin.id), loaded = running.some(pkg => pkg.build.id === plugin.id);
    if (!loaded) for (const typeId of plugin.current.contributes.itemTypes) control.registry.setUnavailableReason(typeId, pluginUnavailableReason(plugin, failure?.reason));
  }
  const plugins = servicePlugins.host;
  try { store.claimService(instanceId); } catch (error) { store.close(); throw error; }
  for (const failure of loadFailures) pluginStore.recordFailure(failure.id, failure.reason);
  const pluginState = () => pluginStatuses(pluginStore.list(), running, breakers);
  useValidatorStore(store);
  /** Each subscriber's layer; `undefined` asks for the whole state as a read returns it. */
  const sockets = new Set<Socket>(), subscribers = new Map<Socket, MapLayer | undefined>(), writers = new Map<Socket, FrameWriter>();
  const health = new ServiceHealth();
  let closing = false;
  let startup: Promise<void> | undefined, startupReviews: Promise<void> | undefined, startupArchitecture: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  const assertStarting = () => { if (closing) throw new Error('Workspace service closed during startup'); };
  let summaries: ActivitySummaries | undefined;
  let titles: ItemTitles | undefined;
  let agentTitles: AgentTitles | undefined;
  let attachTitles: AttachTitles | undefined;
  const plots = new Plots(store, control, { changed: () => broadcast(), allowed: () => !closing && lifecycle.allowsBackgroundWork, directory, client: providers ? providers.titleClient ?? null : undefined });
  const projectSummaries = new ProjectSummaries(store, control, { changed: () => broadcast(), allowed: () => !closing && lifecycle.allowsBackgroundWork, directory, client: providers ? providers.titleClient ?? null : undefined,
    plots: state => plots.observe(state).list.filter(plot => !plot.hidden) });
  const reminders = new Reminders(store, { ...providers?.reminderClock, changed: () => broadcast() });
  reminders.on('due', due => { for (const subscriber of subscribers.keys()) send(subscriber, { event: 'reminder-due', ...due }, 'reminder-due'); });
  const saved = async () => { const value = await store.snapshot(); return { ...value, plots: plots.observe(value.state), projectSummaries: projectSummaries.observe(), reminders: reminders.snapshot() }; };
  // People see a pending provider change at once; background observers keep the saved graph.
  const presented = <T extends { state: WorkspaceState }>(value: T): T => ({ ...value, state: resources.overlay(value.state) });
  const snapshot = async () => presented(await saved());
  /** The snapshot as a subscriber on `layer` receives it; without a layer, the whole one. */
  const forLayer = <T extends { state: WorkspaceState }>(value: T, layer: MapLayer | undefined): T => {
    if (!layer) return value;
    const { state, layers } = presentLayer(value.state, layer);
    return { ...value, state, layer, layers };
  };
  const send = (socket: Socket, frame: ResponseFrame, label: string, flushed?: () => void) => writers.get(socket)?.send(frame, label, { flushed });
  const broadcast = () => health.operation('broadcast', async () => {
    const current = await saved();
    summaries?.observe(current.state);
    titles?.observe(current.state);
    agentTitles?.observe(current.state);
    attachTitles?.observe(current.state);
    findings?.observe();
    loops.observe();
    autoReviews.observe();
    servicePlugins.observe();
    if (!subscribers.size) return;
    const shown = presented(current), frames = new Map<MapLayer | undefined, EncodedFrame>();
    for (const [socket, layer] of subscribers) {
      let frame = frames.get(layer);
      if (!frame) { frame = encodeFrame({ event: 'snapshot', snapshot: forLayer(shown, layer) } satisfies ResponseFrame); frames.set(layer, frame); }
      writers.get(socket)?.sendEncoded(frame, 'snapshot', { replaceable: true });
    }
  });
  // Rollout validations and events change outside commands; one broadcast covers a burst of them.
  let rolloutBroadcast = false;
  store.onRolloutChange(() => {
    if (rolloutBroadcast) return;
    rolloutBroadcast = true;
    setImmediate(() => { rolloutBroadcast = false; if (!closing) void broadcast().catch(() => {}); });
  });
  const resources = new ResourceCoordinator(store, control, plugins, connections, broadcast, Date.now, () => !closing && lifecycle.allowsBackgroundWork);
  const context = new AgentContextCoordinator(store, control, plugins, (nodeId, signal) => resources.context(nodeId, signal));
  const assignments = new AssignmentCoordinator(store, control, providers ? providers.assignments ?? [] : [githubAssignmentAdapter()], () => store.readSettings().value.connections, broadcast, () => !closing && lifecycle.allowsBackgroundWork);
  // Assigned provider work arrives as quiet Triage to-dos; an injected provider set brings its own adapters.
  const triage = new TriageCoordinator(store, control, providers ? providers.triage?.adapters ?? [] : [linearTriageAdapter()], providers?.triage?.connections ?? (() => store.readSettings().value.connections),
    () => control.registry.pluginSettings(store.readSettings().value.plugins), broadcast, () => !closing && lifecycle.allowsBackgroundWork);
  const todoSweeper = new TodoSweeper(control, () => control.registry.pluginSettings(store.readSettings().value.plugins)['workspace.todo'], broadcast, () => !closing && lifecycle.allowsBackgroundWork, providers?.todoClock);
  const githubReader = (connection: ProviderConnection) => new GitHubClient(githubTransport(connections.resolve('github', connection.id).account));
  const inbox = new GitHubInbox(store, control, () => store.readSettings().value.connections, providers?.inboxClient ?? githubReader);
  // An injected provider set never falls through to a real GitHub account.
  const updates = new UpdateChecker(store, { version: process.env.ACT_APP_VERSION ?? 'dev', tags: tagsSource(process.env), plugins: () => pluginState().installed.filter(plugin => !plugin.removed).map(({ id, name, version, source }) => ({ id, name, version, source })),
    allowed: () => !closing && lifecycle.allowsBackgroundWork, ...providers?.updates });
  const standup = new StandupReports(store, control, { client: providers ? providers.titleClient ?? null : undefined, directory, enabled: STANDUP_ENABLED, allowed: () => !closing && lifecycle.allowsBackgroundWork,
    connections: () => store.readSettings().value.connections, github: providers ? providers.inboxClient : githubReader });
  const terminals = runtimeOptions ? new SessionCoordinator(store, control, runtimeOptions, broadcast) : undefined;
  let logPolicySync = Promise.resolve();
  const configureLogs = () => {
    const policy = store.readSettings().value.diagnostics; publishLogPolicy(policy);
    // The stored settings remain authoritative if the runtime is temporarily
    // unavailable. Startup/reconnection will publish them again, without a session launch.
    if (terminals) logPolicySync = logPolicySync.then(async () => { await terminals.runtime.call('diagnostics.configure', policy); }).catch(() => {});
    return logPolicySync;
  };
  const agents = terminals && runtimeOptions ? new AgentCoordinator(directory, runtimeOptions, control, terminals, context, broadcast, store) : undefined;
  // An injected provider set is isolated: omitted capabilities must never fall
  // through to a real account or native provider during fixture execution.
  const reviewSources = providers ? providers.reviews ?? {} : nativeReviewSources(connections);
  const hostedAgents: HostedAgents | undefined = agents && terminals ? { ready: () => agentProvider('claude').probe(), launch: (request, hosted) => agents.launchHosted(request, hosted), fallbackDirectory: () => terminals.fallbackDirectory() } : undefined;
  const architecture = new ArchitectureRequests(directory, store, control, reviewSources, agents ? (request, hosted) => agents.launchHosted(request, hosted) : undefined);
  const reviews = terminals && Object.keys(reviewSources).length ? new ReviewCoordinator(directory, store, control, terminals, reviewSources, broadcast, providers?.reviewRuntime) : undefined;
  const checkouts = new ComparisonPruner(directory, store, terminals, () => !closing && lifecycle.allowsBackgroundWork);
  const findings = reviews ? new ReviewFindingsCoordinator(store, control, nodeId => reviews.result(nodeId), terminals, broadcast, () => !closing && lifecycle.allowsBackgroundWork,
    agents ? { create: request => agents.create(request), model: async provider => (await agentProvider(provider).models()).default } : undefined) : undefined;
  // Review loops drive the host's direct reviews and findings; their records live in the code.review package's storage.
  const loops = new ReviewLoops({ storage: store.pluginStorage('code.review'), store, control, resources, sessions: terminals, changed: broadcast, allowed: () => !closing && lifecycle.allowsBackgroundWork,
    ...(reviews && findings ? { reviews: { start: (prNodeId, provider, input) => reviews.start(prNodeId, provider, input, work => lifecycle.execute(work)), status: (prNodeId, requestId) => reviews.status(prNodeId, requestId), options: () => reviews.options() },
      findings: { run: (nodeId, input) => findings.run(nodeId, input) } } : {}) });
  const autoReviews = new AutoReviews({ storage: store.pluginStorage('code.review'), store, control, resources, changed: broadcast, allowed: () => !closing && lifecycle.allowsBackgroundWork,
    ...(reviews ? { reviews: { start: (prNodeId, provider, input) => reviews.start(prNodeId, provider, input, work => lifecycle.execute(work)) } } : {}) });
  const workflows = new WorkflowReviewCoordinator(store, control, providers ? providers.workflows ?? {} : nativeWorkflowSources(connections, repository => workflowReviewContract(control.registry.pluginSettings(store.readSettings().value.plugins)['github.review-run'], repository)), broadcast, () => !closing && lifecycle.allowsBackgroundWork);
  const lifecycle = new WorkspaceLifecycle(store, control, {
    list: () => terminals ? terminals.runtime.call<SessionRecord[]>('sessions.list') : Promise.resolve([]),
    stop: sessionId => terminals!.runtime.call('sessions.stop', { sessionId, preservePids: [process.pid] }),
    resume: entry => entry.kind === 'agent' ? agents!.restore(entry.nodeId, entry.requestId, entry.continueWork) : entry.kind === 'analysis' ? reviews!.restore(entry.nodeId, entry.requestId) : terminals!.restartTerminal(entry.nodeId, entry.requestId),
    recoverJobs: async () => {
      if (closing) return; await terminals?.recover();
      if (closing) return; await resources.recover();
      if (closing) return; await reviews?.recover();
      if (closing) return; await architecture.recover();
      if (closing) return; await workflows.recover();
    },
  });
  servicePlugins.startWorkspace(pluginId => ({ directory, store, control, resources, terminals, agents: hostedAgents, storage: store.pluginStorage(pluginId), broadcast,
    allowed: () => !closing && lifecycle.allowsBackgroundWork, execute: work => lifecycle.execute(work) }));
  const operation = (id: string, handler: RuntimeOperationHandler, options?: RuntimeOperationOptions) => servicePlugins.registerOperation('host', id, handler, options);
  const requireResource = (context: RuntimeOperationContext) => { if (!context.resource) throw new Error('Node is not a resource item'); return context.resource; };
  operation('plot', async context => {
    const state = await control.read();
    if (!state.nodes.some(node => node.id === context.nodeId && !node.resourceId)) throw new Error('Project not found');
    const result = await plots.run(context.nodeId, context.arguments); await broadcast(); return result;
  }, { requiresNode: false });
  operation('pr.comments', context => lifecycle.execute(() => prComments(control, store, resources, terminals, context.nodeId, context.arguments)));
  operation('pr.review.options', async () => reviews ? await reviews.options() : []);
  operation('pr.architecture', async context => {
    const input = z.object({ operation: z.enum(['options', 'prepare', 'status', 'launch']), requestId: z.string().uuid().optional() }).strict().parse(context.arguments);
    if (input.operation === 'options') return architecture.options(context.resource?.pluginId);
    if (input.operation === 'status') return architecture.status(context.nodeId, input.requestId);
    if (input.operation === 'launch') return lifecycle.execute(async () => architecture.launch(context.nodeId, { requestId: input.requestId }, work => lifecycle.execute(work)));
    return lifecycle.execute(async () => architecture.start(context.nodeId, { requestId: input.requestId }, work => lifecycle.execute(work)));
  });
  operation('review.result', async context => { if (!reviews) throw new Error('Reviews are not configured'); return reviews.result(context.nodeId); });
  operation('review.findings', async context => { if (!findings) throw new Error('Native reviews are not configured'); return lifecycle.execute(() => findings.run(context.nodeId, context.arguments)); });
  operation('review.retry', async context => { if (!reviews) throw new Error('Native reviews are not configured'); return lifecycle.execute(async () => reviews.retry(context.nodeId, context.arguments, work => lifecycle.execute(work))); });
  operation('review.loop', context => lifecycle.execute(() => loops.run(context.nodeId, context.arguments)));
  operation('pr.review.status', context => reviews?.status(context.nodeId, typeof context.arguments.requestId === 'string' ? context.arguments.requestId : undefined) ?? []);
  for (const provider of ['codex', 'claude'] as const) operation(`pr.review.${provider}`, async context => {
    if (!reviews) throw new Error('Native reviews are not configured');
    return lifecycle.execute(async () => reviews.start(context.nodeId, provider, context.arguments, work => lifecycle.execute(work)));
  });
  operation('pr.review.workflow', async context => {
    const step = z.object({ operation: z.enum(['options', 'start', 'status', 'reconcile', 'stop']).default('start') }).parse(context.arguments).operation;
    if (step === 'options') return workflows.options(context.nodeId);
    if (step === 'status') return workflows.status(context.nodeId, typeof context.arguments.requestId === 'string' ? context.arguments.requestId : undefined);
    if (step === 'start') return lifecycle.execute(() => workflows.start(context.nodeId, context.arguments));
    if (step === 'reconcile') return lifecycle.execute(() => workflows.reconcile(context.nodeId, context.arguments));
    return lifecycle.execute(() => workflows.stop(context.nodeId, context.arguments));
  });
  operation('agent.context', ({ nodeId }) => context.prepare(nodeId));
  operation('agent.context.ack', ({ nodeId, arguments: input }) => context.acknowledge(nodeId, z.object({ deliveryId: z.string().uuid() }).parse(input).deliveryId));
  if (agents) {
    operation('agent.context.inject', context => lifecycle.execute(() => agents.injectContext(context.nodeId, context.arguments)));
    operation('agent.resume', context => lifecycle.execute(() => agents.resume(context.nodeId, z.object({ requestId: z.string().uuid() }).parse(context.arguments).requestId)));
    operation('skill.run', context => lifecycle.execute(() => agents.runSkill(context.nodeId, context.arguments)));
  }
  operation('terminal.startup', () => { throw new Error('Terminal startup replay was removed. Use New shell explicitly.'); });
  if (terminals) {
    operation('terminal.start', context => lifecycle.execute(() => terminals.restartTerminal(context.nodeId, z.object({ requestId: z.string().uuid() }).strict().parse(context.arguments).requestId)));
    for (const [action, method] of [['session.read', 'sessions.read'], ['terminal.input', 'sessions.input']] as const) operation(action, context => {
      if (!context.resource || typeof context.resource.data.sessionId !== 'string') throw new Error('Item has no session');
      return terminals.runtime.call(method, { sessionId: context.resource.data.sessionId, ...('data' in context.arguments ? { data: context.arguments.data } : {}) });
    });
  }
  operation('resource.read', async context => {
    requireResource(context);
    if (context.arguments.cachedOnly === true) return resources.cached(context.nodeId);
    const attentionReceipt = await assignments.receipt(context.nodeId);
    return { ...await resources.read(context.nodeId, context.arguments.refresh === true), ...(attentionReceipt ? { attentionReceipt } : {}) };
  });
  operation('resource.viewed', context => {
    requireResource(context);
    const input = z.object({ receipt: z.object({ connectionId: z.string().min(1).max(200), key: z.string().min(1).max(1000), cycle: z.string().uuid() }) }).parse(context.arguments);
    return assignments.viewed(context.nodeId, input.receipt);
  });
  operation('resource.opened', context => { requireResource(context); return lifecycle.execute(() => resources.opened(context.nodeId)); });
  operation('resource.convert', context => {
    requireResource(context);
    const input = z.object({ pluginId: z.string().min(1).max(200).optional() }).strict().parse(context.arguments);
    return lifecycle.execute(() => resources.convert(context.nodeId, input.pluginId));
  });
  operation('resource.actions', context => plugins.actions(requireResource(context), context.signal));
  operation('resource.context', context => { requireResource(context); return resources.context(context.nodeId, context.signal); });
  operation('resource.content', context => {
    requireResource(context);
    const action = z.object({ actionId: z.string().min(1), input: z.record(z.string(), z.json()).default({}), refresh: z.boolean().default(false) }).parse(context.arguments);
    return resources.content(context.nodeId, action.actionId, action.input, action.refresh);
  });
  operation('resource.action', context => {
    requireResource(context);
    const action = z.object({ actionId: z.string().min(1), input: z.record(z.string(), z.json()).default({}) }).parse(context.arguments);
    return lifecycle.execute(() => resources.execute(context.nodeId, action.actionId, action.input, context.signal));
  });
  if (terminals) summaries = new ActivitySummaries(store, control, id => terminals.runtime.call('sessions.read', { sessionId: id }), broadcast, () => !closing && lifecycle.allowsBackgroundWork, directory);
  titles = new ItemTitles(store, control, broadcast, () => !closing && lifecycle.allowsBackgroundWork, directory, providers ? providers.titleClient ?? null : undefined);
  attachTitles = new AttachTitles(store, control, broadcast, () => !closing && lifecycle.allowsBackgroundWork, directory, providers ? providers.titleClient ?? null : undefined);
  if (terminals) agentTitles = new AgentTitles(store, control, id => terminals.runtime.call('sessions.read', { sessionId: id }), broadcast, () => !closing && lifecycle.allowsBackgroundWork, directory, providers ? providers.titleClient ?? null : undefined);
  if (agentTitles) { const titler = agentTitles; operation('agent.title', ({ nodeId }) => titler.request(nodeId)); }
  const pollers: [object, string, string][] = [[resources, 'poll', 'resources.poll'], [assignments, 'tick', 'assignments.tick'], [triage, 'tick', 'triage.tick'], [todoSweeper, 'sweep', 'todos.sweep'],
    [workflows, 'tick', 'workflows.tick'], [checkouts, 'tick', 'checkouts.tick'], [inbox, 'refresh', 'inbox.refresh'], [loops, 'reconcileOnce', 'review-loops.reconcile'],
    [autoReviews, 'reconcileOnce', 'auto-reviews.reconcile'], ...(summaries ? [[summaries, 'tick', 'summaries.tick'] as [object, string, string]] : [])];
  for (const [target, method, name] of pollers) health.timed(target, method, name);
  const creators: Record<string, (request: ResourceCreate) => Promise<unknown>> = { 'resource.attach': request => resources.attach(request), ...(terminals ? {
    'terminal.create': request => terminals.create({ ...request, sessionId: request.requestId, cwd: request.data.cwd }),
    'agent.create': request => agents!.create(request),
  } : {}) };
  const server = createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(5000, () => socket.destroy());
    const writer = new FrameWriter(socket, health);
    writers.set(socket, writer);
    let buffer = '';
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); writers.delete(socket); health.disconnected(writer.peer); });
    const handle = async (line: string) => {
      let id = '', method = 'request', finish: (() => void) | undefined;
      try {
        const request = JSON.parse(line);
        if (typeof request.id !== 'string' || request.id.length > 128) throw new Error('Invalid request ID');
        id = request.id;
        if (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) || !timingSafeEqual(Buffer.from(request.token), Buffer.from(paths.secret))) {
          send(socket, { id, error: { code: 'UNAUTHORIZED', message: 'Workspace authentication failed' } }, method, () => socket.end()); return;
        }
        socket.setTimeout(0);
        if (typeof request.method === 'string') { method = request.method.slice(0, 100); finish = health.started(method); }
        if (closing) throw Object.assign(new Error('Workspace is shutting down'), { code: 'WORKSPACE_CLOSING' });
        const args = request.args ?? {};
        let result: unknown;
        switch (request.method) {
          case 'hello': result = { protocol: PROTOCOL_VERSION, instanceId, pid: process.pid }; break;
          case 'read': result = await snapshot(); break;
          case 'plugins': result = control.registry.describe(); break;
          case 'plugins.installed': result = pluginState(); break;
          case 'plugins.loaded': result = { plugins: running.map(pkg => pkg.build), unavailable: control.registry.unavailable() }; break;
          case 'plugins.prepare': result = await pluginStore.prepare(pluginRequestSchemas['plugins.prepare'].parse(args)); break;
          case 'plugins.prepareFolder': result = await pluginStore.prepareFolder(pluginRequestSchemas['plugins.prepareFolder'].parse(args).path); break;
          case 'plugins.install': await pluginStore.install(pluginRequestSchemas['plugins.install'].parse(args)); result = pluginState(); break;
          case 'plugins.enable': { const input = pluginRequestSchemas['plugins.enable'].parse(args); pluginStore.setEnabled(input.id, input.enabled); result = pluginState(); break; }
          case 'plugins.rollback': { const input = pluginRequestSchemas['plugins.rollback'].parse(args); await pluginStore.rollback(input.id, input.commit); result = pluginState(); break; }
          case 'plugins.remove': pluginStore.remove(pluginRequestSchemas['plugins.remove'].parse(args).id); result = pluginState(); break;
          case 'connections.accounts': result = await connections.accounts(providerAccountsSchema.parse(args).providerId, AbortSignal.timeout(70_000)); break;
          case 'connections.list': result = { providers: connections.describe(), connections: store.readSettings().value.connections, sync: withBudgetLines(assignments.status(), store.readSettings().value.connections) }; break;
          case 'connections.status': result = withBudgetLines(assignments.status(), store.readSettings().value.connections); break;
          case 'connections.refresh': { const input = providerRefreshSchema.parse(args); result = withBudgetLines(await assignments.refresh(input.connectionId), store.readSettings().value.connections); await triage.refresh(input.connectionId); break; }
          case 'settings.read': result = store.readSettings(); break;
          case 'directories.recent': result = store.recentDirectories(); break;
          case 'recordings.list': case 'recordings.delete': {
            if (!terminals) throw new Error('Native sessions are not configured');
            result = await terminals.runtime.call(request.method, request.method === 'recordings.list' ? recordingsSchema.parse(args) : deleteRecordingSchema.parse(args));
            if (request.method === 'recordings.delete') {
              for (const subscriber of subscribers.keys()) send(subscriber, { event: 'recording-deleted', sessionId: (result as { session: SessionRecord }).session.id }, 'recording-deleted');
            }
            break;
          }
          case 'diagnostics.report': {
            const sessions = terminals ? await terminals.runtime.call<SessionRecord[]>('sessions.list').catch(() => undefined) : undefined;
            result = supportReport(await control.read(), store.readSettings().value, store.listJobs(), sessions, health.report()); break;
          }
          case 'diagnostics.health': result = health.report(); break;
          case 'settings.write': case 'connections.select': {
            let write = args;
            if (request.method === 'connections.select') {
              const input = providerSelectSchema.parse(args), provider = connections.describe().find(provider => provider.id === input.providerId), current = store.readSettings();
              if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
              if (input.account && provider.manualAccount && !new RegExp(provider.manualAccount.pattern).test(input.account)) throw new Error(`Enter a valid ${provider.manualAccount.label.toLowerCase()}.`);
              write = { expectedRevision: current.revision, value: { ...current.value, connections: selectProviderAccount(current.value.connections, input.providerId, input.account, randomUUID(), input.label) } };
            }
            const accounts = JSON.stringify(store.readSettings().value.connections);
            const settings = store.writeSettings(write, control.registry); result = settings;
            // A newly connected account can now load the links that were saved as plain web links.
            if (JSON.stringify(settings.value.connections) !== accounts) void resources.upgradeLinks().catch(() => {});
            void configureLogs();
            summaries?.settingsChanged();
            agentTitles?.settingsChanged();
            attachTitles?.settingsChanged();
            standup.settingsChanged();
            projectSummaries.settingsChanged();
            assignments.settingsChanged();
            triage.settingsChanged();
            todoSweeper.settingsChanged();
            await resources.refreshPresentation();
            for (const subscriber of subscribers.keys()) send(subscriber, { event: 'settings', settings }, 'settings');
            await broadcast();
            break;
          }
          case 'sessions.managed': case 'sessions.page': case 'sessions.manage': case 'sessions.stop': {
            if (!terminals) throw new Error('Native sessions are not configured');
            const input = request.method === 'sessions.managed' ? managedSessionsSchema.parse(args)
              : request.method === 'sessions.page' ? sessionPageSchema.parse(args)
              : request.method === 'sessions.manage' ? { ...manageSessionSchema.parse(args), preservePids: [process.pid] }
                : { ...sessionIdSchema.parse(args), preservePids: [process.pid] };
            result = await terminals.runtime.call(request.method, input);
            if (request.method === 'sessions.manage') { await terminals.stopArchived(); terminals.monitor(); }
            break;
          }
          case 'lifecycle.status': result = lifecycle.status(); break;
          case 'github.inbox.read': { const input = z.object({ refresh: z.boolean().default(false), opened: z.boolean().default(false) }).parse(args ?? {}); if (input.refresh) await inbox.refresh(true); else if (input.opened) await inbox.opened(); result = await inbox.read(); break; }
          case 'github.inbox.show': result = await inbox.showOnMap(args); await broadcast(); break;
          case 'github.inbox.hide': result = await inbox.hide(args); break;
          case 'github.inbox.seen': result = await inbox.seen(args); break;
          case 'standup.open': result = standup.open(args); break;
          case 'standup.status': result = standup.status(); break;
          case 'updates.status': result = updates.status(); break;
          case 'updates.check': await updates.check(); result = updates.status(); break;
          case 'reminders.save': result = reminders.save(reminderSaveSchema.parse(args).list); await broadcast(); break;
          case 'reminders.done': result = reminders.done(reminderDoneSchema.parse(args).id); await broadcast(); break;
          case 'reminders.snooze': { const input = reminderSnoozeSchema.parse(args); result = reminders.snooze(input.id, input.minutes); await broadcast(); break; }
          case 'attention.history': { const input = z.object({ offset: z.number().int().min(0).max(99).default(0), limit: z.number().int().min(1).max(100).default(10) }).strict().parse(args ?? {}); result = store.attentionHistory(input.offset, input.limit); break; }
          case 'lifecycle.active': result = await lifecycle.active(); break;
          case 'lifecycle.preview': result = { sessions: await lifecycle.active(), pending: lifecycle.pendingCount }; break;
          case 'lifecycle.close': inbox.stop(); await agents?.pause(); await workflows.pause(); await servicePlugins.pause(); await findings?.close(); await loops.close(); await autoReviews.close(); await reviews?.close(); await architecture.close(); await assignments.pause(); await triage.pause(); await todoSweeper.pause(); await checkouts.pause(); await resources.pause(); await summaries?.pause(); await titles?.pause(); await agentTitles?.pause(); await attachTitles?.pause(); await standup.pause(); await updates.pause(); await plots.pause(); await projectSummaries.pause(); await reminders.pause(); result = await lifecycle.close(); break;
          case 'lifecycle.recover': { const input = z.object({ retry: z.boolean().default(false), startupId: z.string().uuid().optional() }).parse(args); result = lifecycle.recover(input.retry, input.startupId); summaries?.start(); titles?.start(); agentTitles?.start(); attachTitles?.start(); standup.start(); updates.start(); plots.start(); projectSummaries.start(); reminders.start(); assignments.start(); triage.start(); todoSweeper.start(); checkouts.start(); resources.start(); workflows.resume(); findings?.start(); loops.start(); autoReviews.start(); servicePlugins.start(); agents?.start(); break; }
          case 'agent.hook': if (!agents) throw new Error('Native agents are not configured'); result = await agents.hook(args); break;
          case 'plugins.discover': {
            const input = pluginDiscoverySchema.parse(args);
            result = { plugins: control.registry.describe().map(plugin => ({ ...plugin, capabilities: plugins.capabilities(plugin.id) })), packages: pluginState().installed.map(({ id, name, version, commit, dev, enabled, removed, running: active }) => ({ id, name, version, commit, dev, enabled, removed, running: Boolean(active) })), candidates: input.input ? control.registry.matchInput(input.input) : [], urlCandidates: input.input ? control.registry.matchUrl(input.input) : [] }; break;
          }
          case 'runtime.run': {
            const request = runtimeTransportSchema.parse(args), state = await control.read(), handled = servicePlugins.operation(request.action);
            const node = state.nodes.find(node => node.id === request.nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
            if (handled?.options.requiresNode !== false && !node) throw new Error('Node not found');
            if (!handled) throw new Error('This runtime action is not connected');
            result = await handled.handler({ nodeId: request.nodeId, node, resource, arguments: request.arguments, signal: AbortSignal.timeout(10_000), execute: work => lifecycle.execute(work) });
            break;
          }
          case 'skills.list': {
            if (!agents) throw new Error('Agent runtime is unavailable');
            result = await agents.skills(args); break;
          }
          case 'creation.options': {
            const input = creationOptionsSchema.parse(args), definition = control.registry.get(input.pluginId), field = (definition?.creation?.fields ?? definition?.fields)?.[input.field];
            const readers: Record<string, () => Promise<unknown>> = agents ? { 'agent.models': () => agents.models(input.values.provider) } : {};
            if (field?.optionsSource === 'resource.options') { result = await resources.options(input.pluginId, input.field, input.values); break; }
            if (!field?.optionsSource || !readers[field.optionsSource]) throw new Error('Options are unavailable for this field');
            result = await readers[field.optionsSource](); break;
          }
          case 'creation.sessions': {
            const input = savedSessionsSchema.parse(args), creation = control.registry.get(input.pluginId)?.creation;
            const readers: Record<string, () => Promise<unknown>> = agents ? { 'agent.create': () => agents.savedSessions(input.query, input.offset, input.provider, input.cursor) } : {};
            if (!creation?.resume || !creation.action || !readers[creation.action]) throw new Error('Saved sessions are unavailable for this item type');
            result = await readers[creation.action](); break;
          }
          case 'capabilities': result = { creationActions: [...Object.keys(creators), ...control.registry.describe().filter(plugin => plugin.creation?.action === 'resource.attach' && plugins.capabilities(plugin.id).load).map(plugin => `resource.attach:${plugin.id}`)], providers: connections.describe() }; break;
          case 'item.create': {
            const request = placedRequest(resourceCreateSchema.parse(args), (await control.read()).nodes), creation = control.registry.get(request.pluginId)?.creation;
            if (!creation?.action || !creators[creation.action]) throw new Error('This item creation action is not available');
            if (creation.mode !== 'url' && !(creation.resume && (typeof request.data.resumeNodeId === 'string' || typeof request.data.resumeNativeSessionId === 'string')) && !validateCreationFields(creation.fields ?? {}, request.data)) throw new Error('Invalid item creation fields');
            result = await lifecycle.execute(() => creators[creation.action!](request)); break;
          }
          case 'apply': {
            const before = await control.read();
            // Without a revision the envelope goes to the newest workspace, if every command in it allows that.
            result = (args as { expectedRevision?: unknown }).expectedRevision === undefined ? await applyAtHead(control, args, revisionGuard) : await control.dispatch(args);
            await broadcast();
            if (terminals && (args as { commands?: { type: string; action?: string }[] }).commands?.some(command => ['node.archive', 'node.below'].includes(command.type) || command.type === 'nodes.action' && ['archive', 'below'].includes(command.action ?? ''))) {
              terminals.monitor(); await terminals.stopArchived();
            }
            // A placed Triage to-do brings a provider item that has never been read; load it now rather than at the next poll.
            if ((args as { commands?: { type: string }[] }).commands?.some(command => command.type === 'todo.send' || command.type === 'todo.place')) void resources.poll().catch(() => {});
            if (!(result as CommandResult).replayed) await lifecycle.execute(() => resources.mirrorCompletion(before, (result as CommandResult).state, String((args as { commandId?: unknown }).commandId), AbortSignal.timeout(20_000)));
            result = presented(result as CommandResult);
            break;
          }
          case 'view.read': result = await store.readView(String(args.clientId)); break;
          case 'view.write': result = await store.writeView(String(args.clientId), args.view); break;
          case 'subscribe': {
            const cursor = await store.events(args.after ?? 0), layer = mapLayer(args.layer);
            subscribers.set(socket, layer);
            result = { ...forLayer(await snapshot(), layer), resetRequired: cursor.resetRequired };
            break;
          }
          case 'unsubscribe': subscribers.delete(socket); result = {}; break;
          case 'admin.shutdown': send(socket, { id, result: {} }, method, () => { void close(); }); return;
          default: throw new Error('Unknown workspace method');
        }
        send(socket, { id, result }, method);
      } catch (error) { send(socket, { id, error: serializeError(error) }, method); } finally { finish?.(); }
    };
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line) void handle(line);
      }
    });
  });
  function close(): Promise<void> {
    if (shutdown) return shutdown;
    closing = true;
    shutdown = (async () => {
      health.stop();
      await workflows.pause();
      await inbox.close(); await agents?.pause(); await assignments.pause(); await triage.pause(); await todoSweeper.pause(); await checkouts.pause(); await resources.pause();
      await summaries?.close();
      await titles?.close();
      await agentTitles?.close();
      await attachTitles?.close();
      await standup.close();
      await updates.close();
      await plots.close();
      await projectSummaries.close();
      await reminders.close();
      await resources.close();
      await plugins.close();
      await findings?.close();
      await loops.close();
      await autoReviews.close();
      await servicePlugins.close();
      await reviews?.close();
      await architecture.close();
      await lifecycle.drain();
      // Cancel this client's pending hello/configuration before waiting for its
      // result. Closing a client never stops the independent supervisor or PTYs.
      await terminals?.close();
      await logPolicySync;
      // Startup must unwind before releasing SQLite. Its catch below is outside
      // this promise, so both startup failure and concurrent close share one drain.
      await Promise.allSettled([startup, startupReviews, startupArchitecture]);
      // An in-flight workflow recovery can resume its timer after the first pause.
      await workflows.pause();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      // Remove our socket while still holding ownership: a successor must not have
      // its newly created socket removed by this process during shutdown.
      rmSync(paths.socket, { force: true }); store.releaseService(instanceId); useValidatorStore(); store.close();
    })();
    return shutdown;
  }
  startup = (async () => {
    await migratePluginResources(store, control.registry);
    store.migrateSettingsDefaults();
    applySettingsPresets(store, control.registry);
    assertStarting();
    // Only the process holding the SQLite ownership record can remove a stale socket.
    rmSync(paths.socket, { force: true });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.removeListener('error', reject); resolve(); }); });
    chmodSync(paths.socket, 0o600);
    health.start();
    store.recoverInterruptedJobs();
    await configureLogs();
    assertStarting();
    if (terminals && lifecycle.allowsBackgroundWork) await terminals.recover();
    assertStarting();
    if (lifecycle.allowsBackgroundWork) await resources.recover();
    assertStarting();
    findings?.recover();
    if (lifecycle.allowsBackgroundWork) startupReviews = reviews?.recover();
    // The asynchronous review preparation stays owned even after startup returns.
    void startupReviews?.catch(() => {});
    if (lifecycle.allowsBackgroundWork) startupArchitecture = architecture.recover();
    void startupArchitecture?.catch(() => {});
    if (lifecycle.allowsBackgroundWork) await workflows.recover();
    assertStarting();
    summaries?.start();
    titles?.start();
    agentTitles?.start();
    attachTitles?.start();
    standup.start();
    updates.start();
    plots.start();
    projectSummaries.start();
    reminders.start();
    assignments.start(); triage.start(); todoSweeper.start(); checkouts.start(); resources.start(); inbox.start(); loops.start(); servicePlugins.start(); agents?.start();
  })();
  try { await startup; } catch (error) { await close(); throw error; }
  return { close, store, control, resources, paths, instanceId };
}
