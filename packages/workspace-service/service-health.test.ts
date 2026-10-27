import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceHealth } from './service-health.ts';

const START = Date.parse('2026-10-27T10:00:00.000Z');
function clocks() {
  const clock = { wall: START, monotonic: 0 };
  const advance = (ms: number) => { clock.wall += ms; clock.monotonic += ms; };
  const health = new ServiceHealth({ now: () => clock.wall, monotonic: () => clock.monotonic, memory: () => ({ rss: 200_000_000, heapUsed: 80_000_000 }) });
  return { clock, advance, health };
}

test('event-loop lag is the drift of the one-second timer; a lag of 250 ms or more is kept with the operations that were running', async () => {
  const { advance, health } = clocks();
  let release!: () => void;
  const running = health.operation('rollout.reconcile', () => new Promise<void>(resolve => { release = resolve; }));
  advance(1000); health.sample();
  advance(1300); health.sample();
  advance(1100); health.sample();
  advance(990); health.sample();
  release(); await running;
  const report = health.report();
  assert.equal(report.minutes.length, 1);
  assert.equal(report.minutes[0].lagMaxMs, 300);
  assert.equal(report.minutes[0].lagP95Ms, 300);
  assert.equal(report.lastTenMinutes.lagMaxMs, 300);
  assert.deepEqual(report.lagEvents, [{ at: new Date(START + 2300).toISOString(), lagMs: 300, operations: ['rollout.reconcile'] }]);
  assert.deepEqual(report.running, []);
});

test('operations keep the 50 slowest with counts per name; a failing operation is still counted', async () => {
  const { advance, health } = clocks();
  for (let ms = 1; ms <= 60; ms++) await health.operation(ms % 2 ? 'broadcast' : 'apply', async () => { advance(ms); });
  await assert.rejects(health.operation('summaries.tick', async () => { advance(500); throw new Error('offline'); }), /offline/);
  const report = health.report();
  assert.equal(report.slowestOperations.length, 50);
  assert.deepEqual(report.slowestOperations.slice(0, 3).map(operation => [operation.name, operation.ms]), [['summaries.tick', 500], ['apply', 60], ['broadcast', 59]]);
  assert.equal(report.slowestOperations.at(-1)!.ms, 12);
  assert.deepEqual(report.operationCounts.broadcast, { count: 30, totalMs: 900, maxMs: 59 });
  assert.deepEqual(report.operationCounts['summaries.tick'], { count: 1, totalMs: 500, maxMs: 500 });
});

test('broadcasts, coalesced snapshots and drops land in per-minute buckets; only the last 60 minutes are kept', () => {
  const { advance, health } = clocks();
  health.written(1, 'snapshot', 1000); health.written(2, 'snapshot', 1000); health.written(1, 'apply', 50);
  health.coalesced(2, 'snapshot');
  advance(60_000); health.sample();
  health.written(1, 'snapshot', 3000);
  health.dropped(2, { at: START + 60_000, queuedBytes: 8_000_000, frameBytes: 1_100_000, label: 'snapshot' }); health.disconnected(2);
  let report = health.report();
  assert.deepEqual(report.minutes.map(minute => [minute.snapshots, minute.snapshotBytes, minute.coalesced, minute.drops]), [[2, 2000, 1, 0], [1, 3000, 0, 1]]);
  assert.deepEqual(report.broadcasts, { snapshots: 3, bytes: 5000, largestFrameBytes: 3000, coalesced: 1, subscribers: [{ peer: 1, snapshots: 2, bytes: 4000, largestFrameBytes: 3000, coalesced: 0 }] });
  assert.deepEqual(report.drops, { count: 1, recent: [{ at: new Date(START + 60_000).toISOString(), queuedBytes: 8_000_000, frameBytes: 1_100_000, label: 'snapshot' }] });
  assert.equal(report.lastTenMinutes.snapshotsPerMinute, 1.5);
  assert.equal(report.lastTenMinutes.snapshotBytesPerMinute, 2500);
  assert.deepEqual([report.lastTenMinutes.coalesced, report.lastTenMinutes.drops], [1, 1]);
  assert.deepEqual(report.memory, { rssBytes: 200_000_000, heapUsedBytes: 80_000_000 });
  assert.equal(report.minutes[1].rssBytes, 200_000_000);
  for (let minute = 0; minute < 70; minute++) { advance(60_000); health.sample(); }
  report = health.report();
  assert.equal(report.minutes.length, 60);
  assert.equal(report.lastTenMinutes.snapshotsPerMinute, 0);
});

test('the report carries only names of events and operations, counts and times', async () => {
  const { advance, health } = clocks();
  await health.operation('apply', async () => { advance(5); });
  health.written(1, 'snapshot', 10);
  const report = health.report();
  assert.deepEqual(Object.keys(report), ['version', 'startedAt', 'at', 'lastTenMinutes', 'minutes', 'lagEvents', 'running', 'slowestOperations', 'operationCounts', 'broadcasts', 'drops', 'memory']);
  assert.deepEqual(Object.keys(report.slowestOperations[0]), ['name', 'ms', 'at']);
});

test('operation names are bounded so a stream of unknown methods cannot grow the counts', async () => {
  const { health } = clocks();
  for (let n = 0; n < 300; n++) await health.operation(`method-${n}`, async () => {});
  assert.equal(Object.keys(health.report().operationCounts).length, 201);
  assert.equal(health.report().operationCounts.other.count, 100);
});
