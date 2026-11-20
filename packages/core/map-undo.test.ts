import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore, PERSON_ACTOR } from './control.ts';
import { UNDO_ACTOR, UndoHistory, planReversal } from './map-undo.ts';
import type { UndoStep } from './map-undo.ts';
import { layoutFootprints } from '../../src/graph/movement.ts';

const AGENT = { kind: 'agent', id: 'agent' } as never;
async function board(collisions?: 'solid') {
  const store = Object.assign(new MemoryStore(), collisions ? { readMapLayout: () => ({ sizes: {}, collisions }) } : {});
  const control = new WorkspaceControl(store), context = { registry: control.registry };
  const send = async (commands: unknown[], actor = { kind: 'user' as const, id: PERSON_ACTOR }, expectedRevision?: number) =>
    control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: expectedRevision ?? (await control.read()).revision, actor, commands });
  await send([{ type: 'project.create', id: 'acme', title: 'Acme', workingDirectory: '/Users/example/acme', position: { x: 0, y: 0 } }]);
  for (const [id, x] of [['a', 0], ['b', 300], ['c', 600]] as const) await send([{ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'linear.ticket', title: id, projectId: 'acme', position: { x, y: 200 }, data: { issueId: `ACME-${id}` } }]);
  const edit = async (commands: unknown[]) => { const result = await send(commands); return { label: 'Edit', ...result.receipt! } as UndoStep; };
  // What the service's revert does, against the latest map.
  const revert = async (step: UndoStep, direction: 'undo' | 'redo') => {
    const state = await control.read(), envelope = (commands: unknown[]) => ({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: UNDO_ACTOR, commands }) as never;
    const reversal = planReversal(step, state, [], context, direction, commands => control.reduce(state, envelope(commands)), current => layoutFootprints(current.nodes, current.resources, control.registry));
    if (reversal.commands.length) await control.dispatch(envelope(reversal.commands));
    return { ...reversal, state: await control.read() };
  };
  return { control, send, edit, revert };
}
const at = (state: { nodes: { id: string; position: { x: number; y: number } }[] }, id: string) => state.nodes.find(node => node.id === id)!.position;

test('a receipt holds only what the person committed, even after an agent wrote meanwhile', async () => {
  const { control, send } = await board();
  const seen = (await control.read()).revision;
  await send([{ type: 'node.move', id: 'c', position: { x: 600, y: 900 } }, { type: 'node.update', id: 'b', title: 'Renamed by agent' }], AGENT);
  const drop = await send([{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 300, y: 200 } }] }], undefined, seen);
  assert.deepEqual(drop.receipt!.items.map(item => item.id).sort(), ['a', 'b'], 'c moved by the agent is not in it');
  const b = drop.receipt!.items.find(item => item.id === 'b')!;
  assert.deepEqual({ ...b.before, position: b.after.position }, b.after, 'a displaced neighbour records only its position');
  assert.equal((await send([{ type: 'node.move', id: 'a', position: { x: 0, y: 600 } }], AGENT)).receipt, undefined);
});

test('undo puts the moved item and every neighbour it displaced back', async () => {
  const { control, edit, revert } = await board();
  const before = await control.read(), step = await edit([{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 300, y: 200 } }] }]);
  assert.notDeepEqual(at(await control.read(), 'b'), at(before, 'b'), 'the drop displaced b');
  const undone = await revert(step, 'undo');
  for (const id of ['a', 'b', 'c']) assert.deepEqual(at(undone.state, id), at(before, id), id);
  assert.equal(undone.skipped, 0);
});

test('undo leaves an item an agent moved since where it is', async () => {
  const { control, send, edit, revert } = await board();
  const before = await control.read(), step = await edit([{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 300, y: 200 } }] }]);
  await send([{ type: 'node.move', id: 'b', position: { x: 300, y: 900 } }], AGENT);
  const undone = await revert(step, 'undo');
  assert.deepEqual(at(undone.state, 'a'), at(before, 'a'));
  assert.deepEqual(at(undone.state, 'b'), { x: 300, y: 900 });
  assert.equal(undone.skipped, 1);
});

test('undoing a resize keeps a position an agent set since', async () => {
  const { send, edit, revert } = await board();
  const step = await edit([{ type: 'node.resize', id: 'c', size: 'medium' }]);
  await send([{ type: 'node.move', id: 'c', position: { x: 600, y: 1200 } }], AGENT);
  const undone = await revert(step, 'undo'), c = undone.state.nodes.find(node => node.id === 'c')!;
  assert.deepEqual(c.position, { x: 600, y: 1200 });
  assert.equal(c.mapSize ?? 'small', 'small');
});

test('undo never shoves an item outside the step; it skips the one that would land on it', async () => {
  const { send, edit, revert } = await board();
  const step = await edit([{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 0, y: 900 } }] }]);
  await send([{ type: 'node.move', id: 'c', position: { x: 0, y: 200 } }], AGENT);
  const undone = await revert(step, 'undo');
  assert.deepEqual(at(undone.state, 'c'), { x: 0, y: 200 });
  assert.deepEqual(at(undone.state, 'a'), { x: 0, y: 900 });
  assert.deepEqual([undone.reverted, undone.skipped, undone.applied], [0, 1, undefined]);
});

test('redo replays only what the undo put back', async () => {
  const { send, edit, revert } = await board();
  const step = await edit([{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 0, y: 900 } }, { id: 'b', position: { x: 300, y: 900 } }] }]);
  await send([{ type: 'node.move', id: 'a', position: { x: 0, y: 200 } }], AGENT);
  const undone = await revert(step, 'undo');
  assert.deepEqual([at(undone.state, 'b'), undone.skipped], [{ x: 300, y: 200 }, 1]);
  assert.deepEqual(undone.applied!.items.map(item => item.id), ['b']);
  const redone = await revert(undone.applied!, 'redo');
  assert.deepEqual([at(redone.state, 'a'), at(redone.state, 'b')], [{ x: 0, y: 200 }, { x: 300, y: 900 }]);
});

test('a new change clears redo, and an undo files the step it undid', () => {
  const history = new UndoHistory(), step = (label: string) => ({ label, items: [], links: [], plots: [] });
  const move = step('Move'), resize = step('Resize');
  history.record(move);
  history.record(resize);
  const undoing = history.peek('undo')!;
  history.record(step('Drag'));
  history.settle('undo', undoing, undoing);
  assert.deepEqual(history.peek('undo')!.label, 'Drag');
  assert.equal(history.peek('redo'), resize);
  history.record(step('Archive'));
  assert.equal(history.peek('redo'), undefined);
});

test('with solid collisions an item that cannot reach its old spot is skipped, and redo stays consistent', async () => {
  const { send, edit, revert } = await board('solid');
  const step = await edit([{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 0, y: 900 } }, { id: 'b', position: { x: 300, y: 900 } }] }]);
  await send([{ type: 'node.move', id: 'c', position: { x: 0, y: 200 } }], AGENT);
  const undone = await revert(step, 'undo');
  assert.deepEqual([at(undone.state, 'a'), at(undone.state, 'b'), undone.skipped], [{ x: 0, y: 900 }, { x: 300, y: 200 }, 1]);
  assert.deepEqual(undone.applied!.items.map(item => item.id), ['b']);
  const redone = await revert(undone.applied!, 'redo');
  assert.deepEqual([at(redone.state, 'b'), redone.skipped], [{ x: 300, y: 900 }, 0]);
});

test('an undo that can no longer run is skipped instead of failing: archived project, deleted link endpoint', async () => {
  const { send, edit, revert } = await board();
  const archived = await edit([{ type: 'node.archive', id: 'a' }]);
  await send([{ type: 'node.archive', id: 'acme' }], AGENT);
  const first = await revert(archived, 'undo');
  assert.deepEqual([first.reverted, first.skipped], [0, 1]);
  await send([{ type: 'node.restore', id: 'acme' }], AGENT);
  await send([{ type: 'link.save', link: { id: 'bc', sourceId: 'b', targetId: 'c', kind: 'reference' } }]);
  const unlinked = await edit([{ type: 'link.remove', id: 'bc' }]);
  await send([{ type: 'node.archive', id: 'c' }], AGENT);
  await send([{ type: 'node.delete', id: 'c' }], AGENT);
  const second = await revert(unlinked, 'undo');
  assert.deepEqual([second.reverted, second.skipped, second.state.links.length], [0, 1, 0]);
});

test('undoing Move to project brings a to-do\'s attached items back too', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'project.create', id: 'beta', title: 'Beta', workingDirectory: '/Users/example/beta', position: { x: 4000, y: 0 } }]);
  await send([{ type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Ship', data: {}, projectId: 'acme', position: { x: 0, y: 600 } },
    { type: 'link.save', link: { id: 'spec', sourceId: 'task', targetId: 'a', kind: 'reference' } }]);
  const sent = await edit([{ type: 'nodes.send', ids: ['task'], projectId: 'beta' }]);
  assert.equal(sent.items.find(item => item.id === 'a')!.before.projectId, 'acme');
  const undone = await revert(sent, 'undo');
  assert.deepEqual(['task', 'a'].map(id => undone.state.nodes.find(node => node.id === id)!.projectId), ['acme', 'acme']);
});

test('undo never puts an item back into a project archived since', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'project.create', id: 'beta', title: 'Beta', workingDirectory: '/Users/example/beta', position: { x: 4000, y: 0 } }]);
  const sent = await edit([{ type: 'nodes.send', ids: ['a'], projectId: 'beta' }]);
  await send([{ type: 'node.archive', id: 'acme' }], AGENT);
  const undone = await revert(sent, 'undo');
  assert.deepEqual([undone.state.nodes.find(node => node.id === 'a')!.projectId, undone.skipped], ['beta', 1]);
});

test('undo never puts an item back into a project sent to Undermap since', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'project.create', id: 'beta', title: 'Beta', workingDirectory: '/Users/example/beta', position: { x: 4000, y: 0 } }]);
  const sent = await edit([{ type: 'nodes.send', ids: ['a'], projectId: 'beta' }]);
  await send([{ type: 'node.below', id: 'acme' }]);
  const undone = await revert(sent, 'undo');
  assert.deepEqual([undone.state.nodes.find(node => node.id === 'a')!.projectId, undone.skipped], ['beta', 1]);
});
