import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { detectPlots } from '../../src/graph/plots.ts';
import type { PlotView } from '../../src/graph/plots.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { ITEM_GAP, layoutFootprints } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { TIDY_GAP, finishedItems, lineUp, planTidy, tidyTier, readingOrder, tidyDrift, tidyFingerprint } from './tidy.ts';
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

test('the preview fingerprint ignores Undermap items, which a window on the map layer does not hold', () => {
  const { state, plots } = board();
  const below = { ...state, nodes: [...state.nodes, item('u1', 5000, 5000, 'acme', { belowAt: '2026-01-01T00:00:00Z' })], resources: [...state.resources, resource('u1')] };
  const print = (value: TidyInput['state']) => { const entry = input(value, plots, { projectId: 'acme' }); return tidyFingerprint(entry, planTidy(entry, ALL)); };
  assert.equal(print(below), print(state));
  assert.notEqual(print({ ...state, nodes: state.nodes.map(node => node.id === 'a1' ? { ...node, belowAt: '2026-01-01T00:00:00Z' } : node) }), print(state));
});

test('a linked plot lines up as a tree, each column one gap from the last', () => {
  // A PR linking a session and two reviews; the session links three artifacts.
  const ids = ['codex', 'session', 'pr', 'claude', 'mockups', 'tour', 'card', 'loose1'];
  const nodes: Node[] = [{ id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node,
    ...ids.map((id, i) => item(id, 200 + (i % 3) * 300, 40 + Math.floor(i / 3) * 130))];
  const link = (sourceId: string, targetId: string) => ({ id: `${sourceId}-${targetId}`, sourceId, targetId, kind: 'reference', label: '' });
  const links = [link('session', 'mockups'), link('session', 'tour'), link('session', 'card'), link('pr', 'session'), link('pr', 'claude'), link('pr', 'codex')];
  const state = { nodes, resources: nodes.flatMap(node => node.resourceId ? [resource(node.id)] : []), links } as unknown as TidyInput['state'];
  const plots = [plot('p', ids)], options = { ...ALL, spacePlots: false, colors: false };
  const plan = planTidy(input(state, plots), options), after = applied(state, plan);
  const box = (id: string) => itemFootprint(after.nodes.find(node => node.id === id)!, state.resources, registry);
  const left = (id: string) => box(id).x - box(id).width / 2, right = (id: string) => box(id).x + box(id).width / 2;
  // The session links most, so it is the root; each item's links share the column to its right.
  for (const [parent, kids] of [['session', ['pr', 'mockups', 'tour', 'card']], ['pr', ['codex', 'claude']]] as const)
    for (const kid of kids) assert.equal(left(kid), right(parent) + TIDY_GAP, `${kid} sits one gap right of ${parent}`);
  assert.ok(box('loose1').y - box('loose1').height / 2 >= Math.max(...ids.slice(0, 7).map(id => box(id).y + box(id).height / 2)) + TIDY_GAP, 'unlinked members go underneath');
  assert.deepEqual(planTidy(input(after, plots), options).moves, []);
});

test('siblings linked to each other line up next to each other', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const nodes: Node[] = [{ id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node, ...ids.map((id, i) => item(id, 200 + i * 300, 40))];
  const links = [['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'd']].map(([sourceId, targetId]) => ({ id: sourceId + targetId, sourceId, targetId, kind: 'context', label: '' }));
  const state = { nodes, resources: nodes.flatMap(node => node.resourceId ? [resource(node.id)] : []), links } as unknown as TidyInput['state'];
  const plots = [plot('p', ids)], options = { ...ALL, spacePlots: false, colors: false };
  const after = applied(state, planTidy(input(state, plots), options));
  const y = (id: string) => after.nodes.find(node => node.id === id)!.position.y;
  assert.ok(y('b') < y('d') && y('d') < y('c'), 'c no longer sits between b and d');
  assert.deepEqual(planTidy(input(after, plots), options).moves, []);
});

test('a fan with a big card stays one gap from its parent', () => {
  const boxes = [{ id: 'hub', x: 0, y: 0, width: 360, height: 115 }, { id: 'note', x: 900, y: 0, width: 640, height: 413 },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `k${i}`, x: 300 * i, y: 600, width: 420, height: 80 }))];
  const links = boxes.slice(1).map(box => ({ id: box.id, sourceId: 'hub', targetId: box.id, kind: 'reference' as const, label: '' }));
  const out = lineUp(boxes, links), at = new Map(out.map(box => [box.id, box]));
  for (const { targetId } of links) assert.equal(at.get(targetId)!.x - at.get(targetId)!.width / 2, at.get('hub')!.x + 180 + TIDY_GAP);
});

test('plots linked to each other pack side by side, ahead of reading order', () => {
  const acme = { id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node;
  const nodes = [acme, item('a1', 0, 0), item('b1', 600, 0), item('c1', 0, 600), item('d1', 600, 600)];
  const link = { id: 'ad', sourceId: 'a1', targetId: 'd1', kind: 'reference', label: '' };
  const state = { nodes, resources: nodes.flatMap(node => node.resourceId ? [resource(node.id)] : []), links: [link] } as unknown as TidyInput['state'];
  const plots = ['a', 'b', 'c', 'd'].map(id => plot(`p${id}`, [`${id}1`], { color: (['sky', 'rose', 'citron', 'mint'] as const)[id.charCodeAt(0) - 97] as PlotView['color'] }));
  const options = { ...ALL, colors: false }, after = applied(state, planTidy(input(state, plots), options));
  const at = (id: string) => after.nodes.find(node => node.id === id)!.position;
  assert.equal(at('d1').y, at('a1').y, 'd packs right after a, in its row');
  assert.ok(at('b1').y > at('a1').y, 'b moves to the next row');
  assert.deepEqual(planTidy(input(after, plots), options).moves, []);
});

test('a chain through a plot that sits beside a locked one plans nothing on a second run', () => {
  const acme = { id: 'acme', title: 'Acme', position: { x: 0, y: 0 } } as Node;
  const nodes = [acme, item('a1', 0, 0), item('b1', 600, 600), item('c1', 0, 600), item('d1', 600, 0)];
  const links = [['a1', 'b1'], ['b1', 'c1']].map(([sourceId, targetId], i) => ({ id: String(i), sourceId, targetId, kind: 'reference', label: '' }));
  const state = { nodes, resources: nodes.flatMap(node => node.resourceId ? [resource(node.id)] : []), links } as unknown as TidyInput['state'];
  const plots = ['a', 'b', 'c', 'd'].map(id => plot(`p${id}`, [`${id}1`], { ...id === 'a' ? { locked: true } : {}, color: (['sky', 'rose', 'citron', 'mint'] as const)[id.charCodeAt(0) - 97] as PlotView['color'] }));
  const options = { ...ALL, colors: false }, after = applied(state, planTidy(input(state, plots), options));
  assert.deepEqual(planTidy(input(after, plots), options).moves, []);
});

test('a ticket roots its tree: agents beside it, their PRs beside them, however many links an agent has', () => {
  // The second agent links most, as on a real board; it still sits under the ticket, one gap away.
  const kinds: Record<string, string> = { ticket: 'linear.ticket', agent1: 'agent.session', agent2: 'agent.session', pr1: 'github.pull-request', pr2: 'github.pull-request', pr3: 'github.pull-request', pr4: 'github.pull-request', pr5: 'github.pull-request', pr6: 'github.pull-request' };
  const boxes = Object.keys(kinds).map((id, i) => ({ id, x: 300 * (i % 3), y: 120 * Math.floor(i / 3), width: 240, height: 64 }));
  const links = [['ticket', 'agent1'], ['pr1', 'agent1'], ['pr1', 'ticket'], ['pr2', 'agent1'], ['pr1', 'pr2'], ['pr3', 'agent1'], ['pr3', 'pr1'], ['ticket', 'agent2'], ['pr1', 'agent2'],
    ['agent1', 'agent2'], ['pr4', 'agent2'], ['pr5', 'agent2'], ['pr4', 'pr5'], ['pr1', 'pr5'], ['pr6', 'agent2']].map(([sourceId, targetId], i) => ({ id: String(i), sourceId, targetId, kind: 'reference' as const, label: '' }));
  const tier = (id: string) => tidyTier(kinds[id]), out = lineUp(boxes, links, tier), at = new Map(out.map(box => [box.id, box]));
  const left = (id: string) => at.get(id)!.x - at.get(id)!.width / 2, right = (id: string) => at.get(id)!.x + at.get(id)!.width / 2, y = (id: string) => at.get(id)!.y;
  assert.equal(left('agent1'), right('ticket') + TIDY_GAP, 'agents one gap right of the ticket');
  assert.equal(left('agent2'), left('agent1'));
  for (const pr of ['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6']) assert.equal(left(pr), right('agent1') + TIDY_GAP, `${pr} one gap right of the agents`);
  // A PR linked to both agents stays with the one it was linked to first.
  assert.ok(Math.max(...['pr1', 'pr2', 'pr3'].map(y)) < Math.min(...['pr4', 'pr5', 'pr6'].map(y)), 'each agent keeps its own PRs together');
  assert.ok(y('agent1') < y('agent2'));
  const byId = (boxes: typeof out) => [...boxes].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(byId(lineUp(out, links, tier)), byId(out), 'a second run moves nothing');
});

test('a linked loop through a note settles in one Tidy, wherever its cards start', () => {
  const kinds: Record<string, string> = { ticket: 'linear.ticket', note: 'workspace.note', agent: 'agent.session', pr: 'github.pull-request' };
  const links = [['ticket', 'note'], ['note', 'agent'], ['agent', 'pr'], ['pr', 'ticket']].map(([sourceId, targetId], i) => ({ id: String(i), sourceId, targetId, kind: 'reference' as const, label: '' }));
  const tier = (id: string) => tidyTier(kinds[id]), byId = (boxes: { id: string }[]) => [...boxes].sort((a, b) => a.id.localeCompare(b.id));
  for (const order of [['ticket', 'note', 'pr', 'agent'], ['ticket', 'pr', 'note', 'agent'], ['agent', 'pr', 'note', 'ticket']]) {
    const out = lineUp(order.map((id, i) => ({ id, x: 0, y: 100 * i, width: 240, height: 64 })), links, tier);
    assert.deepEqual(byId(lineUp(out, links, tier)), byId(out), `settled from ${order.join(', ')}`);
  }
});
