import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProviderConnection, ProviderSyncStatus } from '../core/connections.ts';

/** Who asked for a provider request. Reads a person started (opening an item, an
 * explicit refresh, an action) are `user`; host polling loops run as `background`. */
export type RequestPriority = 'user' | 'background';
export type BudgetLevel = 'normal' | 'slowed' | 'paused';
interface Window { limit: number; remaining: number; resetAt: number }
export interface BudgetStatus { provider: string; account: string; level: BudgetLevel; limit?: number; remaining?: number; resetAt?: number; requests: number; notModified: number }

const priority = new AsyncLocalStorage<RequestPriority>();
/** Runs provider work as background polling: paced, paused near the limit, and
 * yielding to user reads of the same account. Unmarked work is user-triggered. */
export const inBackground = <T>(work: () => Promise<T>) => priority.run('background', work);
export const requestPriority = (): RequestPriority => priority.getStore() ?? 'user';

export const SLOWED_BELOW = 0.4, PAUSED_BELOW = 0.15, BACKGROUND_SPACING_MS = 250, SEARCH_PER_MINUTE = 30, BACKGROUND_SEARCH_PER_MINUTE = 24;
export class BudgetPausedError extends Error {
  readonly code = 'PROVIDER_BUDGET_PAUSED'; readonly retryAt: number;
  constructor(message: string, retryAt: number) { super(message); this.retryAt = retryAt; }
}
const NAMES: Record<string, string> = { github: 'GitHub', linear: 'Linear', slack: 'Slack', notion: 'Notion' };

/** One shared request budget per provider account. Every caller of that account's
 * transport goes through it, so polling loops cannot jointly exceed the limit.
 * Background requests run one at a time with a minimum spacing, wait while a user
 * request is in flight, slow below 40% of the window and stop below 15% until the
 * window resets. User requests are never paced; only GitHub's search limit applies to them. */
export class RequestBudget {
  readonly provider: string; readonly account: string;
  private clock: () => number; private sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private windows = new Map<string, Window>();
  private retryAt = 0; private users = 0; private lastBackground = 0; private queue: Promise<void> = Promise.resolve();
  private searches: number[] = [];
  private counts = { requests: 0, notModified: 0 };
  constructor(provider: string, account: string, options: BudgetOptions = {}) {
    this.provider = provider; this.account = account; this.clock = options.now ?? Date.now; this.sleep = options.sleep ?? wait;
  }
  private window(resource: string) { const window = this.windows.get(resource); return window && window.resetAt > this.clock() ? window : undefined; }
  level(resource = 'core'): BudgetLevel {
    if (this.retryAt > this.clock()) return 'paused';
    const window = this.window(resource); if (!window || !window.limit) return 'normal';
    const share = window.remaining / window.limit;
    return share < PAUSED_BELOW ? 'paused' : share < SLOWED_BELOW ? 'slowed' : 'normal';
  }
  /** Multiplier for background poll intervals: 1 normally, 2 when slowed, Infinity when paused. */
  backgroundFactor(resource = 'core') { const level = this.level(resource); return level === 'paused' ? Infinity : level === 'slowed' ? 2 : 1; }
  /** When background work of this resource may continue, if it is paused now. */
  resumesAt(resource = 'core') { return Math.max(this.retryAt, this.level(resource) === 'paused' ? this.window(resource)?.resetAt ?? 0 : 0); }
  private paused(resource: string): never {
    const name = NAMES[this.provider] ?? this.provider;
    throw new BudgetPausedError(`${name} background updates are paused until the rate limit resets.`, this.resumesAt(resource) || this.clock() + 60_000);
  }
  private searchSlot(background: boolean) {
    const now = this.clock(); this.searches = this.searches.filter(at => now - at < 60_000);
    if (this.searches.length >= (background ? BACKGROUND_SEARCH_PER_MINUTE : SEARCH_PER_MINUTE)) this.searchLimited(this.searches[0] + 60_000);
    this.searches.push(now);
  }
  private searchLimited(retryAt: number): never { throw new BudgetPausedError(`${NAMES[this.provider] ?? this.provider} search is limited to ${SEARCH_PER_MINUTE} requests a minute. Try again shortly.`, retryAt); }
  /** Waits for this request's turn and returns its release. Writes pass `exempt`:
   * they are counted but never throttled. */
  async acquire(resource: string, signal: AbortSignal, exempt = false): Promise<() => void> {
    signal.throwIfAborted();
    const background = !exempt && requestPriority() === 'background';
    if (!exempt && resource === 'search') this.searchSlot(background);
    if (!background) { this.users++; let done = false; return () => { if (!done) { done = true; this.users--; } }; }
    if (this.level(resource) === 'paused') this.paused(resource);
    let release!: () => void; const turn = new Promise<void>(resolve => { release = resolve; }), previous = this.queue;
    this.queue = previous.then(() => turn);
    try {
      await previous;
      for (;;) {
        signal.throwIfAborted();
        if (this.level(resource) === 'paused') this.paused(resource);
        const spacing = BACKGROUND_SPACING_MS * (this.level(resource) === 'slowed' ? 4 : 1), due = this.lastBackground + spacing - this.clock();
        if (!this.users && due <= 0) break;
        await this.sleep(this.users ? 50 : due, signal);
      }
      this.lastBackground = this.clock(); return release;
    } catch (error) { release(); throw error; }
  }
  /** Records one completed response: its rate-limit window and any hard backoff. */
  observe(resource: string, response: { status: number; limit?: number; remaining?: number; resetAt?: number; retryAt?: number }) {
    this.counts.requests++; if (response.status === 304) this.counts.notModified++;
    if (response.limit !== undefined && response.remaining !== undefined && response.resetAt !== undefined && Number.isFinite(response.limit + response.remaining + response.resetAt) && response.limit > 0)
      this.windows.set(resource, { limit: response.limit, remaining: Math.max(0, response.remaining), resetAt: response.resetAt });
    if (response.retryAt && response.retryAt > this.clock()) this.retryAt = Math.max(this.retryAt, response.retryAt);
  }
  status(): BudgetStatus {
    const window = this.window('core');
    return { provider: this.provider, account: this.account, level: this.level('core'), ...(window ? { limit: window.limit, remaining: window.remaining, resetAt: window.resetAt } : {}), ...this.counts };
  }
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms), abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});

/** A short diagnostics line such as "GitHub · 3,120/5,000 left · background slowed". */
export function budgetLine(status: BudgetStatus) {
  const name = NAMES[status.provider] ?? status.provider, parts = [name];
  if (status.limit !== undefined && status.remaining !== undefined) parts.push(`${status.remaining.toLocaleString('en-US')}/${status.limit.toLocaleString('en-US')} left`);
  else parts.push(`${status.requests.toLocaleString('en-US')} ${status.requests === 1 ? 'request' : 'requests'}`);
  if (status.notModified) parts.push(`${status.notModified.toLocaleString('en-US')} unchanged`);
  if (status.level !== 'normal') parts.push(`background ${status.level}`);
  return parts.join(' · ');
}

/** Adds each enabled connection's budget line to the provider status list (Settings →
 * Connections); connections without item sync get a budget-only entry once they sent requests. */
export function withBudgetLines(sync: ProviderSyncStatus[], connections: ProviderConnection[]): ProviderSyncStatus[] {
  const line = (connection?: ProviderConnection) => { const budget = connection && knownBudget(connection.providerId, connection.account); return budget ? budgetLine(budget.status()) : undefined; };
  const enabled = connections.filter(connection => connection.enabled);
  return [...sync.map(status => { const budget = line(enabled.find(connection => connection.id === status.connectionId)); return budget ? { ...status, budget } : status; }),
    ...enabled.filter(connection => !sync.some(status => status.connectionId === connection.id)).flatMap(connection => { const budget = line(connection); return budget ? [{ connectionId: connection.id, providerId: connection.providerId, enabled: true, working: false, budget, budgetOnly: true }] : []; })];
}

export interface BudgetOptions { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }
const budgets = new Map<string, RequestBudget>(); let options: BudgetOptions = {};
/** The process-wide budget of one provider account, shared by every transport built for it. */
export function requestBudget(provider: string, account: string) {
  const key = `${provider}\0${account.toLowerCase()}`;
  let budget = budgets.get(key); if (!budget) budgets.set(key, budget = new RequestBudget(provider, account, options));
  return budget;
}
export const knownBudget = (provider: string, account: string) => budgets.get(`${provider}\0${account.toLowerCase()}`);
/** Deterministic clocks for tests and simulations; forgets every budget. */
export function resetRequestBudgets(next: BudgetOptions = {}) { budgets.clear(); options = next; }

/** Conditional-request validators and the parsed body they certify, per exact
 * request path of one account. Persisted by the workspace store when one is
 * installed, otherwise kept in a bounded in-memory LRU. Never logged or sent to
 * the renderer/MCP. */
export interface CachedResponse { etag?: string; lastModified?: string; link?: string; body: unknown }
export interface ValidatorStore { validator(provider: string, account: string, path: string): CachedResponse | undefined; saveValidator(provider: string, account: string, path: string, value: CachedResponse, usedAt: number): void; touchValidator(provider: string, account: string, path: string, usedAt: number): void }
export const VALIDATOR_BODY_LIMIT = 512 * 1024, MEMORY_VALIDATORS = 500;
const memory = new Map<string, CachedResponse>(); let persistent: ValidatorStore | undefined;
export function useValidatorStore(store?: ValidatorStore) { persistent = store; memory.clear(); }
export const validators = {
  get(provider: string, account: string, path: string, now: number) {
    const key = `${provider}\0${account.toLowerCase()}\0${path}`;
    if (persistent) { const value = persistent.validator(provider, account.toLowerCase(), path); if (value) persistent.touchValidator(provider, account.toLowerCase(), path, now); return value; }
    const value = memory.get(key); if (value) { memory.delete(key); memory.set(key, value); } return value;
  },
  set(provider: string, account: string, path: string, value: CachedResponse, now: number) {
    if (!value.etag && !value.lastModified) return;
    if (Buffer.byteLength(JSON.stringify(value.body) ?? '') > VALIDATOR_BODY_LIMIT) return;
    if (persistent) { persistent.saveValidator(provider, account.toLowerCase(), path, value, now); return; }
    const key = `${provider}\0${account.toLowerCase()}\0${path}`; memory.delete(key); memory.set(key, value);
    while (memory.size > MEMORY_VALIDATORS) memory.delete(memory.keys().next().value!);
  },
};
