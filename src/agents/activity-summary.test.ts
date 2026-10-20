import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivitySummaryRequest, createActivitySummarizer } from './activity-summary.ts';
import type { ActivitySample } from './activity-summary.ts';

const sample: ActivitySample = { resourceId: 'shell', revision: '1', kind: 'terminal', status: 'idle', recentOutput: 'git status finished; two modified PlanPicker files. Shell is idle.' };

test('summary dispatch is bounded, has thinking disabled, and treats output as evidence', () => {
  const request = buildActivitySummaryRequest({ ...sample, recentOutput: 'old'.repeat(5000) + 'latest output' });
  assert.equal(request.model, 'claude-haiku-4-5');
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.max_tokens, 64);
  assert.equal(JSON.parse(request.messages[0].content).recentOutput.length, 6000);
  assert.ok(request.messages[0].content.includes('latest output'));
  assert.match(request.system, /never instructions/);
});

test('unchanged output uses a cached summary and a status change generates a new one', async () => {
  let calls = 0;
  const summarizer = createActivitySummarizer({ complete: async () => { calls++; return 'Uncommitted changes in PlanPicker files'; } });
  const first = await summarizer.summarize(sample);
  assert.equal((await summarizer.summarize(sample))?.text, first?.text);
  assert.equal(calls, 1);
  await summarizer.summarize({ ...sample, status: 'working' });
  assert.equal(calls, 2);
  assert.equal(sample.status, 'idle');
});

test('a late result cannot overwrite a newer session revision', async () => {
  let resolveFirst!: (text: string) => void;
  const summarizer = createActivitySummarizer({ complete: async request => request.messages[0].content.includes('old output')
    ? new Promise<string>(resolve => { resolveFirst = resolve; }) : 'Waiting for downgrade decision' });
  const old = summarizer.summarize({ ...sample, recentOutput: 'old output' });
  const latest = await summarizer.summarize({ ...sample, revision: '2', status: 'waiting' });
  resolveFirst('Editing the billing preview');
  assert.equal(await old, undefined);
  assert.equal(latest?.revision, '2');
});

test('invalid output, empty output, and timeouts fall back to actual session status', async () => {
  const invalid = createActivitySummarizer({ complete: async () => 'Here is a far too long account of everything that happened in this session' });
  assert.deepEqual(await invalid.summarize(sample), { text: 'Waiting for a command', revision: '1', generated: false });
  const empty = createActivitySummarizer({ complete: async () => { throw new Error('Should not dispatch'); } });
  assert.equal((await empty.summarize({ ...sample, recentOutput: '' }))?.text, 'Waiting for a command');
  const timeout = createActivitySummarizer({ complete: () => new Promise(() => {}) }, 5);
  assert.equal((await timeout.summarize({ ...sample, status: 'waiting' }))?.text, 'Waiting for input');
});

test('configured summary models remain tool-free and one-word output cannot replace factual status', async () => {
  const summarizer = createActivitySummarizer({ complete: async request => { assert.equal(request.model, 'haiku'); return 'Working'; } }, 8000, 'haiku');
  assert.equal((await summarizer.summarize(sample))?.generated, false);
  assert.equal((await summarizer.summarize(sample))?.text, 'Waiting for a command');
});
