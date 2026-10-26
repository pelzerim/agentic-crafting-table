import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../core/control.ts';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { nativeSummaryClient, summaryEvidence } from '../session-runtime/activity-summary.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { AGENT_TITLE_MODEL } from '../../src/agents/agent-title.ts';
import { buildProjectSummaryRequest, normalizeProjectSummary, projectSummarySample } from '../../src/agents/project-summary.ts';
import { projectDashboard } from '../../src/graph/project-dashboard.ts';
import { todoEntries } from '../../src/graph/todos.ts';
import type { PlotView } from '../../src/graph/plots.ts';
import { presentResource } from '../../src/resource-plugins/views.ts';
import { BACKGROUND_HEADROOM } from './standup.ts';

/** A project is summarised once its input has been unchanged this long, and at most this often. */
export const PROJECT_SUMMARY_DEBOUNCE_MS = 60_000, PROJECT_SUMMARY_INTERVAL_MS = 10 * 60_000;
/** The latest summary per project while Summarise projects is on; `revision` changes with the list. */
export interface ProjectSummariesSnapshot { revision: number; list: { projectId: string; text: string; model?: string }[] }
export interface ProjectSummaryOptions { clock?: () => number; client?: ActivitySummaryClient | null; directory?: string; changed?: () => Promise<void>; allowed?: () => boolean; timeoutMs?: number; plots?: (state: WorkspaceState) => readonly PlotView[] }

/** Writes a one- or two-sentence summary per project on the Map that is not muted
 * (MAP-22, AGENT-07) from its reduced dashboard. One request per tick at most. */
export class ProjectSummaries {
  private store: SqliteStore;
  private control: WorkspaceControl;
  private clock: () => number;
  private client: ActivitySummaryClient;
  private changed: () => Promise<void>;
  private allowed: () => boolean;
  private plots: (state: WorkspaceState) => readonly PlotView[];
  private timeoutMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private paused = true;
  private closed = false;
  private pending?: AbortController;
  /** Each project's last input and when it last changed. */
  private inputs = new Map<string, { fingerprint: string; changedAt: number }>();
  private version = 0;
  private last?: { key: string; value: ProjectSummariesSnapshot };
  constructor(store: SqliteStore, control: WorkspaceControl, options: ProjectSummaryOptions = {}) {
    this.store = store; this.control = control; this.clock = options.clock ?? Date.now;
    this.changed = options.changed ?? (async () => {}); this.allowed = options.allowed ?? (() => true); this.timeoutMs = options.timeoutMs ?? 20_000; this.plots = options.plots ?? (() => []);
    const unavailable: ActivitySummaryClient = { async complete() { throw new Error('No model configured for this isolated service'); } };
    if (options.client !== undefined || !options.directory) this.client = options.client ?? unavailable;
    else { const cwd = join(options.directory, 'title-workspace'); mkdirSync(cwd, { recursive: true, mode: 0o700 }); this.client = nativeSummaryClient(cwd); }
  }
  start() {
    if (this.closed) return;
    this.paused = false;
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => { if (!this.closed && !this.paused) this.start(); });
    }, 5000);
  }
  tick() {
    this.polling ??= this.poll().catch(() => { /* The counts line remains usable. */ }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  async pause() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; this.pending?.abort(); await this.polling; }
  async close() { this.closed = true; await this.pause(); }
  settingsChanged() { this.pending?.abort(); }
  observe(): ProjectSummariesSnapshot {
    const settings = this.store.readSettings(), key = `${settings.revision}:${this.version}`;
    if (this.last?.key === key) return this.last.value;
    const list = settings.value.summaries.projectSummaries ? this.store.projectSummaries().flatMap(row => row.text ? [{ projectId: row.projectId, text: row.text, ...(row.model ? { model: row.model } : {}) }] : []) : [];
    const revision = this.last && canonical(this.last.value.list) === canonical(list) ? this.last.value.revision : (this.last?.value.revision ?? 0) + 1;
    this.last = { key, value: { revision, list } };
    return this.last.value;
  }
  private async poll() {
    if (this.closed || this.paused || !this.allowed()) return;
    const policy = this.store.readSettings().value.summaries;
    if (!policy.projectSummaries) return;
    const state = await this.control.read(), now = this.clock();
    const projects = state.nodes.filter(node => !node.resourceId && !node.archivedAt && !node.belowAt && !node.hiddenAt && !node.mutedAt);
    const gone = this.store.projectSummaries().map(row => row.projectId).filter(id => !state.nodes.some(node => node.id === id));
    this.store.forgetProjectSummaries(gone);
    const onMap = state.nodes.filter(node => !node.belowAt && !node.hiddenAt), resources = new Map(state.resources.map(resource => [resource.id, resource]));
    const pipelineOf = (node: { resourceId?: string }) => { const resource = node.resourceId ? resources.get(node.resourceId) : undefined; return resource ? presentResource(this.control.registry, resource).overview?.pipeline : undefined; };
    const todos = todoEntries(state), plots = this.plots(state), stored = new Map(this.store.projectSummaries().map(row => [row.projectId, row]));
    const due: { id: string; fingerprint: string; content: ReturnType<typeof projectSummarySample> }[] = [];
    for (const id of this.inputs.keys()) if (!projects.some(project => project.id === id)) this.inputs.delete(id);
    const titled = onMap.map(node => ({ ...node, title: summaryEvidence(node.title), summary: node.summary ? summaryEvidence(node.summary) : node.summary }));
    for (const project of projects) {
      const sample = projectSummarySample(projectDashboard(project.id, titled, { todos, plots, pipelineOf }));
      const fingerprint = createHash('sha256').update(canonical(['project-summary-v1', AGENT_TITLE_MODEL, sample])).digest('hex');
      const input = this.inputs.get(project.id);
      if (input?.fingerprint !== fingerprint) { this.inputs.set(project.id, { fingerprint, changedAt: now }); continue; }
      if (now - input.changedAt >= PROJECT_SUMMARY_DEBOUNCE_MS && stored.get(project.id)?.fingerprint !== fingerprint) due.push({ id: project.id, fingerprint, content: sample });
    }
    due.sort((a, b) => this.inputs.get(a.id)!.changedAt - this.inputs.get(b.id)!.changedAt || a.id.localeCompare(b.id));
    for (const entry of due) {
      if (!this.store.reserveProjectSummary(entry.id, entry.fingerprint, policy, now, PROJECT_SUMMARY_INTERVAL_MS, BACKGROUND_HEADROOM)) continue;
      const abort = new AbortController(); this.pending = abort;
      const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
      let text: string | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
        text = normalizeProjectSummary(await Promise.race([this.client.complete(buildProjectSummaryRequest(entry.content), abort.signal), cancelled]));
      } catch { /* A failed or uncertain attempt still counts; the earlier text stays. */ }
      finally { clearTimeout(timeout); if (this.pending === abort) this.pending = undefined; }
      if (!text || abort.signal.aborted || this.closed || this.paused || !this.store.readSettings().value.summaries.projectSummaries) return;
      if (this.store.finishProjectSummary(entry.id, entry.fingerprint, text, AGENT_TITLE_MODEL)) { this.version++; await this.changed(); }
      return;
    }
  }
}
