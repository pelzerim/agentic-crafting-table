import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { ResourceCoordinator } from './resources.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { prComments } from './pr-comments.ts';
import { OUTCOME_UNKNOWN } from './protocol.ts';
import { commentVersion } from '../../src/resource-plugins/items/github-pull-request/comment-state.ts';
import type { SessionCoordinator } from './sessions.ts';
async function fixture(run: (f: any) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'act-comments-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), providers = githubFixture();
  const resources = new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => {});
  const apply = async (commands: any[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  await apply([{ type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: 'PR', data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 0, y: 0 } }]);
  await resources.read('pr', true);
  const version = commentVersion(((await resources.read('pr')).detail!.discussion as any[])[0]);
  const args = { sourceResourceId: 'pull', kind: 'discussion', id: 5, version };
  try { await run({ store, control, providers, resources, apply, args, call: (args: any, sessions?: SessionCoordinator) => prComments(control, store, resources, sessions, 'pr', args) }); }
  finally { await resources.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
test('Seen receipts persist, are namespace-specific and invalidate when comment changes', () => fixture(async f => {
  await f.call({ ...f.args, operation: 'seen', seen: true });
  assert.equal((await f.call({ sourceResourceId: 'pull', operation: 'read' }))['discussion:5'], true);
  const reopened = new SqliteStore(f.store.file);
  try { assert.ok(reopened.resourceCache('pull', 'comment-seen', JSON.stringify(['github-fixture', 'fixture', 'billing', 42]))?.value); } finally { reopened.close(); }
  f.providers.comments[0].body = 'Changed issue'; await f.resources.read('pr', true);
  assert.equal((await f.call({ sourceResourceId: 'pull', operation: 'read' }))['discussion:5'], false);
  await assert.rejects(f.call({ ...f.args, operation: 'seen', seen: true }), /changed/);
  await assert.rejects(f.call({ ...f.args, sourceResourceId: 'different', operation: 'seen', seen: true }), /another/);
}));
test('reply writes are bound, journaled, and replaying a completed request posts once', () => fixture(async f => {
  const input = { sourceResourceId: 'pull', requestId: randomUUID(), kind: 'discussion', commentId: '5', body: 'Thanks, fixed.' };
  await f.resources.execute('pr', 'reply', input, AbortSignal.timeout(1000));
  await f.resources.execute('pr', 'reply', input, AbortSignal.timeout(1000));
  assert.equal(f.providers.posts.length, 1);
  await assert.rejects(f.resources.execute('pr', 'reply', { ...input, sourceResourceId: 'wrong' }, AbortSignal.timeout(1000)), /another item/);
}));
test('fix delivery requires an idle connected agent, uses frozen source and strips terminal controls', () => fixture(async f => {
  await f.apply([{ type: 'item.create', id: 'agent', resource: { id: 'agent-resource', pluginId: 'agent.session', schemaVersion: 1, title: 'Claude', data: { provider: 'claude', sessionId: 'session-fixture' } }, position: { x: 200, y: 0 } }, { type: 'node.update', id: 'agent', activity: 'idle' }, { type: 'link.save', link: { id: 'connection', sourceId: 'pr', targetId: 'agent', kind: 'context' } }]);
  f.providers.comments[0].body = 'Fix this \x1b[201~' + 'x'.repeat(70_000); await f.resources.read('pr', true);
  const found = (await f.resources.read('pr')).detail.discussion.find((c: any) => c.kind === 'discussion'); f.args.version = commentVersion(found);
  const inputs: string[] = [];
  const runtime = { runtime: { call: async (method: string, args: any) => { if (method === 'sessions.read') return { session: { state: 'running', nodeId: 'agent' } }; inputs.push(args.data); } } } as unknown as SessionCoordinator;
  const args = { ...f.args, operation: 'fix', requestId: randomUUID(), targetNodeId: 'agent', sessionId: 'session-fixture' };
  await f.call(args, runtime); await f.call(args, runtime);
  assert.equal(inputs.length, 2); assert.match(inputs[0], /pull\/42#issuecomment-5/); assert.match(inputs[0], /Fix this/); assert.ok(inputs[0].length < 65_536); assert.equal((inputs[0].match(/\x1b\[201~/g) ?? []).length, 1); assert.equal(inputs[1], '\r');
  await f.apply([{ type: 'node.update', id: 'agent', activity: 'working' }]);
  await assert.rejects(f.call({ ...args, requestId: randomUUID() }, runtime), /ready/);
  await f.apply([{ type: 'link.remove', id: 'connection' }]);
  await assert.rejects(f.call({ ...args, requestId: randomUUID() }, runtime), /connected/);
  assert.equal(inputs.length, 2);
}));

test('uncertain reply is journaled and retrying the same request does not post again', () => fixture(async f => {
  let writes = 0;
  f.providers.client.reply = async () => { writes++; throw Object.assign(new Error('Reply outcome unknown'), { outcomeUnknown: true }); };
  const input = { sourceResourceId: 'pull', requestId: randomUUID(), kind: 'discussion', commentId: '5', body: 'A reply' };
  await assert.rejects(f.resources.execute('pr', 'reply', input, AbortSignal.timeout(1000)), { message: /unknown/, code: OUTCOME_UNKNOWN });
  await assert.rejects(f.resources.execute('pr', 'reply', input, AbortSignal.timeout(1000)), { message: /could not be confirmed/, code: OUTCOME_UNKNOWN });
  assert.equal(writes, 1);
  assert.equal(f.store.listJobs().at(-1).state, 'outcome-unknown');
}));

test('a write cut off by its deadline rejects as unconfirmed; a refused one keeps its own error', () => fixture(async f => {
  const input = () => ({ sourceResourceId: 'pull', requestId: randomUUID(), kind: 'discussion', commentId: '5', body: 'A reply' });
  f.providers.client.reply = (...args: unknown[]) => new Promise((_resolve, reject) => { const signal = args.find(arg => arg instanceof AbortSignal)!; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  await assert.rejects(f.resources.execute('pr', 'reply', input(), AbortSignal.timeout(50)), { message: /timeout/, code: OUTCOME_UNKNOWN });
  assert.equal(f.store.listJobs().at(-1).state, 'outcome-unknown');
  f.providers.client.reply = async () => { throw Object.assign(new Error('GitHub declined the reply.'), { code: 'GITHUB_REJECTED' }); };
  await assert.rejects(f.resources.execute('pr', 'reply', input(), AbortSignal.timeout(1000)), { message: 'GitHub declined the reply.', code: 'GITHUB_REJECTED' });
  assert.equal(f.store.listJobs().at(-1).state, 'failed');
}));

test('map pills count filtered unseen comments across aliases, receipts, edits and cached restart reconciliation', () => fixture(async f => {
  await f.apply([{ type: 'item.create', id: 'alias', resource: (await f.control.read()).resources.find((r: any) => r.id === 'pull'), position: { x: 300, y: 0 } }]);
  const pills = async () => (await f.control.read()).nodes.filter((n: any) => n.resourceId === 'pull').map((n: any) => n.indicators?.find((c: any) => c.id === 'comments')?.label);
  await f.resources.refreshPresentation();
  assert.deepEqual(await pills(), ['2 unseen comments', '2 unseen comments']);
  const requests = f.providers.requests;
  const comments = (await f.resources.read('pr')).detail.discussion;
  for (const comment of comments) await f.call({ operation: 'seen', sourceResourceId: 'pull', kind: comment.kind, id: comment.id, version: commentVersion(comment), seen: true });
  assert.deepEqual(await pills(), [undefined, undefined]);
  assert.equal(f.providers.requests, requests);
  const revision = (await f.control.read()).revision;
  await f.resources.refreshPresentation(); assert.equal((await f.control.read()).revision, revision);
  await f.call({ ...f.args, operation: 'seen', seen: false });
  assert.deepEqual(await pills(), ['1 unseen comment', '1 unseen comment']);
  await f.call({ ...f.args, operation: 'seen', seen: true });
  f.providers.comments[0].body = 'Edited issue'; await f.resources.read('pr', true);
  assert.deepEqual(await pills(), ['1 unseen comment', '1 unseen comment']);
  f.providers.comments.push({ ...f.providers.comments[0], id: 8, user: { login: 'ci[bot]', type: 'Bot' } });
  await f.resources.read('pr', true); assert.deepEqual(await pills(), ['1 unseen comment', '1 unseen comment']);
  const settings = f.store.readSettings(); f.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, pullRequestConversation: { ...settings.value.pullRequestConversation, bots: true } } });
  const before = f.providers.requests; await f.resources.refreshPresentation();
  assert.deepEqual(await pills(), ['2 unseen comments', '2 unseen comments']); assert.equal(f.providers.requests, before);
  // Simulate an older saved map label; recovery repaints it using durable receipts.
  await f.apply([{ type: 'node.update', id: 'pr', indicators: [{ id: 'comments', label: '99 comments', icon: 'message-square', tone: 'blue' }] }]);
  await f.resources.recover(); assert.deepEqual(await pills(), ['2 unseen comments', '2 unseen comments']);
}));

test('seen-all marks every listed comment whose version still matches and leaves changed or unknown ones unseen', () => fixture(async f => {
  f.providers.comments.push({ id: 6, body: 'Second comment', user: { login: 'reviewer' }, created_at: '2026-09-28', updated_at: '2026-09-28' });
  await f.resources.read('pr', true);
  const discussion = (await f.resources.read('pr')).detail!.discussion as any[];
  const listed = discussion.map(comment => ({ kind: comment.kind, id: comment.id, version: commentVersion(comment) }));
  assert.ok(listed.length >= 2);
  f.providers.comments[0].body = 'Edited after the list was shown'; await f.resources.read('pr', true);
  const seen = await f.call({ sourceResourceId: 'pull', operation: 'seen-all', comments: [...listed, { kind: 'discussion', id: 999, version: 'x' }] });
  assert.equal(seen['discussion:5'], false, 'an edited comment stays unseen');
  assert.equal(seen['discussion:6'], true);
  assert.deepEqual(await f.call({ sourceResourceId: 'pull', operation: 'read' }), seen);
  await assert.rejects(f.call({ sourceResourceId: 'pull', operation: 'seen-all' }), /comments/i);
  await assert.rejects(f.call({ sourceResourceId: 'different', operation: 'seen-all', comments: listed }), /another/);
}));
