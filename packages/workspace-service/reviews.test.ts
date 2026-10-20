import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { ReviewCoordinator, terminalText } from './reviews.ts';
import type { SessionCoordinator, PreparedSession } from './sessions.ts';
import type { SessionRecord } from '../session-runtime/protocol.ts';
import type { ReviewSource } from '../provider-runtime/review-sources.ts';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'act-review-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  await control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } }, { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', projectId: 'project', position: { x: 50, y: 50 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  let headSha = 'a'.repeat(40), failure = '', captureCount = 0, launchCount = 0, block: (() => Promise<void>) | undefined;
  const records = new Map<string, SessionRecord>();
  const source: ReviewSource = { async freeze() { return { comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha }, title: 'Fixed change', description: 'Untrusted PR description', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source, signal) { captureCount++; await block?.(); signal.throwIfAborted(); if (failure) throw new Error(failure); const cwd = join(directory, requestId, 'repository'); mkdirSync(cwd, { recursive: true }); return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId }; } };
  const sessions = { runtime: { async call(method: string, input: { sessionId?: string }) { if (method === 'sessions.list') return [...records.values()]; const session = records.get(input.sessionId!); if (!session) throw new Error('session unavailable'); return { session, chunks: [], firstSequence: 1, lastSequence: 0, truncated: false }; } },
    async launchPrepared(prepared: PreparedSession) {
      await control.dispatch({ commandId: `${prepared.requestId}:node`, expectedRevision: prepared.expectedRevision, actor: { kind: 'user', id: 'fixture' }, commands: prepared.commands });
      let session = records.get(prepared.launch.sessionId);
      if (!session) { launchCount++; session = { ...prepared.launch, native: undefined, id: prepared.launch.sessionId, state: 'running' as const, createdAt: '', updatedAt: '' }; records.set(session.id, session); }
      return { session, chunks: [], firstSequence: 1, lastSequence: 0, truncated: false };
    } } as unknown as SessionCoordinator;
  const runtime = { models: async () => ({ options: ['gpt-6-astra', 'opus', 'sonnet'], default: 'opus' }), probe: async () => ({ executable: '/usr/bin/native', version: 'fixture' }) };
  const coordinator = () => new ReviewCoordinator(directory, store, control, sessions, { 'github.pull-request': source }, async () => {}, runtime);
  return { directory, store, control, records, coordinator, runtime, source, sessions, get captureCount() { return captureCount; }, get launchCount() { return launchCount; }, set head(value: string) { headSha = value; }, set failure(value: string) { failure = value; }, set block(value: (() => Promise<void>) | undefined) { block = value; }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('separate review items pin revisions, reuse active requests and retain completed results through replay and restart', async () => {
  const f = await fixture(); const reviews = f.coordinator();
  try {
    const requestId = randomUUID(), first = await reviews.run('pr', 'codex', { requestId });
    assert.equal(f.launchCount, 1); assert.equal(first.session.readOnly, true);
    const state = await f.control.read(), item = state.nodes.find(node => node.id === first.session.nodeId)!, resource = state.resources.find(resource => resource.id === item.resourceId)!;
    assert.equal(resource.pluginId, 'code.review'); assert.equal(resource.data.baseSha, 'c'.repeat(40)); assert.equal(resource.data.headSha, 'a'.repeat(40)); assert.equal(resource.data.model, 'gpt-6-astra'); assert.equal(item.projectId, 'project'); assert.equal(state.links[0].targetId, item.id);
    assert.equal((await reviews.run('pr', 'codex', { requestId })).session.id, first.session.id);
    assert.equal((await reviews.run('pr', 'codex', { requestId: randomUUID() })).session.id, first.session.id); assert.equal(f.launchCount, 1);
    const second = await reviews.run('pr', 'claude', { requestId: randomUUID(), model: 'sonnet' }); assert.notEqual(second.session.nodeId, first.session.nodeId);
    await assert.rejects(reviews.run('pr', 'codex', { requestId, model: 'sonnet' }), /reused/);
    f.records.get(first.session.id)!.state = 'exited'; f.head = 'd'.repeat(40);
    const newer = await reviews.run('pr', 'codex', { requestId: randomUUID() }); assert.notEqual(newer.session.nodeId, first.session.nodeId); assert.equal(resource.data.headSha, 'a'.repeat(40));
    await reviews.close(); const restarted = f.coordinator(); assert.equal((await restarted.run('pr', 'codex', { requestId })).session.id, first.session.id); assert.equal(f.launchCount, 3); await restarted.close();
  } finally { await reviews.close(); f.close(); }
});

test('missing models fail before creating an item, incomplete captures leave a failed item without a process, and aborted captures recover their saved revision', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  try {
    await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID(), model: 'missing' }), /unavailable/);
    assert.equal((await f.control.read()).nodes.length, 2);
    f.failure = 'incomplete diff'; await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID() }), /incomplete diff/);
    assert.equal((await f.control.read()).resources.find(resource => resource.pluginId === 'code.review')!.data.error, 'incomplete diff'); assert.equal(f.launchCount, 0);
    f.failure = ''; let release!: () => void, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    f.block = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const requestId = randomUUID(), pending = reviews.run('pr', 'claude', { requestId }); const rejection = assert.rejects(pending, /abort/i);
    await ready; const closing = reviews.close(); release(); await rejection; await closing;
    f.head = 'd'.repeat(40); f.block = undefined; reviews = f.coordinator(); await reviews.recover();
    assert.equal(f.launchCount, 1); const state = await f.control.read(); assert.equal(state.resources.find(resource => resource.pluginId === 'code.review' && resource.data.sessionId)!.data.headSha, 'a'.repeat(40));
  } finally { await reviews.close(); f.close(); }
});

test('close recovery restarts a one-off review on the same item and exact comparison, preserving its previous recording', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const started = await reviews.run('pr', 'claude', { requestId: randomUUID() }); f.records.get(started.session.id)!.state = 'exited'; f.head = 'd'.repeat(40);
    const requestId = randomUUID(), recovered = await reviews.restore(started.session.nodeId, requestId);
    assert.equal(recovered.session.nodeId, started.session.nodeId); assert.equal(recovered.session.predecessorId, started.session.id); assert.equal(recovered.session.readOnly, true);
    assert.equal((await f.control.read()).nodes.length, 3); assert.equal(f.captureCount, 1); assert.equal(f.records.has(started.session.id), true);
    assert.equal((await reviews.restore(started.session.nodeId, requestId)).session.id, recovered.session.id); assert.equal(f.launchCount, 2);
  } finally { await reviews.close(); f.close(); }
});

test('closing review recovery leaves later jobs queued until the workspace reopens', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    for (const provider of ['claude', 'codex']) {
      const requestId = randomUUID();
      f.store.enqueueJob(`review:${requestId}`, { action: 'review.prepare', nodeId: 'pr', arguments: { requestId, provider } });
    }
    f.block = async () => { entered(); await held; };
    const recovery = reviews.recover(); await ready;
    const closing = reviews.close(); release(); await closing; await recovery;
    assert.equal(f.captureCount, 1); assert.equal(f.launchCount, 0);
    assert.deepEqual(f.store.listJobs().map(job => job.state), ['outcome-unknown', 'queued']);
    f.block = undefined; reviews = f.coordinator(); await reviews.recover();
    assert.equal(f.captureCount, 3); assert.equal(f.launchCount, 2);
    assert.deepEqual(f.store.listJobs().map(job => job.state), ['succeeded', 'succeeded']);
  } finally { release(); await reviews.close(); f.close(); }
});


test('active reviews deduplicate across PR aliases and fall back to an available model', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    f.runtime.models = async () => ({ options: ['sonnet'], default: 'sonnet' });
    const state = await f.control.read();
    await f.control.dispatch({ commandId: 'alias', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'alias', resourceId: 'alias-resource', pluginId: 'github.pull-request', title: 'Same PR', position: { x: 800, y: 400 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
    const first = await reviews.run('pr', 'claude', { requestId: randomUUID() });
    assert.equal((await f.control.read()).resources.find(resource => resource.pluginId === 'code.review')!.data.model, 'sonnet');
    // Use the UI's asynchronous entry point so the alias request has its own durable status.
    const requestId = randomUUID(); const pending: Promise<unknown>[] = [];
    reviews.start('alias', 'claude', { requestId }, work => { const promise = work(); pending.push(promise); return promise; });
    await Promise.all(pending);
    const [status] = reviews.status('alias', requestId);
    assert.equal(status.state, 'succeeded'); assert.equal(status.nodeId, first.session.nodeId);
    assert.equal((await reviews.run('alias', 'claude', { requestId })).session.id, first.session.id);
    assert.equal(f.launchCount, 1); assert.equal(f.captureCount, 1);
    await reviews.close();
    assert.throws(() => reviews.start('pr', 'claude', { requestId: randomUUID() }, work => work()), /closing/);
  } finally { await reviews.close(); f.close(); }
});

test('a review request rejects a source resource different from the clicked PR', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID(), sourceResourceId: 'another-pr-resource' }), /source PR/);
    assert.equal(f.captureCount, 0); assert.equal(f.launchCount, 0);
  } finally { await reviews.close(); f.close(); }
});

test('captured comparisons must match the saved PR, repository and revisions before launching', async () => {
  for (const mismatch of [{ number: 43 }, { repository: 'fixture/other' }, { headSha: 'd'.repeat(40) }, { baseTipSha: 'd'.repeat(40) }]) {
    const f = await fixture(), reviews = f.coordinator(), capture = f.source.capture;
    f.source.capture = async (...args) => ({ ...await capture(...args), ...mismatch });
    try {
      await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID() }), /comparison does not match/);
      assert.equal(f.launchCount, 0); assert.match(String((await f.control.read()).resources.find(resource => resource.pluginId === 'code.review')!.data.error), /comparison does not match/);
    } finally { await reviews.close(); f.close(); }
  }
});

test('a revision conflict cannot bypass the saved source PR binding', async () => {
  const f = await fixture(), reviews = f.coordinator(), launch = f.sessions.launchPrepared.bind(f.sessions);
  let changed = false;
  f.sessions.launchPrepared = async prepared => {
    if (!changed) {
      changed = true;
      const state = await f.control.read();
      await f.control.dispatch({ commandId: 'retarget-source', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
        { type: 'item.update', id: 'pr', data: { owner: 'fixture', repo: 'billing', number: 43 } },
      ] });
    }
    return launch(prepared);
  };
  try {
    await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID() }), /source PR binding changed/);
    assert.equal(f.launchCount, 0); assert.equal((await f.control.read()).resources.find(resource => resource.pluginId === 'code.review')!.data.phase, 'failed');
  } finally { await reviews.close(); f.close(); }
});

test('finished reviews return Markdown from Codex result files or ANSI-free Claude output', async () => {
  const f = await fixture(); const reviews = f.coordinator();
  try {
    const codex = await reviews.run('pr', 'codex', { requestId: randomUUID() });
    assert.deepEqual(await reviews.result(codex.session.nodeId), { state: 'running' });
    f.records.set(codex.session.id, { ...f.records.get(codex.session.id)!, state: 'exited', exitCode: 0 });
    assert.deepEqual(await reviews.result(codex.session.nodeId), { state: 'complete', markdown: '', truncated: false, startedAt: '', endedAt: '' });
    writeFileSync(join(f.directory, 'review-launches', codex.session.id, 'result.md'), '## Findings\n\n- **High:** plan changes apply immediately\n');
    assert.deepEqual(await reviews.result(codex.session.nodeId), { state: 'complete', markdown: '## Findings\n\n- **High:** plan changes apply immediately', truncated: false, startedAt: '', endedAt: '' });
    const claude = await reviews.run('pr', 'claude', { requestId: randomUUID() });
    const call = f.sessions.runtime.call.bind(f.sessions.runtime);
    (f.sessions.runtime as any).call = async (method: string, input: { sessionId: string }) => {
      const value = await call(method as any, input) as any;
      return input.sessionId === claude.session.id ? { ...value, chunks: [{ sequence: 1, data: '\x1b]0;claude\x07\x1b[?25l⠋ Thinking\r\x1b[2K' }, { sequence: 2, data: '\x1b[1m## Summary\x1b[0m\r\n\r\nLooks **good**.\r\n' }] } : value;
    };
    f.records.set(claude.session.id, { ...f.records.get(claude.session.id)!, state: 'exited', exitCode: 1 });
    assert.deepEqual(await reviews.result(claude.session.nodeId), { state: 'failed', markdown: '## Summary\n\nLooks **good**.', truncated: false, startedAt: '', endedAt: '' });
    await assert.rejects(reviews.result('pr'), /not a code review/);
  } finally { f.close(); }
});

test('terminal text removes control sequences and carriage-return overwrites', () => {
  assert.equal(terminalText('\x1b[31mred\x1b[0m plain'), 'red plain');
  assert.equal(terminalText('50%\r100%\r\ndone'), '100%\ndone');
  assert.equal(terminalText('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(terminalText('tab\tkept\x07'), 'tab\tkept');
});

function holdCapture(f: Awaited<ReturnType<typeof fixture>>) {
  let release = () => {}, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  f.block = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  return { ready, release: () => release() };
}
const reviewItems = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const state = await f.control.read();
  return state.resources.filter(resource => resource.pluginId === 'code.review').map(resource => ({ resource, node: state.nodes.find(node => node.resourceId === resource.id)!, links: state.links.filter(link => link.targetId === state.nodes.find(node => node.resourceId === resource.id)!.id) }));
};

test('the review item appears linked to its PR before capture finishes, reports phases and becomes the launched review', async () => {
  const f = await fixture(), reviews = f.coordinator(), launch = f.sessions.launchPrepared.bind(f.sessions);
  let atLaunch: { phase: unknown; summary?: string } | undefined;
  f.sessions.launchPrepared = async prepared => { const [item] = await reviewItems(f); atLaunch = { phase: item.resource.data.phase, summary: item.node.summary }; return launch(prepared); };
  const hold = holdCapture(f);
  try {
    const requestId = randomUUID(), pending = reviews.run('pr', 'claude', { requestId });
    await hold.ready;
    const [early] = await reviewItems(f);
    assert.ok(early, 'the review item exists while the comparison is still being captured');
    assert.equal(early.resource.data.phase, 'fetching'); assert.equal(early.resource.data.sessionId, undefined); assert.equal(early.resource.data.headSha, 'a'.repeat(40));
    assert.equal(early.node.activity, 'working'); assert.match(early.node.summary ?? '', /Fetching and comparing/); assert.equal(early.node.projectId, 'project');
    assert.deepEqual(early.links.map(link => [link.sourceId, link.kind]), [['pr', 'reference']]);
    assert.equal(reviews.status('pr', requestId)[0].nodeId, early.node.id);
    hold.release(); const started = await pending;
    assert.deepEqual(atLaunch, { phase: 'starting', summary: 'Starting Claude…' });
    const items = await reviewItems(f); assert.equal(items.length, 1);
    const [item] = items; assert.equal(item.node.id, early.node.id); assert.equal(started.session.nodeId, early.node.id);
    assert.equal(item.resource.data.sessionId, requestId); assert.equal(item.resource.data.baseSha, 'c'.repeat(40)); assert.equal(item.resource.data.phase, undefined);
    assert.equal(item.node.summary, 'Reviewing changes'); assert.equal(item.links.length, 1); assert.equal((await f.control.read()).nodes.length, 3);
  } finally { hold.release(); await reviews.close(); f.close(); }
});

test('a review loop round is linked from the previous round, titled with its round and told about earlier rounds', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const first = await reviews.run('pr', 'claude', { requestId: randomUUID(), model: 'opus' });
    f.records.get(first.session.id)!.state = 'exited'; f.head = 'd'.repeat(40);
    const requestId = randomUUID(), second = await reviews.run('pr', 'claude', { requestId, model: 'opus', loop: { round: 2, from: first.session.nodeId, context: 'This is round 2 of 3 of a review loop on this pull request.' } });
    const items = await reviewItems(f), item = items.find(entry => entry.node.id === second.session.nodeId)!;
    assert.deepEqual(item.links.map(link => [link.sourceId, link.kind, link.label]), [[first.session.nodeId, 'reference', 'Round 2']]);
    assert.equal(item.resource.title, 'Claude review · #42 · round 2');
    assert.equal(item.resource.data.sourcePrId, 'pr');
    const previous = items.find(entry => entry.node.id === first.session.nodeId)!;
    assert.equal(item.node.position.x, previous.node.position.x + 280);
    assert.match(readFileSync(join(f.directory, requestId, `review-${requestId}.md`), 'utf8'), /This is round 2 of 3 of a review loop/);
    await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID(), loop: { round: 2, from: 'missing' } }), /previous round/);
  } finally { await reviews.close(); f.close(); }
});

test('a repeated trigger while preparing reveals the same early item', async () => {
  const f = await fixture(), reviews = f.coordinator();
  const hold = holdCapture(f);
  try {
    const pending: Promise<unknown>[] = [], track = (work: () => Promise<unknown>) => { const promise = work(); pending.push(promise); return promise; };
    const first = randomUUID(), second = randomUUID();
    reviews.start('pr', 'codex', { requestId: first }, track); await hold.ready;
    reviews.start('pr', 'codex', { requestId: second }, track);
    const early = reviews.status('pr', first)[0].nodeId!; assert.ok(early);
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reviews.status('pr', second)[0].nodeId, early);
    hold.release(); await Promise.all(pending);
    assert.equal((await reviewItems(f)).length, 1); assert.equal(f.launchCount, 1);
  } finally { hold.release(); await reviews.close(); f.close(); }
});

test('recovery after a restart mid-preparation reuses the early item', async () => {
  const f = await fixture(); let reviews = f.coordinator();
  const hold = holdCapture(f);
  try {
    const pending = reviews.run('pr', 'claude', { requestId: randomUUID() }); const rejection = assert.rejects(pending, /abort/i);
    await hold.ready; const [early] = await reviewItems(f); const closing = reviews.close(); hold.release(); await rejection; await closing;
    f.block = undefined; reviews = f.coordinator(); await reviews.recover();
    const items = await reviewItems(f); assert.equal(items.length, 1); assert.equal(items[0].node.id, early.node.id); assert.equal(items[0].links.length, 1);
    assert.equal(f.launchCount, 1); assert.equal(typeof items[0].resource.data.sessionId, 'string');
  } finally { hold.release(); await reviews.close(); f.close(); }
});

test('a failed preparation shows its error on the item and Retry restarts it on the same item', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    f.failure = 'git fetch failed'; await assert.rejects(reviews.run('pr', 'claude', { requestId: randomUUID() }), /git fetch failed/);
    const [failed] = await reviewItems(f);
    assert.equal(failed.resource.data.phase, 'failed'); assert.equal(failed.resource.data.error, 'git fetch failed');
    assert.equal(failed.node.attention, 'error'); assert.equal(failed.node.attentionNote, 'Review setup failed'); assert.match(failed.node.summary ?? '', /git fetch failed/); assert.equal(f.launchCount, 0);
    f.failure = ''; const pending: Promise<unknown>[] = [], requestId = randomUUID();
    await reviews.retry(failed.node.id, { requestId }, work => { const promise = work(); pending.push(promise); return promise; });
    await Promise.all(pending);
    const items = await reviewItems(f); assert.equal(items.length, 1); assert.equal(items[0].node.id, failed.node.id); assert.equal(items[0].links.length, 1);
    assert.equal(items[0].resource.data.sessionId, requestId); assert.equal(items[0].resource.data.phase, undefined); assert.equal(items[0].node.attention, 'none');
    assert.equal(f.launchCount, 1); assert.equal(reviews.status('pr', requestId)[0].nodeId, failed.node.id);
    await assert.rejects(reviews.retry(failed.node.id, { requestId: randomUUID() }, work => work()), /not waiting for a retry/);
  } finally { await reviews.close(); f.close(); }
});

test('a finished review shown as text can be retried as findings on the same item; structured ones cannot', async () => {
  const f = await fixture(), reviews = f.coordinator();
  try {
    const first = await reviews.run('pr', 'claude', { requestId: randomUUID() });
    await assert.rejects(reviews.retry(first.session.nodeId, { requestId: randomUUID() }, work => work()), /not waiting for a retry/);
    f.records.set(first.session.id, { ...f.records.get(first.session.id)!, state: 'exited', exitCode: 0 });
    const [item] = await reviewItems(f), state = await f.control.read();
    const mark = (format: string) => f.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'fixture' }, commands: [
      { type: 'item.update', id: item.node.id, data: { ...item.resource.data, findings: { sessionId: first.session.id, format } } }, { type: 'node.update', id: item.node.id, activity: 'complete' }] });
    await mark('findings');
    await assert.rejects(reviews.retry(item.node.id, { requestId: randomUUID() }, work => work()), /not waiting for a retry/);
    const current = await f.control.read(); await f.control.dispatch({ commandId: randomUUID(), expectedRevision: current.revision, actor: { kind: 'system', id: 'fixture' }, commands: [
      { type: 'item.update', id: item.node.id, data: { ...item.resource.data, findings: { sessionId: first.session.id, format: 'text' } } }] });
    const pending: Promise<unknown>[] = [], requestId = randomUUID();
    await reviews.retry(item.node.id, { requestId }, work => { const promise = work(); pending.push(promise); return promise; });
    await Promise.all(pending);
    const [retried] = await reviewItems(f);
    assert.equal(retried.node.id, item.node.id); assert.equal(retried.resource.data.sessionId, requestId); assert.equal(retried.resource.data.findings, undefined); assert.equal(f.launchCount, 2);
  } finally { await reviews.close(); f.close(); }
});

test('archiving or deleting the preparing item stops the review without launching', async () => {
  const f = await fixture(), reviews = f.coordinator();
  const hold = holdCapture(f);
  try {
    const requestId = randomUUID(), pending = reviews.run('pr', 'codex', { requestId }); const rejection = assert.rejects(pending, /removed/);
    await hold.ready; const [early] = await reviewItems(f); let state = await f.control.read();
    await f.control.dispatch({ commandId: 'archive-review', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.archive', id: early.node.id }] });
    state = await f.control.read();
    await f.control.dispatch({ commandId: 'delete-review', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.delete', id: early.node.id }] });
    hold.release(); await rejection;
    assert.equal(f.launchCount, 0); assert.equal((await reviewItems(f)).length, 0); assert.equal(reviews.status('pr', requestId)[0].state, 'cancelled');
    await reviews.close(); const restarted = f.coordinator(); await restarted.recover(); assert.equal(f.launchCount, 0); assert.equal((await reviewItems(f)).length, 0); await restarted.close();
  } finally { hold.release(); await reviews.close(); f.close(); }
});
