import { creationConnections, requestConnections } from '../core/resource-creation.ts';
import { randomUUID } from 'node:crypto';
import { agentLastLine } from '../core/last-line.ts';
import { redactSecrets } from '../session-runtime/activity-summary.ts';
import { completionAttention } from '../core/completion-attention.ts';
import * as z from 'zod/v4';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { WorkspaceControl, WorkspaceCommand } from '../core/control.ts';
import type { RuntimeOptions } from '../session-runtime/client.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import { canonical } from '../core/control.ts';
import { readAgentPlan } from '../session-runtime/agent-plan.ts';
import type { HostedLaunch } from '../session-runtime/agent-plan.ts';
import { agentProvider } from './agent-providers.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { AgentContextCoordinator } from './agent-context.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { skillListSchema, skillRunSchema } from '../core/skills.ts';
import { isArchived, isBelow } from '../../src/graph/archive.ts';
import { agentReadiness, isPermissionPrompt } from './rollout-validation.ts';
import { BACKGROUND_STALE_MS, backgroundSummary, outstanding, teammateKey } from './agent-background.ts';
import { agentScene, sceneChanges } from './agent-scene.ts';
import type { BackgroundState, BackgroundTask } from './agent-background.ts';
import { attachPublishedArtifact } from './agent-artifacts.ts';
import { applyAtHead } from './apply-at-head.ts';
import { parseClaudeArtifactUrl } from '../../src/resource-plugins/items/claude-artifact/url.ts';

/** Hooks that say something about the session without being a step of its turn: they are recorded and never change the item's status. */
const NOTED = ['SubagentStart', 'PreCompact', 'PostCompact', 'PostToolUseFailure', 'PermissionDenied', 'TaskCreated', 'TaskCompleted', 'PostModelSwitch'] as const;
const hookSchema = z.object({ nodeId: z.string().min(1), processSessionId: z.string().uuid(), nativeSessionId: z.string().uuid(),
  observedAt: z.number().int().positive(), event: z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop', 'SubagentToolUse', 'SubagentToolStart', 'TeammateIdle', ...NOTED]),
  lastMessage: z.string().max(2000).optional(), taskId: z.string().min(1).max(200).optional(), model: z.string().min(1).max(200).optional(), previousModel: z.string().min(1).max(200).optional(), interrupt: z.boolean().optional(), worktree: z.boolean().optional(),
  notificationType: z.string().optional(), toolName: z.string().optional(), recipient: z.string().min(1).max(64).optional(), agentId: z.string().min(1).max(200).optional(), teammate: z.string().min(1).max(200).optional(),
  backgroundTasks: z.array(z.object({ id: z.string().min(1).max(200), type: z.string().max(100), status: z.string().max(100).optional(), name: z.string().min(1).max(64).optional() })).max(100).optional(),
  launched: z.object({ id: z.string().min(1).max(200), kind: z.literal('subagent') }).optional(),
  artifact: z.object({ url: z.string().max(2048).refine(url => Boolean(parseClaudeArtifactUrl(url)), 'Not a claude.ai artifact URL'), title: z.string().trim().min(1).max(200).optional() }).optional(),
});
type HookEvent = z.infer<typeof hookSchema>;
/** Main-thread tools that give a waiting teammate work; a newly launched one shows up as a new task instead. */
const TEAM_TOOLS = ['SendMessage'];
type Observations = Pick<SqliteStore, 'observeAgent' | 'readSettings' | 'agentObservation' | 'agentBackground' | 'observeBackground' | 'clearBackground'>;

/** What first-party services use to start a Claude session on a prompt they built. */
export interface HostedAgents {
  /** Rejects with the reason Claude cannot be started here. */
  ready(): Promise<unknown>;
  launch(request: ResourceCreate, hosted: HostedLaunch): Promise<unknown>;
  /** Where a launch without a project folder starts. */
  fallbackDirectory(): string;
}
export class AgentCoordinator {
  private directory: string;
  private options: RuntimeOptions;
  private control: WorkspaceControl;
  private sessions: SessionCoordinator;
  private context: AgentContextCoordinator;
  private changed: () => Promise<void>;
  private observations: Observations;
  private quietTimer?: ReturnType<typeof setInterval>; private settling?: Promise<void>;
  private resuming = new Map<string, Promise<SessionSnapshot>>();
  private skillRuns = new Map<string, { source: string; promise: Promise<SessionSnapshot> }>();
  constructor(directory: string, options: RuntimeOptions, control: WorkspaceControl, sessions: SessionCoordinator, context: AgentContextCoordinator, changed: () => Promise<void>, observations: Observations) {
    this.directory = directory; this.options = options; this.control = control; this.sessions = sessions; this.context = context; this.changed = changed;
    this.observations = observations;
  }
  start() { this.quietTimer ??= setInterval(() => { this.settling ??= this.settleQuiet().catch(() => {}).finally(() => { this.settling = undefined; }); }, 5_000); this.quietTimer.unref?.(); }
  async pause() { clearInterval(this.quietTimer); this.quietTimer = undefined; await this.settling; }
  /** An interrupted Claude turn sends no Stop hook, so its item would stay working.
   * Once the terminal has been quiet long enough to count as ready, show it idle.
   * A permission prompt the person answered in the terminal, with no hook after
   * it, is repaired the same way; readiness requires that answer. */
  async settleQuiet(now = Date.now) {
    const state = await this.control.read(), commands: WorkspaceCommand[] = [];
    for (const node of state.nodes) {
      const session = node.activity === 'working' || node.beside || node.pose ? state.resources.find(resource => resource.id === node.resourceId) : undefined;
      // A window that ran out (a quiet helper, a command's hold) changes the scene without any hook; the update below replaces it
      // when the item settles too. Only a session this service has heard from, or a node it has already written, is its to settle.
      if (session?.data.provider === 'claude' && typeof session.data.sessionId === 'string') {
        const background = this.observations.agentBackground(session.data.sessionId);
        const scene = background || node.pose || node.beside || node.helpers ? sceneChanges(node, agentScene(node, background, now(), { ended: node.pose === 'ended' }), now()) : undefined;
        if (scene) commands.push({ type: 'node.update', id: node.id, ...scene });
      }
      const prompted = node.attention === 'input' && node.attentionNote === 'Agent needs permission';
      if (!prompted && (node.activity !== 'working' || node.attention === 'input')) continue;
      const resource = state.resources.find(resource => resource.id === node.resourceId);
      if (resource?.data.provider !== 'claude' || typeof resource.data.sessionId !== 'string') continue;
      const sessionId = resource.data.sessionId, waiting = this.waitingInBackground(sessionId, now());
      if (prompted ? !isPermissionPrompt(this.observations.agentObservation(sessionId)?.event) : waiting.length) continue;
      const background = prompted ? undefined : this.observations.agentBackground(sessionId);
      if (background?.turnEnded && !background.waking && background.tasks.length) {
        commands.push({ type: 'node.update', id: node.id, ...this.settled([]) }, ...completionAttention(node, `claude:${sessionId}:${background.observedAt}`, 'Agent finished'));
        continue;
      }
      const readiness = await agentReadiness(this.sessions, state, { nodeId: node.id, sessionId }, sessionId => this.observations.agentObservation(sessionId), now);
      if (readiness !== 'idle') continue;
      commands.push({ type: 'node.update', id: node.id, ...(prompted ? this.settled(waiting) : { activity: 'idle', summary: 'Ready for your next prompt' }) });
    }
    if (!commands.length) return;
    try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'agent-quiet' }, commands }); await this.changed(); }
    catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
  }
  async savedSessions(query: string, offset: number, provider = 'claude', cursor?: string) { return agentProvider(provider).discover(await this.control.read(), query, offset, cursor); }
  async models(provider: unknown) { return agentProvider(provider).models(); }
  async injectContext(nodeId: string, input: unknown) {
    const args = z.object({ operation: z.enum(['queue', 'status']), sessionId: z.string().min(1), requestId: z.string().uuid().optional() }).strict().parse(input);
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
    const unavailable = (message: string) => {
      if (args.operation === 'queue') throw new Error(message);
      return { state: 'unavailable' as const, message };
    };
    if (!resource || resource.data.provider !== 'claude') return unavailable('Adding context to a running session is currently available for Claude.');
    if (resource.data.sessionId !== args.sessionId) return unavailable('This session has changed. Reopen the item and try again.');
    if (typeof resource.data.launchDirectory !== 'string' || !resource.data.nativeSessionId) return unavailable('Resume this conversation through the table to connect its workbench hooks.');
    const current = await this.sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId: args.sessionId, after: Number.MAX_SAFE_INTEGER });
    if (current.session.state !== 'running' || current.session.stopRequestedAt || current.session.readOnly) return unavailable('Resume the session before adding workbench context.');
    // Revalidate after the runtime read; a concurrent resume must not bind this
    // request to a replacement process or another native conversation.
    const fresh = (await this.control.read()).resources.find(candidate => candidate.id === resource.id);
    if (fresh?.data.sessionId !== args.sessionId || fresh.data.nativeSessionId !== resource.data.nativeSessionId || fresh.data.provider !== 'claude') return unavailable('This session has changed. Reopen the item and try again.');
    if (args.operation === 'status') return this.context.guideStatus(nodeId, args.sessionId);
    return this.context.queueGuide(nodeId, args.sessionId, z.string().uuid().parse(args.requestId));
  }
  private async skillDirectory(projectId: string, requested?: string) {
    const state = await this.control.read(), project = state.nodes.find(node => node.id === projectId && !node.resourceId && !node.projectId);
    if (!project || isArchived(project, state.nodes)) throw new Error('Choose an available project for this skill');
    const cwd = requested || project.workingDirectory || this.sessions.fallbackDirectory();
    try { if (cwd && isAbsolute(cwd) && statSync(cwd).isDirectory()) return realpathSync(cwd); } catch { /* Present a useful directory error below. */ }
    throw new Error('Select an existing working directory for this skill or its project');
  }
  async skills(input: unknown) {
    const request = skillListSchema.parse(input), cwd = await this.skillDirectory(request.projectId, request.cwd);
    return agentProvider(request.provider).skills(cwd);
  }
  async runSkill(projectId: string, input: unknown) {
    const args = skillRunSchema.parse(input);
    const original: ResourceCreate = { requestId: args.requestId, nodeId: args.nodeId, resourceId: args.resourceId, expectedRevision: args.expectedRevision, projectId,
      pluginId: 'agent.session', title: 'Skill run', position: args.position, ...(args.connection ? { connection: args.connection } : {}), data: { provider: args.provider, model: args.model, skillId: args.skillId, arguments: args.arguments, ...(args.cwd ? { cwd: args.cwd } : {}) } };
    const source = canonical({ request: original }), active = this.skillRuns.get(args.requestId);
    if (active) { if (active.source !== source) throw new Error('Skill launch ID was reused with different input'); return active.promise; }
    const promise = (async () => {
      const saved = readAgentPlan(this.directory, args.requestId);
      if (saved) {
        if (canonical(saved.source) !== source) throw new Error('Skill launch ID was reused with different input');
        return this.sessions.launchPrepared(saved);
      }
      const provider = agentProvider(args.provider), cwd = await this.skillDirectory(projectId, args.cwd), catalog = await provider.skills(cwd);
      const selected = catalog.skills.find(skill => skill.id === args.skillId);
      if (!selected) throw new Error('This skill is no longer available in this folder. Refresh the skill list.');
      if (selected.unavailable) throw new Error(selected.unavailable);
      const capability = await provider.probe(), state = await this.control.read();
      return this.sessions.launchPrepared(provider.prepare({ request: { ...original, title: selected.name, data: { ...original.data, cwd } }, originRequest: original,
        state, directory: this.directory, runtime: this.options, capability,
        skill: { id: selected.id, name: selected.name, prompt: provider.skillPrompt(selected, args.arguments) },
      }, this.observations.readSettings().value));
    })().finally(() => this.skillRuns.delete(args.requestId));
    this.skillRuns.set(args.requestId, { source, promise }); return promise;
  }
  async create(request: ResourceCreate) {
    if (typeof request.data.resumeNativeSessionId === 'string') {
      const id = z.string().uuid().parse(request.data.resumeNativeSessionId), key = `native:${request.data.provider ?? 'claude'}:${id}`;
      if (this.resuming.has(key)) return this.resuming.get(key)!;
      const pending = this.importNative(request, id).finally(() => this.resuming.delete(key));
      this.resuming.set(key, pending); return pending;
    }
    if (typeof request.data.resumeNodeId === 'string' && request.data.resumeNodeId) return this.resume(request.data.resumeNodeId, request.requestId, request.projectId, request);
    const provider = agentProvider(request.data.provider), capability = await provider.probe(), state = await this.control.read();
    // A launch that names no model, such as one from an agent, gets the provider's current default.
    const model = typeof request.data.model === 'string' && request.data.model.trim() ? request.data.model : (await provider.models()).default;
    return this.sessions.launchPrepared(provider.prepare({ request: { ...request, data: { ...request.data, model } }, state, directory: this.directory, runtime: this.options, capability, fallbackDirectory: this.sessions.fallbackDirectory() }, this.observations.readSettings().value));
  }
  /** A new Claude session whose opening prompt the host built (never the renderer). */
  async launchHosted(request: ResourceCreate, hosted: HostedLaunch) {
    const saved = readAgentPlan(this.directory, request.requestId);
    if (saved) {
      if (canonical(saved.source) !== canonical({ request, hosted })) throw new Error('Agent launch ID was reused with different input');
      return this.sessions.launchPrepared(saved);
    }
    const provider = agentProvider('claude'), capability = await provider.probe(), state = await this.control.read();
    return this.sessions.launchPrepared(provider.prepare({ request, state, directory: this.directory, runtime: this.options, capability, hosted }, this.observations.readSettings().value));
  }
  private async importNative(request: ResourceCreate, id: string) {
    const saved = readAgentPlan(this.directory, request.requestId);
    if (saved) {
      if (canonical(saved.source) !== canonical({ request })) throw new Error('Agent launch ID was reused with different input');
      return this.sessions.launchPrepared(saved);
    }
    const state = await this.control.read();
    const existing = state.nodes.find(node => state.resources.some(resource => resource.id === node.resourceId && resource.data.provider === (request.data.provider ?? 'claude') && resource.data.nativeSessionId === id));
    if (existing) {
      if (isArchived(existing, state.nodes)) throw new Error('Restore this archived item before resuming it.');
      if (isBelow(existing, state.nodes)) throw new Error('Bring this item back from Undermap before resuming it.');
      return this.resume(existing.id, request.requestId, undefined, request);
    }
    const provider = agentProvider(request.data.provider), native = await provider.resolve(id), capability = await provider.probe();
    return this.sessions.launchPrepared(provider.prepare({ request, state, directory: this.directory, runtime: this.options, capability, native }, this.observations.readSettings().value));
  }
  async resume(nodeId: string, requestId: string, projectId?: string, originRequest?: ResourceCreate, continueWork = false) {
    z.string().uuid().parse(requestId);
    if (this.resuming.has(nodeId)) return this.resuming.get(nodeId)!;
    const pending = this.resumeOnce(nodeId, requestId, projectId, originRequest, continueWork).finally(() => this.resuming.delete(nodeId));
    this.resuming.set(nodeId, pending); return pending;
  }
  async restore(nodeId: string, requestId: string, continueWork: boolean) {
    const result = await this.resume(nodeId, requestId, undefined, undefined, continueWork);
    const deadline = Date.now() + 8000;
    while (true) {
      const current = await this.sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId: result.session.id });
      if (!['running', 'starting'].includes(current.session.state)) throw Object.assign(new Error('The agent could not resume. Open the terminal history for details.'), { code: 'LAUNCH_FAILED' });
      const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId);
      const resource = state.resources.find(resource => resource.id === node?.resourceId);
      if (resource?.data.sessionId === result.session.id && resource.data.nativeStartedAt) return current;
      if (Date.now() > deadline) throw new Error('The agent has not confirmed the resumed conversation. Open its terminal to check for a sign-in or startup prompt, then retry recovery.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  private async resumeOnce(nodeId: string, requestId: string, projectId?: string, originRequest?: ResourceCreate, continueWork = false) {
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || !resource || typeof resource.data.nativeSessionId !== 'string') throw new Error('No saved native conversation for this item');
    if (isArchived(node, state.nodes)) throw new Error('Restore this archived item before resuming it.');
    if (isBelow(node, state.nodes)) throw new Error('Bring this item back from Undermap before resuming it.');
    if (projectId !== undefined && node.projectId !== projectId) throw new Error('Resume the session in its existing project');
    const saved = readAgentPlan(this.directory, requestId);
    if (saved) {
      if (saved.action !== 'agent.resume' || saved.nodeId !== nodeId || (originRequest && canonical(saved.source) !== canonical({ request: originRequest }))) throw new Error('Resume request ID was reused for a different session');
      return this.sessions.launchPrepared(saved);
    }
    const current = await this.sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId: String(resource.data.sessionId) }).catch(error => { if (error.code === 'SESSION_NOT_FOUND') return undefined; throw error; });
    if (current?.session.archivedAt) throw new Error('Restore this session in Sessions before resuming it.');
    if (current && ['running', 'starting'].includes(current.session.state)) {
      if (originRequest && requestConnections(originRequest).length) {
        const envelope = { commandId: `connect:${requestId}`, actor: { kind: 'user' as const, id: 'session-resume' }, commands: creationConnections(requestConnections(originRequest), nodeId) };
        if (originRequest.expectedRevision === undefined) await applyAtHead(this.control, envelope);
        else await this.control.dispatch({ ...envelope, expectedRevision: originRequest.expectedRevision });
        await this.changed();
      }
      return current; // Reattach sends no prompt and starts no CLI.
    }
    const provider = agentProvider(resource.data.provider), capability = await provider.probe();
    // Probing the CLI takes seconds while status updates keep changing the graph.
    const fresh = await this.control.read();
    return this.sessions.launchPrepared(provider.prepare({ request: { requestId, nodeId, resourceId: resource.id, expectedRevision: fresh.revision, pluginId: resource.pluginId, title: node.title, projectId: node.projectId, position: node.position, data: {} }, state: fresh, directory: this.directory, runtime: this.options, capability, resumeNodeId: nodeId, originRequest, continueWork }, this.observations.readSettings().value));
  }
  private waitingInBackground(sessionId: string, at: number) {
    const background = this.observations.agentBackground(sessionId);
    if (!background?.tasks.length) return [];
    if (at - background.observedAt < BACKGROUND_STALE_MS) return outstanding(background, at);
    this.observations.clearBackground(sessionId); return [];
  }
  /** Background work outstanding after this main-thread hook. */
  private background(event: HookEvent) {
    if (event.event === 'SessionEnd') { this.observations.clearBackground(event.processSessionId); return []; }
    const turnEnded = ['Stop', 'StopFailure'].includes(event.event) ? true : ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event.event) ? false : undefined;
    const known = turnEnded === undefined && event.event !== 'SessionStart' ? this.observations.agentBackground(event.processSessionId)
      : this.observations.observeBackground(event.processSessionId, { observedAt: event.observedAt, snapshot: event.backgroundTasks, launched: event.launched, turnEnded, poked: !turnEnded && TEAM_TOOLS.includes(event.toolName ?? ''), ...(event.recipient ? { recipient: event.recipient } : {}),
        ...(event.toolName === 'Bash' && event.event === 'PreToolUse' ? { shell: 'start' as const } : event.toolName === 'Bash' && event.event === 'PostToolUse' ? { shell: 'end' as const } : {}),
        ...(event.event === 'SessionStart' && event.model ? { model: { to: event.model } } : {}), ...(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event.event) ? { worktree: event.worktree === true } : {}) });
    return known ? outstanding(known, event.observedAt) : [];
  }
  /** Where an item stands once nothing asks for the person: its outstanding background work, or ready. */
  private settled(tasks: BackgroundTask[], waking = false) {
    const summary = backgroundSummary(tasks) ?? (waking ? 'Claude is working' : undefined);
    return summary ? { activity: 'working', attention: 'none', summary } as const : { activity: 'idle', attention: 'none', summary: 'Ready for your next prompt' } as const;
  }
  /** A subagent finishing updates what an ended main turn is still waiting on; the
   * main thread's next Stop decides when the item is ready again. Subagent work
   * also answers a permission prompt raised after the main turn ended: a held
   * dialog runs no tools and ends no subagent, and no main-thread hook will follow
   * to clear it. While the main turn is active its own hooks decide, and the prompt
   * stays when another known subagent could be the one asking. */
  private async subagentObserved(event: HookEvent) {
    const stopped = event.event === 'SubagentStop', snapshot = event.backgroundTasks?.filter(task => task.id !== event.agentId);
    let background: BackgroundState | undefined, tracked = false, recorded = false;
    // Subagents use tools constantly; only one that follows a permission prompt matters.
    if (!stopped && !isPermissionPrompt(this.observations.agentObservation(event.processSessionId)?.event)) return {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.control.read(), node = state.nodes.find(node => node.id === event.nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
      if (!node || !resource || resource.data.sessionId !== event.processSessionId || resource.data.nativeSessionId !== event.nativeSessionId || resource.data.provider !== 'claude') return { ignored: true };
      if (!background) {
        const before = this.observations.agentBackground(event.processSessionId);
        tracked = stopped && Boolean(before?.tasks.some(task => task.id === event.agentId));
        background = stopped ? this.observations.observeBackground(event.processSessionId, { observedAt: event.observedAt, ended: event.agentId, snapshot }) : before;
      }
      if (!background) return {};
      const last = this.observations.agentObservation(event.processSessionId);
      const others = background.tasks.some(task => task.id !== event.agentId && ['subagent', 'teammate'].includes(task.kind));
      const prompted = background.turnEnded && node.attention === 'input' && node.attentionNote === 'Agent needs permission' && !others;
      const answered = prompted && (recorded ? last?.event === event.event && last.observedAt === event.observedAt
        : isPermissionPrompt(last?.event) && (recorded = this.observations.observeAgent(event.processSessionId, event.observedAt, event.event)));
      const waiting = outstanding(background, event.observedAt), summary = backgroundSummary(waiting) ?? 'Claude is working';
      if (!answered && (!stopped || !background.turnEnded || node.activity !== 'working' || node.attention !== 'none' || node.summary === summary)) return {};
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: event.processSessionId }, commands: [{ type: 'node.update', id: node.id, ...(answered ? this.settled(waiting, tracked) : { summary }) }] });
        await this.changed(); return {};
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new Error('Agent status changed concurrently; a newer observation will reconcile it');
  }
  /** A teammate's own hooks say whether it works or waits; its task is reported as
   * running either way. Once the main turn has ended, the last busy teammate going
   * idle readies the item as a Stop without background work would, and a teammate
   * that picks up a tool again puts it back to waiting. Tool hooks are recorded only
   * while a teammate is known, and never for a task known as something else. */
  private async teammateObserved(event: HookEvent) {
    const idle = event.event === 'TeammateIdle', key = event.teammate ?? (event.agentId ? teammateKey(event.agentId) : 'teammate');
    let background: BackgroundState | undefined, before: BackgroundTask[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.control.read(), node = state.nodes.find(node => node.id === event.nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
      if (!node || !resource || resource.data.sessionId !== event.processSessionId || resource.data.nativeSessionId !== event.nativeSessionId || resource.data.provider !== 'claude') return { ignored: true };
      if (!background) {
        const known = this.observations.agentBackground(event.processSessionId);
        if (!idle && (!known?.tasks.some(task => task.kind === 'teammate') || known.tasks.some(task => task.id === event.agentId))) return {};
        before = known ? outstanding(known, event.observedAt) : [];
        background = this.observations.observeBackground(event.processSessionId, { observedAt: event.observedAt, teammate: { key, state: idle ? 'idle' : event.event === 'SubagentToolStart' ? 'tool' : 'quiet' } });
      }
      const summary = backgroundSummary(outstanding(background, event.observedAt));
      if (!background.turnEnded || background.waking || summary === backgroundSummary(before)) return {};
      const resting = node.activity === 'idle' && (node.attention === 'none' || (node.attention === 'input' && node.attentionNote === 'Agent waiting'));
      if (!(node.activity === 'working' && node.attention === 'none') && !(summary && resting)) return {};
      const commands: WorkspaceCommand[] = summary ? [{ type: 'node.update', id: node.id, activity: 'working', attention: 'none', summary }]
        : [{ type: 'node.update', id: node.id, ...this.settled([]) }, ...completionAttention(node, `claude:${event.processSessionId}:${event.observedAt}`, 'Agent finished')];
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: event.processSessionId }, commands }); await this.changed(); return {}; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new Error('Agent status changed concurrently; a newer observation will reconcile it');
  }
  /** Every hook may change what the item's sheep is told (AGENT-07e); the node is written only when a value differs. */
  async hook(input: unknown) {
    const event = hookSchema.parse(input), noted = (NOTED as readonly string[]).includes(event.event), result = noted ? {} : await this.observed(event);
    const happened = event.event === 'PostToolUseFailure' && !event.interrupt ? 'stumble' : event.event === 'PermissionDenied' ? 'bump' : undefined;
    for (let attempt = 0; attempt < 3 && !('ignored' in result); attempt++) {
      const state = await this.control.read(), node = state.nodes.find(node => node.id === event.nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
      if (!node || !resource || resource.data.sessionId !== event.processSessionId || resource.data.nativeSessionId !== event.nativeSessionId || resource.data.provider !== 'claude') break;
      if (!attempt && event.agentId && (event.event === 'SubagentToolStart' || event.event === 'SubagentToolUse' || event.event === 'SubagentStart')) this.observations.observeBackground(event.processSessionId, { observedAt: event.observedAt, helper: { id: event.agentId, state: event.event === 'SubagentToolUse' ? 'quiet' : 'tool' } });
      else if (!attempt && noted) this.observations.observeBackground(event.processSessionId, { observedAt: event.observedAt,
        ...(event.event === 'PreCompact' ? { compact: 'start' as const } : event.event === 'PostCompact' ? { compact: 'end' as const } : {}),
        ...(event.taskId && event.event === 'TaskCreated' ? { task: { id: event.taskId, state: 'created' as const } } : event.taskId && event.event === 'TaskCompleted' ? { task: { id: event.taskId, state: 'completed' as const } } : {}),
        ...(event.event === 'PostModelSwitch' && event.model ? { model: { to: event.model, from: event.previousModel } } : {}), ...(event.event === 'PostToolUseFailure' && event.toolName === 'Bash' ? { shell: 'end' as const } : {}) });
      const scene = sceneChanges(node, agentScene(node, this.observations.agentBackground(event.processSessionId), event.observedAt, { ended: event.event === 'SessionEnd' }), event.observedAt, node.activity === 'working' ? happened : undefined);
      if (!scene) break;
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: event.processSessionId }, commands: [{ type: 'node.update', id: node.id, ...scene }] }); await this.changed(); break; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
    return result;
  }
  private async observed(event: HookEvent) {
    if (event.event === 'TeammateIdle' || event.event === 'SubagentToolStart') return this.teammateObserved(event);
    if (event.event === 'SubagentToolUse') await this.teammateObserved(event);
    if (event.event === 'SubagentStop' || event.event === 'SubagentToolUse') return this.subagentObserved(event);
    // A publish is its own fact, independent of how this observation orders against others.
    if (event.event === 'PostToolUse' && event.artifact) await attachPublishedArtifact(this.control, this.changed, { nodeId: event.nodeId, processSessionId: event.processSessionId, nativeSessionId: event.nativeSessionId, ...event.artifact });
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.control.read(), node = state.nodes.find(node => node.id === event.nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
      if (!node || !resource || resource.data.sessionId !== event.processSessionId || resource.data.nativeSessionId !== event.nativeSessionId || resource.data.provider !== 'claude') return { ignored: true };
      if (!this.observations.observeAgent(event.processSessionId, event.observedAt, event.event === 'Notification' && event.notificationType ? `Notification:${event.notificationType}` : event.event)) return { ignored: true };
      const waiting = this.background(event), waitingSummary = event.event === 'Stop' ? backgroundSummary(waiting) : undefined;
      if (waiting.length && event.event === 'Notification' && event.notificationType === 'idle_prompt') return {};
      const inputNeeded = event.event === 'PermissionRequest' || (event.event === 'PreToolUse' && event.toolName === 'AskUserQuestion') || (event.event === 'Notification' && ['permission_prompt', 'idle_prompt'].includes(event.notificationType ?? ''));
      const working = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event.event) && !inputNeeded;
      const commands: WorkspaceCommand[] = [];
      if (event.event === 'SessionStart') commands.push({ type: 'item.update', id: node.id, data: { ...resource.data, nativeStartedAt: new Date().toISOString() } });
      const attentionNote = event.event === 'PermissionRequest' || event.notificationType === 'permission_prompt' ? 'Agent needs permission' : event.event === 'PreToolUse' && inputNeeded ? 'Agent asked a question'
        : event.notificationType === 'idle_prompt' ? 'Agent waiting' : event.event === 'StopFailure' ? 'Agent hit an error' : undefined;
      // The line the agent ended its turn on stays on the node until the next prompt starts a turn.
      const lastLine = event.event === 'Stop' && !waitingSummary ? agentLastLine(redactSecrets(event.lastMessage ?? '')) ?? null : event.event === 'UserPromptSubmit' ? null : undefined;
      const turnEndedAt = event.event === 'Stop' ? new Date(event.observedAt).toISOString() : undefined;
      const next = waitingSummary ? { activity: 'working', attention: 'none', summary: waitingSummary } as const : {
        activity: working ? 'working' : 'idle', attention: inputNeeded ? 'input' : event.event === 'StopFailure' ? 'error' : event.event === 'SessionEnd' ? node.attention : 'none', ...(attentionNote ? { attentionNote } : {}),
        summary: inputNeeded ? 'Waiting for your input' : working ? 'Claude is working' : event.event === 'StopFailure' ? 'Claude reported an error' : event.event === 'SessionEnd' ? 'Conversation closed' : 'Ready for your next prompt',
        ...(lastLine !== undefined && (lastLine ?? undefined) !== node.lastLine ? { lastLine } : {}),
        ...(turnEndedAt && turnEndedAt !== node.turnEndedAt ? { turnEndedAt } : {}),
        ...(event.event === 'UserPromptSubmit' && node.recap ? { recap: null } : {}),
      } as const;
      // Our own MCP tools must be able to read a revision and then write with it.
      // Repeated tool hooks are observations, not graph edits. They must also not
      // overwrite a short summary the agent just wrote through MCP.
      if ((event.event !== 'Notification' || inputNeeded) && (node.activity !== next.activity || node.attention !== next.attention || (attentionNote && !waitingSummary && node.attentionNote !== attentionNote) || event.event === 'SessionEnd' || (waitingSummary && node.summary !== waitingSummary) || 'lastLine' in next || 'recap' in next || 'turnEndedAt' in next))
        commands.push({ type: 'node.update', id: node.id, ...next, ...sceneChanges(node, agentScene({ activity: next.activity, attention: next.attention, attentionNote: 'attentionNote' in next ? next.attentionNote : undefined }, this.observations.agentBackground(event.processSessionId), event.observedAt, { ended: event.event === 'SessionEnd' }), event.observedAt) });
      if (event.event === 'Stop' && !waitingSummary) commands.push(...completionAttention(node, `claude:${event.processSessionId}:${event.observedAt}`, 'Agent finished'));
      try {
        if (commands.length) { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: event.processSessionId }, commands }); await this.changed(); }
        return ['SessionStart', 'UserPromptSubmit'].includes(event.event) ? { context: await this.context.prepare(node.id) } : {};
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new Error('Agent status changed concurrently; a newer observation will reconcile it');
  }
}
