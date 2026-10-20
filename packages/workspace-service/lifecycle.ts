import { isOffMap } from '../../src/graph/archive.ts';
import { isMuted } from '../../src/graph/mute.ts';
import type { WorkspaceState } from '../core/control.ts';
import { randomUUID } from 'node:crypto';
import type { SqliteStore } from './sqlite-store.ts';
import type { WorkspaceControl } from '../core/control.ts';
import type { SessionRecord, SessionSnapshot } from '../session-runtime/protocol.ts';

export interface RecoveryEntry {
  sessionId: string; nodeId: string; resourceId?: string; title: string;
  kind: 'agent' | 'terminal' | 'analysis' | 'unavailable'; continueWork: boolean;
  /** Legacy checkpoint field; never replayed. */
  terminalCommand?: { text: string; cwd: string };
  nativeSessionId?: string; cwd?: string; workspaceId?: string; model?: string;
  requestId: string; state: 'pending' | 'restored' | 'failed' | 'skipped';
  restoredSessionId?: string; error?: string;
}
export interface RecoveryState {
  phase: 'open' | 'closing' | 'closed' | 'recovering';
  startupId?: string; startupPending?: boolean;
  closedAt?: string; entries: RecoveryEntry[]; error?: string;
}
export interface LifecycleRuntime {
  list(): Promise<SessionRecord[]>;
  stop(sessionId: string): Promise<unknown>;
  resume(entry: RecoveryEntry): Promise<SessionSnapshot>;
  recoverJobs(): Promise<void>;
}
const live = (session: SessionRecord) => ['running', 'starting'].includes(session.state);

/** A durable close checkpoint. No process is stopped until its recovery identity is saved. */
export class WorkspaceLifecycle {
  private state: RecoveryState;
  private operations = new Set<Promise<unknown>>();
  private stopping?: Promise<RecoveryState>;
  private recovering?: Promise<void>;
  private blocked = false;
  private store: Pick<SqliteStore, 'readRecovery' | 'writeRecovery'>;
  private control: Pick<WorkspaceControl, 'read'>;
  private runtime: LifecycleRuntime;
  constructor(store: Pick<SqliteStore, 'readRecovery' | 'writeRecovery'>, control: Pick<WorkspaceControl, 'read'>, runtime: LifecycleRuntime) {
    this.store = store; this.control = control; this.runtime = runtime;
    this.state = store.readRecovery();
    this.blocked = this.state.phase !== 'open' || Boolean(this.state.error);
  }
  status(): RecoveryState { return structuredClone(this.state); }
  private save() {
    try { this.store.writeRecovery(this.state); }
    catch (error) { throw new Error(`Recovery checkpoint could not be saved: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  private recoveryFailed(error: unknown) {
    // Storage may still be unavailable. Keep the error in memory for status/Retry
    // rather than trying another write or leaving a rejected background promise.
    this.state.phase = 'open'; this.state.error = error instanceof Error ? error.message : String(error);
    this.blocked = true;
  }
  async active() { return (await this.runtime.list()).filter(live); }
  get allowsBackgroundWork() { return !this.blocked && this.state.phase === 'open'; }
  get pendingCount() { return this.operations.size + Number(Boolean(this.recovering)); }
  async drain() { this.blocked = true; await Promise.allSettled([...this.operations, ...(this.recovering ? [this.recovering] : [])]); }
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.blocked) throw Object.assign(new Error(this.state.error ? 'Recovery needs attention. Retry recovery before starting more work.' : 'The workspace is closing. Reopen it before starting more work.'), { code: 'WORKSPACE_CLOSING' });
    const pending = Promise.resolve().then(operation); this.operations.add(pending);
    try { return await pending; } finally { this.operations.delete(pending); }
  }
  close(): Promise<RecoveryState> {
    if (this.stopping) return this.stopping;
    this.blocked = true;
    this.stopping = this.stop().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private recoveryItem(entry: RecoveryEntry, graph: WorkspaceState) {
    const node = graph.nodes.find(node => node.id === entry.nodeId && node.resourceId === entry.resourceId);
    const resource = entry.resourceId && graph.resources.find(resource => resource.id === entry.resourceId);
    // A muted project stays quiet across a restart: its sessions wait for the person to resume them.
    return node && resource && !isOffMap(node, graph.nodes) && !isMuted(node, graph.nodes) ? { node, resource } : undefined;
  }
  private async stop() {
    // Include launches that had already passed the gate (including slow CLI probes).
    await Promise.allSettled([...this.operations, ...(this.recovering ? [this.recovering] : [])]);
    const sessions = await this.runtime.list(), active = sessions.filter(live), graph = await this.control.read();
    // A manual Stop may still be draining an agent. Wait below without selecting
    // it for recovery. Plain terminals always stay stopped.
    const entries: RecoveryEntry[] = active.filter(session => !session.stopRequestedAt).flatMap(session => {
      const node = graph.nodes.find(node => node.id === session.nodeId);
      const resource = graph.resources.find(resource => resource.id === node?.resourceId && resource.data.sessionId === session.id);
      if (!node || !resource || isOffMap(node, graph.nodes) || session.archivedAt || session.removedAt || resource.pluginId === 'terminal.session') return [];
      const kind = resource?.pluginId === 'agent.session' && ['claude', 'codex'].includes(String(resource.data.provider)) && typeof resource.data.nativeSessionId === 'string' ? 'agent'
        : resource?.data.launchMode === 'review' && session.readOnly ? 'analysis' : 'unavailable';
      return { sessionId: session.id, nodeId: session.nodeId, resourceId: resource.id, title: node.title, kind,
        ...(resource ? Object.fromEntries(['nativeSessionId', 'cwd', 'workspaceId', 'model'].flatMap(key => typeof resource.data[key] === 'string' ? [[key, resource.data[key]]] : [])) : {}),
        continueWork: kind === 'agent' && node?.activity === 'working' && node.attention === 'none', requestId: randomUUID(), state: 'pending' };
    });
    // A failed restore remains actionable after another close.
    const unfinished = this.state.entries.filter(entry => entry.kind !== 'terminal' && ['pending', 'failed'].includes(entry.state) && this.recoveryItem(entry, graph) && !entries.some(current => current.nodeId === entry.nodeId));
    this.state = { ...this.state, phase: 'closing', closedAt: new Date().toISOString(), entries: [...entries, ...unfinished] };
    this.save();
    await Promise.all(active.map(session => this.runtime.stop(session.id)));
    const deadline = Date.now() + 7000;
    while ((await this.active()).length) {
      if (Date.now() > deadline) throw new Error('Some sessions have not stopped. Keep the app open and retry closing.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    this.state.phase = 'closed'; this.save(); return this.status();
  }
  recover(retry = false, startupId?: string): RecoveryState {
    if (this.stopping || this.recovering) return this.status();
    if (startupId && startupId !== this.state.startupId) { this.state.startupId = startupId; this.state.startupPending = true; }
    if (retry) for (const entry of this.state.entries) if (entry.state === 'failed') { entry.state = 'pending'; delete entry.error; }
    if (!this.state.startupPending && this.state.phase === 'open' && !this.state.error && !this.state.entries.some(entry => ['pending', 'failed'].includes(entry.state))) { this.blocked = false; return this.status(); }
    delete this.state.error;
    this.state.phase = 'recovering';
    try { this.save(); } catch (error) { this.recoveryFailed(error); return this.status(); }
    this.blocked = false;
    this.recovering = this.restore().catch(error => this.recoveryFailed(error)).finally(() => { this.recovering = undefined; });
    return this.status();
  }
  private async restore() {
    try {
      if (this.state.startupPending) {
        this.state.startupPending = false; this.save();
      }
      for (const entry of this.state.entries) {
        if (this.blocked) break;
        if (!['pending', 'failed'].includes(entry.state)) continue;
        try {
          const graph = await this.control.read();
          const item = this.recoveryItem(entry, graph);
          if (!item || entry.kind === 'terminal') {
            entry.state = 'skipped'; delete entry.error; this.save(); continue;
          }
          // Reconcile obsolete failures automatically, but a real launch failure
          // still requires Retry. Never rerun work just to refresh a notice.
          if (entry.state === 'failed') continue;
          const { resource } = item;
          const sessions = await this.runtime.list();
          for (const key of ['nativeSessionId', 'cwd', 'workspaceId', 'model'] as const) {
            if (entry[key] !== undefined && resource?.data[key] !== entry[key]) throw new Error('The saved session binding has changed. Resume this item explicitly to use its new configuration.');
          }
          if (entry.kind === 'unavailable') throw new Error('Automatic recovery is not supported for this session type.');
          const current = sessions.find(session => session.nodeId === entry.nodeId && live(session));
          const result = current && current.id === entry.sessionId ? { session: current } : await this.runtime.resume(entry);
          if (!live(result.session)) throw Object.assign(new Error(result.session.error ?? 'The session did not restart.'), { code: 'LAUNCH_FAILED' });
          entry.state = 'restored'; entry.restoredSessionId = result.session.id; delete entry.error;
        } catch (error) {
          entry.state = 'failed'; entry.error = (error as Error).message;
          // Reuse uncertain launch IDs. Rotate only after a confirmed absent/failed launch.
          if (['REVISION_CONFLICT', 'LAUNCH_FAILED', 'ENOENT', 'EACCES', 'INVALID_REQUEST'].includes((error as { code?: string }).code ?? '')) entry.requestId = randomUUID();
        }
        this.save();
      }
      if (!this.blocked) await this.runtime.recoverJobs();
    } catch (error) { this.recoveryFailed(error); }
    finally { this.state.phase = 'open'; this.save(); }
  }
}
