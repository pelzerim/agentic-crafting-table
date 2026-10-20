// Paid opt-in native capability/evaluation check; excluded from ordinary CI.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeSummaryClient } from '../packages/session-runtime/activity-summary.ts';
import { createActivitySummarizer } from '../src/agents/activity-summary.ts';
if (process.env.ACT_LIVE_SUMMARIES !== '1') throw new Error('Set ACT_LIVE_SUMMARIES=1 to run four paid, synthetic summary requests through your installed Claude account.');
const cwd = await mkdtemp(join(tmpdir(), 'craft-summary-live-'));
const summarizer = createActivitySummarizer(nativeSummaryClient(cwd), 20_000, 'haiku');
const cases = [
  { kind: 'agent', status: 'working', recentOutput: 'Updated the billing plan selector. Running its regression tests now.' },
  { kind: 'agent', status: 'waiting', recentOutput: 'Paused for your decision: should downgrades apply now or on the next billing cycle?' },
  { kind: 'terminal', status: 'idle', recentOutput: 'All 24 billing regression tests passed. The shell is back at its prompt.' },
  { kind: 'agent', status: 'complete', recentOutput: 'Completed the plan selector change. All tests passed. Session ended.' },
];
try {
  for (const [index, sample] of cases.entries()) {
    const resourceId = `synthetic-${index}`, started = Date.now();
    try {
      const result = await summarizer.summarize({ ...sample, resourceId, revision: '1' });
      assert.ok(result?.generated, `No valid native label for ${sample.status}`);
      console.log(JSON.stringify({ status: sample.status, kind: sample.kind, text: result.text, model: result.model, elapsedMs: Date.now() - started }));
    } finally { summarizer.dispose(resourceId); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await rm(cwd, { recursive: true, force: true }); }
