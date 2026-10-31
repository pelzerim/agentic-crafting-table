import { isArchived, isBelow, isOffMap } from '../../src/graph/archive.ts';
import * as z from 'zod/v4';
import { creationConnectionSchema, creationConnections, creationNear } from '../core/resource-creation.ts';
import { isAbsolute, join } from 'node:path';
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { completionAttention } from '../core/completion-attention.ts';
import { canonical } from '../core/control.ts';
import { SupervisorConnection } from '../session-runtime/client.ts';
import type { RuntimeOptions } from '../session-runtime/client.ts';
import type { ConversationSwitch, LaunchRequest, NativeAgentState, SessionRecord, SessionSnapshot } from '../session-runtime/protocol.ts';
import type { WorkspaceControl, WorkspaceCommand } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { fieldDefaults } from '../../src/resource-plugins/define.ts';
import { applyAtHead } from './apply-at-head.ts';
import { defaultDirectory } from '../core/working-directories.ts';

export const terminalCreateSchema = z.object({
  requestId: z.string().uuid(), nodeId: z.string().uuid(), resourceId: z.string().uuid(), sessionId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().optional(), title: z.string().trim().min(1).max(500),
  projectId: z.string().min(1).max(200).optional(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(), placedBy: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1).max(4096).optional(), connection: creationConnectionSchema.optional(),
});
export type TerminalCreate = z.infer<typeof terminalCreateSchema>;
/** Without `expectedRevision` the plan's commands are applied to the newest workspace when it launches. */
export interface PreparedSession { requestId: string; expectedRevision?: number; nodeId: string; commands: WorkspaceCommand[]; launch: LaunchRequest; action: 'terminal.create' | 'terminal.resume' | 'agent.create' | 'agent.resume' | 'review.create' | 'review.resume'; source?: unknown }

/** The short Needs me reason for a native agent status that needs the user. */
export function nativeAttentionNote(native: Pick<NativeAgentState, 'status' | 'input'>, disconnected = true) {
  return native.status === 'error' ? disconnected ? 'Agent disconnected' : 'Agent reported an error' : native.status !== 'input' ? undefined
    : native.input === 'approval' ? 'Agent needs permission' : native.input === 'question' ? 'Agent asked a question' : 'Agent waiting';
}

export class SessionCoordinator {
  readonly runtime: SupervisorConnection;
  /** Told when a running native CLI has moved to another conversation. */
  onConversationSwitch?: (nodeId: string, sessionId: string, switched: ConversationSwitch) => void;
  /** The native status last written per running session. */
  private nativeApplied = new Map<string, string>();
  private store: SqliteStore;
  private control: WorkspaceControl;
  private changed: () => Promise<void>;
  private inflight = new Map<string, Promise<SessionSnapshot>>();
  private restarting = new Map<string, Promise<SessionSnapshot>>();
  private restartDirectory: string;
  private inputs = new Map<string, string>();
  private observing?: Promise<void>;
  private recovering?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(store: SqliteStore, control: WorkspaceControl, options: RuntimeOptions, changed: () => Promise<void>) {
    this.store = store; this.control = control; this.changed = changed;
    this.restartDirectory = join(options.directory, 'terminal-launches');
    this.runtime = new SupervisorConnection(options, client => client.call('diagnostics.configure', store.readSettings().value.diagnostics));
  }
  async create(input: unknown) {
    const request = terminalCreateSchema.parse(input);
    const path = join(this.restartDirectory, `create-${request.requestId}.json`);
    const saved = () => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as { request: TerminalCreate; plan: PreparedSession };
        if (canonical(value.request) !== canonical(request)) throw new Error('Terminal launch ID was reused with different input');
        return value.plan;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
    const prior = saved(); if (prior) return this.launchPrepared(prior);
    const state = await this.control.read();
    // Another caller may have frozen this request while the state read awaited.
    const concurrent = saved(); if (concurrent) return this.launchPrepared(concurrent);
    const project = state.nodes.find(node => node.id === request.projectId && !node.resourceId);
    const inherited = fieldDefaults(this.control.registry.get('terminal.session')?.creation?.fields, project, request.cwd === undefined ? {} : { cwd: request.cwd }).cwd || this.fallbackDirectory();
    let cwd: string;
    try {
      if (typeof inherited !== 'string' || !isAbsolute(inherited) || !statSync(inherited).isDirectory()) throw new Error();
      cwd = realpathSync(inherited);
    } catch { throw new Error('Choose an existing working directory for this terminal or its project'); }
    const shell = process.env.SHELL || '/bin/zsh';
    if (!isAbsolute(shell)) throw new Error('The configured shell must be an absolute path'); accessSync(shell, constants.X_OK);
    const workspaceId = `local:${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
    const launch: LaunchRequest = { sessionId: request.sessionId, requestId: request.requestId, nodeId: request.nodeId, workspaceId, executable: shell, args: ['-l'], cwd, cols: 100, rows: 30 };
    const plan: PreparedSession = { requestId: request.requestId, expectedRevision: request.expectedRevision, nodeId: request.nodeId, action: 'terminal.create', launch, commands: [{
      type: 'item.add', id: request.nodeId, resourceId: request.resourceId, pluginId: 'terminal.session', title: request.title,
      data: { sessionId: request.sessionId, workspaceId, shell, cwd }, projectId: request.projectId, position: request.position, ...creationNear(request),
    }, ...creationConnections(request.connection, request.nodeId)] };
    mkdirSync(this.restartDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ request, plan }), { flag: 'wx', mode: 0o600, flush: true });
    return this.launchPrepared(plan);
  }
  /** Where a new launch without a project folder starts: the global default if it still exists, else the most recent folder. */
  fallbackDirectory() {
    const global = this.store.readSettings().value.defaultWorkingDirectory;
    let usable = false;
    try { usable = Boolean(global) && isAbsolute(global) && statSync(global).isDirectory(); } catch { /* Fall through to the recent list. */ }
    return defaultDirectory({ global: usable ? global : '', recent: this.store.recentDirectories() });
  }
  async launchPrepared(request: PreparedSession) {
    const encoded = canonical(request);
    if (this.inputs.has(request.requestId) && this.inputs.get(request.requestId) !== encoded) throw new Error('Launch request was reused with different input');
    if (!this.inflight.has(request.requestId)) {
      this.inputs.set(request.requestId, encoded);
      this.inflight.set(request.requestId, this.launch(request).finally(() => { this.inflight.delete(request.requestId); this.inputs.delete(request.requestId); }));
    }
    return this.inflight.get(request.requestId)!;
  }
  async restartTerminal(nodeId: string, requestId: string): Promise<SessionSnapshot> {
    z.string().uuid().parse(requestId);
    const prior = this.restarting.get(nodeId);
    const pending = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => this.restartTerminalOnce(nodeId, requestId));
    this.restarting.set(nodeId, pending);
    try { return await pending; } finally { if (this.restarting.get(nodeId) === pending) this.restarting.delete(nodeId); }
  }
  private async restartTerminalOnce(nodeId: string, requestId: string): Promise<SessionSnapshot> {
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId);
    const resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || resource?.pluginId !== 'terminal.session') throw new Error('No saved terminal for this item');
    if (isOffMap(node, state.nodes)) throw new Error(isBelow(node, state.nodes) ? 'Bring this terminal back to the map before restarting it.' : 'Restore this archived terminal before restarting it.');
    type SavedRestart = { nodeId: string; requestId: string } & ({ kind: 'attach'; sessionId: string } | { kind: 'launch'; plan: PreparedSession });
    const path = join(this.restartDirectory, requestId + '.json');
    let saved: SavedRestart | undefined;
    try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved) {
      if (saved.nodeId !== nodeId || saved.requestId !== requestId) throw new Error('Terminal restart request ID was reused for a different item');
      if (saved.kind === 'attach') return this.runtime.call('sessions.read', { sessionId: saved.sessionId });
      if (saved.kind !== 'launch' || saved.plan.action !== 'terminal.resume' || saved.plan.nodeId !== nodeId || saved.plan.requestId !== requestId) throw new Error('Saved terminal restart is invalid');
      return this.launchPrepared(saved.plan);
    }
    const persist = (value: SavedRestart) => {
      mkdirSync(this.restartDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
    };
    const existing = (await this.runtime.call<SessionRecord[]>('sessions.list')).find(session => session.nodeId === nodeId && ['running', 'starting'].includes(session.state));
    if (existing) {
      persist({ nodeId, requestId, kind: 'attach', sessionId: existing.id });
      return this.runtime.call('sessions.read', { sessionId: existing.id });
    }
    const cwd = String(resource.data.cwd), shell = String(resource.data.shell ?? process.env.SHELL ?? '/bin/zsh');
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('The terminal working directory is unavailable');
    accessSync(shell, constants.X_OK);
    const plan: PreparedSession = { requestId, nodeId, expectedRevision: state.revision, action: 'terminal.resume',
      launch: { sessionId: requestId, requestId, nodeId, predecessorId: String(resource.data.sessionId), workspaceId: String(resource.data.workspaceId), executable: shell, args: ['-l'], cwd, cols: 100, rows: 30 },
      commands: [{ type: 'item.update', id: nodeId, data: { ...resource.data, sessionId: requestId } }],
    };
    persist({ nodeId, requestId, kind: 'launch', plan });
    return this.launchPrepared(plan);
  }
  private async launch(request: PreparedSession): Promise<SessionSnapshot> {
    const launch = request.launch;
    // A replay first resolves the committed graph command, then the durable launch.
    // A crash between those writes can be recovered without another map item.
    const state = request.action === 'terminal.resume' ? await this.control.read() : undefined;
    const updated = state?.resources.some(resource => resource.id === state.nodes.find(node => node.id === request.nodeId)?.resourceId && resource.data.sessionId === launch.sessionId);
    if (!updated) {
      const envelope = { commandId: request.requestId + ':node', actor: { kind: 'user' as const, id: 'desktop' }, commands: request.commands };
      if (request.expectedRevision === undefined) await applyAtHead(this.control, envelope);
      else await this.control.dispatch({ ...envelope, expectedRevision: request.expectedRevision });
    }
    await this.changed();
    let job = this.store.enqueueJob(request.requestId, { action: request.action, nodeId: request.nodeId, arguments: { launch, source: request.source } });
    if (job.state === 'succeeded') return this.runtime.call('sessions.read', { sessionId: launch.sessionId });
    if (job.state === 'failed') throw Object.assign(new Error(job.error || 'This session could not start. Create a new launch to try again.'), { code: 'LAUNCH_FAILED' });
    if (job.state === 'queued') job = this.store.transitionJob(job.id, 'queued', 'running');
    try {
      const result = await this.runtime.call<SessionSnapshot>('sessions.launch', launch);
      if (['failed', 'lost'].includes(result.session.state)) {
        this.store.transitionJob(job.id, job.state, 'failed', { error: result.session.error || 'Session is unavailable' });
        await this.updateSession(result.session);
        throw new Error(result.session.error || 'Session is unavailable');
      }
      this.store.transitionJob(job.id, job.state, 'succeeded', { result: { sessionId: launch.sessionId }, correlation: { pid: result.session.pid } });
      if (request.action === 'terminal.create' || request.action === 'agent.create') this.store.recordDirectory(launch.cwd);
      await this.stopArchived(); await this.updateSession(result.session); this.monitor(); return result;
    } catch (error) {
      const current = this.store.getJob(job.id)!;
      if (current.state === 'running') this.store.transitionJob(job.id, 'running', 'outcome-unknown', { error: (error as Error).message });
      throw Object.assign(error as Error, { code: current.state === 'failed' ? 'LAUNCH_FAILED' : 'LAUNCH_UNCERTAIN' });
    }
  }
  /** Brings one session's status onto its item. Reports whether it wrote, so a caller holding `seen` reads again. */
  private async updateSession(session: SessionRecord, seen?: Awaited<ReturnType<WorkspaceControl['read']>>): Promise<boolean> {
    const state = seen ?? await this.control.read(), node = state.nodes.find(node => node.id === session.nodeId);
    if (!node) return false; // Deleting a map item never terminates the process.
    const resource = state.resources.find(resource => resource.id === node.resourceId);
    if (resource?.data.sessionId !== session.id) return false; // Ignore old processes after a native resume.
    const commands: WorkspaceCommand[] = [];
    let nativeKey: string | undefined;
    if (session.native?.switched && session.state === 'running' && !session.stopRequestedAt) this.onConversationSwitch?.(node.id, session.id, session.native.switched);
    if (session.native) {
      const native = session.native;
      // The switch may give the item another conversation; this process no longer speaks for its identity.
      const data = native.switched ? resource.data : { ...resource.data, nativeSessionId: native.nativeSessionId, ...(native.readyAt ? { nativeStartedAt: native.readyAt } : {}) };
      if (canonical(data) !== canonical(resource.data)) commands.push({ type: 'item.update', id: node.id, data });
      if (session.state === 'running') {
        const activity = native.status === 'working' ? 'working' : native.status === 'unknown' ? 'unknown' : 'idle';
        const attention = native.status === 'input' ? 'input' : native.status === 'error' ? 'error' : 'none';
        const disconnected = Boolean(session.error), attentionNote = nativeAttentionNote(native, disconnected);
        const pose = native.status === 'input' ? 'asking' : native.status === 'error' ? 'fallen' : undefined;
        // Only a change of native status writes: between changes an agent's own status on its node stands.
        nativeKey = `${native.status}:${native.input ?? ''}:${disconnected}`;
        if (this.nativeApplied.get(session.id) !== nativeKey && (node.activity !== activity || node.attention !== attention || node.attentionNote !== attentionNote)) commands.push({ type: 'node.update', id: node.id, activity, attention, ...(attentionNote ? { attentionNote } : {}), pose: pose ?? 'none',
          summary: native.status === 'input' ? 'Waiting for your input' : native.status === 'working' ? 'Codex is working' : native.status === 'error' ? disconnected ? 'Codex disconnected; resume to reconnect' : 'Codex reported an error; check its terminal' : native.status === 'unknown' ? 'Starting Codex…' : 'Ready for your next prompt' });
      }
      if (native.completionId) commands.push(...completionAttention(node, `codex:${session.id}:${native.completionId}`, 'Agent finished'));
    }
    if (!(node.acceptsContext && session.state === 'running')) { // Native hooks/status own running agent activity.
      const failed = Boolean(session.error) || ['lost', 'failed'].includes(session.state) || (session.state === 'exited' && session.exitCode !== 0 && !session.stopRequestedAt);
      const review = resource.data.launchMode === 'review';
      const activity = review && failed ? 'unknown' : session.state === 'running' ? (review ? 'working' : 'idle') : session.state === 'exited' ? (node.acceptsContext ? 'idle' : 'complete') : 'unknown';
      const attention = failed ? 'error' : 'none';
      const attentionNote = !failed ? undefined : review ? 'Review failed' : `${node.acceptsContext ? 'Agent' : 'Terminal'} ${session.state === 'exited' ? 'exited with an error' : 'stopped unexpectedly'}`;
      const findings = resource.data.findings as { sessionId?: unknown; summary?: unknown } | undefined;
      const finished = findings?.sessionId === session.id && typeof findings.summary === 'string' ? findings.summary : 'Review complete';
      const summary = session.error ?? (session.state === 'running' ? (review ? 'Reviewing changes' : 'Terminal running') : session.state === 'exited' ? (review && !failed ? finished : `Exited · ${session.exitCode ?? 'unknown'}`) : session.state);
      // An agent whose session is not running has ended, or fallen if it ended badly; plain terminals carry no pose. It travels
      // with the status and never causes a write of its own.
      const pose = node.acceptsContext && session.state !== 'running' ? failed ? 'fallen' : 'ended' : undefined;
      if (node.activity !== activity || node.attention !== attention || node.attentionNote !== attentionNote || (session.state !== 'running' && node.summary !== summary)) commands.push({ type: 'node.update', id: node.id, activity, attention, ...(attentionNote ? { attentionNote } : {}), summary, pose: pose ?? 'none' });
      if (!node.acceptsContext && session.state === 'exited' && !failed && !session.stopRequestedAt) commands.push(...completionAttention(node, `session:${session.id}`, review ? 'Review ready' : 'Terminal finished'));
    }
    const applied = () => { if (nativeKey) this.nativeApplied.set(session.id, nativeKey); else this.nativeApplied.delete(session.id); };
    if (!commands.length) { applied(); return false; }
    try {
      await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'sessions' }, commands });
      applied();
      await this.changed();
    } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    return true;
  }
  /** Durable graph/session archive flags and Undermap are the stop intent. Reconcile
   * again after reconnect/startup; a failed stop must never silently lose that intent.
   * Undermap stops every session; archive stops agents and stop-on-archive sessions. */
  async stopArchived(sessions?: SessionRecord[], seen?: Awaited<ReturnType<WorkspaceControl['read']>>) {
    const state = seen ?? await this.control.read();
    const records = sessions ?? await this.runtime.call<SessionRecord[]>('sessions.list');
    for (const session of records) {
      if (!['starting', 'running'].includes(session.state)) continue;
      const node = state.nodes.find(node => node.id === session.nodeId);
      const resource = state.resources.find(resource => resource.id === node?.resourceId);
      const below = node && isBelow(node, state.nodes);
      if (!below && !session.stopOnArchive && resource?.data.provider !== 'claude') continue;
      const archived = below || session.archivedAt || state.nodes.some(alias => resource && alias.resourceId === resource.id && isArchived(alias, state.nodes));
      if (archived) await this.runtime.call('sessions.stop', { sessionId: session.id, preservePids: [process.pid] });
    }
  }
  monitor() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      this.observing = (async () => {
        try {
          // One read serves the whole pass; only a session that wrote reads the workspace again.
          const sessions = await this.runtime.call<SessionRecord[]>('sessions.list');
          let state = await this.control.read(); await this.stopArchived(sessions, state);
          for (const session of sessions) { if (this.closed) return; if (await this.updateSession(session, state)) state = await this.control.read(); }
        } catch { /* Reconcile again after reconnect. */ }
      })().finally(() => { this.observing = undefined; this.monitor(); });
    }, 1000);
  }
  recover(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.recovering) this.recovering = this.recoverOnce().finally(() => { this.recovering = undefined; });
    return this.recovering;
  }
  private async recoverOnce() {
    await this.stopArchived();
    for (const candidate of this.store.listJobs().filter(job => ['terminal.create', 'terminal.resume', 'agent.create', 'agent.resume', 'review.create', 'review.resume'].includes(job.input.action) && ['queued', 'outcome-unknown'].includes(job.state))) {
      if (this.closed) return;
      // Another accepted request can settle a later job while this pass awaits
      // the supervisor. Re-read it before attempting its frozen launch identity.
      const job = this.store.getJob(candidate.id);
      if (!job || !['queued', 'outcome-unknown'].includes(job.state)) continue;
      // Retire pending legacy command replays instead of running them on upgrade.
      if (job.input.action === 'terminal.resume' && (job.input.arguments.launch as LaunchRequest)?.startupCommand) {
        const current = job.state === 'queued' ? this.store.transitionJob(job.id, 'queued', 'running') : job;
        this.store.transitionJob(job.id, current.state, 'failed', { error: 'Terminal startup replay was removed. Use New shell explicitly.' });
        continue;
      }
      try {
        const graph = await this.control.read(), node = graph.nodes.find(node => node.id === job.input.nodeId);
        const resource = graph.resources.find(resource => resource.id === node?.resourceId);
        if (node && ((resource?.data.provider === 'claude' && isArchived(node, graph.nodes)) || isBelow(node, graph.nodes))) {
          const current = job.state === 'queued' ? this.store.transitionJob(job.id, 'queued', 'running') : job;
          this.store.transitionJob(job.id, current.state, 'failed', { error: isBelow(node, graph.nodes) ? 'Session sent to Undermap before launch recovery; bring it back and resume explicitly.' : 'Session archived before launch recovery; restore and resume explicitly.' });
          continue;
        }
        const current = job.state === 'queued' ? this.store.transitionJob(job.id, 'queued', 'running') : job;
        const result = await this.runtime.call<SessionSnapshot>('sessions.launch', job.input.arguments.launch);
        const failed = ['failed', 'lost'].includes(result.session.state);
        this.store.transitionJob(job.id, current.state, failed ? 'failed' : 'succeeded', { result: { sessionId: result.session.id }, error: failed ? result.session.error : undefined });
        await this.updateSession(result.session);
      } catch (error) {
        // A lost reply does not prove the supervisor rejected the launch. Keep
        // its identity eligible for reconciliation, including without a restart.
        const current = this.store.getJob(job.id);
        if (current && ['running', 'outcome-unknown'].includes(current.state)) this.store.transitionJob(job.id, current.state, 'outcome-unknown', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.store.listJobs().some(job => ['terminal.create', 'terminal.resume', 'agent.create', 'agent.resume', 'review.create', 'review.resume'].includes(job.input.action))) this.monitor();
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.runtime.close(); await Promise.allSettled([...this.inflight.values(), ...this.restarting.values(), ...(this.observing ? [this.observing] : []), ...(this.recovering ? [this.recovering] : [])]); }
}
