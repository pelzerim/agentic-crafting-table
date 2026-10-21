import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore } from '../../../../packages/core/control.ts';
import type { ResourceCreate } from '../../../../packages/core/resource-creation.ts';
import { LinearPulls } from './pulls.ts';

async function fixture(pulls: unknown, fail: (request: ResourceCreate) => string | undefined = () => undefined) {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'project.create', id: 'web', title: 'Web', position: { x: 0, y: 0 } }, 0);
  await control.apply({ type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'BIL-128 · Plan changes', projectId: 'web', position: { x: 300, y: 200 }, data: { issueId: 'BIL-128' } }, 1);
  const attached: ResourceCreate[] = [];
  const resources = {
    async cached(nodeId: string) { return nodeId === 'ticket' ? { detail: { identifier: 'BIL-128', pulls } } : null; },
    async attach(request: ResourceCreate) { attached.push(request); const failure = fail(request); if (failure) throw new Error(failure); return { nodeId: request.nodeId }; },
  };
  return { pulls: new LinearPulls(control, resources as never), attached };
}
const requestId = '9b1f7e2c-3d4a-4b5c-8d6e-7f8091a2b3c4';

test('Add linked pull requests attaches each pull request Linear lists beside the ticket, in its project, linked from it', async () => {
  const f = await fixture([{ owner: 'acme', repo: 'app', number: 42 }, { owner: 'acme', repo: 'api', number: 7 }]);
  assert.deepEqual(await f.pulls.run('ticket', { operation: 'options' }), { pulls: 2 });
  const result = await f.pulls.run('ticket', { operation: 'add', requestId }) as { added: number; nodeId: string };
  assert.equal(result.added, 2);
  assert.deepEqual(f.attached.map(request => [request.pluginId, request.data.url, request.projectId, request.placedBy]), [
    ['github.pull-request', 'https://github.com/acme/app/pull/42', 'web', 'ticket'], ['github.pull-request', 'https://github.com/acme/api/pull/7', 'web', 'ticket']]);
  assert.deepEqual(f.attached.map(request => request.connections), f.attached.map(request => [{ id: request.connections![0].id, otherId: 'ticket', kind: 'reference', sourceIsNew: false }]));
  assert.equal(result.nodeId, f.attached[0].nodeId);
  assert.equal(f.attached[0].connectionId, undefined, 'the default GitHub account loads them');
  await f.pulls.run('ticket', { operation: 'add', requestId });
  assert.deepEqual(f.attached.slice(2).map(request => request.requestId), f.attached.slice(0, 2).map(request => request.requestId), 'a repeated click replays the same requests');
});

test('a ticket without linked pull requests says so; one that cannot load is reported while the rest are added', async () => {
  const none = await fixture([]);
  await assert.rejects(none.pulls.run('ticket', { operation: 'add', requestId }), /Linear lists no pull requests on BIL-128/);
  const some = await fixture([{ owner: 'acme', repo: 'app', number: 42 }, { owner: 'acme', repo: 'secret', number: 1 }], request => String(request.data.url).includes('secret') ? 'Not found' : undefined);
  assert.deepEqual(await some.pulls.run('ticket', { operation: 'add', requestId }), { added: 1, nodeId: some.attached[0].nodeId, failed: ['acme/secret #1: Not found'] });
  const all = await fixture([{ owner: 'acme', repo: 'secret', number: 1 }], () => 'Connect GitHub in Settings to load this item.');
  await assert.rejects(all.pulls.run('ticket', { operation: 'add', requestId }), /Connect GitHub/);
  await assert.rejects(none.pulls.run('ticket', { operation: 'add', requestId: 'nope' }), /requestId/);
});
