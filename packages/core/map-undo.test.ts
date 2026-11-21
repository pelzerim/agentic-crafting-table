import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore, PERSON_ACTOR } from './control.ts';
import { UNDO_ACTOR, UndoHistory, planReversal, stepBoard } from './map-undo.ts';
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

test('undoing a bulk archive restores an item stored before its project', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'item.add', id: 'z', resourceId: 'z-r', pluginId: 'linear.ticket', title: 'z', position: { x: 4000, y: 600 }, data: { issueId: 'ACME-z' } }]);
  await send([{ type: 'project.create', id: 'beta', title: 'Beta', workingDirectory: '/Users/example/beta', position: { x: 4000, y: 0 } }, { type: 'node.attach', id: 'z', projectId: 'beta' }]);
  // A populated project's anchor has no footprint, so a loose item can be moved onto it.
  await send([{ type: 'item.add', id: 'f', resourceId: 'f-r', pluginId: 'linear.ticket', title: 'f', position: { x: 6000, y: 0 }, data: { issueId: 'ACME-f' } }]);
  const loose = (await send([{ type: 'node.move', id: 'f', position: { x: 4000, y: 0 } }])).state.nodes.find(node => node.id === 'f')!.position;
  const archived = await edit([{ type: 'node.archive', id: 'z' }, { type: 'node.archive', id: 'beta' }]);
  assert.deepEqual(archived.items.map(item => item.id), ['z', 'beta'], 'the receipt lists the item first');
  const undone = await revert(archived, 'undo');
  assert.deepEqual([undone.skipped, ...['z', 'beta'].map(id => Boolean(undone.state.nodes.find(node => node.id === id)!.archivedAt))], [0, false, false]);
  assert.deepEqual(undone.state.nodes.find(node => node.id === 'f')!.position, loose, 'the loose item on the anchor stays put');
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

test('Move to board undoes and redoes with the project\'s members, and the step names the board to show', async () => {
  const { control, send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }]);
  const before = (await control.read()).nodes.map(node => ({ ...node.position }));
  const moved = await edit([{ type: 'node.move', id: 'acme', board: 'side' }]);
  const boards = (state: { nodes: { board?: string }[] }) => state.nodes.map(node => node.board);
  assert.deepEqual(boards(await control.read()), ['side', 'side', 'side', 'side']);
  assert.equal(stepBoard(moved, 'undo'), 'main');
  const undone = await revert(moved, 'undo');
  assert.deepEqual(boards(undone.state), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(undone.state.nodes.map(node => node.position), before);
  assert.equal(stepBoard(undone.applied!, 'redo'), 'side');
  assert.deepEqual(boards((await revert(undone.applied!, 'redo')).state), ['side', 'side', 'side', 'side']);
});

test('undoing Move to board is refused once the project gained an item since', async () => {
  const { control, send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }]);
  const moved = await edit([{ type: 'node.move', id: 'acme', board: 'side' }]), { x, y } = at(await control.read(), 'acme');
  await send([{ type: 'item.add', id: 'd', resourceId: 'd-r', pluginId: 'linear.ticket', title: 'd', projectId: 'acme', position: { x: x + 900, y: y + 200 }, data: { issueId: 'ACME-d' } }], AGENT);
  const undone = await revert(moved, 'undo');
  assert.deepEqual(undone.state.nodes.map(node => node.board), ['side', 'side', 'side', 'side', 'side']);
  assert.equal(undone.reverted, 0);
});

test('undo never moves an item taken to another board since, even at the same spot', async () => {
  const { control, send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'item.add', id: 'loose', resourceId: 'loose-r', pluginId: 'linear.ticket', title: 'loose', position: { x: 2000, y: 0 }, data: { issueId: 'ACME-loose' } }]);
  const dragged = await edit([{ type: 'node.move', id: 'loose', position: { x: 2000, y: 600 } }]);
  await send([{ type: 'node.move', id: 'loose', board: 'side', position: { x: 2000, y: 600 } }]);
  const undone = await revert(dragged, 'undo'), loose = undone.state.nodes.find(node => node.id === 'loose')!;
  assert.deepEqual([loose.board, loose.position, undone.skipped], ['side', { x: 2000, y: 600 }, 1]);
});

test('undoing a board deletion brings back its archived items on it, still archived, and redo takes them off again', async () => {
  const { control, send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }]);
  await send([{ type: 'node.move', id: 'acme', board: 'side' }]);
  await send([{ type: 'node.archive', id: 'acme' }]);
  const deleted = await edit([{ type: 'board.delete', id: 'side' }]);
  const acme = (state: { nodes: { id: string; board?: string; archivedAt?: string }[] }) => { const node = state.nodes.find(entry => entry.id === 'acme')!; return [node.board, Boolean(node.archivedAt)]; };
  assert.deepEqual(acme(await control.read()), [undefined, true]);
  const undone = await revert(deleted, 'undo');
  assert.deepEqual(acme(undone.state), ['side', true]);
  assert.deepEqual(undone.state.nodes.map(node => node.board), ['side', 'side', 'side', 'side'], 'its items follow it');
  const redone = await revert(undone.applied!, 'redo');
  assert.deepEqual([redone.state.boards.map(entry => entry.id), acme(redone.state)], [['main'], [undefined, true]]);
});

test('undoing a loose item\'s Move to board puts it back at its spot with a neighbour close by', async () => {
  const { control, send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'item.add', id: 'loose', resourceId: 'loose-r', pluginId: 'linear.ticket', title: 'loose', position: { x: 6000, y: 0 }, data: { issueId: 'ACME-loose' } }]);
  const state = await control.read(), spot = at(state, 'loose'), { width } = layoutFootprints(state.nodes, state.resources, control.registry).find(box => box.id === 'loose')!;
  const moved = await edit([{ type: 'node.move', id: 'loose', board: 'side' }]);
  await send([{ type: 'item.add', id: 'near', resourceId: 'near-r', pluginId: 'linear.ticket', title: 'near', position: { x: spot.x + width + 100, y: spot.y }, data: { issueId: 'ACME-near' } }]);
  const undone = await revert(moved, 'undo'), loose = undone.state.nodes.find(node => node.id === 'loose')!;
  assert.deepEqual([loose.board, loose.position, undone.skipped], [undefined, spot, 0]);
});

test('redo of Move to board for a project whose items shifted on arrival skips none of them', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'item.add', id: 'blocker', resourceId: 'blocker-r', pluginId: 'linear.ticket', title: 'blocker', board: 'side', position: { x: 300, y: 200 }, data: { issueId: 'ACME-blocker' } }]);
  const moved = await edit([{ type: 'node.move', id: 'acme', board: 'side' }]);
  assert.ok(moved.items.some(item => item.id !== 'acme'), 'its items arrived shifted');
  const undone = await revert(moved, 'undo'), redone = await revert(undone.applied!, 'redo');
  assert.deepEqual([undone.skipped, redone.skipped, redone.state.nodes.filter(node => node.id !== 'blocker').every(node => node.board === 'side')], [0, 0, true]);
});

test('undoing a board deletion puts the board back in its tab place', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'board.save', board: { id: 'third', name: 'Third' } }]);
  await send([{ type: 'node.move', id: 'acme', board: 'side' }]);
  const deleted = await edit([{ type: 'board.delete', id: 'main' }]);
  const undone = await revert(deleted, 'undo');
  assert.deepEqual(undone.state.boards.map(entry => entry.id), ['main', 'side', 'third']);
});

test('undoing a project\'s Move to board after an agent took it to a third board changes nothing there, nor does redo', async () => {
  const { control, send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'board.save', board: { id: 'third', name: 'Third' } }, { type: 'item.add', id: 'blocker', resourceId: 'blocker-r', pluginId: 'linear.ticket', title: 'blocker', board: 'side', position: { x: 300, y: 200 }, data: { issueId: 'ACME-blocker' } }]);
  const moved = await edit([{ type: 'node.move', id: 'acme', board: 'side' }]);
  assert.ok(moved.items.some(item => item.id !== 'acme'), 'its items arrived shifted');
  await send([{ type: 'node.move', id: 'acme', board: 'third' }], AGENT);
  const third = async () => (await control.read()).nodes.filter(node => node.board === 'third').map(node => [node.id, node.position]);
  const before = await third(), undone = await revert(moved, 'undo');
  assert.deepEqual([await third(), undone.commands], [before, []]);
  assert.deepEqual([await third(), (await revert(moved, 'redo')).commands], [before, []]);
});

test('undoing a loose item\'s Move to board after it moved on the new board leaves it there', async () => {
  const { send, edit, revert } = await board();
  await send([{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'item.add', id: 'loose', resourceId: 'loose-r', pluginId: 'linear.ticket', title: 'loose', position: { x: 3000, y: 0 }, data: { issueId: 'ACME-loose' } }]);
  const moved = await edit([{ type: 'node.move', id: 'loose', board: 'side' }]);
  await send([{ type: 'node.move', id: 'loose', position: { x: 4000, y: 2000 } }]);
  const undone = await revert(moved, 'undo'), loose = undone.state.nodes.find(node => node.id === 'loose')!;
  assert.deepEqual([loose.board, loose.position, undone.skipped], ['side', { x: 4000, y: 2000 }, 1]);
});
