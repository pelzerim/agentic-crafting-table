import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { overlaps } from './spatial.ts';
import { isBelow } from './archive.ts';
import { ITEM_GAP } from './movement.ts';
import { NEIGHBORHOOD_PADDING } from './project-neighborhoods.ts';
import { restoreMapPositions, sendBelow } from './undermap.ts';

const AT = '2026-10-01T00:00:00.000Z';
const footprint = (node: GraphNode): SpatialBox => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.resourceId ? 150 : 240, height: node.resourceId ? 48 : 112 });
const project = (id: string, x = 0, y = 0, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, position: { x, y }, ...extra });
const item = (id: string, projectId: string | undefined, x: number, y = 0, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, resourceId: `${id}-r`, projectId, position: { x, y }, ...extra });
const at = (nodes: readonly GraphNode[], id: string) => nodes.find(node => node.id === id)!;
const left = (box: SpatialBox) => box.x - box.width / 2, right = (box: SpatialBox) => box.x + box.width / 2;
const top = (box: SpatialBox) => box.y - box.height / 2, bottom = (box: SpatialBox) => box.y + box.height / 2;
const bounds = (boxes: readonly SpatialBox[]) => ({ left: Math.min(...boxes.map(left)), right: Math.max(...boxes.map(right)), top: Math.min(...boxes.map(top)), bottom: Math.max(...boxes.map(bottom)) });

function assertClearBelow(nodes: readonly GraphNode[]) {
  const boxes = nodes.filter(node => node.resourceId && isBelow(node, nodes)).map(footprint);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
    assert.ok(!overlaps(boxes[i], boxes[j], ITEM_GAP), `${boxes[i].id} overlaps ${boxes[j].id} below the map`);
}
function assertOutsideFields(nodes: readonly GraphNode[], ids: readonly string[], owner: string | undefined) {
  const below = nodes.filter(node => node.resourceId && isBelow(node, nodes) && node.projectId && node.projectId !== owner);
  for (const projectId of new Set(below.map(node => node.projectId))) {
    const field = bounds(below.filter(node => node.projectId === projectId).map(footprint));
    for (const id of ids) {
      const box = footprint(at(nodes, id));
      const inside = right(box) > field.left - NEIGHBORHOOD_PADDING && left(box) < field.right + NEIGHBORHOOD_PADDING
        && bottom(box) > field.top - NEIGHBORHOOD_PADDING && top(box) < field.bottom + NEIGHBORHOOD_PADDING;
      assert.ok(!inside, `${id} lands in the field of ${projectId}`);
    }
  }
}
const offsets = (nodes: readonly GraphNode[], ids: readonly string[]) => ids.map(id => ({ x: at(nodes, id).position.x - at(nodes, ids[0]).position.x, y: at(nodes, id).position.y - at(nodes, ids[0]).position.y }));

test('the first item of a project below keeps its position', () => {
  const nodes = [project('p'), item('a', 'p', 0), item('b', 'p', 400)];
  const next = sendBelow(nodes, ['a'], AT, footprint);
  assert.deepEqual(at(next, 'a').position, { x: 0, y: 0 });
  assert.equal(at(next, 'a').belowAt, AT);
  assert.equal(at(next, 'a').mapPosition, undefined);
  assert.deepEqual(at(next, 'b'), nodes[2], 'other items are never rearranged');
});

for (const count of [1, 3, 20]) test(`${count} item${count === 1 ? '' : 's'} sent below land as one block beside the project's items below, overlap-free`, () => {
  const existing = [item('x', 'p', 0, 0, { belowAt: AT }), item('y', 'p', 200, 0, { belowAt: AT })];
  const sent = Array.from({ length: count }, (_, i) => item(`s${String(i).padStart(2, '0')}`, 'p', (i % 5) * 190, Math.floor(i / 5) * 80));
  const nodes = [project('p'), ...existing, ...sent];
  const ids = sent.map(node => node.id);
  const next = sendBelow(nodes, ids, AT, footprint);
  assertClearBelow(next);
  assert.deepEqual(offsets(next, ids), offsets(nodes, ids), 'the block keeps its shape');
  for (const node of sent) assert.deepEqual(at(next, node.id).mapPosition, node.position, 'the map position is kept for surfacing');
  const cluster = bounds(existing.map(footprint)), block = bounds(ids.map(id => footprint(at(next, id))));
  assert.equal(block.left, cluster.right + ITEM_GAP, 'directly to the right of the cluster');
  assert.equal(block.top, cluster.top);
  for (const node of existing) assert.deepEqual(at(next, node.id).position, node.position, 'items already below stay where they are');
});

test('blocked on the right, the block takes the next side and stays out of other projects’ fields', () => {
  const nodes = [project('p'), project('q', 600, 0),
    item('x', 'p', 0, 0, { belowAt: AT }), item('q1', 'q', 500, 0, { belowAt: AT }),
    item('a', 'p', 0, 0), item('b', 'p', 0, 70)];
  const next = sendBelow(nodes, ['a', 'b'], AT, footprint);
  assertClearBelow(next); assertOutsideFields(next, ['a', 'b'], 'p');
  const cluster = bounds([footprint(nodes[2])]), block = bounds(['a', 'b'].map(id => footprint(at(next, id))));
  assert.equal(block.top, cluster.bottom + ITEM_GAP, 'below the cluster');
  assert.equal(block.left, cluster.left);
  assert.deepEqual(offsets(next, ['a', 'b']), offsets(nodes, ['a', 'b']));
});

test('a floating item that would overlap items below moves clear; an unobstructed one stays put', () => {
  const nodes = [project('p'), item('x', 'p', 0, 0, { belowAt: AT }), item('f', undefined, 2000, 0), item('g', undefined, 0, 0)];
  const kept = sendBelow(nodes, ['f'], AT, footprint);
  assert.deepEqual(at(kept, 'f').position, { x: 2000, y: 0 });
  const moved = sendBelow(nodes, ['g'], AT, footprint);
  assertClearBelow(moved); assertOutsideFields(moved, ['g'], undefined);
  assert.deepEqual(at(moved, 'g').mapPosition, { x: 0, y: 0 });
});

test('a project sent below keeps its internal layout and lands clear of other projects below', () => {
  const nodes = [project('q', 0, 0, { belowAt: AT }), item('q1', 'q', 0, 0), item('q2', 'q', 200, 0),
    project('p', 100, 0), item('a', 'p', 100, 0), item('b', 'p', 300, 80), item('old', 'p', 500, 0, { archivedAt: AT })];
  const next = sendBelow(nodes, ['p'], AT, footprint);
  assertClearBelow(next); assertOutsideFields(next, ['a', 'b'], 'p');
  const moved = ['p', 'a', 'b', 'old'];
  assert.deepEqual(offsets(next, moved), offsets(nodes, moved), 'project, members and archived members move together');
  for (const id of moved) assert.deepEqual(at(next, id).mapPosition, at(nodes, id).position);
  assert.equal(at(next, 'p').belowAt, AT); assert.equal(at(next, 'a').belowAt, undefined, 'members follow their project');
  assert.deepEqual(at(next, 'q1').position, { x: 0, y: 0 });
});

test('a project sent below with nothing else there keeps its position', () => {
  const nodes = [project('p'), item('a', 'p', 0), item('b', 'p', 200)];
  assert.deepEqual(sendBelow(nodes, ['p'], AT, footprint).map(node => node.position), nodes.map(node => node.position));
});

test('placement is deterministic and independent of selection order', () => {
  const nodes = [project('p'), project('q', 300, 0), item('x', 'p', 0, 0, { belowAt: AT }), item('y', 'q', 300, 0, { belowAt: AT }),
    item('a', 'p', 0, 0), item('b', 'q', 300, 0), item('c', undefined, 150, 0)];
  const forward = sendBelow(nodes, ['a', 'b', 'c'], AT, footprint), backward = sendBelow(nodes, ['c', 'b', 'a'], AT, footprint);
  assert.deepEqual(forward, backward);
  assert.deepEqual(sendBelow(nodes, ['a', 'b', 'c'], AT, footprint), forward);
  assertClearBelow(forward);
});

test('items already below or archived are not moved again', () => {
  const nodes = [project('p'), item('x', 'p', 0, 0, { belowAt: AT }), item('a', 'p', 0, 0, { archivedAt: AT })];
  assert.throws(() => sendBelow(nodes, ['a'], AT, footprint), /Restore it from the archive first/);
  assert.deepEqual(sendBelow(nodes, ['x'], '2026-10-02T00:00:00.000Z', footprint), nodes);
});

test('surfacing restores the saved map position of the node and the members that went with it', () => {
  const nodes = [project('q', 0, 0, { belowAt: AT }), item('q1', 'q', 0, 0),
    project('p', 100, 0), item('a', 'p', 100, 0), item('b', 'p', 0, 300, { belowAt: AT })];
  const below = sendBelow(nodes, ['p'], AT, footprint);
  const returned = restoreMapPositions(below.map(node => node.id === 'p' ? { ...node, belowAt: undefined } : node), 'p');
  for (const id of ['p', 'a']) {
    assert.deepEqual(at(returned, id).position, at(nodes, id).position);
    assert.equal(at(returned, id).mapPosition, undefined);
  }
  assert.deepEqual(at(returned, 'b'), at(below, 'b'), 'an item sent below on its own stays below');
  const single = sendBelow([project('r'), item('x', 'r', 0, 0, { belowAt: AT }), item('c', 'r', 0, 0)], ['c'], AT, footprint);
  assert.deepEqual(at(restoreMapPositions(single, 'c'), 'c').position, { x: 0, y: 0 });
  assert.deepEqual(restoreMapPositions(nodes, 'a'), nodes, 'nodes sent below before positions were saved keep theirs');
});
