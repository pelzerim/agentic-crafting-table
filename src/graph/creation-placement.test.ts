import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_REACH, creationAnchors, creationContext, itemPlacement, projectPlacement } from './creation-placement.ts';
import { NEIGHBORHOOD_PADDING } from './project-neighborhoods.ts';
import { ITEM_GAP } from './movement.ts';
import { boundsOf, field } from './undermap.ts';
import { overlaps } from './spatial.ts';
import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';

const ITEM = { width: 150, height: 48 }, PROJECT = { width: 240, height: 112 };
const footprint = (node: GraphNode): SpatialBox => ({ id: node.id, ...node.position, ...(node.resourceId ? ITEM : PROJECT) });
const item = (id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, resourceId: `${id}-r`, position: { x, y }, ...extra });
const project = (id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, position: { x, y }, ...extra });
const place = (nodes: readonly GraphNode[], anchors: readonly string[], projectId?: string, position?: { x: number; y: number }) =>
  itemPlacement(nodes, footprint, creationContext(nodes, anchors, projectId), ITEM, position);
/** Places several items one after another, each seeing the ones before it. */
const fan = (nodes: GraphNode[], count: number, anchors: readonly string[], projectId?: string) => Array.from({ length: count }, (_, index) => {
  const context = creationContext(nodes, anchors, projectId), position = itemPlacement(nodes, footprint, context, ITEM)!;
  nodes.push(item(`new-${index}`, position.x, position.y, { projectId: context.projectId }));
  return position;
});
const clear = (nodes: readonly GraphNode[]) => {
  const populated = new Set(nodes.map(node => node.projectId)), boxes = nodes.filter(node => node.resourceId || !populated.has(node.id)).map(footprint);
  return boxes.every((a, i) => boxes.slice(i + 1).every(b => !overlaps(a, b, ITEM_GAP)));
};

test('reach is one neighborhood padding', () => assert.equal(CONTEXT_REACH, NEIGHBORHOOD_PADDING));

test('links come before the agent itself, without repeats', () => {
  assert.deepEqual(creationAnchors(['pr', 'agent', 'note'], 'agent'), ['pr', 'agent', 'note']);
  assert.deepEqual(creationAnchors(['pr'], 'agent'), ['pr', 'agent']);
  assert.deepEqual(creationAnchors([], undefined), []);
});

test('an item lands right of the first node it links to, on its row, and joins its project', () => {
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' }), item('pr', 600, 300, { projectId: 'p' })];
  const context = creationContext(nodes, ['pr', 'agent']);
  assert.equal(context.anchor?.id, 'pr'); assert.equal(context.projectId, 'p');
  assert.deepEqual(itemPlacement(nodes, footprint, context, ITEM), { x: 600 + 150 + ITEM_GAP, y: 300 });
});

test('without links the item lands beside the calling agent', () => {
  const nodes = [item('agent', 100, 100)];
  assert.equal(creationContext(nodes, ['agent']).projectId, undefined);
  assert.deepEqual(place(nodes, ['agent']), { x: 100 + 150 + ITEM_GAP, y: 100 });
});

test('rows align on the anchor top when heights differ', () => {
  const nodes = [item('agent', 0, 0)];
  const tall = itemPlacement(nodes, footprint, creationContext(nodes, ['agent']), { width: 240, height: 112 })!;
  assert.equal(tall.y - 112 / 2, -48 / 2); assert.equal(tall.x - 240 / 2, 150 / 2 + ITEM_GAP);
});

test('items created one after another form a column beside the anchor', () => {
  const nodes = [item('agent', 0, 0), item('far', 5000, 5000)];
  const positions = fan(nodes, 5, ['agent']);
  assert.deepEqual(positions.map(position => position.x), Array(5).fill(150 + ITEM_GAP));
  assert.deepEqual(positions.map(position => position.y), [0, 1, 2, 3, 4].map(index => index * (48 + ITEM_GAP)));
  assert.ok(clear(nodes));
});

test('a blocked right-hand column gives way to the row below, then the nearest free spot', () => {
  const wall = (id: string, y: number) => ({ ...item(id, 150 + ITEM_GAP, y), mapDimensions: { width: 150, height: 48 } });
  const blocked = [item('agent', 0, 0), ...Array.from({ length: 6 }, (_, index) => wall(`wall-${index}`, index * (48 + ITEM_GAP)))];
  assert.deepEqual(place(blocked, ['agent']), { x: 0, y: 48 + ITEM_GAP });
  const nodes = [...blocked];
  fan(nodes, 12, ['agent']);
  assert.ok(clear(nodes));
  for (const node of nodes.filter(node => node.id.startsWith('new-'))) assert.ok(Math.hypot(node.position.x, node.position.y) < 1200, `${node.id} stays near the anchor`);
});

test('a named project wins: an anchor outside it does not count and the item lands among its members', () => {
  const nodes = [project('p', 0, 0), project('q', 3000, 0), item('agent', 0, 0, { projectId: 'p' }),
    item('q1', 3000, 0, { projectId: 'q' }), item('q2', 3000 + 150 + ITEM_GAP, 0, { projectId: 'q' })];
  const context = creationContext(nodes, ['agent'], 'q');
  assert.equal(context.anchor, undefined); assert.equal(context.projectId, 'q');
  const position = itemPlacement(nodes, footprint, context, ITEM)!, members = boundsOf(nodes.filter(node => node.projectId === 'q').map(footprint));
  assert.ok(overlaps({ id: 'new', ...position, ...ITEM }, field('q', members, NEIGHBORHOOD_PADDING), 0), 'inside the project field');
  assert.ok(clear([...nodes, item('new', position.x, position.y)]));
  assert.ok(Math.abs(position.x - 3085) <= 150 + ITEM_GAP && Math.abs(position.y) <= 48 + ITEM_GAP, 'beside the member centroid');
});

test('an anchor inside the named project is used', () => {
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' }), item('pr', 400, 400, { projectId: 'p' })];
  assert.deepEqual(place(nodes, ['pr', 'agent'], 'p'), { x: 400 + 150 + ITEM_GAP, y: 400 });
});

test('an empty project receives the item on its own spot', () => {
  const nodes = [project('p', 900, 900), item('other', 0, 0)];
  assert.deepEqual(place(nodes, [], 'p'), { x: 900, y: 900 });
  const taken = [...nodes, item('first', 900, 900, { projectId: 'p' })], second = place(taken, [], 'p')!;
  assert.ok(clear([...taken, item('second', second.x, second.y, { projectId: 'p' })]));
});

test('with no anchor and no project the given position is used, and none stays undefined', () => {
  const nodes = [item('other', 0, 0)];
  assert.deepEqual(place(nodes, ['mcp-client'], undefined, { x: 9000, y: 9000 }), { x: 9000, y: 9000 });
  assert.equal(place(nodes, ['mcp-client']), undefined);
  assert.equal(place(nodes, []), undefined);
});

test('a position within reach of the anchor or of the project is kept', () => {
  const floating = [item('agent', 0, 0)];
  const near = { x: 150 + CONTEXT_REACH - 1, y: 0 };
  assert.deepEqual(place(floating, ['agent'], undefined, near), near);
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' }), item('m', 600, 0, { projectId: 'p' })];
  const inField = { x: 300, y: 48 + CONTEXT_REACH - 1 };
  assert.deepEqual(place(nodes, ['agent'], undefined, inField), inField);
});

test('a far-off position is placed as if none was given', () => {
  const floating = [item('agent', 0, 0)];
  assert.deepEqual(place(floating, ['agent'], undefined, { x: 150 + CONTEXT_REACH + 1, y: 0 }), place(floating, ['agent']));
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' })];
  assert.deepEqual(place(nodes, ['agent'], undefined, { x: 40_000, y: -12_000 }), { x: 150 + ITEM_GAP, y: 0 });
  assert.deepEqual(place(nodes, [], 'p', { x: 40_000, y: -12_000 }), place(nodes, [], 'p'));
});

test('anchors that are archived, in Undermap or in such a project fall through to the next one', () => {
  const at = '2026-10-07T00:00:00.000Z';
  const nodes = [project('gone', -900, 0, { belowAt: at }), item('archived', 500, 500, { archivedAt: at }), item('below', 700, 700, { belowAt: at }), item('member', -900, 0, { projectId: 'gone' }), item('agent', 0, 0)];
  const context = creationContext(nodes, ['archived', 'below', 'member', 'missing', 'agent']);
  assert.equal(context.anchor?.id, 'agent'); assert.equal(context.projectId, undefined);
  assert.deepEqual(itemPlacement(nodes, footprint, context, ITEM), { x: 150 + ITEM_GAP, y: 0 });
  assert.equal(creationContext(nodes, ['member']).anchor, undefined);
});

test('a project that is off the map gives no context, so its item keeps the given position', () => {
  const nodes = [project('gone', 0, 0, { archivedAt: '2026-10-07T00:00:00.000Z' }), item('agent', 0, 0)];
  assert.deepEqual(place(nodes, ['agent'], 'gone', { x: 7000, y: 7000 }), { x: 7000, y: 7000 });
  assert.equal(place(nodes, ['agent'], 'gone'), undefined);
});

test('items off the map are not obstacles', () => {
  const nodes = [item('agent', 0, 0), item('below', 150 + ITEM_GAP, 0, { belowAt: '2026-10-07T00:00:00.000Z' })];
  assert.deepEqual(place(nodes, ['agent']), { x: 150 + ITEM_GAP, y: 0 });
});

test('a project node is not an item anchor', () => {
  const nodes = [project('p', 0, 0), item('agent', 2000, 0)];
  assert.equal(creationContext(nodes, ['p', 'agent']).anchor?.id, 'agent');
});

test('a floating item never lands inside another project\'s neighborhood', () => {
  const nodes = [item('agent', 0, 0), project('q', 500, 0), item('q1', 500, 0, { projectId: 'q' })];
  const position = place(nodes, ['agent'])!, other = field('q', boundsOf([footprint(nodes[2])]), NEIGHBORHOOD_PADDING);
  assert.ok(!overlaps({ id: 'new', ...position, ...ITEM }, other, 0));
  assert.ok(clear([...nodes, item('new', position.x, position.y)]));
  assert.ok(Math.hypot(position.x, position.y) < 400);
});

test('a new project lands beside the caller\'s project, clear of every neighborhood', () => {
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' }), item('m', 400, 200, { projectId: 'p' }), item('float', 2000, 0)];
  const position = projectPlacement(nodes, footprint, ['agent'], PROJECT)!;
  const home = field('p', boundsOf([footprint(nodes[1]), footprint(nodes[2])]), NEIGHBORHOOD_PADDING), own = field('new', boundsOf([{ id: 'new', ...position, ...PROJECT }]), NEIGHBORHOOD_PADDING);
  assert.ok(!overlaps(own, home, 0)); assert.ok(overlaps(own, home, 1), 'the two neighborhoods touch');
  assert.equal(own.y - own.height / 2, home.y - home.height / 2, 'same row');
  assert.ok(position.x > home.x);
});

test('several new projects never share a neighborhood', () => {
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' })];
  const fields: SpatialBox[] = [field('p', boundsOf([footprint(nodes[1])]), NEIGHBORHOOD_PADDING)];
  for (let index = 0; index < 4; index++) {
    const position = projectPlacement(nodes, footprint, ['agent'], PROJECT)!, own = field(`n${index}`, boundsOf([{ id: '', ...position, ...PROJECT }]), NEIGHBORHOOD_PADDING);
    assert.ok(fields.every(other => !overlaps(own, other, 0)), `project ${index} is clear`);
    fields.push(own); nodes.push(project(`n${index}`, position.x, position.y));
  }
});

test('a new project keeps a position within reach of the caller\'s project and loses a far one', () => {
  const nodes = [project('p', 0, 0), item('agent', 0, 0, { projectId: 'p' })];
  const beside = projectPlacement(nodes, footprint, ['agent'], PROJECT)!;
  const near = { x: beside.x + 100, y: beside.y + 60 };
  assert.deepEqual(projectPlacement(nodes, footprint, ['agent'], PROJECT, near), near);
  assert.deepEqual(projectPlacement(nodes, footprint, ['agent'], PROJECT, { x: 50_000, y: 50_000 }), beside);
});

test('a new project from a floating agent lands beside the agent; without a caller the position stands', () => {
  const nodes = [item('agent', 0, 0)];
  const position = projectPlacement(nodes, footprint, ['agent'], PROJECT)!;
  assert.ok(position.x > 0 && position.x < 150 / 2 + NEIGHBORHOOD_PADDING + 240 + ITEM_GAP + 1);
  assert.deepEqual(projectPlacement(nodes, footprint, ['mcp-client'], PROJECT, { x: 9, y: 9 }), { x: 9, y: 9 });
  assert.equal(projectPlacement(nodes, footprint, ['mcp-client'], PROJECT), undefined);
});
