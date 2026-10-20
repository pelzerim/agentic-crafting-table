import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceMetrics, SAMPLE_LIMIT } from './performance.ts';

test('performance reports retain bounded numeric samples, budgets and reset without content', () => {
  let now = 0;
  const metrics = new PerformanceMetrics(() => now);
  for (let i = 0; i < 5000; i++) metrics.record('terminal.read', i);
  metrics.record('private prompt' as any, 2);
  metrics.record('terminal.write', NaN); metrics.record('terminal.write', -1);
  now = 1234;
  const report = metrics.snapshot(), reads = report.metrics['terminal.read'];
  assert.equal(reads.retained, SAMPLE_LIMIT); assert.equal(reads.count, 5000);
  assert.equal(reads.max, 4999); assert.equal(reads.p95, 4974); assert.equal(reads.overBudget, true);
  assert.equal(report.elapsedMs, 1234); assert.equal(report.metrics['terminal.write'].count, 0);
  assert.ok(!JSON.stringify(report).includes('private prompt'));
  metrics.record('renderer.long-task', 150);
  assert.equal(metrics.snapshot().metrics['renderer.long-task'].overBudget, true, 'one severe stall is enough to flag');
  metrics.reset(); assert.equal(metrics.snapshot().metrics['terminal.read'].count, 0);
  assert.equal(metrics.snapshot().elapsedMs, 0);
});
