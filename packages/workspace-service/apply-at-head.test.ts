import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceControl } from '../core/control.ts';
import { revisionGuard } from '../core/revision-policy.ts';
import { applyAtHead, HEAD_ATTEMPTS } from './apply-at-head.ts';
import { SqliteStore } from './sqlite-store.ts';

const agent = { kind: 'agent' as const, id: 'agent' };
const project = (id: string) => ({ type: 'project.create' as const, id, title: id, position: { x: 0, y: 0 } });
const pullRequest = { type: 'item.add' as const, id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'Pull request', projectId: 'project', position: { x: 300, y: 0 }, data: { owner: 'acme', repo: 'app', number: 7 },
  links: [{ otherId: 'agent', kind: 'reference' as const }] };

/** A workspace with an agent, where every read is followed by `bumps` writes from someone else. */
async function racing(control: WorkspaceControl, bumps: number) {
  await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'seed' }, commands: [project('project'),
    { type: 'item.add', id: 'agent', resourceId: 'agent-resource', pluginId: 'workspace.note', projectId: 'project', position: { x: 0, y: 0 }, data: { text: 'agent' } }] });
  const read = control.read.bind(control); let left = bumps, reads = 0;
  control.read = async () => {
    const state = await read(); reads++;
    if (left > 0) { left--; await control.dispatch({ commandId: `bump:${left}`, expectedRevision: state.revision, actor: { kind: 'provider', id: 'poll' }, commands: [project(`bump-${left}`)] }); }
    return state;
  };
  return { reads: () => reads };
}

for (const [name, open] of [
  ['memory', async () => ({ control: new WorkspaceControl(), close: async () => {} })],
  ['sqlite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'act-apply-at-head-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
    return { control: new WorkspaceControl(store), close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
  }],
] as const) {
  test(`${name}: an item with links lands once while the revision moves underneath`, async () => {
    const { control, close } = await open();
    try {
      const race = await racing(control, 2);
      const result = await applyAtHead(control, { commandId: 'register-pr', actor: agent, commands: [pullRequest] }, revisionGuard);
      assert.equal(result.replayed, false);
      assert.equal(race.reads(), 3, 'two stale reads, then one that held');
      assert.equal(result.state.revision, 4, 'seed, two bumps, the item');
      assert.equal(result.state.nodes.filter(node => node.id === 'pr').length, 1);
      assert.deepEqual(result.state.links.map(link => [link.sourceId, link.targetId, link.kind]), [['pr', 'agent', 'reference']]);
      assert.equal(result.state.nodes.filter(node => node.id.startsWith('bump-')).length, 2, 'the concurrent writes are kept');
    } finally { await close(); }
  });

  test(`${name}: the same commandId replays after the map moved on, and never applies twice`, async () => {
    const { control, close } = await open();
    try {
      await racing(control, 0);
      const envelope = { commandId: 'register-pr', actor: agent, commands: [pullRequest] };
      const first = await applyAtHead(control, envelope, revisionGuard);
      await control.dispatch({ commandId: 'later', expectedRevision: first.state.revision, actor: { kind: 'user', id: 'user' }, commands: [project('later')] });
      const again = await applyAtHead(control, envelope, revisionGuard);
      assert.equal(again.replayed, true);
      assert.equal(again.state.revision, first.state.revision, 'the replay returns what the command produced');
      const now = await control.read();
      assert.equal(now.revision, first.state.revision + 1);
      assert.equal(now.nodes.filter(node => node.id === 'pr').length, 1);
      await assert.rejects(applyAtHead(control, { ...envelope, commands: [{ ...pullRequest, id: 'pr-2' }] }, revisionGuard), { code: 'COMMAND_ID_CONFLICT' });
    } finally { await close(); }
  });

  test(`${name}: a command that needs a revision is refused before anything is written`, async () => {
    const { control, close } = await open();
    try {
      await racing(control, 0);
      await assert.rejects(applyAtHead(control, { commandId: 'move', actor: agent, commands: [{ type: 'node.move', id: 'agent', position: { x: 5, y: 5 } }] }, revisionGuard),
        /^Error: node\.move needs expectedRevision: it overwrites positions the user may be changing\. Pass the revision from workspace_read\.$/);
      await assert.rejects(applyAtHead(control, { commandId: 'mixed', actor: agent, commands: [project('added'), { type: 'node.archive', id: 'agent' }] }, revisionGuard), /node\.archive needs expectedRevision/);
      const state = await control.read();
      assert.equal(state.revision, 1); assert.ok(!state.nodes.some(node => node.id === 'added'), 'a refused batch applies none of its members');
    } finally { await close(); }
  });

  test(`${name}: gives up with the conflict after ${HEAD_ATTEMPTS} attempts`, async () => {
    const { control, close } = await open();
    try {
      const race = await racing(control, 100);
      await assert.rejects(applyAtHead(control, { commandId: 'register-pr', actor: agent, commands: [pullRequest] }, revisionGuard), { code: 'REVISION_CONFLICT' });
      assert.equal(race.reads(), HEAD_ATTEMPTS);
      assert.ok(!(await control.store.read()).nodes.some(node => node.id === 'pr'));
    } finally { await close(); }
  });
}

test('a to-do that appears between the read and the write is not overwritten', async () => {
  const control = new WorkspaceControl();
  await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'seed' }, commands: [project('project')] });
  const read = control.read.bind(control); let raced = false;
  control.read = async () => {
    const state = await read();
    if (!raced) { raced = true; await control.dispatch({ commandId: 'user-todo', expectedRevision: state.revision, actor: { kind: 'user', id: 'user' }, commands: [{ type: 'todo.save', todo: { id: 'todo', title: 'Written by the user', completed: false, nodeIds: [] } }] }); }
    return state;
  };
  await assert.rejects(applyAtHead(control, { commandId: 'agent-todo', actor: agent, commands: [{ type: 'todo.save', todo: { id: 'todo', title: 'Written by the agent', completed: false, nodeIds: [] } }] }, revisionGuard),
    /todo\.save needs expectedRevision: it replaces a to-do that already exists/);
  assert.equal((await control.store.read()).todos[0].title, 'Written by the user');
});
