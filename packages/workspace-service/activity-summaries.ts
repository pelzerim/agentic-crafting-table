import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../core/control.ts';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import { nativeSummaryClient, summaryEvidence } from '../session-runtime/activity-summary.ts';
import { createActivitySummarizer } from '../../src/agents/activity-summary.ts';
import type { ActivitySample, ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { isOffMap } from '../../src/graph/archive.ts';

type Source = { nodeId: string; resourceId: string; sessionId: string; status: ActivitySample['status']; activity: string; attention: string; summary: string };
function sources(state: WorkspaceState): Source[] {
  return state.resources.filter(resource => ['agent.session', 'terminal.session'].includes(resource.pluginId) && typeof resource.data.sessionId === 'string').flatMap(resource => {
    const node = state.nodes.find(node => node.resourceId === resource.id && !isOffMap(node, state.nodes));
    if (!node) return [];
    return [{ nodeId: node.id, resourceId: resource.id, sessionId: String(resource.data.sessionId), activity: node.activity, attention: node.attention, summary: node.summary,
      status: node.attention === 'input' ? 'waiting' : node.attention === 'error' ? 'disconnected' : node.activity === 'working' ? 'working' : node.activity === 'complete' ? 'complete' : 'idle' }];
  });
}
const identity = (source: Source) => canonical([source.sessionId, source.activity, source.attention, source.summary]);

/** Single background helper, independent of terminal rendering/status. A rolling
 * durable allowance bounds attempts; cache stores labels/hashes, never PTY text. */
export class ActivitySummaries {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private paused = false;
  private polling?: Promise<void>;
  private index = 0;
  private pending?: { source: Source; cancel(): void };
  private evidence = new Map<string, { text: string; changedAt: number; firstAt: number }>();
  private client: ActivitySummaryClient;
  private store: SqliteStore;
  private control: WorkspaceControl;
  private readSession: (id: string) => Promise<SessionSnapshot>;
  private changed: () => Promise<void>;
  private allowed: () => boolean;
  private clock: () => number;
  constructor(store: SqliteStore, control: WorkspaceControl,
    readSession: (id: string) => Promise<SessionSnapshot>, changed: () => Promise<void>,
    allowed: () => boolean, directory: string, client?: ActivitySummaryClient, clock = Date.now) {
    this.store = store; this.control = control; this.readSession = readSession; this.changed = changed; this.allowed = allowed; this.clock = clock;
    const cwd = join(directory, 'summary-workspace'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    this.client = client ?? nativeSummaryClient(cwd);
  }
  observe(state: WorkspaceState) {
    if (!this.pending) return;
    const current = sources(state).find(source => source.resourceId === this.pending!.source.resourceId);
    if (!current || identity(current) !== identity(this.pending.source)) this.pending.cancel();
  }
  start() {
    if (this.closed) return;
    this.paused = false;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.paused) return;
      void this.tick().finally(() => { if (!this.closed && !this.paused) this.start(); });
    }, 2000);
  }
  tick(): Promise<void> {
    if (!this.polling) this.polling = this.poll().catch(() => { /* Factual status remains usable offline. */ }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  async pause() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; this.pending?.cancel(); await this.polling; this.evidence.clear(); }
  async close() { this.closed = true; await this.pause(); }
  settingsChanged() { this.pending?.cancel(); this.evidence.clear(); }
  private async poll() {
    if (this.closed || this.paused || !this.allowed()) return;
    const policy = this.store.readSettings().value.summaries;
    if (!policy.enabled) return;
    const state = await this.control.read(), available = sources(state);
    for (const id of this.evidence.keys()) if (!available.some(source => source.resourceId === id)) this.evidence.delete(id);
    if (!available.length) return;
    // Round-robin avoids a chatty first session consuming the whole allowance.
    const source = available[this.index++ % available.length], snapshot = await this.readSession(source.sessionId);
    if (snapshot.session.state !== 'running' || this.paused || this.closed) return;
    const fresh = sources(await this.control.read()).find(item => item.resourceId === source.resourceId);
    if (!fresh || identity(fresh) !== identity(source) || !this.allowed() || canonical(this.store.readSettings().value.summaries) !== canonical(policy)) return;
    const text = summaryEvidence(snapshot.chunks.map(chunk => chunk.data).join(''));
    if (!text) return;
    const now = this.clock(), prior = this.evidence.get(source.resourceId);
    const evidence = prior?.text === text ? prior : { text, changedAt: now, firstAt: prior?.firstAt ?? now };
    this.evidence.set(source.resourceId, evidence);
    // Wait for a short quiet period, but still summarize a continuous stream.
    if (now - evidence.changedAt < 2000 && now - evidence.firstAt < 10_000) return;
    const fingerprint = createHash('sha256').update(canonical([source.sessionId, source.activity, source.attention, policy.model, text])).digest('hex');
    const cached = this.store.summary(source.resourceId);
    let resultText = cached?.fingerprint === fingerprint ? cached.text : undefined;
    if (resultText && cached?.expectedSummary !== source.summary) return; // Already applied or explicitly edited since generation.
    if (!resultText) {
      if (!this.store.reserveSummary(source.resourceId, fingerprint, source.summary, policy, now)) return;
      this.evidence.set(source.resourceId, { ...evidence, firstAt: now });
      const summarizer = createActivitySummarizer(this.client, 20_000, policy.model);
      const pending = { source, cancel: () => summarizer.dispose(source.resourceId) }; this.pending = pending;
      try {
        const resource = state.resources.find(resource => resource.id === source.resourceId)!;
        const result = await summarizer.summarize({ resourceId: source.resourceId, revision: fingerprint, kind: resource.pluginId === 'terminal.session' ? 'terminal' : 'agent', status: source.status, recentOutput: text });
        if (!result || this.closed || this.paused || !this.allowed() || canonical(this.store.readSettings().value.summaries) !== canonical(policy)) return;
        if (!this.store.finishSummary(source.resourceId, fingerprint, result.text, result.generated)) return;
        resultText = result.text;
      } finally { if (this.pending === pending) this.pending = undefined; summarizer.dispose(source.resourceId); }
    }
    if (!resultText) return;
    const current = await this.control.read(), latest = sources(current).find(item => item.resourceId === source.resourceId);
    if (!latest || identity(latest) !== identity(source) || latest.summary === resultText || this.closed || this.paused || !this.allowed()) return;
    await this.control.dispatch({ commandId: randomUUID(), expectedRevision: current.revision, actor: { kind: 'system', id: 'activity-summary' }, commands: [{ type: 'node.update', id: latest.nodeId, summary: resultText }] });
    await this.changed();
  }
}
