import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { canonical } from '../core/control.ts';
import { nativeSummaryClient, summaryEvidence } from '../session-runtime/activity-summary.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { AGENT_TITLE_MODEL } from '../../src/agents/agent-title.ts';
import { buildPlotNameRequest, normalizePlotName } from '../../src/agents/plot-name.ts';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { PLOT_COLORS, PLOT_SAME, assignPlotColors, detectPlots, isPlotColor, jaccard, plotFallbackName } from '../../src/graph/plots.ts';
import type { PlotBox, PlotSnapshot } from '../../src/graph/plots.ts';

const plotId = z.string().min(1).max(200);
/** A person's plot changes from the map; agents are refused before reaching them. */
export const plotRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('rename'), plotId, name: z.string().max(200).transform(name => name.trim().replace(/\s+/g, ' ')).pipe(z.string().max(48).regex(/^[^\x00-\x1f\x7f<>`]*$/)) }),
  z.object({ operation: z.literal('hide'), plotId, hidden: z.boolean() }),
  z.object({ operation: z.literal('project'), shown: z.boolean() }),
  z.object({ operation: z.literal('auto'), plotId }),
  z.object({ operation: z.literal('color'), plotId, color: z.enum(PLOT_COLORS).nullable() }),
  z.object({ operation: z.literal('seen'), plotIds: z.array(plotId).max(60) }),
]);
/** A plot is named once its membership has settled, and at most this often. */
export const PLOT_NAME_DEBOUNCE_MS = 30_000, PLOT_NAME_INTERVAL_MS = 10 * 60_000;
export interface PlotNamingOptions { clock?: () => number; client?: ActivitySummaryClient | null; directory?: string; changed?: () => Promise<void>; allowed?: () => boolean; timeoutMs?: number }

/** Detects plots on each committed revision (MAP-24) and keeps their identity and
 * names in SQLite. Never runs for drag previews: only saved layout reaches it. Names
 * come from the tool-free title helper, lazily for plots the map has shown. */
export class Plots {
  private store: SqliteStore;
  private control: WorkspaceControl;
  private clock: () => number;
  private client: ActivitySummaryClient;
  private changed: () => Promise<void>;
  private allowed: () => boolean;
  private timeoutMs: number;
  private last?: { key: string; value: PlotSnapshot };
  private version = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private paused = true;
  private closed = false;
  private pending?: AbortController;
  /** When the map last showed each plot; unseen plots keep their local name. */
  private seen = new Map<string, number>();
  private requested = new Set<string>();
  constructor(store: SqliteStore, control: WorkspaceControl, options: PlotNamingOptions = {}) {
    this.store = store; this.control = control; this.clock = options.clock ?? Date.now;
    this.changed = options.changed ?? (async () => {}); this.allowed = options.allowed ?? (() => true); this.timeoutMs = options.timeoutMs ?? 20_000;
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
    }, 2000);
  }
  tick() {
    this.polling ??= this.poll().catch(() => { /* The local name remains usable. */ }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  async pause() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; this.pending?.abort(); await this.polling; }
  async close() { this.closed = true; await this.pause(); }
  /** Names, hiding or the project switch changed: the next observe rebuilds its views. */
  invalidate() { this.version++; }
  async run(projectId: string, input: unknown) {
    const request = plotRequestSchema.parse(input);
    if (request.operation === 'project') this.store.setPlotsShown(projectId, request.shown);
    else if (request.operation === 'seen') { for (const id of request.plotIds) this.seen.set(id, this.clock()); return { ok: true }; }
    else {
      const record = this.store.plotRecords().find(record => record.id === request.plotId);
      if (!record || record.projectId !== projectId) throw new Error('This plot is not in this project any more.');
      if (request.operation === 'rename') this.store.renamePlot(record.id, request.name || undefined, false);
      else if (request.operation === 'hide') this.store.hidePlot(record.id, request.hidden);
      else if (request.operation === 'color') this.store.choosePlotColor(record.id, request.color ?? undefined);
      else {
        if (!this.store.readSettings().value.summaries.plotNames) throw new Error('Turn on Name plots in Settings → AI features first.');
        this.store.renamePlot(record.id, undefined, false); this.requested.add(record.id); this.seen.set(record.id, this.clock());
      }
    }
    this.invalidate();
    return { ok: true };
  }
  private async poll() {
    if (this.closed || this.paused || !this.allowed()) return;
    const settings = this.store.readSettings().value, policy = settings.summaries;
    if (!policy.plotNames || !settings.mapPlots) return;
    const state = await this.control.read(), view = this.observe(state), now = this.clock();
    const records = new Map(this.store.plotRecords().map(record => [record.id, record]));
    for (const id of this.requested) if (!records.get(id)?.active) this.requested.delete(id);
    const due = view.list.filter(plot => {
      const record = records.get(plot.id)!;
      if (plot.hidden || view.hiddenProjects.includes(plot.projectId) || plot.source === 'user' || !this.seen.has(plot.id)) return false;
      return this.requested.has(plot.id) || now - record.changedAt >= PLOT_NAME_DEBOUNCE_MS;
    }).sort((a, b) => Number(this.requested.has(b.id)) - Number(this.requested.has(a.id)) || this.seen.get(b.id)! - this.seen.get(a.id)!);
    const byId = new Map(state.nodes.map(node => [node.id, node])), resources = new Map(state.resources.map(resource => [resource.id, resource]));
    for (const plot of due) {
      const forced = this.requested.has(plot.id);
      const items = plot.memberIds.flatMap(id => byId.get(id) ?? []).map(node => {
        const plugin = node.resourceId ? this.control.registry.get(resources.get(node.resourceId)?.pluginId ?? '') : undefined;
        const summary = plugin?.activityTitle && node.summary ? summaryEvidence(node.summary).slice(0, 80) : '';
        return { type: plugin?.name ?? 'Item', title: summaryEvidence(node.title).slice(0, 120), ...(summary ? { summary } : {}) };
      });
      const fingerprint = createHash('sha256').update(canonical(['plot-name-v1', AGENT_TITLE_MODEL, plot.memberIds, items.map(item => item.title)])).digest('hex');
      if (!this.store.reservePlotName(plot.id, fingerprint, policy, now, forced ? 0 : PLOT_NAME_INTERVAL_MS)) continue;
      this.requested.delete(plot.id);
      const project = byId.get(plot.projectId)?.title ?? '', sample = { project: summaryEvidence(project).slice(0, 120), ...(plot.source === 'generated' ? { currentName: plot.name } : {}), items };
      const abort = new AbortController(); this.pending = abort;
      const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
      let name: string | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
        name = normalizePlotName(await Promise.race([this.client.complete(buildPlotNameRequest(sample), abort.signal), cancelled]));
      } catch { /* A failed or uncertain attempt still counts; the local or previous name stays. */ }
      finally { clearTimeout(timeout); if (this.pending === abort) this.pending = undefined; }
      if (!name || name === 'KEEP' || abort.signal.aborted || this.closed || this.paused || !this.store.readSettings().value.summaries.plotNames) return;
      if (this.store.renamePlot(plot.id, name, true, fingerprint)) { this.invalidate(); await this.changed(); }
      return;
    }
  }
  observe(state: WorkspaceState): PlotSnapshot {
    const settings = this.store.readSettings(), key = `${state.revision}:${settings.revision}:${this.version}`;
    if (this.last?.key === key) return this.last.value;
    const byId = new Map(state.nodes.map(node => [node.id, node]));
    const boxes: PlotBox[] = [];
    for (const node of state.nodes) {
      const project = node.projectId ? byId.get(node.projectId) : undefined;
      if (!node.resourceId || !project || project.resourceId || node.archivedAt || node.belowAt || project.archivedAt || project.belowAt) continue;
      const box = itemFootprint(node, state.resources, this.control.registry, settings.value.itemMapSizes);
      boxes.push({ ...box, projectId: project.id });
    }
    const records = this.store.plotRecords(), dormant = records.filter(record => !record.active);
    const detected = detectPlots(boxes, records.filter(record => record.active), () => randomUUID(), state.links);
    const known = new Set(records.map(record => record.id)), reclaimed = new Set<string>();
    const plots = detected.map(plot => {
      if (known.has(plot.id)) return plot;
      const match = dormant.filter(record => record.projectId === plot.projectId && !reclaimed.has(record.id))
        .map(record => ({ record, score: jaccard(plot.memberIds, record.memberIds) })).filter(entry => entry.score >= PLOT_SAME)
        .sort((a, b) => b.score - a.score || b.record.changedAt - a.record.changedAt)[0];
      if (!match) return plot;
      reclaimed.add(match.record.id); return { ...plot, id: match.record.id };
    });
    this.store.savePlots(plots, this.clock());
    const saved = new Map(this.store.plotRecords().map(record => [record.id, record]));
    const colorOf = (id: string) => { const record = saved.get(id)!, chosen = isPlotColor(record.chosenColor) ? record.chosenColor : undefined; return { color: isPlotColor(record.color) ? record.color : undefined, ...(chosen ? { chosenColor: chosen } : {}) }; };
    // A reclaimed plot keeps its color unless a plot that stayed shows it now.
    const kept = plots.filter(plot => !reclaimed.has(plot.id)).map(plot => { const { color, chosenColor } = colorOf(plot.id); return { projectId: plot.projectId, color: chosenColor ?? color }; });
    const assigned = assignPlotColors(plots.map(plot => {
      const { color, chosenColor } = colorOf(plot.id), clashes = reclaimed.has(plot.id) && !chosenColor && kept.some(other => other.projectId === plot.projectId && other.color === color);
      return { ...plot, ...(color && !clashes ? { color: chosenColor ?? color } : {}) };
    }), boxes);
    this.store.colorPlots(assigned);
    const value: PlotSnapshot = { list: plots.map(plot => {
      const record = saved.get(plot.id)!, titles = plot.memberIds.map(id => byId.get(id)?.title ?? ''), { color, chosenColor } = colorOf(plot.id);
      return { id: plot.id, projectId: plot.projectId, memberIds: plot.memberIds, name: record.name ?? plotFallbackName(titles), source: record.name === undefined ? 'local' : record.generated ? 'generated' : 'user', hidden: record.hidden,
        color: assigned.get(plot.id) ?? color!, ...(chosenColor ? { chosenColor } : {}) };
    }), hiddenProjects: this.store.hiddenPlotProjects(), revision: this.version };
    this.last = { key, value };
    return value;
  }
}
