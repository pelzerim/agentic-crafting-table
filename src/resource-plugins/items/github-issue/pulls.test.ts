import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore } from '../../../../packages/core/control.ts';
import type { ResourceCreate } from '../../../../packages/core/resource-creation.ts';
import { GitHubIssuePulls } from './pulls.ts';

async function fixture(pulls: unknown, fail: (request: ResourceCreate) => string | undefined = () => undefined) {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'project.create', id: 'web', title: 'Web', position: { x: 0, y: 0 } }, 0);
  await control.apply({ type: 'item.add', id: 'issue', resourceId: 'issue-r', pluginId: 'github.issue', title: 'Search ignores accents', projectId: 'web', position: { x: 300, y: 200 }, data: { owner: 'acme', repo: 'web', number: 7 } }, 1);
  const attached: ResourceCreate[] = [], reads: string[] = [];
  const resources = {
    async execute(nodeId: string, actionId: string) { reads.push(`${nodeId}:${actionId}`); return { pulls }; },
    async attach(request: ResourceCreate) { attached.push(request); const failure = fail(request); if (failure) throw new Error(failure); return { nodeId: request.nodeId }; },
  };
  return { pulls: new GitHubIssuePulls(control, resources as never), attached, reads };
}
const requestId = '9b1f7e2c-3d4a-4b5c-8d6e-7f8091a2b3c4', signal = () => new AbortController().signal;

test('Add linked pull requests reads them from GitHub and attaches each beside the issue, in its project, linked from it', async () => {
  const f = await fixture([{ owner: 'acme', repo: 'web', number: 12 }, { owner: 'acme', repo: 'api', number: 3 }]);
  assert.deepEqual(await f.pulls.run('issue', { operation: 'options' }, signal()), { pulls: 2 });
  const result = await f.pulls.run('issue', { operation: 'add', requestId }, signal()) as { added: number; nodeId: string };
  assert.equal(result.added, 2);
  assert.deepEqual(f.reads, ['issue:issue.pulls', 'issue:issue.pulls'], 'each run reads the current links');
  assert.deepEqual(f.attached.map(request => [request.pluginId, request.data.url, request.projectId, request.placedBy]), [
    ['github.pull-request', 'https://github.com/acme/web/pull/12', 'web', 'issue'], ['github.pull-request', 'https://github.com/acme/api/pull/3', 'web', 'issue']]);
  assert.deepEqual(f.attached.map(request => request.connections), f.attached.map(request => [{ id: request.connections![0].id, otherId: 'issue', kind: 'reference', sourceIsNew: false }]));
  assert.equal(result.nodeId, f.attached[0].nodeId);
  await f.pulls.run('issue', { operation: 'add', requestId }, signal());
  assert.deepEqual(f.attached.slice(2).map(request => request.requestId), f.attached.slice(0, 2).map(request => request.requestId), 'a repeated click replays the same requests');
});

test('an issue without linked pull requests says so; one that cannot load is reported while the rest are added', async () => {
  const none = await fixture([]);
  await assert.rejects(none.pulls.run('issue', { operation: 'add', requestId }, signal()), /GitHub links no pull requests to #7/);
  const some = await fixture([{ owner: 'acme', repo: 'web', number: 12 }, { owner: 'acme', repo: 'secret', number: 1 }], request => String(request.data.url).includes('secret') ? 'Not found' : undefined);
  assert.deepEqual(await some.pulls.run('issue', { operation: 'add', requestId }, signal()), { added: 1, nodeId: some.attached[0].nodeId, failed: ['acme/secret #1: Not found'] });
  await assert.rejects(none.pulls.run('issue', { operation: 'add', requestId: 'nope' }, signal()), /requestId/);
  await assert.rejects(none.pulls.run('missing', { operation: 'options' }, signal()), /Choose a GitHub issue/);
});
