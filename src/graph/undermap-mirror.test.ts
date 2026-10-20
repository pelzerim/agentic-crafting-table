import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode } from './graph.ts';
import { overlaps } from './spatial.ts';
import { MIRROR, UNDERMAP_LOOSE, mirrorLayout, mirrorPlace, searchUndermap, sendBelow, restoreMapPositions } from './undermap.ts';
import type { MirrorLayout, MirrorOptions } from './undermap.ts';

const size = (node: GraphNode) => node.resourceId ? { width: 200, height: 84 } : { width: 240, height: 112 };
const options = (extra: Partial<MirrorOptions> = {}): MirrorOptions => ({ size, padding: 240, timeZone: 'UTC', now: '2026-10-06T09:00:00Z', ...extra });
const project = (id: string, x = 0, y = 0, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, position: { x, y }, ...extra });
const item = (id: string, projectId: string | undefined, x: number, y = 0, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, resourceId: `${id}-r`, projectId, position: { x, y }, ...extra });
/** `count` items of one project sent below one per hour, the first at `from`. */
const sent = (prefix: string, projectId: string | undefined, count: number, from: string, extra: Partial<GraphNode> = {}) => Array.from({ length: count }, (_, index) =>
  item(`${prefix}${String(index).padStart(4, '0')}`, projectId, 5000 + index * 300, 9000, { belowAt: new Date(Date.parse(from) + index * 3_600_000).toISOString(), ...extra }));
const area = (layout: MirrorLayout, id: string) => layout.areas.find(area => area.id === id)!;
const month = (layout: MirrorLayout, id: string, key: string) => area(layout, id).months.find(month => month.key === key)!;
const cardBox = (layout: MirrorLayout, id: string) => ({ id, ...layout.positions.get(id)!, ...size({ id, title: '', resourceId: 'r', position: { x: 0, y: 0 } }) });
const outer = (layout: MirrorLayout, id: string, padding = 240) => { const a = area(layout, id); return { id, x: a.x, y: a.y, width: a.width + padding * 2, height: a.height + padding * 2 }; };
const mapItems = (projectId: string, x: number, y: number) => [item(`${projectId}-a`, projectId, x, y), item(`${projectId}-b`, projectId, x + 400, y + 200)];

test('an item sent below lies under its own project, at the place the project has on the map', () => {
  const nodes = [project('a', 0, 0), ...mapItems('a', 300, 0), project('b', 6000, 0), ...mapItems('b', 6300, 0),
    ...sent('a-', 'a', 3, '2026-09-10T10:00:00Z'), ...sent('b-', 'b', 2, '2026-09-12T10:00:00Z')];
  const layout = mirrorLayout(nodes, options());
  assert.deepEqual(layout.areas.map(area => area.id), ['a', 'b']);
  // The map members span x 200…800 and start at y −42: the area hangs centred under that top edge.
  assert.equal(area(layout, 'a').x, 500); assert.equal(area(layout, 'a').top, -42);
  assert.equal(area(layout, 'b').x, 6500);
  for (const id of ['a-0000', 'a-0001', 'a-0002']) {
    const box = cardBox(layout, id), a = area(layout, 'a');
    assert.ok(box.x - 100 >= a.left && box.x + 100 <= a.left + a.width && box.y - 42 >= a.top && box.y + 42 <= a.top + a.height, `${id} lies inside its project's area`);
  }
  assert.deepEqual(layout.visible.slice().sort(), ['a-0000', 'a-0001', 'a-0002', 'b-0000', 'b-0001']);
  assert.equal(area(layout, 'a').count, 3); assert.equal(area(layout, 'a').title, 'a');
});

test('positions are computed: the same input gives the same layout, stored positions below do not matter', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), ...sent('x', 'a', 40, '2026-08-20T10:00:00Z')];
  const first = mirrorLayout(nodes, options()), again = mirrorLayout([...nodes].reverse(), options());
  assert.deepEqual([...first.positions].sort(), [...again.positions].sort());
  assert.deepEqual(first.areas, again.areas);
  const moved = nodes.map(node => node.belowAt ? { ...node, position: { x: -99999, y: 12345 }, mapPosition: { x: 1, y: 2 } } : node);
  assert.deepEqual([...mirrorLayout(moved, options()).positions].sort(), [...first.positions].sort());
});

test('cards never overlap and one arrival leaves the other months where they were', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), ...sent('s', 'a', 10, '2026-09-01T10:00:00Z'), ...sent('o', 'a', 6, '2026-10-01T10:00:00Z')];
  const layout = mirrorLayout(nodes, options());
  const boxes = layout.visible.map(id => cardBox(layout, id));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j], MIRROR.gap), `${boxes[i].id} overlaps ${boxes[j].id}`);
  const after = mirrorLayout([...nodes, item('new', 'a', 0, 0, { belowAt: '2026-10-05T10:00:00Z' })], options());
  assert.deepEqual(after.positions.get('new'), layout.positions.get('o0005'), 'the newest item takes the first place');
  assert.equal(after.positions.get('s0003')!.x, layout.positions.get('s0003')!.x);
});

test('months group by the time an item was sent below, newest month on top, newest item first', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0),
    item('aug', 'a', 0, 0, { belowAt: '2026-08-03T10:00:00Z' }), item('sep1', 'a', 0, 0, { belowAt: '2026-09-18T10:00:00Z' }),
    item('sep2', 'a', 0, 0, { belowAt: '2026-09-29T10:00:00Z' }), item('oct', 'a', 0, 0, { belowAt: '2026-10-02T10:00:00Z' })];
  const layout = mirrorLayout(nodes, options()), months = area(layout, 'a').months;
  assert.deepEqual(months.map(month => [month.key, month.label, month.count, month.range]), [
    ['2026-10', 'OCTOBER', 1, '2 Oct'], ['2026-09', 'SEPTEMBER', 2, '18 Sep – 29 Sep'], ['2026-08', 'AUGUST', 1, '3 Aug']]);
  assert.ok(months[0].y < months[1].y && months[1].y < months[2].y);
  assert.deepEqual(months[1].ids, ['sep2', 'sep1']);
  const sep2 = layout.positions.get('sep2')!, sep1 = layout.positions.get('sep1')!;
  assert.ok(sep2.y === sep1.y && sep2.x < sep1.x, 'newest first in the row');
  assert.ok(sep2.y > months[1].y && sep2.y < months[2].y, 'cards lie under their month line');
  assert.deepEqual(mirrorPlace(layout, 'sep1'), { areaId: 'a', month: '2026-09' });
});

test('months follow the given time zone and carry the year when it is not the current one', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0),
    item('edge', 'a', 0, 0, { belowAt: '2026-01-01T03:30:00Z' }), item('newyear', 'a', 0, 0, { belowAt: '2026-01-01T12:00:00Z' }), item('old', 'a', 0, 0, { belowAt: '2024-12-31T23:30:00Z' })];
  const utc = area(mirrorLayout(nodes, options()), 'a').months;
  assert.deepEqual(utc.map(month => [month.key, month.label, month.count]), [['2026-01', 'JANUARY', 2], ['2024-12', 'DECEMBER 2024', 1]]);
  // 03:30 UTC on 1 January is still 31 December in New York.
  const newYork = area(mirrorLayout(nodes, options({ timeZone: 'America/New_York' })), 'a').months;
  assert.deepEqual(newYork.map(month => [month.key, month.label, month.count, month.range]), [['2026-01', 'JANUARY', 1, '1 Jan'], ['2025-12', 'DECEMBER 2025', 1, '31 Dec'], ['2024-12', 'DECEMBER 2024', 1, '31 Dec']]);
  // 23:30 UTC on 31 December 2024 is already 2025 in Tokyo.
  const tokyo = area(mirrorLayout(nodes, options({ timeZone: 'Asia/Tokyo' })), 'a').months;
  assert.deepEqual(tokyo.map(month => month.key), ['2026-01', '2025-01']);
  const nextYear = area(mirrorLayout(nodes, options({ now: '2027-02-01T00:00:00Z' })), 'a').months;
  assert.deepEqual(nextYear.map(month => month.label), ['JANUARY 2026', 'DECEMBER 2024']);
});

test('an area shows its budget of cards, newest first; the month it runs out in is cut, every older month is a line with a count', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), ...sent('apr', 'a', 5, '2026-04-02T00:00:00Z'), ...sent('jun', 'a', 37, '2026-06-02T00:00:00Z'), ...sent('aug', 'a', 9, '2026-08-02T00:00:00Z'),
    ...sent('sep', 'a', 12, '2026-09-02T00:00:00Z'), ...sent('oct', 'a', 10, '2026-10-01T00:00:00Z')];
  const layout = mirrorLayout(nodes, options()), months = area(layout, 'a').months;
  assert.equal(area(layout, 'a').columns, 7);
  // 10 + 12 = 22 of 28 places; August shows its newest 6 of 9, June and April are lines.
  assert.deepEqual(months.map(month => [month.key, month.open, month.toggle, month.shown, month.more]), [['2026-10', true, undefined, 10, 0], ['2026-09', true, undefined, 12, 0], ['2026-08', true, 'more', 6, 3], ['2026-06', false, 'line', 0, 37], ['2026-04', false, 'line', 0, 5]]);
  assert.equal(layout.visible.length, 28);
  assert.deepEqual(layout.visible.slice(22), months[2].ids.slice(0, 6), 'the newest of the cut month');
  assert.ok(months[2].moreY! > layout.positions.get(months[2].ids[5])!.y && months[2].moreY! < months[3].y);
  assert.ok(!layout.positions.has('jun0000'));
  assert.equal(months[3].count, 37);
  assert.equal(months[4].y - months[3].y, MIRROR.line, 'closed months take one line each');
});

test('a collapsed month opens in place, one per project, and the area grows downward', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), ...sent('jun', 'a', 37, '2026-06-02T00:00:00Z'), ...sent('aug', 'a', 9, '2026-08-02T00:00:00Z'), ...sent('oct', 'a', 25, '2026-10-01T00:00:00Z')];
  const closed = mirrorLayout(nodes, options()), opened = mirrorLayout(nodes, options({ open: { a: '2026-06' } }));
  assert.equal(month(opened, 'a', '2026-06').open, true); assert.equal(month(opened, 'a', '2026-06').expanded, true); assert.equal(month(opened, 'a', '2026-06').shown, 37);
  // August keeps the 3 places the budget left it, opened June or not.
  for (const layout of [closed, opened]) assert.deepEqual([month(layout, 'a', '2026-08').shown, month(layout, 'a', '2026-08').toggle], [3, 'more']);
  assert.equal(month(closed, 'a', '2026-06').open, false);
  assert.equal(opened.visible.length, 25 + 3 + 37);
  const whole = month(mirrorLayout(nodes, options({ open: { a: '2026-08' } })), 'a', '2026-08');
  assert.deepEqual([whole.shown, whole.more, whole.expanded, whole.fit], [9, 0, true, 3]);
  assert.equal(area(opened, 'a').top, area(closed, 'a').top);
  assert.ok(area(opened, 'a').height > area(closed, 'a').height);
  assert.deepEqual(opened.positions.get('oct0000'), closed.positions.get('oct0000'), 'cards above the opened month stay');
  // A key that names no month of the project changes nothing.
  assert.deepEqual(mirrorLayout(nodes, options({ open: { a: '1999-01' } })).areas, closed.areas);
});

test('the newest month is always open; past the budget it ends with “+N more”, which opens the rest', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), ...sent('sep', 'a', 5, '2026-09-02T00:00:00Z'), ...sent('oct', 'a', 60, '2026-10-01T00:00:00Z')];
  const layout = mirrorLayout(nodes, options()), newest = month(layout, 'a', '2026-10');
  assert.deepEqual([newest.open, newest.shown, newest.more, newest.toggle, newest.fit], [true, 28, 32, 'more', 28]);
  assert.ok(newest.moreY! > layout.positions.get(newest.ids[27])!.y);
  assert.equal(month(layout, 'a', '2026-09').open, false);
  assert.deepEqual(layout.visible, newest.ids.slice(0, 28), 'the newest 28');
  const all = mirrorLayout(nodes, options({ open: { a: '2026-10' } })), expanded = month(all, 'a', '2026-10');
  assert.deepEqual([expanded.shown, expanded.more, expanded.toggle, expanded.expanded], [60, 0, 'more', true]);
  assert.equal(all.visible.length, 60);
});

test('a neighbour close by takes columns, never fewer than four, and no area pushes one that keeps its place', () => {
  const near = [project('a'), ...mapItems('a', 0, 0), project('b'), ...mapItems('b', 2000, 0), ...sent('a-', 'a', 30, '2026-10-01T00:00:00Z'), ...sent('b-', 'b', 30, '2026-10-01T00:00:00Z')];
  const layout = mirrorLayout(near, options());
  // Centres 2,000 apart: 2,000 − two paddings − the gap between areas leaves room for five columns.
  assert.equal(area(layout, 'a').columns, 5); assert.equal(area(layout, 'b').columns, 5);
  assert.ok(!overlaps(outer(layout, 'a'), outer(layout, 'b'), 0));
  assert.equal(month(layout, 'a', '2026-10').shown, 20, 'the budget is four rows of the columns that fit');
  const far = mirrorLayout(near.map(node => node.id.startsWith('b') && !node.belowAt ? { ...node, position: { x: node.position.x + 3000, y: node.position.y } } : node), options());
  assert.equal(area(far, 'a').columns, 7);
  // Closer than four columns allow: both keep four, and the later one (by place) yields downward.
  const tight = mirrorLayout(near.map(node => node.id.startsWith('b') && !node.belowAt ? { ...node, position: { x: node.position.x - 1200, y: node.position.y } } : node), options());
  assert.equal(area(tight, 'a').columns, 4); assert.equal(area(tight, 'b').columns, 4);
  assert.equal(area(tight, 'a').top, -42, 'the first area keeps its place');
  assert.ok(area(tight, 'b').top > area(tight, 'a').top + area(tight, 'a').height);
  assert.ok(!overlaps(outer(tight, 'a'), outer(tight, 'b'), 0));
});

test('a project stacked under another yields downward while a month above it is open', () => {
  const nodes = [project('a'), ...mapItems('a', 0, 0), project('b'), ...mapItems('b', 0, 1900), ...sent('a-', 'a', 10, '2026-10-01T00:00:00Z'), ...sent('old', 'a', 80, '2026-05-01T00:00:00Z'), ...sent('b-', 'b', 4, '2026-10-01T00:00:00Z')];
  const closed = mirrorLayout(nodes, options()), opened = mirrorLayout(nodes, options({ open: { a: '2026-05' } }));
  assert.equal(area(closed, 'b').top, 1858, 'under its project while nothing is open');
  assert.ok(area(opened, 'b').top > area(closed, 'b').top);
  assert.ok(!overlaps(outer(opened, 'a'), outer(opened, 'b'), 0));
});

test('when a project moves on the map its area below follows', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), ...sent('x', 'a', 5, '2026-10-01T00:00:00Z')];
  const before = mirrorLayout(nodes, options());
  const after = mirrorLayout(nodes.map(node => node.belowAt ? node : { ...node, position: { x: node.position.x + 700, y: node.position.y - 300 } }), options());
  assert.equal(area(after, 'a').x - area(before, 'a').x, 700); assert.equal(area(after, 'a').top - area(before, 'a').top, -300);
  assert.deepEqual(after.positions.get('x0002'), { x: before.positions.get('x0002')!.x + 700, y: before.positions.get('x0002')!.y - 300 });
});

test('items without a project share one Loose area at the lower left of the map', () => {
  const nodes = [project('a', 0, 0), ...mapItems('a', 300, 0), item('floating', undefined, -400, 900),
    item('loose1', undefined, 50, 50, { belowAt: '2026-10-02T00:00:00Z' }), item('loose2', undefined, 4000, -4000, { belowAt: '2026-09-02T00:00:00Z' }),
    item('orphan', 'gone', 0, 0, { belowAt: '2026-10-03T00:00:00Z', lostProject: 'Gone' }), ...sent('x', 'a', 3, '2026-10-01T00:00:00Z')];
  const layout = mirrorLayout(nodes, options()), loose = area(layout, UNDERMAP_LOOSE);
  assert.equal(loose.title, 'Loose'); assert.equal(loose.count, 3); assert.equal(loose.loose, true);
  assert.deepEqual(loose.months.map(month => [month.label, month.count]), [['OCTOBER', 2], ['SEPTEMBER', 1]]);
  // The map reaches from x −500 (the floating item) down to y 942; Loose starts at that left edge, below everything.
  assert.equal(loose.left, -500);
  assert.ok(loose.top > 942 && loose.top > area(layout, 'a').top + area(layout, 'a').height);
  assert.ok(!overlaps(outer(layout, 'a'), outer(layout, UNDERMAP_LOOSE), 0));
  assert.deepEqual(mirrorPlace(layout, 'orphan'), { areaId: UNDERMAP_LOOSE, month: '2026-10' });
});

test('a whole project sent below keeps its place and packs its members by the same rule', () => {
  const footprint = (node: GraphNode) => ({ id: node.id, x: node.position.x, y: node.position.y, ...size(node) });
  const map = [project('a', 0, 0), ...mapItems('a', 300, 0), item('early', 'a', 900, 0), project('b', 6000, 0), ...mapItems('b', 6300, 0)];
  const one = sendBelow(map, ['early'], '2026-08-10T00:00:00Z', footprint), nodes = sendBelow(one, ['a'], '2026-10-02T00:00:00Z', footprint);
  const layout = mirrorLayout(nodes, options()), a = area(layout, 'a');
  assert.equal(a.x, 500); assert.equal(a.top, -42); assert.equal(a.count, 3);
  assert.deepEqual(a.months.map(month => [month.key, month.ids]), [['2026-10', ['a-a', 'a-b']], ['2026-08', ['early']]]);
  assert.ok(layout.projects.includes('a') && !layout.projects.includes('b'), 'only projects with something below get an area');
  // Bring back returns everything to the map positions it left.
  const back = restoreMapPositions(nodes.map(node => node.id === 'a' ? { ...node, belowAt: undefined } : node), 'a');
  for (const id of ['a-a', 'a-b']) assert.deepEqual(back.find(node => node.id === id)!.position, map.find(node => node.id === id)!.position);
});

test('archived items and archived projects have no place below', () => {
  const nodes = [project('a'), ...mapItems('a', 300, 0), item('gone', 'a', 0, 0, { belowAt: '2026-10-01T00:00:00Z', archivedAt: '2026-10-02T00:00:00Z' }),
    project('z', 9000, 0, { archivedAt: '2026-10-02T00:00:00Z' }), item('z1', 'z', 9300, 0, { belowAt: '2026-10-01T00:00:00Z' })];
  const layout = mirrorLayout(nodes, options());
  assert.deepEqual(layout.areas, []); assert.deepEqual(layout.visible, []);
});

test('1,000 items below mount a bounded number of cards', () => {
  const projects = ['a', 'b', 'c', 'd'], nodes: GraphNode[] = projects.flatMap((id, index) => [project(id, index % 2 * 4000, Math.floor(index / 2) * 3000), ...mapItems(id, index % 2 * 4000 + 300, Math.floor(index / 2) * 3000)]);
  for (let index = 0; index < 1000; index++) nodes.push(item(`n${index}`, projects[index % 4], 0, 0, { belowAt: new Date(Date.parse('2026-04-09T00:00:00Z') + index * 15_500_000).toISOString() }));
  const started = performance.now(), layout = mirrorLayout(nodes, options()), elapsed = performance.now() - started;
  assert.equal(layout.count, 1000);
  assert.ok(layout.visible.length <= 4 * 28, `${layout.visible.length} cards`);
  for (const a of layout.areas) assert.ok(a.months.filter(month => month.open).reduce((sum, month) => sum + month.shown, 0) <= 28);
  assert.ok(elapsed < 250, `layout took ${elapsed} ms`);
  const opened = mirrorLayout(nodes, options({ open: { a: area(layout, 'a').months.at(-1)!.key } }));
  assert.ok(opened.visible.length <= 4 * 28 + area(layout, 'a').months.at(-1)!.count);
});

test('search matches title, project and month, newest first', () => {
  const nodes = [project('a', 0, 0, { title: 'Billing redesign' }), ...mapItems('a', 300, 0), project('b', 6000, 0, { title: 'Docs site' }), ...mapItems('b', 6300, 0),
    item('p1', 'a', 0, 0, { title: 'Fix rate limiter', belowAt: '2026-06-02T00:00:00Z' }), item('p2', 'a', 0, 0, { title: 'Fix sort order', belowAt: '2026-10-02T00:00:00Z' }),
    item('p3', 'b', 0, 0, { title: 'Rate limiter docs', belowAt: '2026-09-02T00:00:00Z' }), item('up', 'a', 300, 300, { title: 'Rate limiter on the map' })];
  const layout = mirrorLayout(nodes, options());
  assert.deepEqual(searchUndermap(layout, nodes, 'rate LIMIT').map(match => [match.id, match.project, match.month]), [['p3', 'Docs site', 'SEPTEMBER'], ['p1', 'Billing redesign', 'JUNE']]);
  assert.deepEqual(searchUndermap(layout, nodes, 'billing').map(match => match.id), ['p2', 'p1']);
  assert.deepEqual(searchUndermap(layout, nodes, 'june').map(match => match.id), ['p1']);
  assert.deepEqual(searchUndermap(layout, nodes, 'docs rate').map(match => match.id), ['p3']);
  assert.deepEqual(searchUndermap(layout, nodes, '  '), []);
  assert.equal(searchUndermap(layout, nodes, 'i', 2).length, 2);
});
