import { join, sep } from 'node:path';
import type { SqliteStore, JobRecord } from './sqlite-store.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SessionRecord, SessionSnapshot } from '../session-runtime/protocol.ts';
import { pruneComparisons } from '../provider-runtime/comparison-pruning.ts';

export const PRUNE_CHECK_MS = 60_000;
export const PRUNE_INTERVAL_MS = 30 * 60_000;
const unsettled = ['queued', 'running', 'outcome-unknown'];
const live = (session: SessionRecord) => session.state === 'starting' || session.state === 'running';
type SessionRuntime = Pick<SessionCoordinator, 'runtime'>;
export interface PrunerOptions { now?: () => number; log?: (line: string) => void }

/** Removes the PR checkouts of finished reviews and architecture requests
 * (`comparisons/<requestId>/repository` and its manifest). The request and result
 * Markdown next to them stay, and a later request captures the checkout again. */
export class ComparisonPruner {
  private directory: string; private store: SqliteStore; private sessions?: SessionRuntime; private allowed: () => boolean;
  private now: () => number; private log: (line: string) => void;
  private timer?: ReturnType<typeof setTimeout>; private running?: Promise<unknown>; private paused = true; private lastRun?: number;
  constructor(directory: string, store: SqliteStore, sessions: SessionRuntime | undefined, allowed: () => boolean, options: PrunerOptions = {}) {
    this.directory = directory; this.store = store; this.sessions = sessions; this.allowed = allowed;
    this.now = options.now ?? Date.now; this.log = options.log ?? (line => process.stderr.write(line));
  }
  start() { this.paused = false; this.schedule(); }
  async pause() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; await this.running?.catch(() => {}); }
  private schedule() {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, PRUNE_CHECK_MS); this.timer.unref();
  }
  /** One check: prunes when background work is allowed and the last run is 30 minutes old. */
  async tick() {
    const now = this.now();
    if (this.running || !this.allowed() || (this.lastRun !== undefined && now - this.lastRun < PRUNE_INTERVAL_MS)) return false;
    this.lastRun = now;
    this.running = this.prune(now).finally(() => { this.running = undefined; });
    await this.running; return true;
  }
  async prune(now: number): Promise<string[]> {
    const { pruned, bytes } = await pruneComparisons(this.directory, { now, finished: requestId => this.finished(requestId) });
    if (pruned.length) this.log(`Pruned ${pruned.length} review checkouts (${Math.round(bytes / 1024 / 1024)} MB).\n`);
    return pruned;
  }
  /** True when no unsettled job refers to the request folder and no session runs in it:
   * the review session its job names, or any session (architecture, resumed review)
   * whose working directory is inside the folder. A session that cannot be read is not running. */
  async finished(requestId: string): Promise<boolean> {
    const jobs = this.store.listJobs(), folder = join(this.directory, 'comparisons', requestId);
    const preparations = new Set(jobs.filter(job => job.input.action === 'architecture.prepare' && result(job).sourceRequestId === requestId).map(job => String(job.input.arguments.requestId)));
    const related = jobs.filter(job => job.id === requestId || job.requestKey.endsWith(`:${requestId}`)
      || job.input.arguments.requestId === requestId || job.input.arguments.sourceRequestId === requestId || result(job).sourceRequestId === requestId
      || (job.input.action === 'architecture.launch' && preparations.has(String(job.input.arguments.requestId))));
    if (related.some(job => unsettled.includes(job.state))) return false;
    if (!this.sessions) return true;
    const runtime = this.sessions.runtime;
    for (const sessionId of new Set(related.map(job => result(job).sessionId).filter((id): id is string => typeof id === 'string'))) {
      const snapshot = await runtime.call<SessionSnapshot>('sessions.read', { sessionId }).catch(() => undefined);
      if (snapshot && live(snapshot.session)) return false;
    }
    const sessions = await runtime.call<SessionRecord[]>('sessions.list').catch(() => [] as SessionRecord[]);
    return !sessions.some(session => live(session) && (session.cwd === folder || session.cwd.startsWith(folder + sep)));
  }
}
const result = (job: JobRecord) => (job.result && typeof job.result === 'object' ? job.result : {}) as Record<string, unknown>;
