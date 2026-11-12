import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { WorkflowReviewCoordinator } from './workflow-reviews.ts';
import type { WorkflowSource } from '../provider-runtime/workflow-sources.ts';
import { timedWorkflowYaml, workflowFixture } from '../../tests/fixtures/workflow.ts';
import { GitHubError } from '../provider-runtime/github.ts';
import { attentionItems, attentionReceipt } from '../../src/graph/attention.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'act-workflow-')), store = new SqliteStore(join(dir, 'test.sqlite')), control = new WorkspaceControl(store), provider = workflowFixture();
  await control.dispatch({ commandId: 'fixture', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Project', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', projectId: 'project', position: { x: 500, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
  ] });
  let now = Date.parse('2026-09-25T12:00:00Z'), connected = true;
  const sources: Record<string, WorkflowSource> = { 'github.pull-request': {
    freeze: resource => ({ identity: { owner: 'fixture', repo: 'billing', number: Number(resource.data.number) }, sourceData: resource.data, connectionId: 'fixture-account', account: 'fixture-developer' }),
    client: () => { if (!connected) throw new Error('Disconnected'); return provider.client; },
  } };
  return { store, control, provider, sources, advance(ms = 30_000) { now += ms; }, disconnect() { connected = false; },
    coordinator: () => { const coordinator = new WorkflowReviewCoordinator(store, control, sources, async () => {}, () => true, () => now); coordinator.resume(); return coordinator; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('durable workflow creates one linked item, deduplicates aliases/retries and retains the actual report on restart', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    const state = await f.control.read(), item = state.nodes.find(n => n.id !== 'pr' && n.resourceId)!;
    assert.equal(f.provider.posts, 1); assert.equal(item.projectId, 'project'); assert.equal(item.activity, 'working'); assert.equal(state.links[0].targetId, item.id);
    await reviews.start('pr', { requestId }); await reviews.start('pr', { requestId: randomUUID() }); await reviews.tick(); assert.equal(f.provider.posts, 1);
    await f.control.dispatch({ commandId: 'alias', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'alias', resourceId: 'alias-resource', pluginId: 'github.pull-request', title: 'Alias', position: { x: 1000, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
    const aliasRequest = randomUUID(); await reviews.start('alias', { requestId: aliasRequest }); await reviews.tick();
    assert.equal((await reviews.status('alias', aliasRequest))[0].nodeId, item.id); assert.equal(f.provider.posts, 1);
    await reviews.pause(); f.store.recoverInterruptedJobs(); reviews = f.coordinator(); f.provider.complete(); f.advance(); await reviews.tick();
    const result = (await reviews.status(item.id))[0]; assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.match(result.report!, /Fixture findings/); assert.match(result.resultUrl!, /issuecomment-400$/);
    assert.equal(f.provider.posts, 1); assert.equal((await f.control.read()).nodes.find(n => n.id === item.id)!.activity, 'complete');
    const finished = await f.control.read();
    assert.deepEqual(attentionItems(finished.nodes).find(entry => entry.node.id === item.id)?.reasons, ['finished']);
    assert.deepEqual(attentionItems(finished.nodes).find(entry => entry.node.id === item.id)?.notes, ['Workflow review ready']);
    await f.control.apply({ type: 'attention.acknowledge', ...attentionReceipt(finished.nodes, item.id) }, finished.revision);
    await reviews.pause(); reviews = f.coordinator(); f.advance(); await reviews.tick();
    assert.equal(attentionItems((await f.control.read()).nodes).length, 0, 'restart and completed polling do not revive a viewed report');
    await reviews.start('pr', { requestId }); await reviews.tick(); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('workflow shortcuts reject a changed source resource before creating a job or posting', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    await assert.rejects(reviews.start('pr', { requestId: randomUUID(), sourceResourceId: 'a-different-pr' }), /source PR no longer matches/);
    assert.equal(f.provider.posts, 0); assert.equal(f.store.listJobs().length, 0);
    const requestId = randomUUID();
    await reviews.start('pr', { requestId, sourceResourceId: 'pr-resource' }); await reviews.tick();
    await reviews.start('pr', { requestId, sourceResourceId: 'pr-resource' }); await reviews.tick();
    assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('accepted POST timeout survives restart, never reposts, and requires an eligible explicit trigger choice', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  try {
    f.provider.postFailure = new GitHubError('GITHUB_POST_UNCERTAIN', 'accepted then disconnected');
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].status, 'needs-confirmation');
    await reviews.pause(); f.store.recoverInterruptedJobs(); reviews = f.coordinator(); f.advance(); await reviews.tick();
    assert.deepEqual((await reviews.status('pr', requestId))[0].candidates, [101]); assert.equal(f.provider.posts, 1);
    await assert.rejects(reviews.stop('pr', { requestId }), /Confirm/);
    await assert.rejects(reviews.reconcile('pr', { requestId, triggerId: 999 }), /eligible/);
    await reviews.start('pr', { requestId: randomUUID() }); await reviews.tick(); assert.equal(f.provider.posts, 1);
    f.provider.complete(); await reviews.reconcile('pr', { requestId, triggerId: 101 }); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].state, 'succeeded', JSON.stringify(await reviews.status('pr', requestId))); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('read failures after an uncertain POST preserve uncertainty and explicit no-trigger decision never posts', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    f.provider.postFailure = new GitHubError('GITHUB_POST_UNCERTAIN', 'fixture'); const requestId = randomUUID();
    await reviews.start('pr', { requestId }); await reviews.tick(); f.provider.status = 401; f.advance(); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].state, 'outcome-unknown');
    const watchedId = (await reviews.status('pr', requestId))[0].nodeId, watched = (await f.control.read()).nodes.find(node => node.id === watchedId)!;
    assert.deepEqual([watched.attentionSources?.workflow, watched.attentionNotes?.workflow], ['error', 'Confirm the /review trigger']);
    await reviews.reconcile('pr', { requestId, triggerId: null }); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].state, 'cancelled'); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('crash after journalling but before receiving POST identity does not send a second comment', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick(); await reviews.pause();
    const job = f.store.listJobs().find(j => j.input.action === 'review.workflow')!;
    f.store.transitionJob(job.id, 'waiting', 'running', { correlation: { triggerId: undefined } }); f.store.recoverInterruptedJobs();
    reviews = f.coordinator(); f.advance(); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].status, 'needs-confirmation'); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('unsupported workflow or changed source fails before posting; uncertain identity cannot be reused for another item', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    f.provider.yaml = 'name: old'; const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    assert.equal(f.provider.posts, 0); assert.equal((await reviews.status('pr', requestId))[0].state, 'failed');
    await assert.rejects(reviews.start('project', { requestId }), /reused/);
    await reviews.pause(); await assert.rejects(reviews.start('pr', { requestId: randomUUID() }), /Reopen/);
  } finally { await reviews.pause(); f.close(); }
});

test('green without report waits until the deadline; cancellation stops only local polling and retains graph items', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick(); f.provider.complete(); f.provider.comments.pop(); f.advance(); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].status, 'awaiting-result'); f.advance(3_600_000); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].state, 'failed'); assert.equal(f.provider.posts, 1);
    const second = randomUUID(); await reviews.start('pr', { requestId: second }); await reviews.tick(); await reviews.stop('pr', { requestId: second });
    assert.equal((await reviews.status('pr', second))[0].state, 'cancelled'); assert.equal((await f.control.read()).nodes.length, 4); assert.equal(f.provider.posts, 2);
  } finally { await reviews.pause(); f.close(); }
});

test('disconnect pauses reads with persisted backoff, retains the trigger and never retries writes', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick(); f.disconnect(); f.advance(); await reviews.tick();
    const result = (await reviews.status('pr', requestId))[0]; assert.equal(result.state, 'waiting'); assert.equal(result.triggerId, 101); assert.match(result.error!, /Disconnected/); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('source edits during preflight prevent the external write and retain an explicit failed request', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const before = f.provider.client.preflight.bind(f.provider.client);
    f.provider.client.preflight = async (...args) => {
      const result = await before(...args), state = await f.control.read();
      await f.control.dispatch({ commandId: 'edit-source', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.update', id: 'pr', data: { owner: 'fixture', repo: 'billing', number: 43 } }] }); return result;
    };
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    const status = (await reviews.status('pr', requestId))[0]; assert.equal(status.state, 'failed'); assert.match(status.error!, /source PR or account changed/); assert.equal(f.provider.posts, 0);
  } finally { await reviews.pause(); f.close(); }
});

test('closing during the comment request journals uncertainty, then resumes reads without reposting', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  try {
    const before = f.provider.postReview.bind(f.provider); let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.provider.postReview = async (identity, signal) => {
      await before(identity, signal); entered();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new GitHubError('GITHUB_POST_UNCERTAIN', 'closed after accept')), { once: true }));
    };
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); const working = reviews.tick(); await ready; await reviews.pause(); await working;
    assert.equal((await reviews.status('pr', requestId))[0].state, 'outcome-unknown');
    f.store.recoverInterruptedJobs(); reviews = f.coordinator(); f.advance(); await reviews.tick();
    assert.deepEqual((await reviews.status('pr', requestId))[0].candidates, [101]); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('a crash before reservation capture is an explicit failure, never a new POST or a corrupt status list', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const requestId = randomUUID(); f.store.enqueueJob(`workflow:${requestId}`, { action: 'review.workflow', nodeId: 'pr', arguments: { requestId } });
    await reviews.tick(); const status = (await reviews.status('pr', requestId))[0];
    assert.equal(status.state, 'failed'); assert.match(status.error!, /Nothing was posted/); assert.equal(f.provider.posts, 0);
  } finally { await reviews.pause(); f.close(); }
});

test('timed workflow tracking reports its mode and adopts the single nearby review run', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    f.provider.yaml = timedWorkflowYaml; const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    let status = (await reviews.status('pr', requestId))[0]; assert.equal(status.tracking, 'timed'); assert.equal(status.triggerId, 101);
    f.provider.complete(101, 'Claude Code'); f.advance(); await reviews.tick();
    status = (await reviews.status('pr', requestId))[0]; assert.equal(status.state, 'succeeded', JSON.stringify(status)); assert.equal(status.runId, 200); assert.match(status.resultUrl!, /issuecomment-400$/);
    assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('timed workflow tracking times out without a nearby run and fails as ambiguous beside another /review', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    f.provider.yaml = timedWorkflowYaml; const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    f.advance(); await reviews.tick(); assert.equal((await reviews.status('pr', requestId))[0].state, 'waiting');
    f.advance(3_600_000); await reviews.tick();
    let status = (await reviews.status('pr', requestId))[0]; assert.equal(status.state, 'failed', JSON.stringify(status)); assert.equal(status.status, 'timed-out');
    const second = randomUUID(); await reviews.start('pr', { requestId: second }); await reviews.tick(); f.provider.complete(102, 'Claude Code'); f.advance(); await reviews.tick();
    status = (await reviews.status('pr', second))[0]; assert.equal(status.state, 'failed'); assert.equal(status.status, 'ambiguous'); assert.match(status.error!, /another \/review/i);
    assert.equal(status.runsUrl, 'https://github.com/fixture/billing/actions/workflows/review.yml'); assert.equal(f.provider.posts, 2);
  } finally { await reviews.pause(); f.close(); }
});

test('a trigger whose run is never observed times out at the watch deadline', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    f.advance(); await reviews.tick(); assert.equal((await reviews.status('pr', requestId))[0].state, 'waiting');
    f.advance(3_600_000); await reviews.tick();
    const status = (await reviews.status('pr', requestId))[0]; assert.equal(status.state, 'failed', JSON.stringify(status)); assert.equal(status.status, 'timed-out');
  } finally { await reviews.pause(); f.close(); }
});

test('exact workflow tracking still requires the run-name contract', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].tracking, 'exact');
    f.provider.complete(101, 'Claude Code'); f.advance(); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].state, 'waiting', 'an unnamed run is not adopted in exact mode');
  } finally { await reviews.pause(); f.close(); }
});

const reviewItems = async (f: Awaited<ReturnType<typeof fixture>>) => { const state = await f.control.read(); return state.nodes.filter(node => state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'github.review-run'); };

test('a review the workflow posted on its own becomes one linked item, is never posted for, and raises its report', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const report = f.provider.reported();
    const undecided = f.provider.reported(490); f.provider.jobs.pop();
    assert.equal(await reviews.adopt('pr', undecided), 'pending');
    Object.assign(f.provider.runs[1], { status: 'completed', conclusion: 'success' });
    assert.equal(await reviews.adopt('pr', undecided), 'unrelated'); assert.equal(await reviews.adopt('pr', { runId: 480, commentId: 680 }), 'unrelated');
    assert.equal(f.store.listJobs().length, 0);
    assert.equal(await reviews.adopt('pr', report), 'adopted'); await reviews.tick();
    const state = await f.control.read(), [item] = await reviewItems(f);
    assert.equal((await reviewItems(f)).length, 1); assert.equal(item.projectId, 'project'); assert.equal(item.activity, 'working'); assert.equal(item.summary, 'Watching review');
    assert.deepEqual(state.links.map(link => [link.sourceId, link.targetId, link.label]), [['pr', item.id, 'Workflow review']]);
    const watching = (await reviews.status(item.id))[0];
    assert.equal(watching.adopted, true); assert.equal(watching.status, 'running'); assert.equal(watching.triggerId, undefined); assert.equal(watching.runUrl, 'https://github.com/fixture/billing/actions/runs/500');
    assert.equal(await reviews.adopt('pr', report), 'tracked'); assert.equal(await reviews.adopt('pr', { ...report, commentId: 999 }), 'tracked');
    f.provider.report(); f.advance(); await reviews.tick();
    const result = (await reviews.status(item.id))[0];
    assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.match(result.report!, /Fixture findings/); assert.match(result.resultUrl!, /issuecomment-700$/);
    const finished = await f.control.read();
    assert.deepEqual(attentionItems(finished.nodes).find(entry => entry.node.id === item.id)?.notes, ['Workflow review ready']);
    assert.equal(f.provider.posts, 0); assert.equal((await reviewItems(f)).length, 1);
    assert.equal((await reviews.status('pr')).length, 1);
    await assert.rejects(reviews.adopt('missing', report), /pull request/); await assert.rejects(reviews.adopt('pr', { runId: 0, commentId: 1 }));
  } finally { await reviews.pause(); f.close(); }
});

test('an adopted review survives a crash mid-read without asking for a trigger, and fails at its deadline while disconnected', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  try {
    await reviews.adopt('pr', f.provider.reported()); await reviews.tick();
    const [item] = await reviewItems(f), job = f.store.listJobs()[0];
    await reviews.pause(); f.store.transitionJob(job.id, 'waiting', 'running', {}); f.store.recoverInterruptedJobs();
    assert.equal(f.store.getJob(job.id)!.state, 'outcome-unknown');
    reviews = new WorkflowReviewCoordinator(f.store, f.control, f.sources, async () => {}, () => true, () => Date.parse('2026-09-25T12:00:00Z')); await reviews.recover();
    const recovered = (await f.control.read()).nodes.find(node => node.id === item.id)!;
    assert.equal(recovered.summary, 'Watching review'); assert.equal(recovered.attentionSources?.workflow, undefined);
    assert.equal((await reviews.status(item.id))[0].status, 'running');
    await assert.rejects(reviews.reconcile(item.id, { requestId: String(job.input.arguments.requestId), triggerId: null }), /not awaiting/);
    await reviews.pause(); reviews = f.coordinator(); f.disconnect(); f.advance(); await reviews.tick();
    const waiting = (await reviews.status(item.id))[0]; assert.equal(waiting.state, 'waiting'); assert.match(waiting.error!, /Disconnected/);
    f.advance(3_600_000); await reviews.tick();
    assert.equal((await reviews.status(item.id))[0].state, 'failed'); assert.equal(f.provider.posts, 0);
  } finally { await reviews.pause(); f.close(); }
});

test('a newer report replaces the older one in the same item, stops the older watch and raises attention again', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    await reviews.adopt('pr', f.provider.reported(500)); await reviews.tick();
    const [item] = await reviewItems(f);
    assert.equal(await reviews.adopt('pr', f.provider.reported(510)), 'adopted'); await reviews.tick();
    assert.deepEqual(f.store.listJobs().map(job => job.state), ['cancelled', 'waiting']);
    assert.deepEqual((await reviewItems(f)).map(node => node.id), [item.id]);
    assert.deepEqual((await reviews.status(item.id)).map(result => result.runId), [510]);
    assert.deepEqual((await reviews.status('pr')).map(result => result.runId), [510]);
    f.provider.report(500); f.provider.report(510, 'Second findings'); f.advance(); await reviews.tick();
    const first = await f.control.read();
    assert.match((await reviews.status(item.id))[0].report!, /Second findings/); assert.equal(first.nodes.find(node => node.id === item.id)!.activity, 'complete');
    await f.control.apply({ type: 'attention.acknowledge', ...attentionReceipt(first.nodes, item.id) }, first.revision);
    assert.equal(await reviews.adopt('pr', f.provider.reported(520)), 'adopted'); await reviews.tick();
    assert.equal((await f.control.read()).nodes.find(node => node.id === item.id)!.activity, 'working');
    f.provider.report(520, 'Third findings'); f.advance(); await reviews.tick();
    const second = await f.control.read();
    assert.deepEqual(attentionItems(second.nodes).find(entry => entry.node.id === item.id)?.notes, ['Workflow review ready']);
    assert.match((await reviews.status(item.id))[0].report!, /Third findings/);
    await reviews.stop(item.id, { requestId: (await reviews.status(item.id))[0].requestId });
    assert.equal((await reviews.status(item.id))[0].state, 'succeeded');
    assert.equal(await reviews.adopt('pr', f.provider.reported(525)), 'adopted'); await reviews.tick();
    const third = await f.control.read(), [newest] = await reviews.status(item.id);
    assert.equal(attentionItems(third.nodes).find(entry => entry.node.id === item.id), undefined, 'the unread older report no longer asks for attention');
    assert.equal(newest.report, undefined); assert.equal(newest.status, 'running');
    await f.control.apply({ type: 'node.archive', id: item.id }, third.revision);
    assert.equal(await reviews.adopt('pr', f.provider.reported(530)), 'adopted'); await reviews.tick();
    const items = await reviewItems(f);
    assert.equal(items.length, 2); assert.equal(items.find(node => node.id === item.id)!.summary, 'Stopped watching'); assert.equal(f.provider.posts, 0);
  } finally { await reviews.pause(); f.close(); }
});

test('a report is not adopted while a /review request looks for its run, nor after that request tracks the run', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    const report = f.provider.reported(500, 'issue_comment');
    assert.equal(await reviews.adopt('pr', report), 'deferred');
    f.provider.runs[0].display_title = 'ACT review comment 101'; f.advance(); await reviews.tick();
    assert.equal((await reviews.status('pr', requestId))[0].runId, 500);
    assert.equal(await reviews.adopt('pr', report), 'tracked');
    assert.equal(await reviews.adopt('pr', f.provider.reported(510)), 'adopted'); await reviews.tick();
    assert.equal((await reviewItems(f)).length, 2); assert.equal(f.provider.posts, 1);
  } finally { await reviews.pause(); f.close(); }
});

test('a /review request beside an adopted review posts its own comment and gets its own item', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    await reviews.adopt('pr', f.provider.reported()); await reviews.tick();
    const requestId = randomUUID(); await reviews.start('pr', { requestId }); await reviews.tick();
    assert.equal(f.provider.posts, 1); assert.equal((await reviewItems(f)).length, 2);
    const [requested] = await reviews.status('pr', requestId); assert.equal(requested.adopted, false); assert.equal(requested.triggerId, 101);
    await reviews.pause(); assert.equal(await reviews.adopt('pr', f.provider.reported(510)), 'deferred');
  } finally { await reviews.pause(); f.close(); }
});

test('a caller that stops waiting ends the read of a reported run, and nothing is adopted', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const stopped = new AbortController(), get = f.provider.get;
    f.provider.get = (path, signal) => { stopped.abort(new Error('Stopped waiting')); return get(path, signal); };
    await assert.rejects(reviews.adopt('pr', f.provider.reported(), stopped.signal), /Stopped waiting/); f.provider.get = get;
    await assert.rejects(reviews.adopt('pr', f.provider.reported(505), stopped.signal), /Stopped waiting/);
    assert.deepEqual(await reviews.status('pr'), []); assert.deepEqual(await reviewItems(f), []);
    assert.equal(await reviews.adopt('pr', f.provider.reported(510), new AbortController().signal), 'adopted');
  } finally { await reviews.pause(); f.close(); }
});
