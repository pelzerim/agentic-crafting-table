import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { canonical } from '../core/control.ts';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import { nativeSummaryClient, summaryEvidence } from '../session-runtime/activity-summary.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { AGENT_TITLE_MODEL, buildAgentTitleRequest, normalizeAgentTitle, sameAgentTitle } from '../../src/agents/agent-title.ts';
import { isOffMap } from '../../src/graph/archive.ts';

/** At most one automatic attempt per item in this window; a long turn is named after the shorter one. */
export const AGENT_TITLE_INTERVAL_MS = 10 * 60_000, AGENT_TITLE_WORKING_MS = 60_000;
type Node = WorkspaceState['nodes'][number];
type Resource = WorkspaceState['resources'][number];

function gitBranch(cwd: string) {
  try {
    let git = join(cwd, '.git');
    if (statSync(git).isFile()) git = resolve(cwd, readFileSync(git, 'utf8').match(/^gitdir:\s*(.+)$/m)![1].trim());
    return readFileSync(join(git, 'HEAD'), 'utf8').match(/^ref: refs\/heads\/(.+)$/m)?.[1].slice(0, 200);
  } catch { return undefined; }
}

/** Names agent items from their recent output with the tool-free title helper,
 * while their title is a creation default or one it generated itself. */
export class AgentTitles {
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private paused = true;
  private closed = false;
  private index = 0;
  private pending?: { nodeId: string; sourceTitle: string; abort: AbortController };
  /** When each automation-owned item was first seen working since its last attempt. */
  private worked = new Map<string, number>();
  private requested = new Set<string>();
  private client: ActivitySummaryClient;
  private store: SqliteStore;
  private control: WorkspaceControl;
  private readSession: (id: string) => Promise<SessionSnapshot>;
  private changed: () => Promise<void>;
  private allowed: () => boolean;
  private clock: () => number;
  private timeoutMs: number;
  constructor(store: SqliteStore, control: WorkspaceControl, readSession: (id: string) => Promise<SessionSnapshot>,
    changed: () => Promise<void>, allowed: () => boolean, directory: string,
    client?: ActivitySummaryClient | null, clock = Date.now, timeoutMs = 20_000) {
    this.store = store; this.control = control; this.readSession = readSession; this.changed = changed; this.allowed = allowed;
    this.clock = clock; this.timeoutMs = timeoutMs;
    const cwd = join(directory, 'title-workspace'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    this.client = client === null ? { async complete() { throw new Error('No model configured for this isolated service'); } } : client ?? nativeSummaryClient(cwd);
  }
  private owned(node: Node, resource: Resource) {
    const defaults = this.control.registry.get(resource.pluginId)?.activityTitle?.defaults;
    return Boolean(defaults) && typeof resource.data.sessionId === 'string' && (node.generatedTitle === node.title || defaults!.includes(node.title));
  }
  private candidates(state: WorkspaceState) {
    return state.resources.flatMap(resource => {
      const node = this.control.registry.get(resource.pluginId)?.activityTitle && state.nodes.find(node => node.resourceId === resource.id && !isOffMap(node, state.nodes));
      return node && this.owned(node, resource) ? [{ node, resource }] : [];
    });
  }
  observe(state: WorkspaceState) {
    const now = this.clock();
    for (const { node, resource } of this.candidates(state)) if (node.activity === 'working' && !this.worked.has(resource.id)) this.worked.set(resource.id, now);
    if (!this.pending) return;
    const node = state.nodes.find(node => node.id === this.pending!.nodeId);
    if (!node || isOffMap(node, state.nodes) || node.title !== this.pending.sourceTitle) this.pending.abort.abort();
  }
  start() {
    if (this.closed) return;
    this.paused = false;
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => { if (!this.closed && !this.paused) this.start(); });
    }, 2000);
  }
  tick() {
    this.polling ??= this.poll().catch(() => { /* The current title remains usable. */ }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  async pause() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; this.pending?.abort.abort(); await this.polling; }
  async close() { this.closed = true; await this.pause(); }
  settingsChanged() { if (!this.store.readSettings().value.summaries.agentTitles) this.pending?.abort.abort(); }
  /** Hands the title back to automation and names the item on the next tick. */
  async request(nodeId: string) {
    if (!this.store.readSettings().value.summaries.agentTitles) throw new Error('Turn on Auto-title agents in Settings → Display first.');
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || !resource || !this.control.registry.get(resource.pluginId)?.activityTitle) throw new Error('Only agent items can be named from their activity.');
    if (isOffMap(node, state.nodes)) throw new Error('Bring this agent back to the map first.');
    if (node.generatedTitle !== node.title) {
      await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'agent-title' }, commands: [{ type: 'node.title.generated', id: node.id, title: node.title, sourceTitle: node.title }] });
      await this.changed();
    }
    this.requested.add(resource.id);
    return { nodeId, requested: true };
  }
  private async poll() {
    if (this.closed || this.paused || !this.allowed()) return;
    const policy = this.store.readSettings().value.summaries;
    if (!policy.agentTitles) return;
    const state = await this.control.read(), now = this.clock(), candidates = this.candidates(state);
    const ids = new Set(candidates.map(candidate => candidate.resource.id));
    for (const id of [...this.worked.keys(), ...this.requested]) if (!ids.has(id)) { this.worked.delete(id); this.requested.delete(id); }
    this.observe(state);
    const due = candidates.filter(({ node, resource }) => {
      if (this.requested.has(resource.id)) return true;
      const since = this.worked.get(resource.id), prior = this.store.agentTitle(resource.id);
      return since !== undefined && (node.activity !== 'working' || now - since >= AGENT_TITLE_WORKING_MS) && (!prior || now - prior.attemptedAt >= AGENT_TITLE_INTERVAL_MS);
    });
    if (!due.length) return;
    // Explicit requests first, then round-robin so one busy agent cannot starve the rest.
    const { node, resource } = due.find(candidate => this.requested.has(candidate.resource.id)) ?? due[this.index++ % due.length];
    const forced = this.requested.delete(resource.id);
    const snapshot = await this.readSession(String(resource.data.sessionId));
    const recentOutput = summaryEvidence(snapshot.chunks.map(chunk => chunk.data).join(''));
    if (!recentOutput || this.closed || this.paused) return;
    const linkedIds = new Set(state.links.flatMap(link => link.sourceId === node.id ? [link.targetId] : link.targetId === node.id ? [link.sourceId] : []));
    const linked = state.nodes.filter(other => linkedIds.has(other.id) && other.resourceId && !isOffMap(other, state.nodes)).map(other => summaryEvidence(other.title).slice(0, 120)).slice(0, 5);
    const cwd = typeof resource.data.cwd === 'string' ? resource.data.cwd : undefined;
    const sample = { provider: String(resource.data.provider ?? 'agent'), currentTitle: node.generatedTitle === node.title && normalizeAgentTitle(node.title) !== 'KEEP' ? node.title : undefined,
      status: node.attention === 'input' ? 'waiting' : node.activity, directory: cwd && basename(cwd), branch: cwd && gitBranch(cwd), linked, recentOutput };
    const fingerprint = createHash('sha256').update(canonical(['agent-title-v1', AGENT_TITLE_MODEL, sample.provider, sample.directory ?? null, sample.branch ?? null, linked, recentOutput])).digest('hex');
    if (!forced && this.store.agentTitle(resource.id)?.fingerprint === fingerprint) { this.worked.delete(resource.id); return; }
    if (!this.store.reserveAgentTitle(resource.id, fingerprint, policy, now, forced ? 0 : AGENT_TITLE_INTERVAL_MS)) return;
    this.worked.delete(resource.id);
    const abort = new AbortController(), pending = { nodeId: node.id, sourceTitle: node.title, abort }; this.pending = pending;
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    let title: string | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
      title = normalizeAgentTitle(await Promise.race([this.client.complete(buildAgentTitleRequest(sample), abort.signal), cancelled]));
    } catch { /* Failed or uncertain requests consume their attempt and are not repeated for this evidence. */ }
    finally { clearTimeout(timeout); if (this.pending === pending) this.pending = undefined; }
    if (!title || title === 'KEEP' || abort.signal.aborted || this.closed || this.paused || !this.allowed() || !this.store.readSettings().value.summaries.agentTitles) return;
    const latest = await this.control.read(), current = latest.nodes.find(other => other.id === node.id), currentResource = latest.resources.find(other => other.id === resource.id);
    if (!current || !currentResource || isOffMap(current, latest.nodes) || current.title !== node.title || !this.owned(current, currentResource) || sameAgentTitle(title, current.title)) return;
    try {
      await this.control.dispatch({ commandId: randomUUID(), expectedRevision: latest.revision, actor: { kind: 'system', id: 'agent-title' }, commands: [{ type: 'node.title.generated', id: node.id, title, sourceTitle: node.title }] });
    } catch { return; } // A newer revision or rename wins; the next turn can try again.
    await this.changed();
  }
}
