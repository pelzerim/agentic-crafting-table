import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { nativeSummaryClient, summaryEvidence } from '../session-runtime/activity-summary.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { buildAttachTitleRequest, normalizeAttachTitle } from '../../src/agents/attach-title.ts';
import { isOffMap } from '../../src/graph/archive.ts';

type Node = WorkspaceState['nodes'][number];

/** Names a newly attached provider item once from its message text. The queue
 * row is settled before the model call, so failures and restarts never retry. */
export class AttachTitles {
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private paused = true;
  private closed = false;
  private pending?: { resourceId: string; sourceTitle: string; abort: AbortController };
  private client: ActivitySummaryClient;
  private store: SqliteStore;
  private control: WorkspaceControl;
  private changed: () => Promise<void>;
  private allowed: () => boolean;
  private clock: () => number;
  private timeoutMs: number;
  constructor(store: SqliteStore, control: WorkspaceControl, changed: () => Promise<void>, allowed: () => boolean, directory: string,
    client?: ActivitySummaryClient | null, clock = Date.now, timeoutMs = 20_000) {
    this.store = store; this.control = control; this.changed = changed; this.allowed = allowed;
    this.clock = clock; this.timeoutMs = timeoutMs;
    const cwd = join(directory, 'title-workspace'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    this.client = client === null ? { async complete() { throw new Error('No model configured for this isolated service'); } } : client ?? nativeSummaryClient(cwd);
  }
  /** Map nodes still showing the provider title the item was attached with. */
  private targets(state: WorkspaceState, resourceId: string, sourceTitle: string) {
    const nodes = state.nodes.filter(node => node.resourceId === resourceId && !isOffMap(node, state.nodes));
    const renamed = nodes.some(node => node.generatedTitle !== undefined || node.title !== sourceTitle);
    return { nodes, renamed, ready: nodes.filter((node): node is Node => node.title === sourceTitle && node.generatedTitle === undefined) };
  }
  observe(state: WorkspaceState) {
    if (!this.pending) return;
    const { nodes, renamed } = this.targets(state, this.pending.resourceId, this.pending.sourceTitle);
    if (!nodes.length || renamed) this.pending.abort.abort();
  }
  settingsChanged() { if (!this.store.readSettings().value.summaries.attachTitles) this.pending?.abort.abort(); }
  start() {
    if (this.closed) return;
    this.paused = false;
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => { if (!this.closed && !this.paused) this.start(); });
    }, 500);
  }
  tick() {
    this.polling ??= this.poll().catch(() => { /* The provider title remains. */ }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  async pause() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; this.pending?.abort.abort(); await this.polling; }
  async close() { this.closed = true; await this.pause(); }
  private async poll() {
    if (this.closed || this.paused || !this.allowed()) return;
    const policy = this.store.readSettings().value.summaries;
    if (!policy.attachTitles) return;
    const queued = this.store.pendingAttachTitles();
    if (!queued.length) return;
    const state = await this.control.read(), now = this.clock();
    for (const item of queued) {
      const { nodes, renamed } = this.targets(state, item.resourceId, item.sourceTitle);
      if (renamed) { this.store.settleAttachTitle(item.resourceId, 'skipped', now); continue; }
      if (!nodes.length) continue; // Archived before naming: kept for when it returns.
      if (!this.store.reserveAttachTitle(item.resourceId, policy, now)) return;
      const abort = new AbortController(), pending = { resourceId: item.resourceId, sourceTitle: item.sourceTitle, abort }; this.pending = pending;
      const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
      let title: string | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
        const output = await Promise.race([this.client.complete(buildAttachTitleRequest({ kind: item.kind, text: summaryEvidence(item.text) }), abort.signal), cancelled]);
        title = normalizeAttachTitle(output, [item.kind, item.sourceTitle]);
      } catch { /* The single attempt is spent; the provider title stays. */ }
      finally { clearTimeout(timeout); if (this.pending === pending) this.pending = undefined; }
      if (title) await this.apply(item.resourceId, item.sourceTitle, title, abort.signal);
      return; // One request per tick.
    }
  }
  private async apply(resourceId: string, sourceTitle: string, title: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted || this.closed || this.paused || !this.allowed() || !this.store.readSettings().value.summaries.attachTitles) return;
      const latest = await this.control.read(), { ready, renamed } = this.targets(latest, resourceId, sourceTitle);
      if (renamed || !ready.length) return;
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: latest.revision, actor: { kind: 'system', id: 'attach-title' },
          commands: ready.map(node => ({ type: 'node.title.generated' as const, id: node.id, title, sourceTitle })) });
        await this.changed(); return;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') return; }
    }
  }
}
