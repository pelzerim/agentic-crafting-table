import { performance } from 'node:perf_hooks';
import type { FrameDrop, FrameObserver } from './local-rpc.ts';

const SAMPLE_INTERVAL_MS = 1000;
const MINUTE_MS = 60_000;
const KEPT_MINUTES = 60;
const RECENT_MINUTES = 10;
const LAG_EVENT_MS = 250;
const KEPT_LAG_EVENTS = 100;
const KEPT_SLOWEST_OPERATIONS = 50;
const KEPT_DROPS = 50;
const COUNTED_OPERATION_NAMES = 200;

export interface ServiceHealthOptions {
  now?: () => number;
  monotonic?: () => number;
  memory?: () => { rss: number; heapUsed: number };
}
interface Minute { index: number; lagSamples: number[]; snapshots: number; snapshotBytes: number; coalesced: number; drops: number; rssBytes?: number; heapUsedBytes?: number }
interface Subscriber { peer: number; snapshots: number; bytes: number; largestFrameBytes: number; coalesced: number }
interface OperationCount { count: number; totalMs: number; maxMs: number }

const round = (ms: number) => Math.round(ms * 10) / 10;
const p95 = (values: number[]) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * 0.95) - 1]; };

/** The workspace service's own health: event-loop lag, which operations ran and for how long,
 * snapshot broadcasts per subscriber and dropped clients, and memory. Names of events and
 * operations only; never workspace content. */
export class ServiceHealth implements FrameObserver {
  private now: () => number;
  private monotonic: () => number;
  private memory: () => { rss: number; heapUsed: number };
  private startedAt: number;
  private lastSample: number;
  private timer?: ReturnType<typeof setInterval>;
  private minutes: Minute[] = [];
  private lagEvents: { at: string; lagMs: number; operations: string[] }[] = [];
  private running = new Map<number, string>();
  private operations = 0;
  private slowest: { name: string; ms: number; at: string }[] = [];
  private counts = new Map<string, OperationCount>();
  private subscribers = new Map<number, Subscriber>();
  private snapshots = { count: 0, bytes: 0, largestFrameBytes: 0, coalesced: 0 };
  private drops: FrameDrop[] = [];
  private dropCount = 0;
  private lastMemory?: { rssBytes: number; heapUsedBytes: number };
  private memoryMinute = -1;
  constructor(options: ServiceHealthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.memory = options.memory ?? (() => process.memoryUsage());
    this.startedAt = this.now(); this.lastSample = this.monotonic();
    this.sampleMemory();
  }
  start() {
    if (this.timer) return;
    this.lastSample = this.monotonic();
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS); this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
  /** One tick of the sampling timer: how late it fired is the event loop's lag. */
  sample() {
    const current = this.monotonic(), lag = Math.max(0, current - this.lastSample - SAMPLE_INTERVAL_MS);
    this.lastSample = current;
    this.minute().lagSamples.push(lag);
    if (lag >= LAG_EVENT_MS) {
      this.lagEvents.push({ at: new Date(this.now()).toISOString(), lagMs: round(lag), operations: [...new Set(this.running.values())] });
      if (this.lagEvents.length > KEPT_LAG_EVENTS) this.lagEvents.shift();
    }
    this.sampleMemory();
  }
  /** Runs `run` as a named operation: it is listed as running while it runs, then counted with its duration. */
  async operation<T>(name: string, run: () => T | Promise<T>): Promise<T> {
    const finish = this.started(name);
    try { return await run(); } finally { finish(); }
  }
  /** Marks `name` as running until the returned function is called. */
  started(name: string) {
    const id = ++this.operations, started = this.monotonic();
    this.running.set(id, name);
    return () => {
      if (!this.running.delete(id)) return;
      this.finished(name, this.monotonic() - started);
    };
  }
  /** Replaces `target[method]` with the same method run as the operation `name`; the target's own calls go through it too. */
  timed(target: object, method: string, name: string) {
    const record = target as Record<string, unknown>, original = record[method];
    if (typeof original !== 'function') throw new Error(`Cannot time ${name}: ${method} is not a method`);
    record[method] = (...args: unknown[]) => this.operation(name, () => original.apply(target, args));
  }
  written(peer: number, label: string, bytes: number) {
    if (label !== 'snapshot') return;
    const minute = this.minute(), subscriber = this.subscriber(peer);
    minute.snapshots++; minute.snapshotBytes += bytes;
    this.snapshots.count++; this.snapshots.bytes += bytes; this.snapshots.largestFrameBytes = Math.max(this.snapshots.largestFrameBytes, bytes);
    subscriber.snapshots++; subscriber.bytes += bytes; subscriber.largestFrameBytes = Math.max(subscriber.largestFrameBytes, bytes);
  }
  coalesced(peer: number, label: string) {
    if (label !== 'snapshot') return;
    this.minute().coalesced++; this.snapshots.coalesced++; this.subscriber(peer).coalesced++;
  }
  dropped(_peer: number, drop: FrameDrop) {
    this.minute().drops++; this.dropCount++;
    this.drops.push(drop); if (this.drops.length > KEPT_DROPS) this.drops.shift();
  }
  disconnected(peer: number) { this.subscribers.delete(peer); }
  report() {
    const currentIndex = this.minuteIndex(this.now()), firstRecent = currentIndex - RECENT_MINUTES + 1;
    const recent = this.minutes.filter(minute => minute.index >= firstRecent);
    const windowMinutes = Math.max(1, Math.min(RECENT_MINUTES, currentIndex - this.minuteIndex(this.startedAt) + 1));
    const sum = (key: 'snapshots' | 'snapshotBytes' | 'coalesced' | 'drops') => recent.reduce((total, minute) => total + minute[key], 0);
    return {
      version: 1 as const,
      startedAt: new Date(this.startedAt).toISOString(),
      at: new Date(this.now()).toISOString(),
      lastTenMinutes: {
        lagMaxMs: round(Math.max(0, ...recent.flatMap(minute => minute.lagSamples))), lagP95Ms: round(p95(recent.flatMap(minute => minute.lagSamples))),
        snapshotsPerMinute: round(sum('snapshots') / windowMinutes), snapshotBytesPerMinute: Math.round(sum('snapshotBytes') / windowMinutes),
        coalesced: sum('coalesced'), drops: sum('drops'),
      },
      minutes: this.minutes.map(minute => ({
        start: new Date(minute.index * MINUTE_MS).toISOString(), lagMaxMs: round(Math.max(0, ...minute.lagSamples)), lagP95Ms: round(p95(minute.lagSamples)),
        snapshots: minute.snapshots, snapshotBytes: minute.snapshotBytes, coalesced: minute.coalesced, drops: minute.drops,
        rssBytes: minute.rssBytes ?? null, heapUsedBytes: minute.heapUsedBytes ?? null,
      })),
      lagEvents: [...this.lagEvents],
      running: [...new Set(this.running.values())],
      slowestOperations: [...this.slowest],
      operationCounts: Object.fromEntries([...this.counts].map(([name, count]) => [name, { ...count, totalMs: round(count.totalMs), maxMs: round(count.maxMs) }])),
      broadcasts: {
        snapshots: this.snapshots.count, bytes: this.snapshots.bytes, largestFrameBytes: this.snapshots.largestFrameBytes, coalesced: this.snapshots.coalesced,
        subscribers: [...this.subscribers.values()].map(subscriber => ({ ...subscriber })),
      },
      drops: { count: this.dropCount, recent: this.drops.map(drop => ({ ...drop, at: new Date(drop.at).toISOString() })) },
      memory: this.lastMemory ? { ...this.lastMemory } : null,
    };
  }
  private finished(name: string, elapsed: number) {
    const ms = round(elapsed), key = this.counts.has(name) || this.counts.size < COUNTED_OPERATION_NAMES ? name : 'other';
    const count = this.counts.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    count.count++; count.totalMs += elapsed; count.maxMs = Math.max(count.maxMs, elapsed); this.counts.set(key, count);
    if (this.slowest.length < KEPT_SLOWEST_OPERATIONS || ms > this.slowest.at(-1)!.ms) {
      this.slowest.push({ name: key, ms, at: new Date(this.now()).toISOString() });
      this.slowest.sort((a, b) => b.ms - a.ms);
      if (this.slowest.length > KEPT_SLOWEST_OPERATIONS) this.slowest.pop();
    }
  }
  private subscriber(peer: number) {
    let subscriber = this.subscribers.get(peer);
    if (!subscriber) { subscriber = { peer, snapshots: 0, bytes: 0, largestFrameBytes: 0, coalesced: 0 }; this.subscribers.set(peer, subscriber); }
    return subscriber;
  }
  private minuteIndex(time: number) { return Math.floor(time / MINUTE_MS); }
  private minute() {
    const index = this.minuteIndex(this.now()), last = this.minutes.at(-1);
    if (last?.index === index) return last;
    const minute: Minute = { index, lagSamples: [], snapshots: 0, snapshotBytes: 0, coalesced: 0, drops: 0 };
    this.minutes.push(minute);
    if (this.minutes.length > KEPT_MINUTES) this.minutes.shift();
    return minute;
  }
  private sampleMemory() {
    const minute = this.minute();
    if (minute.index === this.memoryMinute) return;
    const usage = this.memory();
    this.memoryMinute = minute.index;
    this.lastMemory = { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
    minute.rssBytes = usage.rss; minute.heapUsedBytes = usage.heapUsed;
  }
}
export type ServiceHealthReport = ReturnType<ServiceHealth['report']>;
