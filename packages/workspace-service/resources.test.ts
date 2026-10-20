import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { resourceCreateSchema } from '../core/resource-creation.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { ResourceSnapshot } from '../../src/resource-plugins/types.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';

const request = (projectId?: string): ResourceCreate => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'github.pull-request', title: 'URL lookup', data: { url: 'https://github.com/fixture/billing/pull/42' }, projectId, position: { x: 300, y: 50 } });
async function fixture(run: (input: { store: SqliteStore; control: WorkspaceControl; providers: ReturnType<typeof githubFixture>; coordinator: ResourceCoordinator; restart(): void; advance(ms: number): void; apply(commands: WorkspaceCommand[]): Promise<void> }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-resources-')), file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store), providers = githubFixture(), now = Date.now();
  let coordinator = new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => {}, () => now);
  const input = { get store() { return store; }, get control() { return control; }, providers, get coordinator() { return coordinator; },
    restart() { store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store); coordinator = new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => {}, () => now); },
    advance(ms: number) { now += ms; }, async apply(commands: WorkspaceCommand[]) { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands }); } };
  try { await run(input); } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('URL attachment reuses an MCP item, preserves lifecycle/layout/links and creates only cross-project aliases', () => fixture(async input => {
  await input.apply([{ type: 'project.create', id: 'project', title: 'Billing', summary: '', position: { x: 0, y: 0 } }, { type: 'item.add', id: 'existing', resourceId: 'pr', pluginId: 'github.pull-request', title: 'Old title', projectId: 'project', position: { x: 50, y: 80 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }, { type: 'node.complete', id: 'existing' }, { type: 'node.update', id: 'existing', attention: 'review' }, { type: 'link.save', link: { id: 'reference', sourceId: 'existing', targetId: 'project', kind: 'reference', label: '' } }]);
  const before = await input.control.read(), original = before.nodes.find(node => node.id === 'existing')!, first = request('project');
  const result = await input.coordinator.attach(first); assert.deepEqual(result, { nodeId: 'existing', resourceId: 'pr' });
  const state = await input.control.read(); assert.equal(state.resources.length, 1); assert.equal(state.nodes.length, 2);
  const saved = state.nodes.find(node => node.id === 'existing')!;
  assert.equal(saved.title, input.providers.pull.title); assert.equal(saved.completedAt, original.completedAt); assert.equal(saved.attention, 'review'); assert.deepEqual(saved.position, original.position); assert.deepEqual(state.links, before.links);
  assert.equal(state.resources[0].connectionId, 'github-fixture');
  assert.deepEqual(await input.coordinator.attach(first), result); assert.equal((await input.control.read()).revision, state.revision);
  await assert.rejects(input.coordinator.attach({ ...first, data: { url: 'https://github.com/fixture/billing/pull/43' } }), /command ID|Command ID/i);
  await input.coordinator.attach(request()); assert.equal((await input.control.read()).resources.length, 1); assert.equal((await input.control.read()).nodes.length, 3);
  input.restart(); assert.deepEqual(await input.coordinator.attach(first), result); assert.equal((await input.control.read()).nodes.length, 3);
}));

test('URL attachment saves every requested connection with the item in one revision, or nothing at all', () => fixture(async input => {
  const note = (id: string): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, position: { x: 900, y: 400 } });
  await input.apply([note('one'), note('two'), note('three')]);
  const before = await input.control.read(), ids = [randomUUID(), randomUUID(), randomUUID()];
  const invalid = resourceCreateSchema.parse({ ...request(), expectedRevision: before.revision, connections: [{ id: ids[0], otherId: 'one', kind: 'reference', sourceIsNew: true }, { id: ids[1], otherId: 'missing', kind: 'reference', sourceIsNew: true }] });
  await assert.rejects(input.coordinator.attach(invalid), /Both endpoints must exist/);
  assert.deepEqual(await input.control.read(), before);
  const first = resourceCreateSchema.parse({ ...request(), expectedRevision: before.revision, connection: { id: ids[0], otherId: 'one', kind: 'reference', sourceIsNew: true },
    connections: [{ id: ids[1], otherId: 'two', kind: 'reference', sourceIsNew: false }, { id: ids[2], otherId: 'three', kind: 'reference', sourceIsNew: true }] });
  const result = await input.coordinator.attach(first) as { nodeId: string }, state = await input.control.read();
  assert.equal(state.revision, before.revision + 1);
  assert.deepEqual(state.links.map(link => [link.id, link.sourceId, link.targetId]), [[ids[0], result.nodeId, 'one'], [ids[1], 'two', result.nodeId], [ids[2], result.nodeId, 'three']]);
  assert.deepEqual(await input.coordinator.attach(first), result); assert.equal((await input.control.read()).revision, state.revision);
  // The same URL again, as a new request: the item is reused and a connection it already has is kept, not refused.
  const again = resourceCreateSchema.parse({ ...request(), expectedRevision: state.revision, connections: [{ id: randomUUID(), otherId: 'one', kind: 'reference', sourceIsNew: false }] });
  assert.deepEqual(await input.coordinator.attach(again), result);
  assert.deepEqual((await input.control.read()).links, state.links);
  const connection = (otherId = 'one') => ({ id: randomUUID(), otherId, kind: 'reference', sourceIsNew: true });
  assert.equal(resourceCreateSchema.safeParse({ ...request(), connections: Array.from({ length: 9 }, () => connection()) }).success, false, 'at most eight connections');
  assert.equal(resourceCreateSchema.safeParse({ ...request(), connection: connection(), connections: Array.from({ length: 8 }, () => connection()) }).success, false, 'the single connection counts');
  assert.equal(resourceCreateSchema.safeParse({ ...request(), connections: [{ ...connection(), id: ids[0] }, { ...connection('two'), id: ids[0] }] }).success, false, 'connection ids are distinct');
}));

test('provider snapshots and comparison files survive restart with explicit stale errors and durable rate-limit backoff', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first);
  const files = await input.coordinator.content(first.nodeId, 'files', { head: input.providers.pull.head.sha, base: input.providers.pull.base.sha });
  assert.equal((files as any).content.files[0].filename, 'src/billing/plans.ts');
  const calls = input.providers.requests; input.restart();
  assert.equal((await input.coordinator.read(first.nodeId) as ResourceSnapshot).title, input.providers.pull.title); assert.equal(input.providers.requests, calls);
  input.providers.fail(429, { 'retry-after': '3600' }); input.advance(70_000);
  const stale = await input.coordinator.read(first.nodeId) as ResourceSnapshot; assert.equal(stale.stale, true); assert.match(stale.error!, /rate limit/);
  const failedCalls = input.providers.requests; input.restart(); await input.coordinator.read(first.nodeId, true); assert.equal(input.providers.requests, failedCalls);
  const staleFiles = await input.coordinator.content(first.nodeId, 'files', { head: input.providers.pull.head.sha, base: input.providers.pull.base.sha });
  assert.equal((staleFiles as any).stale, true); assert.equal((staleFiles as any).content.files.length, 1);
  input.providers.accounts[0].enabled = false; await assert.rejects(input.coordinator.read(first.nodeId), /Connect GitHub/);
}));

test('PR refresh keeps done/attention state and rejects files from a changed or incomplete comparison', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first); await input.apply([{ type: 'node.complete', id: first.nodeId }, { type: 'node.update', id: first.nodeId, attention: 'input' }]);
  const original = (await input.control.read()).nodes[0], head = input.providers.pull.head.sha;
  input.providers.pull = { ...input.providers.pull, title: 'Renamed on GitHub', state: 'closed', head: { ...input.providers.pull.head, sha: 'c'.repeat(40) } };
  await input.coordinator.read(first.nodeId, true);
  const updated = (await input.control.read()).nodes[0]; assert.equal(updated.title, 'Renamed on GitHub'); assert.equal(updated.completedAt, original.completedAt); assert.equal(updated.attention, 'input'); assert.deepEqual(updated.position, original.position);
  await assert.rejects(input.coordinator.content(first.nodeId, 'files', { head, base: input.providers.pull.base.sha }), /comparison changed/);
  input.providers.pull.changed_files = 2;
  await assert.rejects(input.coordinator.content(first.nodeId, 'files', { head: input.providers.pull.head.sha, base: input.providers.pull.base.sha }), /incomplete file list/);
}));

test('failed URL lookups create no item and safe retry survives a simulated graph-commit interruption', () => fixture(async input => {
  const first = request(); input.providers.fail(401);
  await assert.rejects(input.coordinator.attach(first), /sign-in expired/); assert.equal((await input.control.read()).nodes.length, 0);
  input.providers.fail(200); await input.coordinator.attach(first);
  // Crash after atomic graph receipt but before the job completion checkpoint.
  const job = input.store.listJobs()[0];
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(input.store.file); db.prepare("UPDATE jobs SET state='running', result=NULL WHERE id=?").run(job.id); db.close();
  // Reopen directly because the test deliberately closed the current handle.
  const store = new SqliteStore(input.store.file), control = new WorkspaceControl(store); store.recoverInterruptedJobs();
  const recovered = new ResourceCoordinator(store, control, input.providers.host(control.registry), input.providers.connections, async () => {});
  try { await recovered.attach(first); assert.equal((await control.read()).nodes.length, 1); } finally { await recovered.close(); store.close(); }
}));

test('shutdown cancels provider lookup before graph creation', () => fixture(async input => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  input.providers.delay(signal => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const pending = input.coordinator.attach(request()); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; await input.coordinator.close(); await rejected;
  assert.equal((await input.control.read()).nodes.length, 0);
  assert.equal(input.store.listJobs()[0].state, 'outcome-unknown');
  input.providers.delay(undefined); input.restart(); await input.coordinator.recover();
  assert.equal((await input.control.read()).nodes.length, 1);
}));

test('agent context can bind previously registered PRs without opening their views', () => fixture(async input => {
  await input.apply([{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'Registered by agent', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }]);
  const [one, two] = await Promise.all([input.coordinator.context('pr', AbortSignal.timeout(1000)), input.coordinator.context('pr', AbortSignal.timeout(1000))]);
  assert.deepEqual(one, two); assert.equal(one.title, input.providers.pull.title); assert.match(one.content, /next billing cycle/);
  assert.equal((await input.control.read()).resources[0].connectionId, 'github-fixture');
}));

// These exercise the same backend tick used by the timer with a deterministic
// clock, real persisted workspace state and fixture-only GitHub reads.
test('background PR polling deduplicates aliases, persists approval unread cycles and preserves independent reasons', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first);
  await input.apply([{ type: 'project.create', id: 'other', title: 'Other project', position: { x: 800, y: 0 }, summary: '' }]);
  await input.coordinator.attach(request('other'));
  const approval = { ...input.providers.reviewEntries[0], state: 'APPROVED' };
  input.providers.reviewEntries = [approval]; input.providers.inline = [{ ...input.providers.comments[0], id: 99 }];
  await input.apply([{ type: 'attention.set', id: first.nodeId, source: 'github.assignment', reason: 'assigned' }, { type: 'node.complete', id: first.nodeId }]);
  input.advance(61_000); const calls = input.providers.requests;
  await input.coordinator.poll();
  let nodes = (await input.control.read()).nodes.filter(node => node.resourceId);
  assert.equal(input.providers.requests - calls, 5, 'one complete observation across both aliases');
  assert.ok(nodes.every(node => node.summary === 'Approved · 2 comments' && node.attentionSources?.['provider:github.pull-request'] === 'approved'));
  assert.ok(nodes.every(node => node.attentionNotes?.['provider:github.pull-request'] === 'PR approved'));
  assert.equal(nodes[0].attentionSources?.['github.assignment'], 'assigned'); assert.ok(nodes[0].completedAt);
  await input.apply([{ type: 'attention.acknowledge', id: first.nodeId, versions: Object.fromEntries(nodes.map(node => [node.id, node.attentionVersion!])) }]);
  input.restart(); input.advance(61_000); await input.coordinator.poll();
  nodes = (await input.control.read()).nodes.filter(node => node.resourceId);
  assert.ok(nodes.every(node => node.attentionSeenVersion === node.attentionVersion));
  input.providers.reviewEntries = [{ ...approval, state: 'DISMISSED' }]; input.advance(61_000); await input.coordinator.poll();
  assert.equal((await input.control.read()).nodes[0].attentionSources?.['provider:github.pull-request'], undefined);
  input.providers.reviewEntries = [{ ...approval, id: 100 }]; input.advance(61_000); await input.coordinator.poll();
  nodes = (await input.control.read()).nodes.filter(node => node.resourceId);
  assert.ok(nodes.every(node => node.attentionSeenVersion !== node.attentionVersion));
  input.providers.queue = { queued: true, position: 1 }; input.advance(61_000); await input.coordinator.poll();
  nodes = (await input.control.read()).nodes.filter(node => node.resourceId);
  assert.ok(nodes.every(node => node.summary.startsWith('Queued') && !node.attentionSources?.['provider:github.pull-request']));
  input.providers.queue = { queued: false, position: null }; input.advance(61_000); await input.coordinator.poll();
  nodes = (await input.control.read()).nodes.filter(node => node.resourceId);
  assert.ok(nodes.every(node => node.attentionSources?.['provider:github.pull-request'] === 'approved' && node.attentionSeenVersion !== node.attentionVersion));
  input.providers.pull = { ...input.providers.pull, merged: true, state: 'closed' }; input.advance(61_000); await input.coordinator.poll();
  nodes = (await input.control.read()).nodes.filter(node => node.resourceId);
  assert.ok(nodes.every(node => node.summary.startsWith('Merged') && !node.attentionSources?.['provider:github.pull-request']));
  assert.equal(nodes[0].attentionSources?.['github.assignment'], 'assigned');
}));

test('background observations stop at archive/account/lifecycle gates and do not commit a paused read', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first); input.advance(61_000);
  await input.apply([{ type: 'node.archive', id: first.nodeId }]); const calls = input.providers.requests;
  await input.coordinator.poll(); assert.equal(input.providers.requests, calls);
  await input.apply([{ type: 'node.restore', id: first.nodeId }]); input.providers.accounts[0].enabled = false;
  await input.coordinator.poll(); assert.equal(input.providers.requests, calls);
  input.providers.accounts[0].enabled = true;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  input.providers.delay(signal => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const before = await input.control.read(); const pending = input.coordinator.poll(); await ready;
  await input.coordinator.pause(); await pending; assert.deepEqual(await input.control.read(), before);
  input.providers.delay(undefined); input.restart();
  const gated = new ResourceCoordinator(input.store, input.control, input.providers.host(input.control.registry), input.providers.connections, async () => {}, Date.now, () => false);
  const after = input.providers.requests; try { await gated.poll(); assert.equal(input.providers.requests, after); } finally { await gated.close(); }
}));

test('failing head checks raise Needs me once per head commit within the existing reads and clear when checks pass', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first);
  const source = 'provider:github.pull-request', node = async () => (await input.control.read()).nodes.find(item => item.id === first.nodeId)!;
  input.providers.checks = [{ name: 'unit', conclusion: 'FAILURE' }, { name: 'lint', conclusion: 'SUCCESS' }];
  input.advance(61_000); let calls = input.providers.requests; await input.coordinator.poll();
  assert.equal(input.providers.requests - calls, 5, 'checks arrive with the queue read, never as extra requests');
  let saved = await node();
  assert.equal(saved.attentionSources?.[source], 'checks-failing'); assert.equal(saved.attentionEvents?.[source], `checks-failing:${input.providers.pull.head.sha}`);
  assert.equal(saved.indicators?.[0].label, 'Checks failing'); assert.equal(saved.indicators?.[0].stage, 'failing');
  await input.apply([{ type: 'attention.acknowledge', id: first.nodeId, versions: { [first.nodeId]: saved.attentionVersion! } }]);
  input.advance(61_000); calls = input.providers.requests; await input.coordinator.poll();
  assert.equal(input.providers.requests - calls, 5); saved = await node();
  assert.equal(saved.attentionSeenVersion, saved.attentionVersion, 'unchanged failing head stays seen');
  input.providers.pull = { ...input.providers.pull, head: { ...input.providers.pull.head, sha: 'd'.repeat(40) } }; input.advance(61_000); await input.coordinator.poll();
  saved = await node();
  assert.equal(saved.attentionSources?.[source], 'checks-failing'); assert.notEqual(saved.attentionSeenVersion, saved.attentionVersion, 'a new failing head is unread again');
  input.providers.checks = [{ name: 'unit', conclusion: 'SUCCESS' }]; input.advance(61_000); await input.coordinator.poll();
  saved = await node();
  assert.equal(saved.attentionSources?.[source], undefined); assert.equal(saved.indicators?.[0].label, 'Open');
  input.providers.pull = { ...input.providers.pull, state: 'closed', merged: true }; input.providers.checks = [{ name: 'unit', conclusion: 'FAILURE' }];
  input.advance(61_000); calls = input.providers.requests; await input.coordinator.poll();
  assert.equal(input.providers.requests - calls, 4, 'merged pull requests skip the queue and checks read');
  assert.equal((await node()).attentionSources?.[source], undefined);
}));

test('background failures preserve approval and content, expose stale status and honor durable backoff', () => fixture(async input => {
  input.providers.reviewEntries[0].state = 'APPROVED';
  const first = request(); await input.coordinator.attach(first);
  const before = (await input.control.read()).nodes[0];
  input.providers.fail(429, { 'retry-after': '3600' }); input.advance(61_000); await input.coordinator.poll();
  let after = (await input.control.read()).nodes[0];
  assert.equal(after.attentionVersion, before.attentionVersion); assert.equal(after.summary, before.summary);
  assert.ok(after.indicators?.some(cue => cue.id === 'connection'));
  const calls = input.providers.requests; input.restart(); input.advance(61_000); await input.coordinator.poll();
  assert.equal(input.providers.requests, calls);
  input.providers.fail(200); input.advance(3_600_000); await input.coordinator.poll();
  after = (await input.control.read()).nodes[0]; assert.equal(after.attentionVersion, before.attentionVersion);
  assert.ok(!after.indicators?.some(cue => cue.id === 'connection'));
}));

test('background reads and simultaneous explicit refresh share one provider observation', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first); input.advance(61_000);
  const calls = input.providers.requests; let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  input.providers.delay(async () => { entered(); await gate; });
  const polling = input.coordinator.poll(); await ready;
  const refreshing = input.coordinator.read(first.nodeId, true); release();
  await Promise.all([polling, refreshing]); assert.equal(input.providers.requests - calls, 5);
}));

test('start polls without an open view and pause cancels a background tick joined to a manual refresh', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first); input.advance(61_000);
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  input.providers.delay(signal => new Promise((_resolve, reject) => { entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const manual = input.coordinator.read(first.nodeId, true), rejected = assert.rejects(manual, { name: 'AbortError' });
  await ready; input.coordinator.start(); await input.coordinator.pause(); await rejected;
  input.providers.delay(undefined); input.providers.reviewEntries[0].state = 'APPROVED';
  input.coordinator.start(); await input.coordinator.poll();
  assert.equal((await input.control.read()).nodes[0].attentionSources?.['provider:github.pull-request'], 'approved');
}));

test('saved previews survive expiration and restart without waiting for refresh or credentials', () => fixture(async input => {
  const first = request(); await input.coordinator.attach(first);
  input.advance(86_400_000); input.restart();
  const calls = input.providers.requests;
  input.providers.accounts[0].enabled = false;
  const saved = await input.coordinator.cached(first.nodeId);
  assert.equal(saved?.title, input.providers.pull.title);
  assert.equal(saved?.stale, true); assert.equal(saved?.attentionReceipt, undefined);
  assert.equal(input.providers.requests, calls);
  input.providers.accounts[0].enabled = true;
  let start!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  input.providers.delay(async () => { start(); await gate; });
  const reading = input.coordinator.read(first.nodeId);
  try {
    await entered;
    const preview = await Promise.race([input.coordinator.cached(first.nodeId), new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Saved content waited for the provider')), 500); timer.unref();
    })]);
    assert.equal(preview?.title, saved?.title);
    assert.deepEqual(preview?.detail, saved?.detail);
  } finally { release(); await reading; }
  // Changing the PR identity must never reuse the old content.
  await input.apply([{ type: 'item.resolve', id: first.nodeId, data: { owner: 'fixture', repo: 'billing', number: 43 } }]);
  assert.equal(await input.coordinator.cached(first.nodeId), null);
  assert.equal(await input.coordinator.cached('missing'), null);
}));

test('background polling pauses for items below the map and resumes when they return', () => fixture(async input => {
  const first = request(); const { nodeId } = await input.coordinator.attach(first) as { nodeId: string };
  await input.apply([{ type: 'node.below', id: nodeId }]);
  input.advance(61_000); let calls = input.providers.requests; await input.coordinator.poll();
  assert.equal(input.providers.requests, calls, 'no provider reads while below');
  await input.apply([{ type: 'node.surface', id: nodeId }]);
  input.advance(61_000); calls = input.providers.requests; await input.coordinator.poll();
  assert.ok(input.providers.requests > calls);
}));

test('new pull request comments enter Needs me once; seeing some never re-alerts and seeing all clears it', () => fixture(async input => {
  const { commentReceiptFingerprint, commentDigest } = await import('../../src/resource-plugins/items/github-pull-request/presentation.ts');
  const { commentKey } = await import('../../src/resource-plugins/items/github-pull-request/comment-state.ts');
  const first = request(); const { nodeId } = await input.coordinator.attach(first) as { nodeId: string };
  const node = async () => (await input.control.read()).nodes.find(candidate => candidate.id === nodeId)!;
  input.advance(61_000); await input.coordinator.poll();
  assert.equal((await node()).attentionSources?.['pr.comments'], undefined, 'existing comments at attach time never alert');
  input.providers.comments = [...input.providers.comments, { id: 6, body: 'Please also cover annual plans.', user: { login: 'fixture-reviewer' }, created_at: '2026-09-29', updated_at: '2026-09-29' }, { id: 7, body: 'And coupons.', user: { login: 'fixture-reviewer' }, created_at: '2026-09-29', updated_at: '2026-09-29' }];
  input.advance(61_000); await input.coordinator.poll();
  let current = await node();
  assert.equal(current.attentionSources?.['pr.comments'], 'comment'); assert.notEqual(current.attentionSeenVersion, current.attentionVersion);
  assert.equal(current.attentionNotes?.['pr.comments'], '2 new comments');
  const version = current.attentionVersion;
  input.advance(61_000); await input.coordinator.poll();
  assert.equal((await node()).attentionVersion, version, 'unchanged polls do not re-alert');
  const state = await input.control.read(), resource = state.resources.find(record => record.id === current.resourceId)!;
  const discussion = (await input.coordinator.read(nodeId)).detail!.discussion as any[];
  const receipt = (ids: number[]) => Object.fromEntries(discussion.filter(comment => ids.includes(comment.id)).map(comment => [commentKey(comment), commentDigest(comment)]));
  const seen = (ids: number[]) => input.store.cacheResource(resource.id, 'comment-seen', commentReceiptFingerprint(resource), receipt(ids), Date.now());
  seen([5, 6]); await input.coordinator.refreshPresentation(nodeId);
  current = await node(); assert.equal(current.attentionSources?.['pr.comments'], 'comment'); assert.equal(current.attentionVersion, version, 'seeing some never re-alerts');
  seen([5, 6, 7]); await input.coordinator.refreshPresentation(nodeId);
  assert.equal((await node()).attentionSources?.['pr.comments'], undefined, 'seeing all clears it');
}));

test('my own pull request comments never enter Needs me or the unseen count', () => fixture(async input => {
  const first = request(); const { nodeId } = await input.coordinator.attach(first) as { nodeId: string };
  const node = async () => (await input.control.read()).nodes.find(candidate => candidate.id === nodeId)!;
  input.advance(61_000); await input.coordinator.poll();
  const unseen = (value: Awaited<ReturnType<typeof node>>) => (value.indicators ?? []).find(cue => cue.id === 'comments')?.label;
  const before = unseen(await node());
  input.providers.comments = [...input.providers.comments, { id: 8, body: 'Pushed a fix.', user: { login: 'fixture-developer' }, created_at: '2026-09-29', updated_at: '2026-09-29' }];
  input.advance(61_000); await input.coordinator.poll();
  let current = await node();
  assert.equal(current.attentionSources?.['pr.comments'], undefined, 'my own comment does not notify me');
  assert.equal(unseen(current), before, 'my own comment is not counted as unseen');
  input.providers.comments = [...input.providers.comments, { id: 9, body: 'Looks good.', user: { login: 'fixture-reviewer' }, created_at: '2026-09-29', updated_at: '2026-09-29' }];
  input.advance(61_000); await input.coordinator.poll();
  current = await node();
  assert.equal(current.attentionNotes?.['pr.comments'], '1 new comment', 'others still notify');
}));
