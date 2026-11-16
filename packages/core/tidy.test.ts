import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { detectPlots } from '../../src/graph/plots.ts';
import type { PlotView } from '../../src/graph/plots.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { ITEM_GAP, layoutFootprints } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { finishedItems, planTidy, readingOrder, tidyDrift } from './tidy.ts';
import type { TidyInput, TidyOptions, TidyPlan } from './tidy.ts';
import type { WorkspaceState } from './control.ts';

const registry = createResourcePluginRegistry();
const resource = (id: string) => ({ id: `${id}-r`, pluginId: 'linear.ticket', schemaVersion: 1, title: id, data: { issueId: `ACME-${id}` } });
type Node = WorkspaceState['nodes'][number];
const item = (id: string, x: number, y: number, projectId = 'acme', extra: Partial<Node> = {}): Node => ({ id, title: id, resourceId: `${id}-r`, projectId, position: { x, y }, ...extra } as Node);
const plot = (id: string, memberIds: string[], extra: Partial<PlotView> = {}): PlotView => ({ id, projectId: 'acme', memberIds, name: id, source: 'local', hidden: false, color: 'rose', pinnedMemberIds: [], ...extra });
const ALL: TidyOptions = { lineUp: true, spacePlots: true, colors: true, archive: false };

function board() {
  const nodes: Node[] = [
    { id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node,
    item('a1', 200, 40), item('a2', 470, 60), item('a3', 210, 130), item('a4', 480, 150),
    item('b1', 900, 40), item('b2', 1170, 20), item('b3', 1000, 130),
    item('c1', 200, 600), item('c2', 470, 600), item('c3', 740, 600),
    { id: 'beta', title: 'Beta', position: { x: 3000, y: 0 } } as Node,
    item('z1', 3000, 100, 'beta'), item('z2', 3290, 110, 'beta'), item('z3', 3580, 90, 'beta'), item('z4', 3000, 900, 'beta'), item('z5', 3600, 900, 'beta'),
    item('loose', -600, -600, undefined),
  ];
  const plots = [plot('pa', ['a1', 'a2', 'a3', 'a4'], { color: 'sky' }), plot('pb', ['b1', 'b2', 'b3'], { color: 'sky', chosenColor: 'sky' }),
    plot('pc', ['c1', 'c2', 'c3'], { color: 'citron', locked: true }), plot('pz', ['z1', 'z2', 'z3'], { projectId: 'beta' })];
  const state = { nodes, resources: nodes.flatMap(node => node.resourceId ? [resource(node.id)] : []), links: [] } as unknown as TidyInput['state'];
  return { state, plots };
}
const input = (state: TidyInput['state'], plots: PlotView[], extra: Partial<TidyInput> = {}): TidyInput => ({ state, registry, plots, now: Date.parse('2026-01-15T12:00:00Z'), ...extra });
const applied = (state: TidyInput['state'], plan: TidyPlan) => ({ ...state, nodes: state.nodes.map(node => { const move = plan.moves.find(entry => entry.id === node.id); return move ? { ...node, position: move.to } : node; }) });
const recolored = (plots: PlotView[], plan: TidyPlan) => plots.map(entry => {
  const change = plan.colors.find(color => color.plotId === entry.id), pin = plan.pins.find(row => row.plotId === entry.id);
  return { ...entry, ...change ? { color: change.to } : {}, ...pin ? { pinnedMemberIds: pin.memberIds } : {} };
});

test('tidy is deterministic and a tidied board plans nothing', () => {
  const { state, plots } = board();
  const plan = planTidy(input(state, plots), ALL);
  assert.deepEqual(planTidy(input(structuredClone(state), structuredClone(plots)), ALL), plan);
  assert.ok(plan.moves.length > 0);
  const again = planTidy(input(applied(state, plan), recolored(plots, plan)), ALL);
  assert.deepEqual(again.moves, []);
  assert.deepEqual(again.colors, []);
  assert.deepEqual(again.pins, []);
});

test('tidy keeps plot membership, clears every footprint and never touches locked plots or free items', () => {
  const { state, plots } = board();
  const plan = planTidy(input(state, plots), ALL), after = applied(state, plan);
  for (const id of ['c1', 'c2', 'c3', 'loose']) assert.equal(plan.moves.some(move => move.id === id), false, id);
  const boxes = after.nodes.filter(node => node.projectId).map(node => ({ ...itemFootprint(node, after.resources, registry), projectId: node.projectId! }));
  const pins = [...plots.filter(entry => entry.locked).map(entry => ({ plotId: entry.id, projectId: entry.projectId, memberIds: entry.memberIds, locked: true })), ...plan.pins];
  const detected = detectPlots(boxes, plots, () => 'new', [], pins).map(entry => [entry.id, [...entry.memberIds].sort()]);
  assert.deepEqual(Object.fromEntries(detected), Object.fromEntries(plots.map(entry => [entry.id, [...entry.memberIds].sort()])));
  const all = layoutFootprints(after.nodes, after.resources, registry);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.equal(overlaps(all[i], all[j], ITEM_GAP), false, `${all[i].id} overlaps ${all[j].id}`);
});

test('a plot keeps its reading order and its top-left corner', () => {
  const { state, plots } = board();
  const plan = planTidy(input(state, plots, { projectId: 'acme' }), { ...ALL, spacePlots: false }), after = applied(state, plan);
  const boxesOf = (nodes: readonly Node[]) => nodes.filter(node => node.id.startsWith('a')&& node.resourceId).map(node => itemFootprint(node, state.resources, registry));
  assert.deepEqual(readingOrder(boxesOf(after.nodes)).map(box => box.id), readingOrder(boxesOf(state.nodes)).map(box => box.id));
  const corner = (boxes: ReturnType<typeof boxesOf>) => ({ x: Math.min(...boxes.map(box => box.x - box.width / 2)), y: Math.min(...boxes.map(box => box.y - box.height / 2)) });
  assert.deepEqual(corner(boxesOf(after.nodes)), corner(boxesOf(state.nodes)));
  assert.equal(plan.moves.some(move => move.id.startsWith('z')), false);
});

test('only duplicate colours change and a chosen colour stays', () => {
  const { state, plots } = board();
  const plan = planTidy(input(state, plots), ALL);
  assert.deepEqual(plan.colors.map(change => change.plotId), ['pa']);
  assert.notEqual(plan.colors[0].to, 'sky');
  assert.notEqual(plan.colors[0].to, 'citron');
});

test('finished work excludes working, Needs me, recent and locked plot items', () => {
  const old = '2026-01-01T00:00:00Z', recent = '2026-01-14T00:00:00Z', now = Date.parse('2026-01-15T12:00:00Z');
  const nodes = [
    { id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node,
    item('done', 0, 0, 'acme', { completedAt: old }), item('merged', 0, 0, 'acme', { activity: 'complete', activityAt: old }),
    item('fresh', 0, 0, 'acme', { completedAt: recent }), item('busy', 0, 0, 'acme', { completedAt: old, activity: 'working' }),
    item('asks', 0, 0, 'acme', { completedAt: old, attention: 'input', attentionNote: 'Pick a name' } as Partial<Node>), item('held', 0, 0, 'acme', { completedAt: old }),
  ];
  assert.deepEqual(finishedItems(nodes, [plot('locked', ['held'], { locked: true })], now), ['done', 'merged']);
});

test('regroup moves an item into another plot and pins that membership', () => {
  const { state, plots } = board();
  const plan = planTidy(input(state, plots, { regroup: [{ itemId: 'a4', plotId: 'pb' }, { itemId: 'c1', plotId: 'pa' }, { itemId: 'z1', plotId: 'pa' }] }), ALL);
  const pb = plan.pins.find(pin => pin.plotId === 'pb');
  assert.deepEqual(pb?.memberIds, ['a4', 'b1', 'b2', 'b3']);
  assert.equal(plan.pins.some(pin => pin.memberIds.includes('c1') || pin.memberIds.includes('z1')), false);
});

test('a second tidy plans nothing, around fixed obstacles and with differing footprints', () => {
  const run = (state: TidyInput['state'], plots: PlotView[]) => {
    for (const options of [ALL, { ...ALL, lineUp: false }]) {
      const first = planTidy(input(state, plots), options), again = planTidy(input(applied(state, first), recolored(plots, first)), options);
      assert.deepEqual(again.moves, [], JSON.stringify(again.moves));
    }
  };
  const linked = (nodes: Node[], plots: PlotView[]) => ({ state: { nodes, resources: nodes.flatMap(node => node.resourceId ? [resource(node.id)] : []), links: [] } as unknown as TidyInput['state'], plots });
  const acme = { id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node;
  const two = linked([acme, item('p1', 0, -108), item('p2', 0, 200), item('q1', 1200, 0), item('q2', 1200, 200), item('ticket', 400, 0, 'acme', { projectId: undefined })], [plot('pp', ['p1', 'p2']), plot('pq', ['q1', 'q2'], { color: 'sky' })]);
  run(two.state, two.plots);
  const wide = { mapDimensions: { width: 520, height: 140 } } as Partial<Node>, tall = { mapDimensions: { width: 200, height: 420 } } as Partial<Node>;
  const mixed = linked([acme, item('p1', 0, 0, 'acme', wide), item('p2', 40, 260), item('q1', 1300, 0, 'acme', tall), item('q2', 1600, 30), item('r1', 300, 900), item('r2', 700, 950, 'acme', wide),
    item('ticket', 500, 120, 'acme', { projectId: undefined }), item('stone', 900, 500, 'acme', { ...tall, projectId: undefined })], [plot('pp', ['p1', 'p2']), plot('pq', ['q1', 'q2'], { color: 'sky' }), plot('pr', ['r1', 'r2'], { color: 'citron' })]);
  run(mixed.state, mixed.plots);
});

test('the drift check catches a layout that would move an item into another plot', () => {
  const { state, plots } = board(), options = { ...ALL, spacePlots: false, colors: false }, plan = planTidy(input(state, plots), options);
  assert.deepEqual(tidyDrift(input(state, plots), options, plan, applied(state, plan)), { membership: [], unsettled: [] });
  const pulled = { ...plan, moves: [...plan.moves.filter(move => move.id !== 'a4'), { id: 'a4', from: { x: 480, y: 150 }, to: { x: 1170, y: 120 } }] };
  assert.ok(tidyDrift(input(state, plots), options, pulled, applied(state, pulled)).membership.includes('a4'));
});
