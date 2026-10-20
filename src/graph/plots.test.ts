import test from 'node:test';
import assert from 'node:assert/strict';
import { PLOT_BRIDGE, PLOT_COLORS, PLOT_JOIN, PLOT_LEAVE, assignPlotColors, detectPlots, plotFallbackName, plotGap, plotPatches } from './plots.ts';
import type { PlotBox, PlotColor } from './plots.ts';

const card = (id: string, x: number, y: number, projectId = 'photos', width = 200, height = 60): PlotBox => ({ id, projectId, x, y, width, height });
let next = 0;
const fresh = () => `plot-${++next}`;
const ids = (plots: ReturnType<typeof detectPlots>) => plots.map(plot => plot.memberIds.join(','));
/** Three groups of three cards each, 190 px apart, plus two loose cards. */
const sample = () => [
  card('a1', 0, 0), card('a2', 260, 0), card('a3', 0, 100),
  card('b1', 800, 0), card('b2', 1060, 0), card('b3', 800, 100),
  card('c1', 0, 500), card('c2', 260, 500), card('c3', 0, 600),
  card('loose1', 1600, 900), card('loose2', 2200, 900),
];

test('the gap is measured between footprint edges', () => {
  assert.equal(plotGap(card('a', 0, 0), card('b', 272, 0)), 72);
  assert.equal(plotGap(card('a', 0, 0), card('b', 100, 20)), 0);
  assert.equal(plotGap(card('a', 0, 0), card('b', 230, 90)), Math.hypot(30, 30));
});

test('members within the join gap form plots of at least three items; pairs and loose items do not', () => {
  const plots = detectPlots(sample(), [], fresh);
  assert.deepEqual(ids(plots), ['a1,a2,a3', 'b1,b2,b3', 'c1,c2,c3']);
  assert.ok(plots.every(plot => plot.projectId === 'photos'));
  assert.deepEqual(detectPlots([card('x', 0, 0), card('y', 230, 0), ...sample().slice(9)], [], fresh), [], 'a pair is just neighbours');
});

test('a card joins within 72 px but leaves only past 120 px', () => {
  const start = sample(), joined = detectPlots([...start.filter(box => box.id !== 'a2'), card('a2', 200 + PLOT_JOIN, 0)], [], fresh);
  assert.ok(ids(joined).includes('a1,a2,a3'));
  const outside = detectPlots([...start.filter(box => box.id !== 'a2'), card('a2', 200 + PLOT_JOIN + 1, 0)], [], fresh);
  assert.ok(!ids(outside).includes('a1,a2,a3'), 'a new card beyond the join gap stays out');
  const nudged = detectPlots([...start.filter(box => box.id !== 'a2'), card('a2', 200 + PLOT_LEAVE, 0)], joined, fresh);
  assert.ok(ids(nudged).includes('a1,a2,a3'), 'an existing member stays within the leave gap');
  assert.equal(nudged.find(plot => plot.memberIds.includes('a2'))!.id, joined.find(plot => plot.memberIds.includes('a2'))!.id);
  const left = detectPlots([...start.filter(box => box.id !== 'a2'), card('a2', 200 + PLOT_LEAVE + 1, 0)], joined, fresh);
  assert.ok(!left.some(plot => plot.memberIds.includes('a2')), 'past the leave gap the member leaves');
});

test('a plot keeps its identity while it shares at least half its members, otherwise it is new', () => {
  const first = detectPlots(sample(), [], fresh), a = first.find(plot => plot.memberIds.includes('a1'))!;
  const grown = detectPlots([...sample(), card('a4', 260, 100)], first, fresh);
  assert.equal(grown.find(plot => plot.memberIds.includes('a4'))!.id, a.id);
  const replaced = detectPlots([...sample().filter(box => !['a2', 'a3'].includes(box.id)), card('n1', 0, 100), card('n2', 260, 100), card('n3', 260, 0)], first, fresh);
  assert.notEqual(replaced.find(plot => plot.memberIds.includes('a1'))!.id, a.id, 'Jaccard 1/6 is a new plot');
});

test('a plot holding more than 60% of its project or more than 12 items is not drawn', () => {
  assert.deepEqual(detectPlots([card('a1', 0, 0), card('a2', 260, 0), card('a3', 0, 100), card('loose', 1600, 0)], [], fresh), [], '3 of 4 is 75%');
  assert.equal(detectPlots([card('a1', 0, 0), card('a2', 260, 0), card('a3', 0, 100), card('l1', 1600, 0), card('l2', 2200, 0)], [], fresh).length, 1, '3 of 5 is exactly 60%');
  const grid = Array.from({ length: 13 }, (_, i) => card(`g${i}`, i * 260, 0));
  const others = Array.from({ length: 20 }, (_, i) => card(`o${i}`, i * 600, 2000));
  assert.deepEqual(detectPlots([...grid, ...others], [], fresh), [], '13 items is too large');
});

test('at most six plots per project, largest first with a stable tie-break', () => {
  const boxes = Array.from({ length: 8 }, (_, group) => Array.from({ length: group === 7 ? 4 : 3 }, (_, i) => card(`p${group}-${i}`, group * 1000 + (i % 2) * 260, Math.floor(i / 2) * 100))).flat();
  const plots = detectPlots(boxes, [], fresh);
  assert.equal(plots.length, 6);
  assert.deepEqual(plots[0].memberIds, ['p7-0', 'p7-1', 'p7-2', 'p7-3']);
  assert.deepEqual(plots.slice(1).map(plot => plot.memberIds[0]), ['p0-0', 'p1-0', 'p2-0', 'p3-0', 'p4-0']);
});

test('only members of the same project form a plot', () => {
  const boxes = [card('a1', 0, 0), card('a2', 260, 0, 'other'), card('a3', 0, 100), card('l1', 1600, 0), card('l2', 2200, 0), card('o1', 3000, 0, 'other'), card('o2', 3600, 0, 'other')];
  assert.deepEqual(detectPlots(boxes, [], fresh), []);
});

const link = (sourceId: string, targetId: string) => ({ sourceId, targetId });
const loose = (count: number) => Array.from({ length: count }, (_, i) => card(`loose-${i}`, 5000 + i * 600, 3000));

test('linked items join a plot however far apart they sit', () => {
  const boxes = [card('n2', 0, 0), card('pr1', 0, -200), card('pr2', 0, 230), card('ticket', 600, 0), ...loose(3)];
  assert.deepEqual(detectPlots(boxes, [], fresh), [], 'every gap is past the leave gap');
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, [link('n2', 'pr1'), link('n2', 'pr2'), link('ticket', 'n2')])), ['n2,pr1,pr2,ticket']);
});

test('a linked pair and a loose item make a plot together', () => {
  const boxes = [card('x1', 0, 0), card('x2', 230, 0), card('y', 0, 400), ...loose(2)];
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, [link('y', 'x2')])), ['x1,x2,y']);
});

test('links between two plots never join them', () => {
  assert.deepEqual(ids(detectPlots(sample(), [], fresh, [link('a1', 'b1'), link('c2', 'a2'), link('b3', 'c3')])), ['a1,a2,a3', 'b1,b2,b3', 'c1,c2,c3']);
});

test('an item linked to two plots joins the nearer one', () => {
  const boxes = [...sample(), card('x', 1200, 300)];
  for (const links of [[link('x', 'a1'), link('x', 'b2')], [link('b2', 'x'), link('a1', 'x')]]) assert.deepEqual(ids(detectPlots(boxes, [], fresh, links)), ['b1,b2,b3,x', 'a1,a2,a3', 'c1,c2,c3']);
});

test('items linked through each other join together, and links to other projects or missing items do not count', () => {
  const boxes = [...sample(), card('s1', 0, 1200), card('s2', 0, 1600), card('foreign', 0, 300, 'other'), card('o1', 3000, 0, 'other'), card('o2', 3600, 0, 'other')];
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, [link('s2', 's1'), link('s1', 'c3'), link('foreign', 'a1'), link('ghost', 'b1')])), ['c1,c2,c3,s1,s2', 'a1,a2,a3', 'b1,b2,b3']);
});

test('two linked items are a plot, however far apart and however small the project', () => {
  const pair = [card('x', 0, 0), card('y', 900, 700)];
  assert.deepEqual(ids(detectPlots(pair, [], fresh, [link('x', 'y')])), ['x,y'], 'the whole project');
  assert.deepEqual(ids(detectPlots([...pair, ...loose(4)], [], fresh, [link('y', 'x')])), ['x,y']);
  assert.deepEqual(ids(detectPlots([card('x', 0, 0), card('y', 230, 0), ...loose(4)], [], fresh, [link('x', 'y')])), ['x,y'], 'a linked pair of neighbours');
  assert.deepEqual(detectPlots([...pair, ...loose(4)], [], fresh), [], 'unlinked items are just items');
});

test('a linked group is never trimmed by the share of its project', () => {
  const boxes = Array.from({ length: 5 }, (_, i) => card(`n${i}`, i * 500, i * 300)), links = [link('n0', 'n1'), link('n1', 'n2'), link('n3', 'n2')];
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, links)), ['n0,n1,n2,n3'], '4 of 5 items');
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, [...links, link('n4', 'n0')])), ['n0,n1,n2,n3,n4'], 'every item of the project');
  const core = [card('a1', 0, 0), card('a2', 260, 0), card('a3', 0, 100)];
  assert.deepEqual(ids(detectPlots([...core, card('s', 0, 900), ...loose(2)], [], fresh, [link('s', 'a1')])), ['a1,a2,a3,s'], '4 of 6 is past 60% and stays whole');
});

test('a linked group is never trimmed by size', () => {
  const chain = Array.from({ length: 15 }, (_, i) => card(`c${String(i).padStart(2, '0')}`, i * 400, 0));
  const links = chain.slice(1).map((box, i) => link(chain[i].id, box.id));
  assert.deepEqual(ids(detectPlots([...chain, ...loose(3)], [], fresh, links)), [chain.map(box => box.id).join(',')]);
  const core = [card('a1', 0, 2000), card('a2', 260, 2000), card('a3', 0, 2100)];
  const spokes = Array.from({ length: 11 }, (_, i) => card(`s${String(i).padStart(2, '0')}`, 0, 2300 + i * 200));
  assert.deepEqual(ids(detectPlots([...core, ...spokes, ...loose(6)], [], fresh, spokes.map(box => link(box.id, 'a1')))), [['a1', 'a2', 'a3', ...spokes.map(box => box.id)].join(',')], '14 items around a proximity core');
});

test('a pile past the caps is not a plot, but the linked items in it are', () => {
  const pile = Array.from({ length: 13 }, (_, i) => card(`g${String(i).padStart(2, '0')}`, i * 260, 0)), others = Array.from({ length: 20 }, (_, i) => card(`o${i}`, i * 600, 2000));
  assert.deepEqual(ids(detectPlots([...pile, ...others], [], fresh, [link('g03', 'g04')])), ['g03,g04']);
  assert.deepEqual(ids(detectPlots([...pile, ...others], [], fresh, [link('g03', 'g09'), link('o2', 'g09')])), ['g03,g09,o2']);
  assert.deepEqual(ids(detectPlots([card('a1', 0, 0), card('a2', 260, 0), card('a3', 0, 100), card('far', 1600, 0)], [], fresh, [link('far', 'a1')])), ['a1,far'], '3 of 4 neighbours are a pile');
});

test('a link added between two existing plots never joins them', () => {
  const boxes = [card('a1', 0, 0), card('a2', 0, 600), card('b1', 900, 0), card('b2', 900, 600), ...loose(3)], pairs = [link('a1', 'a2'), link('b1', 'b2')];
  const before = detectPlots(boxes, [], fresh, pairs);
  assert.deepEqual(ids(before), ['a1,a2', 'b1,b2']);
  const after = detectPlots(boxes, before, fresh, [...pairs, link('a2', 'b1')]);
  assert.deepEqual(after, before, 'both plots stay as they were');
  assert.deepEqual(detectPlots(boxes, after, fresh, [...pairs, link('a2', 'b1'), link('b2', 'a1')]), before, 'and stay separate while they remain linked');
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, [...pairs, link('a2', 'b1')])), ['a1,a2,b1,b2'], 'with no plots yet the same links are one group');
  const cores = detectPlots(sample(), [], fresh);
  assert.deepEqual(detectPlots(sample(), cores, fresh, [link('a1', 'b1'), link('c2', 'a2')]), cores);
});

test('a link from a loose item to a plot pulls in the item and what is linked to it, except members of another plot', () => {
  const first = detectPlots(sample(), [], fresh), boxes = [...sample(), card('x', 0, 1200), card('y', 0, 1600), card('z', 0, 2000)];
  const joined = detectPlots(boxes, first, fresh, [link('x', 'c3')]);
  assert.deepEqual(ids(joined), ['c1,c2,c3,x', 'a1,a2,a3', 'b1,b2,b3']);
  assert.equal(joined[0].id, first.find(plot => plot.memberIds.includes('c1'))!.id);
  const chain = detectPlots(boxes, joined, fresh, [link('x', 'c3'), link('y', 'x'), link('z', 'y'), link('z', 'a1')]);
  assert.deepEqual(ids(chain), ['c1,c2,c3,x,y,z', 'a1,a2,a3', 'b1,b2,b3'], 'z is linked to another plot and still joins only this one');
});

test('a loose chain reaching two plots joins the one with the fewest hops, then the nearest, and never merges them', () => {
  const first = detectPlots(sample(), [], fresh), chain = [card('x1', 400, 1200), card('x2', 400, 1600), card('x3', 400, 2000)], along = [link('x1', 'x2'), link('x2', 'x3')];
  // c is the nearest plot, yet most of the chain is fewer links away from b.
  const hops = detectPlots([...sample(), ...chain], first, fresh, [...along, link('x1', 'c3'), link('x2', 'b1'), link('x3', 'b2')]);
  assert.deepEqual(ids(hops), ['b1,b2,b3,x1,x2,x3', 'a1,a2,a3', 'c1,c2,c3']);
  const tie = detectPlots([...sample(), ...chain], first, fresh, [...along, link('x1', 'b1'), link('c3', 'x3')]);
  assert.deepEqual(ids(tie), ['c1,c2,c3,x1,x2,x3', 'a1,a2,a3', 'b1,b2,b3'], 'the same hops from each: the nearest plot');
  assert.deepEqual(ids(detectPlots([...sample(), ...chain], [], fresh, [...along, link('x1', 'b1'), link('c3', 'x3')])), ids(tie), 'the same on first detection');
  assert.deepEqual(detectPlots([...sample(), ...chain], tie, fresh, [...along, link('x1', 'b1'), link('c3', 'x3'), link('x2', 'b2'), link('x3', 'b3')]), tie, 'once joined it stays, whatever is linked later');
});

test('seven linked pairs in one project are seven plots; only unlinked groups share the six places', () => {
  const pairs = Array.from({ length: 7 }, (_, i) => [card(`p${i}a`, i * 700, 0), card(`p${i}b`, i * 700, 400)]).flat(), links = Array.from({ length: 7 }, (_, i) => link(`p${i}a`, `p${i}b`));
  assert.deepEqual(ids(detectPlots(pairs, [], fresh, links)), Array.from({ length: 7 }, (_, i) => `p${i}a,p${i}b`));
  const groups = Array.from({ length: 8 }, (_, group) => Array.from({ length: 3 }, (_, i) => card(`q${group}-${i}`, group * 1000 + (i % 2) * 260, 3000 + Math.floor(i / 2) * 100))).flat();
  assert.deepEqual(ids(detectPlots([...pairs, ...groups], [], fresh, links)), Array.from({ length: 7 }, (_, i) => `p${i}a,p${i}b`), 'linked plots already fill the places');
  assert.deepEqual(ids(detectPlots([...pairs, ...groups], [], fresh, links.slice(0, 2))), ['q0-0,q0-1,q0-2', 'q1-0,q1-1,q1-2', 'q2-0,q2-1,q2-2', 'q3-0,q3-1,q3-2', 'p0a,p0b', 'p1a,p1b'], 'two linked plots leave four places');
  assert.equal(detectPlots(groups, [], fresh, [link('q0-0', 'q0-1'), link('q7-0', 'q7-1')]).length, 6, 'q7 is past the six but linked, so q5 gives way');
  assert.ok(ids(detectPlots(groups, [], fresh, [link('q0-0', 'q0-1'), link('q7-0', 'q7-1')])).includes('q7-0,q7-1,q7-2'));
});

test('a link to another project never joins or forms a plot', () => {
  const boxes = [card('x', 0, 0), card('y', 0, 400, 'other'), card('z', 0, 800, 'other'), card('w', 0, 1200, 'other'), ...loose(3)];
  assert.deepEqual(detectPlots(boxes, [], fresh, [link('x', 'y')]), []);
  assert.deepEqual(ids(detectPlots(boxes, [], fresh, [link('x', 'y'), link('y', 'z'), link('x', 'w')])), ['y,z'], 'only the link inside one project counts');
});

test('removing a link lets go of what it held; an item still linked to another plot joins that one', () => {
  const boxes = [card('a', 0, 0), card('b', 0, 600), card('z', 0, 1200), card('c', 900, 0), card('d', 900, 600), ...loose(3)];
  const before = detectPlots(boxes, [], fresh, [link('a', 'b'), link('b', 'z'), link('c', 'd')]);
  assert.deepEqual(ids(before), ['a,b,z', 'c,d']);
  const bound = detectPlots(boxes, before, fresh, [link('a', 'b'), link('b', 'z'), link('c', 'd'), link('b', 'c')]);
  assert.deepEqual(bound, before);
  const cut = detectPlots(boxes, bound, fresh, [link('b', 'z'), link('c', 'd'), link('b', 'c')]);
  assert.deepEqual(ids(cut), ['b,z', 'c,d'], 'a falls out; b and z stay a plot of their own');
  assert.equal(cut[0].id, before[0].id);
  const moved = detectPlots(boxes, bound, fresh, [link('a', 'z'), link('c', 'd'), link('b', 'c')]);
  assert.deepEqual(ids(moved), ['b,c,d', 'a,z'], 'b is left with only its link into the other plot');
});

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function random(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

test('detection is stable: its own result fed back gives the same plots, in any input order', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed), pick = (count: number) => Math.floor(next() * count);
    const count = 2 + pick(28), spread = 400 + pick(2400);
    let boxes = Array.from({ length: count }, (_, i) => card(`i${String(i).padStart(2, '0')}`, pick(spread), pick(spread), `project-${pick(2)}`, 120 + pick(120), 48 + pick(40)));
    let links = Array.from({ length: pick(count) }, () => link(boxes[pick(count)].id, boxes[pick(count)].id)).filter(one => one.sourceId !== one.targetId);
    let plots = detectPlots(boxes, [], fresh, links);
    for (let step = 0; step < 6; step++) {
      assert.deepEqual(detectPlots(boxes, plots, fresh, links), plots, `seed ${seed} step ${step}: a second pass changed the plots`);
      assert.deepEqual(detectPlots([...boxes].reverse(), plots, fresh, [...links].reverse()).map(plot => plot.memberIds), plots.map(plot => plot.memberIds), `seed ${seed} step ${step}: input order changed the plots`);
      const members = plots.flatMap(plot => plot.memberIds);
      assert.equal(new Set(members).size, members.length, `seed ${seed}: an item is in two plots`);
      // One committed change at a time: move an item, add a link or remove one.
      const change = pick(3);
      if (change === 0) boxes = boxes.map((box, i) => i === step % count ? { ...box, x: pick(spread), y: pick(spread) } : box);
      else if (change === 1) { const from = boxes[pick(count)].id, to = boxes[pick(count)].id; if (from !== to) links = [...links, link(from, to)]; }
      else links = links.slice(1);
      plots = detectPlots(boxes, plots, fresh, links);
    }
  }
});

test('every item with a link inside its project is in a plot', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed), pick = (count: number) => Math.floor(next() * count), count = 4 + pick(20);
    const boxes = Array.from({ length: count }, (_, i) => card(`i${String(i).padStart(2, '0')}`, pick(3000), pick(3000)));
    const links = Array.from({ length: 1 + pick(count) }, () => link(boxes[pick(count)].id, boxes[pick(count)].id)).filter(one => one.sourceId !== one.targetId);
    const member = new Set(detectPlots(boxes, [], fresh, links).flatMap(plot => plot.memberIds));
    for (const one of links) assert.ok(member.has(one.sourceId) && member.has(one.targetId), `seed ${seed}: ${one.sourceId}–${one.targetId} has an end outside every plot`);
  }
});

test('a plot is one patch while its parts sit within reach of each other; far parts get their own, largest first', () => {
  // Gaps of 140 and 170 px are over the join distance but under the patch reach, 400 px is not.
  const patches = plotPatches([card('n2', 0, 0), card('pr1', 0, -200), card('pr2', 0, 230), card('ticket', 600, 0), card('ticket-note', 600, 100)]);
  assert.deepEqual(patches.map(part => part.map(box => box.id).join(',')), ['n2,pr1,pr2', 'ticket,ticket-note']);
  assert.deepEqual(plotPatches([card('a', 0, 0), card('b', 200 + PLOT_BRIDGE, 0)]).length, 1, 'a gap of exactly the reach still bridges');
  assert.deepEqual(plotPatches([card('a', 0, 0), card('b', 201 + PLOT_BRIDGE, 0)]).length, 2);
});

test('detection on a 500-item map is linear in practice', () => {
  const boxes = Array.from({ length: 500 }, (_, i) => card(`m${i}`, (i % 25) * 260 + Math.floor(i / 75) * 3000, Math.floor((i % 75) / 25) * 100 + Math.floor(i / 25) * 400, `project-${Math.floor(i / 50)}`));
  const started = performance.now(), plots = detectPlots(boxes, [], fresh), elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `${elapsed} ms`);
  assert.ok(plots.length <= 60);
});

test('the local name uses a shared ticket or PR prefix, else the most frequent keyword, plus the count', () => {
  assert.equal(plotFallbackName(['BIL-12 · Plan switcher', 'BIL-12 · Proration', 'Stripe listen']), 'BIL-12 · 3 items');
  assert.equal(plotFallbackName(['Billing proration', 'billing-api release', 'Plan switcher', 'Billing invoice tests']), 'Billing · 4 items');
  assert.equal(plotFallbackName(['The', 'A', 'Of']), '3 items');
});

test('a new plot takes the first palette color no other plot in its project uses; other projects reuse colors', () => {
  assert.deepEqual(PLOT_COLORS, ['rose', 'sky', 'citron', 'orchid', 'clay', 'slate']);
  const plot = (id: string, projectId = 'photos', color?: PlotColor) => ({ id, projectId, memberIds: [`${id}-1`], ...(color ? { color } : {}) });
  const boxes = ['a', 'b', 'c', 'x', 'y'].map((id, i) => card(`${id}-1`, i * 1000, 0, ['x', 'y'].includes(id) ? 'other' : 'photos'));
  assert.deepEqual([...assignPlotColors([plot('a'), plot('b'), plot('c'), plot('x', 'other'), plot('y', 'other')], boxes)], [['a', 'rose'], ['b', 'sky'], ['c', 'citron'], ['x', 'rose'], ['y', 'sky']]);
  assert.deepEqual([...assignPlotColors([plot('a', 'photos', 'sky'), plot('b', 'photos', 'rose'), plot('c')], boxes)], [['c', 'citron']], 'colored plots keep theirs');
  assert.deepEqual([...assignPlotColors([plot('a', 'photos', 'rose'), plot('c', 'photos', 'citron'), plot('b')], boxes)], [['b', 'sky']], 'a color freed by a dissolved plot is the first free one again');
  assert.deepEqual([...assignPlotColors([plot('a', 'photos', 'rose'), plot('b', 'photos', 'rose'), plot('c')], boxes)], [['c', 'sky']], 'a color two plots chose counts once');
});

test('past six plots colors repeat, starting with the color whose plots are farthest away, then palette order', () => {
  const plot = (id: string, color?: PlotColor) => ({ id, projectId: 'photos', memberIds: [id], ...(color ? { color } : {}) });
  const six = PLOT_COLORS.map((color, i) => plot(`p${i}`, color)), boxes = PLOT_COLORS.map((_, i) => card(`p${i}`, i * 1000, 0));
  assert.deepEqual([...assignPlotColors([...six, plot('n')], [...boxes, card('n', 0, 1000)])], [['n', 'slate']], 'next to rose, slate is farthest');
  assert.deepEqual([...assignPlotColors([...six, plot('n')], [...boxes, card('n', 5000, 1000)])], [['n', 'rose']]);
  assert.deepEqual([...assignPlotColors([...six, plot('n')], [...boxes, card('n', 2500, 0)])], [['n', 'rose']], 'equally far: palette order');
  const twice = [...six, plot('r2', 'slate')], more = [...boxes, card('r2', 0, 4000)];
  assert.deepEqual([...assignPlotColors([...twice, plot('n')], [...more, card('n', 0, 1000)])], [['n', 'clay']], 'a color is as near as its nearest plot');
  const input = [...six, plot('n1'), plot('n2')], placed = [...boxes, card('n1', 0, 1000), card('n2', 5000, 1000)];
  assert.deepEqual([...assignPlotColors(input, placed)], [['n1', 'slate'], ['n2', 'rose']], 'assigned in input order, each seeing the earlier ones');
  assert.deepEqual([...assignPlotColors(input, placed)], [...assignPlotColors(input, placed)]);
});
