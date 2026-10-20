/** Consecutive failures after which an installed package pauses, and how long it stays paused. */
export const BREAKER_FAILURES = 10, BREAKER_PAUSE_MS = 5 * 60_000;

/** Plugin messages can contain private data; keep a short first line only. */
export const pluginFailure = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) || 'Unknown error';

const cancelled = (error: unknown) => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/** Pauses one installed package after repeated failures in a row, then lets a call through again. */
export class PluginBreaker {
  readonly pluginId: string;
  private failures = 0;
  private pausedUntil = 0;
  private reason = '';
  private readonly now: () => number;
  constructor(pluginId: string, now: () => number = Date.now) { this.pluginId = pluginId; this.now = now; }

  get status(): { paused: boolean; until?: number; reason?: string } {
    return this.pausedUntil > this.now() ? { paused: true, until: this.pausedUntil, reason: this.reason } : { paused: false };
  }
  allows() { return this.pausedUntil <= this.now(); }
  succeeded() { this.failures = 0; this.pausedUntil = 0; }
  failed(error: unknown) {
    if (cancelled(error)) return;
    this.failures++; this.reason = pluginFailure(error);
    if (this.failures >= BREAKER_FAILURES) this.pausedUntil = this.now() + BREAKER_PAUSE_MS;
  }
  refusal() { return new Error(`Plugin ${this.pluginId} is paused after ${BREAKER_FAILURES} failures in a row. It tries again in a few minutes; reload plugins to retry now.`); }
}

const thenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';

/** Wraps every method of a package-supplied object. Failures count towards the package's breaker;
 * `quiet` swallows them (returning undefined) where a throw would disturb the host's own work. */
export function guardPlugin<T extends object>(value: T, breaker: PluginBreaker, mode: 'throw' | 'quiet' = 'throw'): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(value, {
    get(target, key, receiver) {
      const property = Reflect.get(target, key, receiver);
      if (typeof property !== 'function') return property;
      if (!wrapped.has(key)) wrapped.set(key, (...args: unknown[]) => {
        if (!breaker.allows()) { if (mode === 'quiet') return undefined; throw breaker.refusal(); }
        const fail = (error: unknown) => { breaker.failed(error); if (mode === 'quiet') return undefined; throw error; };
        try {
          const result = Reflect.apply(property, target, args);
          if (thenable(result)) return Promise.resolve(result).then(settled => { breaker.succeeded(); return settled; }, fail);
          breaker.succeeded(); return result;
        } catch (error) { return fail(error); }
      });
      return wrapped.get(key);
    },
  });
}

export function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
