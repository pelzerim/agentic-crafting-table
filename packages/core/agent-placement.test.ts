import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl, commandSchema } from './control.ts';
import type { WorkspaceState } from './control.ts';
import { layoutFootprints, ITEM_GAP } from '../../src/graph/movement.ts';
import { CONTEXT_REACH } from '../../src/graph/creation-placement.ts';
import { NEIGHBORHOOD_PADDING } from '../../src/graph/project-neighborhoods.ts';
import { boundsOf, field } from '../../src/graph/undermap.ts';
import { overlaps } from '../../src/graph/spatial.ts';

const user = { kind: 'user', id: 'test' }, agent = { kind: 'agent', id: 'agent' };
const note = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, ...extra });
const projectAt = (id: string, x: number, y: number) => ({ type: 'project.create', id, title: id, position: { x, y } });
/** Project p holds the calling agent's node and a pull request; project q holds two notes far away. */
async function seeded() {
  const control = new WorkspaceControl(new MemoryStore());
  const { state } = await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: user, commands: [
    projectAt('p', 0, 0), projectAt('q', 4000, 0),
    note('agent', { projectId: 'p', position: { x: 0, y: 0 } }), note('pr', { projectId: 'p', position: { x: 700, y: 400 } }),
    note('q1', { projectId: 'q', position: { x: 4000, y: 0 } }), note('q2', { projectId: 'q', position: { x: 4400, y: 0 } }),
    note('floating', { position: { x: -3000, y: -3000 } }),
  ] });
  return { control, state };
}
const boxes = (control: WorkspaceControl, state: WorkspaceState) => new Map(layoutFootprints(state.nodes, state.resources, control.registry).map(box => [box.id, box]));
const edges = (control: WorkspaceControl, state: WorkspaceState, id: string) => boundsOf([boxes(control, state).get(id)!]);
const clear = (control: WorkspaceControl, state: WorkspaceState) => { const all = [...boxes(control, state).values()]; return all.every((a, i) => all.slice(i + 1).every(b => !overlaps(a, b, ITEM_GAP))); };
const unmoved = (before: WorkspaceState, after: WorkspaceState) => before.nodes.every(node => { const now = after.nodes.find(other => other.id === node.id)!; return now.position.x === node.position.x && now.position.y === node.position.y; });
const apply = (control: WorkspaceControl, state: WorkspaceState, commandId: string, commands: unknown[], actor: unknown = agent) => control.dispatch({ commandId, expectedRevision: state.revision, actor, commands });

test('old payloads stay valid and position is optional on the three creating commands', () => {
  assert.ok(commandSchema.parse(note('a', { position: { x: 1, y: 2 } })));
  for (const command of [note('a'), { type: 'project.create', id: 'x', title: 'x' }, { type: 'item.create', id: 'b', resource: { id: 'b-r', pluginId: 'workspace.note', schemaVersion: 2, title: 'b', data: { text: 'b' } } }]) assert.ok(commandSchema.parse(command));
});

test('an agent item without a position lands right of the agent on its row and joins its project', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'add', [note('n')]);
  const created = edges(control, after, 'n'), self = edges(control, after, 'agent');
  assert.equal(created.left, self.right + ITEM_GAP); assert.equal(created.top, self.top);
  assert.equal(after.nodes.find(node => node.id === 'n')!.projectId, 'p');
  assert.ok(unmoved(state, after)); assert.ok(clear(control, after));
});

test('the first linked node anchors the item before the agent does', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'add', [note('n', { links: [{ otherId: 'pr', kind: 'reference' }, { otherId: 'agent', kind: 'reference' }] })]);
  const created = edges(control, after, 'n'), anchor = edges(control, after, 'pr');
  assert.equal(created.left, anchor.right + ITEM_GAP); assert.equal(created.top, anchor.top);
  assert.equal(after.links.length, 2);
});

test('item.create follows the same rule', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'create', [{ type: 'item.create', id: 'n', resource: { id: 'n-r', pluginId: 'workspace.note', schemaVersion: 2, title: 'n', data: { text: 'n' } } }]);
  assert.equal(edges(control, after, 'n').left, edges(control, after, 'agent').right + ITEM_GAP);
  assert.equal(after.nodes.find(node => node.id === 'n')!.projectId, 'p');
});

test('a named project wins over the anchor: the item lands among that project\'s members', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'add', [note('n', { projectId: 'q', links: [{ otherId: 'agent', kind: 'reference' }] })]);
  const created = after.nodes.find(node => node.id === 'n')!, all = boxes(control, after);
  assert.equal(created.projectId, 'q');
  assert.ok(overlaps(all.get('n')!, field('q', boundsOf([all.get('q1')!, all.get('q2')!]), NEIGHBORHOOD_PADDING), 0));
  assert.ok(unmoved(state, after)); assert.ok(clear(control, after));
});

test('a batch fans out as one column beside the anchor, and later commands continue it', async () => {
  const { control, state } = await seeded();
  const first = await apply(control, state, 'batch', ['a', 'b', 'c', 'd'].map(id => note(id, { links: [{ otherId: 'agent', kind: 'reference' }] })));
  const second = await apply(control, first.state, 'next', [note('e')]);
  const all = boxes(control, second.state), self = edges(control, second.state, 'agent'), placed = ['a', 'b', 'c', 'd', 'e'].map(id => edges(control, second.state, id));
  const column = placed.filter(box => box.left === self.right + ITEM_GAP);
  assert.ok(column.length >= 3, 'the right-hand column fills first');
  assert.deepEqual(column, placed.slice(0, column.length)); assert.equal(column[0].top, self.top);
  for (let index = 1; index < column.length; index++) assert.equal(column[index].top, column[index - 1].bottom + ITEM_GAP);
  assert.equal(placed[column.length].left, self.left, 'then the row below the anchor'); assert.equal(placed[column.length].top, self.bottom + ITEM_GAP);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.ok(overlaps(all.get(id)!, all.get('agent')!, CONTEXT_REACH), `${id} stays within reach of the anchor`);
  assert.ok(unmoved(state, second.state)); assert.ok(clear(control, second.state));
});

test('replaying the same commandId returns the same placement and adds nothing', async () => {
  const { control, state } = await seeded();
  const envelope = { commandId: 'once', expectedRevision: state.revision, actor: agent, commands: [note('n'), note('m')] };
  const first = await control.dispatch(envelope), replay = await control.dispatch(structuredClone(envelope));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, first.state);
  assert.equal((await control.read()).nodes.length, state.nodes.length + 2);
});

test('a far-off position from an agent is placed as if none was given', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'far', [note('n', { position: { x: 60_000, y: -45_000 } })]);
  assert.equal(edges(control, after, 'n').left, edges(control, after, 'agent').right + ITEM_GAP);
});

test('an in-context position from an agent is kept', async () => {
  const { control, state } = await seeded();
  const position = { x: 300, y: CONTEXT_REACH };
  const { state: after } = await apply(control, state, 'near', [note('n', { position })]);
  assert.deepEqual(after.nodes.find(node => node.id === 'n')!.position, position);
});

test('a person\'s position is never replaced, and a person still has to give one', async () => {
  const { control, state } = await seeded();
  const position = { x: 60_000, y: -45_000 };
  const { state: after } = await apply(control, state, 'far', [note('n', { position }), projectAt('r', 90_000, 90_000)], user);
  const created = after.nodes.find(node => node.id === 'n')!;
  assert.deepEqual(created.position, position); assert.equal(created.projectId, undefined);
  assert.deepEqual(after.nodes.find(node => node.id === 'r')!.position, { x: 90_000, y: 90_000 });
  await assert.rejects(apply(control, after, 'none', [note('m')], user), /position is required/);
  await assert.rejects(apply(control, after, 'none-project', [{ type: 'project.create', id: 's', title: 's' }], { kind: 'provider', id: 'poll' }), /position is required/);
});

test('an agent with no context is refused without a position and placed as asked with one', async () => {
  const { control, state } = await seeded();
  const unbound = { kind: 'agent', id: 'mcp-client' };
  await assert.rejects(apply(control, state, 'none', [note('n')], unbound), /position is required.*link/i);
  const { state: after } = await apply(control, state, 'given', [note('n', { position: { x: 60_000, y: 60_000 } })], unbound);
  assert.deepEqual(after.nodes.find(node => node.id === 'n')!.position, { x: 60_000, y: 60_000 });
  const { state: named } = await apply(control, after, 'project', [note('m', { projectId: 'q' })], unbound);
  assert.equal(named.nodes.find(node => node.id === 'm')!.projectId, 'q'); assert.ok(clear(control, named));
});

test('an anchor in Undermap or the archive falls through, so the item stays on the map', async () => {
  const { control, state } = await seeded();
  const below = await apply(control, state, 'below', [{ type: 'node.below', id: 'pr' }, { type: 'node.archive', id: 'floating' }], user);
  const { state: after } = await apply(control, below.state, 'add', [note('n', { links: [{ otherId: 'pr', kind: 'reference' }, { otherId: 'floating', kind: 'reference' }] })]);
  const created = after.nodes.find(node => node.id === 'n')!;
  assert.equal(edges(control, after, 'n').left, edges(control, after, 'agent').right + ITEM_GAP);
  assert.equal(created.belowAt, undefined); assert.equal(created.projectId, 'p');
});

test('an agent whose own node is below gets no anchor from it', async () => {
  const { control, state } = await seeded();
  const below = await apply(control, state, 'below', [{ type: 'node.below', id: 'agent' }], user);
  const { state: after } = await apply(control, below.state, 'add', [note('n', { links: [{ otherId: 'pr', kind: 'reference' }] })]);
  assert.equal(edges(control, after, 'n').left, edges(control, after, 'pr').right + ITEM_GAP);
  await assert.rejects(apply(control, after, 'none', [note('m', { links: [{ otherId: 'agent', kind: 'reference' }] })]), /position is required/);
});

test('an agent\'s new project lands beside its own project, clear of every neighborhood', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'projects', [{ type: 'project.create', id: 'x', title: 'x' }, { type: 'project.create', id: 'y', title: 'y', position: { x: 80_000, y: 80_000 } }]);
  const all = boxes(control, after), home = field('p', boundsOf([all.get('agent')!, all.get('pr')!]), NEIGHBORHOOD_PADDING), other = field('q', boundsOf([all.get('q1')!, all.get('q2')!]), NEIGHBORHOOD_PADDING);
  const fields = ['x', 'y'].map(id => field(id, boundsOf([all.get(id)!]), NEIGHBORHOOD_PADDING));
  assert.equal(fields[0].x - fields[0].width / 2, home.x + home.width / 2, 'the neighborhoods touch');
  assert.equal(fields[0].y - fields[0].height / 2, home.y - home.height / 2);
  for (const own of fields) for (const taken of [home, other]) assert.ok(!overlaps(own, taken, 0));
  assert.ok(!overlaps(fields[0], fields[1], 0)); assert.ok(overlaps(fields[1], home, CONTEXT_REACH + 1), 'the far position was replaced');
  assert.ok(unmoved(state, after)); assert.ok(clear(control, after));
});

test('near places a host-created item in the asking agent\'s context', async () => {
  const { control, state } = await seeded();
  const { state: after } = await apply(control, state, 'host', [note('n', { near: ['pr', 'agent'] })], user);
  assert.equal(edges(control, after, 'n').left, edges(control, after, 'pr').right + ITEM_GAP);
  assert.equal(after.nodes.find(node => node.id === 'n')!.projectId, 'p');
});
