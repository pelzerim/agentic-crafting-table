import type { WorkspaceControl } from '../core/control.ts';
import type { PluginStorage } from '../plugin-sdk/host.ts';
import { isArchived, isOffMap } from '../../src/graph/archive.ts';
import { findById } from '../../src/graph/lookup.ts';
import type { ReportedWorkflowRun, WorkflowBotComment } from '../../src/pull-requests/workflow-correlation.ts';

/** The github.review-run package's plugin storage collection; one record, `state`. */
export const REPORT_ADOPTION_COLLECTION = 'report-adoption';
const KEY = 'state', RETRY_MS = 60_000, SETTLED_RUNS_PER_PULL_REQUEST = 300;
/** `on` says whether the setting was on at the last pass. `settledUntil` holds, per pull request resource, the time up to
 * which a report is never shown: when the setting came on for a pull request that was there, and later when the newest
 * review on the map was posted. `settled` holds, per pull request resource, the runs nothing more is done for. */
interface ReportAdoptionRecord { on: boolean; settledUntil: Record<string, number>; settled: Record<string, number[]> }
export type ReportAdoptionOutcome = 'adopted' | 'tracked' | 'unrelated' | 'pending' | 'deferred';

export interface WorkflowReportAdoptionOptions {
  storage: PluginStorage; control: WorkspaceControl; enabled: () => boolean;
  /** `cached` is the pull request's last read; `checkedAt` says when that read was stored, without decoding it. */
  resources: { cached(nodeId: string): Promise<{ detail?: unknown } | null>; checkedAt(resourceId: string): number | undefined };
  reviews: { reports(nodeId: string, comments: WorkflowBotComment[]): Promise<ReportedWorkflowRun[]>; adopt(nodeId: string, report: { runId: number; commentId: number }, signal: AbortSignal): Promise<ReportAdoptionOutcome> };
  changed: () => Promise<void>; allowed?: () => boolean; now?: () => number;
}

/** Settings → Items → Workflow review → Show reviews the workflow posts on its own. Turning it on settles every report posted
 * until then on a pull request that is there; after that the newest report of an open, mapped pull request is handed to the workflow review coordinator,
 * which decides whether its run is a review. A report is settled once it is adopted, already tracked or not a review, and
 * every report older than an adopted or tracked one is settled with it, so no pull request shows an old review. */
export class WorkflowReportAdoption {
  private options: WorkflowReportAdoptionOptions; private allowed: () => boolean; private now: () => number;
  private reconciling?: Promise<void>; private again = false; private timer?: ReturnType<typeof setInterval>; private closed = false;
  private readAt = new Map<string, number>(); private retryAt = new Map<string, number>(); private stop = new AbortController();
  constructor(options: WorkflowReportAdoptionOptions) { this.options = options; this.allowed = options.allowed ?? (() => true); this.now = options.now ?? Date.now; }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.closed = false; this.stop = new AbortController(); clearInterval(this.timer); this.timer = setInterval(() => this.observe(), 15_000); this.timer.unref?.(); this.observe(); }
  async close() { this.closed = true; clearInterval(this.timer); this.stop.abort(new Error('Workflow report adoption closed.')); await this.reconciling?.catch(() => {}); }
  /** One pass; a pass asked for while one runs runs once more after it. */
  reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = (async () => { do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.closed); })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  private async reconcileOnce() {
    const record = this.read(), state = await this.options.control.read();
    const pullRequests = new Set(state.resources.filter(resource => resource.pluginId === 'github.pull-request').map(resource => resource.id));
    if (!this.options.enabled()) { this.readAt.clear(); this.retryAt.clear(); if (record.on) this.save({ on: false, settledUntil: {}, settled: {} }); return; }
    if (!record.on) { this.readAt.clear(); this.retryAt.clear(); const now = this.now(); this.save({ on: true, settledUntil: Object.fromEntries([...pullRequests].map(id => [id, now])), settled: {} }); return; }
    const settledUntil = Object.fromEntries(Object.entries(record.settledUntil).filter(([id]) => pullRequests.has(id)));
    const settled = new Map(Object.entries(record.settled).filter(([id]) => pullRequests.has(id)).map(([id, runs]) => [id, new Set(runs)]));
    const save = () => this.save({ on: true, settledUntil, settled: Object.fromEntries([...settled].map(([id, runs]) => [id, [...runs].slice(-SETTLED_RUNS_PER_PULL_REQUEST)])) });
    const visited = new Set<string>();
    for (const node of state.nodes) {
      const resourceId = node.resourceId;
      if (this.closed || !resourceId || visited.has(resourceId) || !pullRequests.has(resourceId) || isArchived(node, state.nodes) || isOffMap(node, state.nodes)) continue;
      visited.add(resourceId);
      const checkedAt = this.options.resources.checkedAt(resourceId), retryAt = this.retryAt.get(resourceId);
      if (checkedAt === undefined || (retryAt === undefined ? this.readAt.get(resourceId) === checkedAt : retryAt > this.now())) continue;
      const detail = (await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { state?: unknown; merged?: unknown }; discussion?: unknown } | undefined;
      if (!detail?.pull || !Array.isArray(detail.discussion)) continue;
      this.readAt.set(resourceId, checkedAt); this.retryAt.delete(resourceId);
      try {
        const until = settledUntil[resourceId], runs = settled.get(resourceId) ?? new Set<number>();
        const reports = (await this.options.reviews.reports(node.id, botComments(detail.discussion))).filter(report => until === undefined || Date.parse(report.createdAt) > until).reverse();
        const settle = (from: number) => { for (const report of reports.slice(from).reverse()) { runs.delete(report.runId); runs.add(report.runId); } settled.set(resourceId, runs); save(); };
        if (detail.pull.merged === true || detail.pull.state !== 'open') continue;
        for (const [index, report] of reports.entries()) {
          if (this.closed) { this.readAt.delete(resourceId); break; }
          if (runs.has(report.runId)) continue;
          const outcome = await this.options.reviews.adopt(node.id, { runId: report.runId, commentId: report.commentId }, this.stop.signal);
          if (outcome === 'pending' || outcome === 'deferred') { this.retryAt.set(resourceId, this.now() + RETRY_MS); break; }
          if (outcome === 'unrelated') { runs.add(report.runId); settled.set(resourceId, runs); save(); continue; }
          const posted = Date.parse(report.createdAt); if (Number.isFinite(posted)) settledUntil[resourceId] = Math.max(until ?? posted, posted);
          settle(index);
          if (outcome === 'adopted') await this.options.changed();
          break;
        }
      } catch { this.retryAt.set(resourceId, this.now() + RETRY_MS); }
    }
    if (Object.keys(settledUntil).length !== Object.keys(record.settledUntil).length || settled.size !== Object.keys(record.settled).length) save();
  }
  private read(): ReportAdoptionRecord {
    const value = this.options.storage.get(REPORT_ADOPTION_COLLECTION, KEY)?.value as Partial<ReportAdoptionRecord> | undefined;
    const plain = (entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const settled = plain(value?.settled), settledUntil = plain(value?.settledUntil);
    return { on: value?.on === true, settledUntil: Object.fromEntries(Object.entries(settledUntil).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))),
      settled: Object.fromEntries(Object.entries(settled).filter(([, runs]) => Array.isArray(runs)).map(([id, runs]) => [id, (runs as unknown[]).filter((run): run is number => Number.isSafeInteger(run))])) };
  }
  private save(record: ReportAdoptionRecord) { this.options.storage.put(REPORT_ADOPTION_COLLECTION, KEY, { on: record.on, settledUntil: record.settledUntil, settled: record.settled }); }
}

/** The top-level comments of a pull request's cached discussion, in the shape the report rule reads. */
function botComments(discussion: unknown[]): WorkflowBotComment[] {
  return discussion.flatMap(entry => {
    const comment = entry as { id?: unknown; kind?: unknown; author?: unknown; body?: unknown; date?: unknown };
    return comment?.kind === 'discussion' && typeof comment.id === 'number' && typeof comment.author === 'string' && typeof comment.body === 'string' && typeof comment.date === 'string'
      ? [{ id: comment.id, author: comment.author, body: comment.body, createdAt: comment.date }] : [];
  });
}
