import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode } from './graph.ts';
import { moveItems, repairLayout, layoutFootprints, ITEM_GAP } from './movement.ts';
import { overlaps } from './spatial.ts';
import { freePosition, itemFootprint } from './footprints.ts';
import { createResourcePluginRegistry } from '../resource-plugins/builtins.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';

const registry = createResourcePluginRegistry();
registry.register({ ...registry.get('linear.ticket')!, id: 'fixture.wide', mapSizes: undefined, appearance: { size: 'small', tone: 'neutral', shape: 'rounded', width: 380 } });
const resources: ResourceRecord[] = [
  { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { sessionId: 'native-session', provider: 'claude' } },
  { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'test', number: 1 } },
  { id: 'wide-r', pluginId: 'fixture.wide', schemaVersion: 1, title: 'Wide plugin', data: { issueId: 'T-1' } },
];
const item = (id: string, x: number, y = 0, resourceId = 'agent-r', projectId?: string): GraphNode => ({ id, title: id, resourceId, projectId, position: { x, y } });
const positions = (nodes: readonly GraphNode[]) => Object.fromEntries(nodes.map(node => [node.id, node.position]));
function assertClear(nodes: readonly GraphNode[]) {
  const boxes = layoutFootprints(nodes, resources, registry);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j], ITEM_GAP), false, `${boxes[i].id} overlaps ${boxes[j].id}`);
}

test('held item stays exact; displaced plugin cards clear their full footprints without changing identity', () => {
  const input = [item('held', -500), item('pr', 0, 0, 'pr-r'), item('wide', 350, 0, 'wide-r'), item('distant', 1800)];
  const original = structuredClone(input), intent = [{ id: 'held', position: { x: 0, y: 0 } }];
  assert.equal(itemFootprint(input[2], resources, registry).width, 380);
  const result = moveItems(input, resources, registry, intent);
  assert.deepEqual(result[0].position, intent[0].position);
  assert.notDeepEqual(result[1].position, input[1].position);
  assert.deepEqual(result[2], input[2]); assert.deepEqual(result[3], input[3]);
  assertClear(result);
  assert.deepEqual(result.map(({ position, ...node }) => node), input.map(({ position, ...node }) => node));
  assert.deepEqual(positions(moveItems([...input].reverse(), resources, registry, intent)), positions(result));
  assert.deepEqual(moveItems(result, resources, registry, intent), result);
  assert.deepEqual(input, original);
});

test('project moves pin the entire group, translate archived members and displace outside obstructions', () => {
  const input = [
    { id: 'project', title: 'Project', position: { x: -400, y: -400 } },
    item('a', 0, 0, 'agent-r', 'project'), item('b', 400, 0, 'pr-r', 'project'),
    { ...item('archived', 0, 0, 'agent-r', 'project'), archivedAt: '2026-01-01T00:00:00Z' }, item('obstacle', 700),
  ];
  const result = moveItems(input, resources, registry, [{ id: 'project', position: { x: 300, y: -400 } }]);
  for (let i = 0; i < 4; i++) assert.deepEqual(result[i].position, { x: input[i].position.x + 700, y: input[i].position.y });
  assert.notDeepEqual(result[4].position, input[4].position);
  assertClear(result);
});

test('populated project anchors and archived descendants are not invisible obstacles; empty projects are', () => {
  const input = [
    { id: 'project', title: 'Project', position: { x: 0, y: 0 } }, item('member', 600, 0, 'pr-r', 'project'), item('held', -500),
    { id: 'archived-project', title: 'Archived', position: { x: 0, y: 0 }, archivedAt: '2026-01-01T00:00:00Z' }, item('hidden', 0, 0, 'agent-r', 'archived-project'),
    { id: 'empty', title: 'Empty', position: { x: 1300, y: 0 } },
  ];
  const ontoAnchor = moveItems(input, resources, registry, [{ id: 'held', position: { x: 0, y: 0 } }]);
  assert.deepEqual(ontoAnchor.filter(node => node.id !== 'held'), input.filter(node => node.id !== 'held'));
  const ontoEmpty = moveItems(input, resources, registry, [{ id: 'held', position: { x: 1300, y: 0 } }]);
  assert.notDeepEqual(ontoEmpty[5].position, input[5].position); assertClear(ontoEmpty);
});

test('batch intents reject overlapping targets, duplicates, nonfinite positions and conflicting project offsets', () => {
  const nodes = [item('a', 0), item('b', 400)];
  assert.throws(() => moveItems(nodes, resources, registry, nodes.map(node => ({ id: node.id, position: { x: 20, y: 20 } }))), /positions overlap/);
  assert.throws(() => moveItems(nodes, resources, registry, [{ id: 'a', position: { x: Infinity, y: 0 } }]), /finite/);
  assert.throws(() => moveItems(nodes, resources, registry, [{ id: 'missing', position: { x: 0, y: 0 } }]), /Node not found/);
  assert.throws(() => moveItems(nodes, resources, registry, [nodes[0], nodes[0]]), /only once/);
  const group = [{ id: 'project', title: 'Project', position: { x: -500, y: 0 } }, { ...nodes[0], projectId: 'project' }];
  assert.throws(() => moveItems(group, resources, registry, [{ id: 'project', position: { x: 0, y: 0 } }, { id: 'a', position: { x: 700, y: 0 } }]), /member offsets/);
  const matching = [{ id: 'a', position: { x: 500, y: 0 } }, { id: 'project', position: { x: 0, y: 0 } }];
  assert.deepEqual(moveItems(group, resources, registry, matching)[1].position, matching[0].position);
});

test('translating an older overlapping project preserves its offsets; a member move repairs overlap', () => {
  const input = [{ id: 'project', title: 'Project', position: { x: -500, y: 0 } }, item('a', 0, 0, 'agent-r', 'project'), item('b', 0, 0, 'pr-r', 'project')];
  const group = moveItems(input, resources, registry, [{ id: 'project', position: { x: 100, y: 200 } }]);
  assert.deepEqual(group[1].position, group[2].position);
  assertClear(moveItems(group, resources, registry, [{ id: 'a', position: group[1].position }]));
});

test('explicit legacy-layout repair clears overlaps deterministically without touching hidden nodes or metadata', () => {
  const input = [
    { id: 'project', title: 'Project', position: { x: 0, y: 0 } },
    item('a', 0, 0, 'agent-r', 'project'), item('b', 0, 0, 'pr-r', 'project'),
    item('wide', 0, 0, 'wide-r'), item('distant', -1800),
    { ...item('archived', 0), archivedAt: '2026-01-01T00:00:00Z' },
    { id: 'hidden-project', title: 'Hidden', position: { x: 0, y: 0 }, archivedAt: '2026-01-01T00:00:00Z' },
    item('hidden-member', 0, 0, 'agent-r', 'hidden-project'),
    { id: 'empty', title: 'Empty', position: { x: 0, y: 0 } },
  ];
  const before = structuredClone(input), repaired = repairLayout(input, resources, registry);
  assertClear(repaired);
  for (const id of ['project', 'distant', 'archived', 'hidden-project', 'hidden-member']) assert.deepEqual(repaired.find(node => node.id === id), input.find(node => node.id === id));
  assert.deepEqual(repaired.map(({ position, ...node }) => node), input.map(({ position, ...node }) => node));
  assert.deepEqual(positions(repairLayout([...input].reverse(), resources, registry)), positions(repaired));
  assert.deepEqual(repairLayout(repaired, resources, registry), repaired);
  assert.deepEqual(input, before);
  const nearby = [item('a', 0), item('b', 0), item('z-clear', 0, -240)];
  const fixed = repairLayout(nearby, resources, registry);
  assert.deepEqual(fixed[2], nearby[2], 'reserve a nearby clear item before displacing the overlap toward it');
  assertClear(fixed);
});

test('seeded dense mixed footprints stay clear and deterministic across negative coordinates and repeated drops', () => {
  let seed = 80471;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  let nodes: GraphNode[] = [];
  for (let i = 0; i < 48; i++) {
    const node = item(`node-${i}`, Math.round(random() * 800) - 600, Math.round(random() * 800) - 600, resources[i % resources.length].id);
    node.position = freePosition(itemFootprint(node, resources, registry), layoutFootprints(nodes, resources, registry)); nodes.push(node);
  }
  for (let i = 0; i < 32; i++) {
    const held = nodes[Math.floor(random() * nodes.length)], target = nodes[Math.floor(random() * nodes.length)];
    const intent = [{ id: held.id, position: { ...target.position } }];
    const next = moveItems(nodes, resources, registry, intent);
    assert.deepEqual(next.find(node => node.id === held.id)!.position, target.position);
    assert.deepEqual(positions(moveItems([...nodes].reverse(), resources, registry, intent)), positions(next));
    assertClear(next); nodes = next;
  }
});

test('solid moves stop at the first item in the way and leave it in place', () => {
  const input = [item('held', -800), item('wall', 0)];
  const held = itemFootprint(input[0], resources, registry), wall = itemFootprint(input[1], resources, registry);
  const result = moveItems(input, resources, registry, [{ id: 'held', position: { x: 0, y: 0 } }], {}, undefined, 'solid');
  assert.deepEqual(result[1], input[1]);
  assert.ok(Math.abs(result[0].position.x - (-(held.width + wall.width) / 2 - ITEM_GAP)) < .01, `stopped at ${result[0].position.x}`);
  assert.equal(result[0].position.y, 0);
  assertClear(result);
});

test('solid moves slide along an item and land on clear targets beyond it', () => {
  const input = [item('held', -800), item('wall', 0)];
  const held = itemFootprint(input[0], resources, registry), wall = itemFootprint(input[1], resources, registry);
  const slid = moveItems(input, resources, registry, [{ id: 'held', position: { x: 0, y: 40 } }], {}, undefined, 'solid');
  assert.ok(Math.abs(slid[0].position.x - (-(held.width + wall.width) / 2 - ITEM_GAP)) < .01);
  assert.ok(Math.abs(slid[0].position.y - 40) < .01, `slid to ${slid[0].position.y}`);
  const beyond = moveItems(input, resources, registry, [{ id: 'held', position: { x: 900, y: 0 } }], {}, undefined, 'solid');
  assert.deepEqual(beyond[0].position, { x: 900, y: 0 }); assert.deepEqual(beyond[1], input[1]);
});

test('solid project moves stop the whole group together, keeping member offsets', () => {
  const input = [
    { id: 'project', title: 'Project', position: { x: -1500, y: 0 } },
    item('a', -1000, 0, 'agent-r', 'project'), item('b', -1000, 300, 'pr-r', 'project'), item('wall', 0),
  ];
  const result = moveItems(input, resources, registry, [{ id: 'project', position: { x: -500, y: 0 } }], {}, undefined, 'solid');
  assert.deepEqual(result[3], input[3]);
  const dx = result[1].position.x - input[1].position.x;
  assert.ok(dx > 0 && dx < 1000, `moved ${dx}`);
  for (const index of [0, 2]) assert.deepEqual(result[index].position, { x: input[index].position.x + dx, y: input[index].position.y });
  assertClear(result);
});

test('solid moves on a grid stop at the last clear grid point', () => {
  const input = [item('held', -960), item('wall', 0)];
  const result = moveItems(input, resources, registry, [{ id: 'held', position: { x: 0, y: 0 } }], {}, 48, 'solid');
  assert.deepEqual(result[1], input[1]);
  assert.equal(Math.abs(result[0].position.x % 48), 0); assert.equal(Math.abs(result[0].position.y), 0);
  assertClear(result);
});
