/** Fixed names and bounded numeric samples: never collect terminal content or identities. */
export const metricDefinitions = {
  'map.geometry': { unit: 'ms', budget: 16 },
  'map.placement': { unit: 'ms', budget: 16 },
  'map.plots': { unit: 'ms', budget: 16 },
  'map.biome': { unit: 'ms', budget: 16 },
  'map.frame-interval': { unit: 'ms', budget: 33 },
  'map.long-task': { unit: 'ms', budget: 100 },
  'map.card-render': { unit: 'count', budget: null },
  'map.dashboard-render': { unit: 'count', budget: null },
  'frame.interval': { unit: 'ms', budget: 50 },
  'renderer.long-task': { unit: 'ms', budget: 100 },
  'terminal.read': { unit: 'ms', budget: 100 },
  'terminal.write': { unit: 'ms', budget: 50 },
  'terminal.renderer-release': { unit: 'ms', budget: 32 },
  'terminal.fit': { unit: 'ms', budget: 32 },
  'terminal.input': { unit: 'ms', budget: 100 },
  'terminal.output': { unit: 'characters', budget: null },
  'terminal.empty-read': { unit: 'count', budget: null },
  'terminal.commit': { unit: 'count', budget: null },
  'terminal.read-inflight': { unit: 'count', budget: null },
  'terminal.backlog-chunks': { unit: 'count', budget: null },
  'terminal.output-gap': { unit: 'count', budget: null },
} as const;
export type MetricName = keyof typeof metricDefinitions;
export const SAMPLE_LIMIT = 512;
type Samples = { values: number[]; next: number; count: number; total: number; max: number };

export class PerformanceMetrics {
  private samples = new Map<MetricName, Samples>();
  private started: number;
  private clock: () => number;
  constructor(clock = () => performance.now()) { this.clock = clock; this.started = clock(); }
  record(name: MetricName, value: number) {
    if (!Object.hasOwn(metricDefinitions, name) || !Number.isFinite(value) || value < 0) return;
    let sample = this.samples.get(name);
    if (!sample) { sample = { values: [], next: 0, count: 0, total: 0, max: 0 }; this.samples.set(name, sample); }
    sample.values[sample.next] = value; sample.next = (sample.next + 1) % SAMPLE_LIMIT;
    sample.count++; sample.total += value; sample.max = Math.max(sample.max, value);
  }
  reset() { this.samples.clear(); this.started = this.clock(); }
  snapshot() {
    return { version: 1, elapsedMs: this.clock() - this.started, sampleLimit: SAMPLE_LIMIT,
      metrics: Object.fromEntries(Object.entries(metricDefinitions).map(([name, definition]) => {
        const sample = this.samples.get(name as MetricName), sorted = [...(sample?.values ?? [])].sort((a, b) => a - b);
        const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
        const p95 = percentile(.95);
        return [name, { ...definition, count: sample?.count ?? 0, total: sample?.total ?? 0,
          max: sample?.max ?? 0, retained: sorted.length, p50: percentile(.5), p95, p99: percentile(.99),
          overBudget: definition.budget !== null && (name.endsWith('long-task')
            ? (sample?.max ?? 0) > definition.budget : sorted.length >= 5 && p95 > definition.budget) }];
      })),
    };
  }
}
