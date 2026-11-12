import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { WorkflowReportAdoption } from './workflow-report-adoption.ts';
import { reportedWorkflowRuns } from '../../src/pull-requests/workflow-correlation.ts';
import { DEFAULT_WORKFLOW_REVIEW_CONTRACT, reportMarker } from '../../src/pull-requests/workflow-contract.ts';

type Outcome = 'adopted' | 'tracked' | 'unrelated' | 'pending' | 'deferred';
type Comment = { id: number; kind: string; author: string; body: string; date: string };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'act-report-adoption-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const pulls = new Map<string, { pull: { state: string; merged?: boolean }; discussion: Comment[] }>(), outcomes = new Map<number, Outcome | Error | 'until stopped'>(), asked: string[] = [], reads: string[] = [];
  const checked = new Map<string, number>(); let on = true, now = Date.parse('2026-09-25T12:00:00Z'), notified = 0;
  const apply = async (...commands: WorkspaceCommand[]) => { await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands }); };
  const create = () => new WorkflowReportAdoption({ storage: store.pluginStorage('github.review-run'), control, enabled: () => on, now: () => now, changed: async () => { notified++; },
    resources: { async cached(nodeId) { reads.push(nodeId); const detail = pulls.get(nodeId); return detail ? { detail } : null; }, checkedAt: resourceId => checked.get(resourceId) },
    reviews: {
      async reports(_nodeId, comments) { return reportedWorkflowRuns('acme/app', comments, reportMarker(DEFAULT_WORKFLOW_REVIEW_CONTRACT)); },
      async adopt(nodeId, report, signal) {
        asked.push(`${nodeId}:${report.runId}:${report.commentId}`); const outcome = outcomes.get(report.runId) ?? 'adopted';
        if (outcome === 'until stopped') return new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
        if (outcome instanceof Error) throw outcome; return outcome;
      },
    } });
  const pr = (id: string, number: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: `PR ${number}`, data: { owner: 'acme', repo: 'app', number }, position: { x: number * 300, y: 0 } });
  /** A bot comment that reports a run, as the pull request's cached discussion holds it, posted so many minutes after the fixture's clock starts. */
  const report = (runId: number, minute: number): Comment => ({ id: runId + 1000, kind: 'discussion', author: 'github-actions[bot]', body: `## Review\n[View run](https://github.com/acme/app/actions/runs/${runId})`, date: new Date(Date.parse('2026-09-25T12:00:00Z') + minute * 60_000).toISOString() });
  const read = (id: string, discussion: Comment[], pull: { state: string; merged?: boolean } = { state: 'open' }) => { pulls.set(id, { pull, discussion }); checked.set(`${id}-r`, (checked.get(`${id}-r`) ?? 0) + 1); };
  return { store, control, outcomes, asked, reads, apply, create, pr, report, read, notified: () => notified, setting(value: boolean) { on = value; }, advance(ms: number) { now += ms; },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('turned on, a report posted before that on a mapped pull request stays unshown whenever it is read, and a later report is adopted once', async () => {
  const f = fixture();
  try {
    const adoption = f.create();
    await f.apply(f.pr('seen', 1), f.pr('unread', 2)); f.read('seen', [f.report(500, -30)]);
    await adoption.reconcile(); await adoption.reconcile();
    f.read('unread', [f.report(600, -20)]); await adoption.reconcile();
    assert.deepEqual(f.asked, [], 'what was posted before the setting came on is not shown');
    f.advance(120_000); f.read('seen', [f.report(500, -30), f.report(505, -5)]); await adoption.reconcile();
    assert.deepEqual(f.asked, [], 'a report the stored read did not hold yet was still posted before the setting came on');
    f.read('seen', [f.report(500, -30), f.report(505, -5), f.report(510, 3)]); await adoption.reconcile(); await adoption.reconcile();
    assert.deepEqual(f.asked, ['seen:510:1510']); assert.equal(f.notified(), 1);
    await adoption.close();
    const restarted = f.create(); f.read('seen', [f.report(500, -30), f.report(505, -5), f.report(510, 3)]); await restarted.reconcile();
    assert.deepEqual(f.asked, ['seen:510:1510'], 'what is settled survives a restart');
  } finally { f.close(); }
});

test('nothing is adopted while the setting is off, and turning it on again leaves what was posted meanwhile unshown', async () => {
  const f = fixture();
  try {
    const adoption = f.create();
    await adoption.reconcile(); f.setting(false); await adoption.reconcile();
    await f.apply(f.pr('pr', 1)); f.read('pr', [f.report(500, 1)]); await adoption.reconcile();
    f.advance(600_000); f.setting(true); await adoption.reconcile(); await adoption.reconcile();
    assert.deepEqual(f.asked, []);
    f.read('pr', [f.report(500, 1), f.report(510, 12)]); await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:510:1510']);
  } finally { f.close(); }
});

test('a pull request added afterwards shows its newest review only: unrelated runs are passed over and older reports are never adopted', async () => {
  const f = fixture();
  try {
    const adoption = f.create(); await adoption.reconcile();
    await f.apply(f.pr('pr', 1)); f.outcomes.set(530, 'unrelated');
    const human = { ...f.report(540, 9), author: 'fixture-developer' }, inline = { ...f.report(550, 9), kind: 'inline' };
    f.read('pr', [f.report(500, 1), f.report(510, 2), f.report(520, 3), f.report(530, 4), human, inline]);
    await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:530:1530', 'pr:520:1520']);
    f.read('pr', [f.report(500, 1), f.report(510, 2), f.report(520, 3), f.report(530, 4)]); await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:530:1530', 'pr:520:1520'], 'the older reports stay settled');
    f.outcomes.set(560, 'tracked'); f.read('pr', [f.report(520, 3), f.report(560, 5)]); await adoption.reconcile(); await adoption.reconcile();
    assert.deepEqual(f.asked.slice(2), ['pr:560:1560'], 'a run a request already follows is settled like an adopted one');
    assert.equal(f.notified(), 1);
  } finally { f.close(); }
});

test('a report that shows up later but was posted before the review on the map does not replace it', async () => {
  const f = fixture();
  try {
    const adoption = f.create(); await adoption.reconcile();
    await f.apply(f.pr('pr', 1)); f.read('pr', [f.report(520, 5)]); await adoption.reconcile();
    f.read('pr', [f.report(510, 1), f.report(520, 5)]); await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:520:1520']);
    f.outcomes.set(530, 'tracked'); f.read('pr', [f.report(510, 1), f.report(520, 5), f.report(530, 7)]); await adoption.reconcile();
    f.read('pr', [f.report(510, 1), f.report(520, 5), f.report(525, 6), f.report(530, 7), f.report(540, 8)]); await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:520:1520', 'pr:530:1530', 'pr:540:1540'], 'a run a request follows counts as the review on the map too');
    await adoption.close();
    const restarted = f.create(); f.read('pr', [f.report(535, 7.5), f.report(540, 8)]); await restarted.reconcile();
    assert.equal(f.asked.length, 3, 'which survives a restart');
  } finally { f.close(); }
});

test('an undecided report is asked about again a minute later, and nothing older is adopted in its place', async () => {
  const f = fixture();
  try {
    const adoption = f.create(); await adoption.reconcile();
    await f.apply(f.pr('pr', 1)); f.outcomes.set(510, 'pending'); f.read('pr', [f.report(500, 1), f.report(510, 2)]);
    await adoption.reconcile(); await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:510:1510']);
    f.advance(59_000); await adoption.reconcile(); assert.equal(f.asked.length, 1);
    f.outcomes.set(510, 'deferred'); f.advance(1000); await adoption.reconcile(); assert.equal(f.asked.length, 2);
    f.outcomes.set(510, 'adopted'); f.advance(60_000); await adoption.reconcile(); f.advance(60_000); await adoption.reconcile();
    assert.deepEqual(f.asked, ['pr:510:1510', 'pr:510:1510', 'pr:510:1510']);
  } finally { f.close(); }
});

test('a closed, merged, archived or unread pull request adopts nothing, and an unchanged read is not decoded again', async () => {
  const f = fixture();
  try {
    const adoption = f.create(); await adoption.reconcile();
    await f.apply(f.pr('closed', 1), f.pr('merged', 2), f.pr('archived', 3), f.pr('unread', 4), f.pr('open', 5));
    f.read('closed', [f.report(500, 1)], { state: 'closed' }); f.read('merged', [f.report(510, 1)], { state: 'closed', merged: true }); f.read('archived', [f.report(520, 1)]); f.read('open', []);
    await f.apply({ type: 'node.archive', id: 'archived' });
    await adoption.reconcile(); await adoption.reconcile();
    assert.deepEqual(f.asked, []);
    assert.deepEqual(f.reads.filter(id => id === 'open'), ['open']); assert.equal(f.reads.includes('archived'), false);
    f.read('closed', [f.report(500, 1)], { state: 'open' }); await adoption.reconcile();
    assert.deepEqual(f.asked, ['closed:500:1500'], 'a reopened pull request shows its newest report');
  } finally { f.close(); }
});

test('a pull request whose provider cannot be asked is tried again and blocks no other', async () => {
  const f = fixture();
  try {
    const adoption = f.create(); await adoption.reconcile();
    await f.apply(f.pr('broken', 1), f.pr('fine', 2)); f.read('broken', [f.report(500, 1)]); f.read('fine', [f.report(600, 1)]);
    f.outcomes.set(500, new Error('Disconnected'));
    await adoption.reconcile();
    assert.deepEqual(f.asked, ['broken:500:1500', 'fine:600:1600']);
    f.outcomes.delete(500); await adoption.reconcile(); assert.equal(f.asked.length, 2);
    f.advance(60_000); await adoption.reconcile();
    assert.deepEqual(f.asked.slice(2), ['broken:500:1500']);
  } finally { f.close(); }
});

test('closing ends a read that is under way, and the report is asked about again afterwards', async () => {
  const f = fixture();
  try {
    const adoption = f.create(); await adoption.reconcile();
    await f.apply(f.pr('pr', 1)); f.outcomes.set(500, 'until stopped'); f.read('pr', [f.report(500, 1)]);
    const pass = adoption.reconcile(); while (!f.asked.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await Promise.race([adoption.close().then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('still reading'), 500))]), 'closed');
    await pass; f.outcomes.delete(500);
    adoption.start(); await adoption.reconcile(); assert.equal(f.asked.length, 1, 'not before its retry is due');
    f.advance(60_000); await adoption.reconcile(); await adoption.close();
    assert.deepEqual(f.asked, ['pr:500:1500', 'pr:500:1500']);
  } finally { f.close(); }
});
