import type { WorkspaceControl } from '../core/control.ts';
import type { PluginStorage } from '../plugin-sdk/host.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { stableUuid } from './resources.ts';
import { isArchived, isOffMap } from '../../src/graph/archive.ts';
import type { ReviewAgentId } from '../../src/pull-requests/review-agents.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';

/** The code.review package's plugin storage collection; one record, `state`. */
export const AUTO_REVIEW_COLLECTION = 'auto-review';
const KEY = 'state';
/** `on` says whether the setting was on at the last pass; `settled` holds the pull request resources nothing more is done for. */
interface AutoReviewRecord { on: boolean; settled: string[] }

export interface AutoReviewOptions {
  storage: PluginStorage; store: Pick<SqliteStore, 'readSettings'>; control: WorkspaceControl;
  resources: { cached(nodeId: string): Promise<{ detail?: unknown } | null> };
  reviews?: { start(prNodeId: string, provider: ReviewAgentId, input: JsonObject): unknown };
  changed: () => Promise<void>; allowed?: () => boolean;
}

/** Settings → GitHub pull request → Automatic reviews. Turning it on settles every pull request already on the map; each one
 * that lands afterwards gets one direct review per chosen agent as soon as it reads open (a draft counts), and one first read
 * closed or merged is settled without a review. The pull request is settled before its reviews start, so nothing repeats. */
export class AutoReviews {
  private options: AutoReviewOptions; private allowed: () => boolean;
  private reconciling?: Promise<void>; private again = false; private timer?: ReturnType<typeof setInterval>; private closed = false;
  constructor(options: AutoReviewOptions) { this.options = options; this.allowed = options.allowed ?? (() => true); }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.closed = false; clearInterval(this.timer); this.timer = setInterval(() => this.observe(), 15_000); this.timer.unref?.(); this.observe(); }
  async close() { this.closed = true; clearInterval(this.timer); await this.reconciling?.catch(() => {}); }
  /** One pass; a pass asked for while one runs runs once more after it. */
  reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = (async () => { do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.closed); })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  private async reconcileOnce() {
    const setting = this.options.store.readSettings().value.autoReview, record = this.read(), state = await this.options.control.read();
    const pulls = state.nodes.filter(node => node.resourceId && !isArchived(node, state.nodes) && !isOffMap(node, state.nodes)
      && state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'github.pull-request');
    if (!setting.enabled) { if (record.on) this.save({ on: false, settled: [] }); return; }
    if (!record.on) { this.save({ on: true, settled: [...new Set(pulls.map(node => node.resourceId!))] }); return; }
    const known = new Set(state.resources.map(resource => resource.id)), settled = new Set(record.settled.filter(id => known.has(id)));
    for (const node of pulls) {
      if (this.closed || settled.has(node.resourceId!)) continue;
      const pull = ((await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { state?: unknown; merged?: unknown } } | undefined)?.pull;
      if (!pull) continue;
      settled.add(node.resourceId!); this.save({ on: true, settled: [...settled] });
      if (pull.merged === true || pull.state !== 'open' || !this.options.reviews) continue;
      for (const provider of setting.agents) {
        try { this.options.reviews.start(node.id, provider, { requestId: stableUuid(`auto-review:${node.resourceId}:${provider}`), sourceResourceId: node.resourceId! }); }
        catch { /* A review that cannot start is not retried; the pull request menu starts one by hand. */ }
      }
      await this.options.changed();
    }
  }
  private read(): AutoReviewRecord {
    const value = this.options.storage.get(AUTO_REVIEW_COLLECTION, KEY)?.value as Partial<AutoReviewRecord> | undefined;
    return { on: value?.on === true, settled: Array.isArray(value?.settled) ? value.settled.filter((id): id is string => typeof id === 'string') : [] };
  }
  private save(record: AutoReviewRecord) { this.options.storage.put(AUTO_REVIEW_COLLECTION, KEY, { on: record.on, settled: record.settled }); }
}
