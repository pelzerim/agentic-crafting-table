import test from 'node:test';
import assert from 'node:assert/strict';
import { SNAP_PITCH, snapPosition, snapStep } from './snap.ts';
import { freePosition } from './footprints.ts';
import { moveItems, ITEM_GAP, layoutFootprints } from './movement.ts';
import { overlaps } from './spatial.ts';
import type { GraphNode } from './graph.ts';
import { createResourcePluginRegistry } from '../resource-plugins/builtins.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';

const onGrid = (position: { x: number; y: number }, pitch = SNAP_PITCH) => position.x % pitch === 0 && position.y % pitch === 0;

test('a centre snaps to the nearest grid point; no pitch leaves it alone', () => {
  assert.equal(SNAP_PITCH, 48);
  assert.deepEqual(snapPosition({ x: 70, y: -30 }, 48), { x: 48, y: -48 });
  assert.deepEqual(snapPosition({ x: 73, y: 0 }, 48), { x: 96, y: 0 });
  assert.deepEqual(snapPosition({ x: 24, y: 23 }, 48), { x: 48, y: 0 });
  assert.deepEqual(snapPosition({ x: 70, y: -30 }, undefined), { x: 70, y: -30 });
  assert.deepEqual(snapPosition({ x: 70.4, y: -30.6 }, undefined), { x: 70.4, y: -30.6 });
});

test('an arrow key walks one grid cell when snapping, otherwise its usual step', () => {
  assert.equal(snapStep(10, 48), 48);
  assert.equal(snapStep(100, 48), 96);
  assert.equal(snapStep(10, undefined), 10);
});

test('a clear edge chosen with a pitch lies on the grid and still clears the obstacle', () => {
  const box = { id: 'new', x: 0, y: 0, width: 150, height: 48 }, obstacle = { id: 'old', x: 0, y: 0, width: 200, height: 84 };
  const free = freePosition(box, [obstacle], ITEM_GAP, 48);
  assert.ok(onGrid(free), `${free.x},${free.y}`);
  assert.equal(overlaps({ ...box, ...free }, obstacle, ITEM_GAP), false);
  assert.deepEqual(freePosition(box, [], ITEM_GAP, 48), { x: 0, y: 0 }, 'a clear requested spot is kept as asked');
  const unsnapped = freePosition(box, [obstacle], ITEM_GAP);
  assert.equal(onGrid(unsnapped), false, 'without a pitch the edge sits at the gap');
});

const registry = createResourcePluginRegistry();
const resources: ResourceRecord[] = [{ id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { sessionId: 'native-session', provider: 'claude' } }];
const item = (id: string, x: number, y = 0): GraphNode => ({ id, title: id, resourceId: 'agent-r', position: { x, y } });

test('a displaced neighbour settles on the grid when moves snap', () => {
  const nodes = [item('held', -500), item('bystander', 10, 5)];
  const result = moveItems(nodes, resources, registry, [{ id: 'held', position: { x: 0, y: 0 } }], {}, 48);
  const bystander = result.find(node => node.id === 'bystander')!;
  assert.notDeepEqual(bystander.position, { x: 10, y: 5 });
  assert.ok(onGrid(bystander.position), `${bystander.position.x},${bystander.position.y}`);
  const boxes = layoutFootprints(result, resources, registry);
  assert.equal(overlaps(boxes[0], boxes[1], ITEM_GAP), false);
});
