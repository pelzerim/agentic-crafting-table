import test from 'node:test';
import assert from 'node:assert/strict';
import { neighborhoodContours, neighborhoodDistance, neighborhoodOutline, outlineDistance } from './neighborhood.ts';
import { neighborhoodFill } from './neighborhood-fill.ts';

const boxes = [{ id: 'a', x: 0, y: 0, width: 120, height: 80 }, { id: 'b', x: 300, y: 0, width: 120, height: 80 }, { id: 'c', x: 0, y: 300, width: 120, height: 80 }];

test('rounded pixel perimeter encloses every member with corner clearance', () => {
  const shape = neighborhoodOutline(boxes);
  assert.ok(shape.length > 4);
  for (const b of boxes) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
    assert.ok(outlineDistance({ x: b.x + dx * b.width / 2 + 20 * Math.cos(angle), y: b.y + dy * b.height / 2 + 20 * Math.sin(angle) }, shape) < 1e-8);
  }
});

test('sparse items share one full enclosure without narrow connecting corridors', () => {
  const cards = [{ id: 'a', x: 0, y: 0, width: 100, height: 60 }, { id: 'b', x: 600, y: 0, width: 100, height: 60 }];
  const contours = neighborhoodContours(cards);
  assert.equal(neighborhoodDistance({ x: 300, y: 0 }, contours), 0);
  assert.equal(contours.length, 1);
  assert.ok(contours[0].length >= 12);
  assert.equal(neighborhoodDistance({ x: 300, y: 49 }, contours), 0);
  assert.equal(neighborhoodDistance({ x: 0, y: 49 }, contours), 0);
  assert.ok(neighborhoodDistance({ x: 300, y: 500 }, contours) > 0);
  assert.equal(neighborhoodDistance({ x: 600, y: 0 }, contours), 0);
});

test('enclosed space belongs to the project for fill, creation and attachment', () => {
  const ring = [
    { id: 'top', x: 0, y: -150, width: 400, height: 50 },
    { id: 'bottom', x: 0, y: 150, width: 400, height: 50 },
    { id: 'left', x: -175, y: 0, width: 50, height: 250 },
    { id: 'right', x: 175, y: 0, width: 50, height: 250 },
  ];
  const contours = neighborhoodContours(ring);
  assert.equal(contours.length, 1);
  assert.equal(neighborhoodDistance({ x: 0, y: 0 }, contours), 0);
  ring.forEach(card => assert.equal(neighborhoodDistance(card, contours), 0));
  assert.equal(neighborhoodDistance({ x: 0, y: -110 }, contours), 0);
  assert.deepEqual(neighborhoodContours([...ring].reverse()), contours);
});

test('rounded envelopes contain every full card at the smallest and largest map scales', () => {
  for (const scale of [.2, .65, 1.35]) {
    const cards = boxes.map((card, index) => ({ ...card, width: (index === 0 ? 240 : 218) / scale, height: (index === 0 ? 44 : 100) / scale }));
    const contours = neighborhoodContours(cards, 20 / scale);
    for (const card of cards) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const point = { x: card.x + dx * card.width / 2 + 20 / scale * Math.cos(angle), y: card.y + dy * card.height / 2 + 20 / scale * Math.sin(angle) };
      assert.ok(neighborhoodDistance(point, contours) < 1e-8);
    }
  }
});

test('moving and adding members grows the outline, removing them restores it', () => {
  const original = neighborhoodOutline(boxes);
  const moved = boxes.map(b => b.id === 'b' ? { ...b, x: 650 } : b);
  assert.ok(Math.max(...neighborhoodOutline(moved).map(p => p.x)) > Math.max(...original.map(p => p.x)));
  assert.equal(outlineDistance({ x: 900, y: 500 }, neighborhoodOutline([...boxes, { id: 'd', x: 900, y: 500, width: 218, height: 100 }])), 0);
  assert.deepEqual(neighborhoodOutline(boxes), original);
});

test('moving a group along its world grid translates the contour and input order does not change it', () => {
  const original = neighborhoodOutline(boxes);
  assert.deepEqual(neighborhoodOutline([...boxes].reverse()), original);
  const shifted = neighborhoodOutline(boxes.map(b => ({ ...b, x: b.x + 96, y: b.y - 48 })));
  assert.equal(shifted.length, original.length);
  shifted.forEach((p, i) => assert.ok(Math.abs(p.x - original[i].x - 96) < 1e-9 && Math.abs(p.y - original[i].y + 48) < 1e-9));
});

test('every edge is horizontal or vertical and diagonal groups retain their full interior', () => {
  const diagonal = [{ id: 'a', x: 0, y: 0, width: 218, height: 100 }, { id: 'b', x: 480, y: 400, width: 240, height: 44 }];
  const contours = neighborhoodContours(diagonal), shape = contours[0];
  assert.equal(contours.length, 1);
  shape.forEach((p, i) => { const next = shape[(i + 1) % shape.length]; assert.ok(p.x === next.x || p.y === next.y); });
  for (let fraction = 0; fraction <= 1; fraction += .05) assert.equal(neighborhoodDistance({ x: 480 * fraction, y: 400 * fraction }, contours), 0);
});

test('single, overlapping, distant, and empty groups have finite usable geometry', () => {
  assert.deepEqual(neighborhoodOutline([]), []);
  assert.equal(outlineDistance({ x: 0, y: 0 }, []), Infinity);
  for (const input of [[boxes[0]], [boxes[0], { ...boxes[0], id: 'overlap' }], [...boxes, { id: 'far', x: -2000, y: 1300, width: 240, height: 44 }]]) {
    const shape = neighborhoodOutline(input);
    assert.ok(shape.length >= 4 && shape.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    input.forEach(b => assert.equal(outlineDistance(b, shape), 0));
  }
});


test('a single item has rounded ends without filling the outside box corners', () => {
  const shape = neighborhoodContours([{ id: 'wide', x: 0, y: 0, width: 200, height: 150 }], 75, 20)[0];
  const extent = (axis: 'x' | 'y') => Math.max(...shape.map(p => p[axis])) - Math.min(...shape.map(p => p[axis]));
  assert.ok(extent('x') >= 350 && extent('x') <= 375); // Full size + pad, plus at most one pixel step.
  assert.ok(extent('y') >= 300 && extent('y') <= 320);
  assert.ok(outlineDistance({ x: 175, y: 149 }, shape) > 0);
  assert.equal(outlineDistance({ x: 175, y: 0 }, shape), 0);
  assert.equal(outlineDistance({ x: 0, y: 150 }, shape), 0);
});

test('diagonal groups stretch along the members without the empty sides of a circle', () => {
  // The requested two-item layout: a small to-do lower left and agent upper right.
  const cards = [{ id: 'todo', x: 0, y: 300, width: 218, height: 48 }, { id: 'agent', x: 600, y: 0, width: 240, height: 112 }];
  const shape = neighborhoodContours(cards, 240, 24)[0];
  for (let t = 0; t <= 1; t += .025) assert.equal(outlineDistance({ x: 600 * t, y: 300 * (1 - t) }, shape), 0);
  // Both are inside the old circumcircle, but well away from this diagonal group.
  assert.ok(outlineDistance({ x: -100, y: -250 }, shape) > 0);
  assert.ok(outlineDistance({ x: 700, y: 550 }, shape) > 0);
  assert.ok(Math.max(...shape.map(p => p.x)) - Math.min(...shape.map(p => p.x)) > Math.max(...shape.map(p => p.y)) - Math.min(...shape.map(p => p.y)));
  for (const card of cards) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (let angle = 0; angle < Math.PI * 2; angle += .01) {
    assert.ok(outlineDistance({ x: card.x + dx * card.width / 2 + 240 * Math.cos(angle), y: card.y + dy * card.height / 2 + 240 * Math.sin(angle) }, shape) < 1e-8);
  }
});

test('seeded layouts preserve corner clearance, translation and bounded contour complexity', () => {
  let seed = 8462;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (const padding of [0, 30, 240, 800]) for (let run = 0; run < 12; run++) {
    const cards = Array.from({ length: 1 + run }, (_, id) => ({ id: String(id), x: random() * 4000 - 2000, y: random() * 4000 - 2000, width: 20 + random() * 240, height: 20 + random() * 120 }));
    const outline = neighborhoodContours(cards, padding, 24)[0];
    assert.ok(outline.length <= 512);
    assert.deepEqual(neighborhoodContours([...cards].reverse(), padding, 24)[0], outline);
    for (const card of cards) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const point = { x: card.x + dx * card.width / 2 + padding * Math.cos(angle), y: card.y + dy * card.height / 2 + padding * Math.sin(angle) };
      assert.ok(outlineDistance(point, outline) < 1e-8);
    }
  }
  for (const padding of [-1, NaN, Infinity]) assert.throws(() => neighborhoodContours(boxes, padding), /padding/);
  assert.ok(neighborhoodContours(boxes, 1e8, 24)[0].length <= 512);
});

const agent = (id: string, x: number, y: number) => ({ id, x, y, width: 240, height: 112 });
const resource = (id: string, x: number, y: number) => ({ id, x, y, width: 150, height: 48 });
const lShape = [
  agent('a1', 0, 0), resource('r1', 300, -20), resource('r2', 560, 30), agent('a2', 860, 0), resource('r3', 1160, -30), resource('r4', 1740, -10), resource('r5', 2020, 30),
  resource('v1', -20, 330), resource('v3', -30, 800), agent('v4', 10, 1030), resource('v5', -20, 1280), resource('v6', 30, 1500),
];
const compact = [agent('a', 0, 0), resource('r1', 300, -30), resource('n', 20, 170), resource('r2', 310, 140)];
type XY = { x: number; y: number };
/** Area of the unsmoothed padded hull: hull + perimeter * padding + one padding disk. */
function paddedHullArea(cards: readonly (XY & { width: number; height: number })[], padding: number) {
  const corners = cards.flatMap(b => [-1, 1].flatMap(dx => [-1, 1].map(dy => ({ x: b.x + dx * b.width / 2, y: b.y + dy * b.height / 2 }))));
  const turn = (a: XY, b: XY, c: XY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (points: XY[]) => points.reduce<XY[]>((result, p) => { while (result.length >= 2 && turn(result.at(-2)!, result.at(-1)!, p) <= 0) result.pop(); result.push(p); return result; }, []).slice(0, -1);
  const sorted = [...corners].sort((a, b) => a.x - b.x || a.y - b.y), hull = [...half(sorted), ...half([...sorted].reverse())];
  const perimeter = hull.reduce((sum, p, i) => sum + Math.hypot(hull[(i + 1) % hull.length].x - p.x, hull[(i + 1) % hull.length].y - p.y), 0);
  return polygonArea(hull) + perimeter * padding + Math.PI * padding * padding;
}
function selfIntersects(shape: readonly XY[]) {
  const segments = shape.map((a, i) => ({ a, b: shape[(i + 1) % shape.length] }));
  const side = (p: XY, q: XY, r: XY) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return segments.some((s, i) => segments.some((t, j) => j > i + 1 && !(i === 0 && j === segments.length - 1)
    && side(s.a, s.b, t.a) * side(s.a, s.b, t.b) < 0 && side(t.a, t.b, s.a) * side(t.a, t.b, s.b) < 0));
}

test('the spline hull bows long runs outward but keeps compact groups, clearance and the rounded corners', () => {
  for (const cards of [compact, lShape]) {
    const shape = neighborhoodContours(cards, 240, 24)[0], ratio = polygonArea(shape) / paddedHullArea(cards, 240);
    assert.ok(ratio >= 1 && ratio <= (cards === compact ? 1.08 : 1.2), `area ratio ${ratio}`);
    assert.ok(!selfIntersects(shape));
    shape.forEach((p, i) => { const next = shape[(i + 1) % shape.length]; assert.ok(p.x === next.x || p.y === next.y); });
    for (const card of cards) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
      assert.equal(outlineDistance({ x: card.x + dx * card.width / 2 + 240 * Math.cos(angle), y: card.y + dy * card.height / 2 + 240 * Math.sin(angle) }, shape), 0);
    }
  }
  const shape = neighborhoodContours(lShape, 240, 24)[0];
  // The curve passes the rounded hull's outer corners within a few cells.
  for (const corner of [{ x: -120 - 170, y: -56 - 170 }, { x: 2095 + 170, y: -18 - 170 }, { x: -105 - 170, y: 1524 + 170 }]) {
    assert.ok(Math.min(...shape.map(p => Math.hypot(p.x - corner.x, p.y - corner.y))) < 72, `${corner.x},${corner.y}`);
  }
  // Midway along the long diagonal the field reaches well past the straight padded edge.
  const normal = { x: 1470 / Math.hypot(1470, 1990), y: 1990 / Math.hypot(1470, 1990) }, middle = { x: (2095 + 105) / 2, y: (54 + 1524) / 2 };
  assert.equal(outlineDistance({ x: middle.x + normal.x * 340, y: middle.y + normal.y * 340 }, shape), 0);
  assert.ok(outlineDistance({ x: middle.x + normal.x * 600, y: middle.y + normal.y * 600 }, shape) > 0);
});

test('the spline hull changes continuously while a member is dragged', () => {
  let previous = neighborhoodContours(lShape, 240, 24)[0];
  for (let step = 1; step <= 40; step++) {
    const shape = neighborhoodContours(lShape.map(card => card.id === 'r5' ? { ...card, x: card.x + step * 6, y: card.y + step * 9 } : card), 240, 24)[0];
    for (const p of shape) assert.ok(outlineDistance(p, previous) <= 48 + 1e-9);
    for (const p of previous) assert.ok(outlineDistance(p, shape) <= 48 + 1e-9);
    previous = shape;
  }
});

const polygonArea = (shape: readonly { x: number; y: number }[]) => Math.abs(shape.reduce((sum, p, i) => { const q = shape[(i + 1) % shape.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;

test('wide and tall groups keep their contour on the 24 px world grid, so the fill paints exactly the contour', () => {
  for (const cards of [
    [{ id: 'a', x: 13, y: 7, width: 240, height: 112 }, { id: 'b', x: 3400, y: 900, width: 150, height: 48 }],
    [{ id: 'a', x: -5, y: 0, width: 240, height: 112 }, { id: 'b', x: 700, y: 5200, width: 200, height: 84 }],
    [{ id: 'a', x: 0, y: 0, width: 240, height: 112 }, { id: 'b', x: 2400, y: 300, width: 150, height: 48 }],
  ]) {
    const shape = neighborhoodContours(cards, 240, 24)[0];
    assert.ok(shape.length <= 512);
    for (const p of shape) assert.ok(Math.abs(p.x / 24 - Math.round(p.x / 24)) < 1e-9 && Math.abs(p.y / 24 - Math.round(p.y / 24)) < 1e-9, `${p.x},${p.y} is off the grid`);
    const fill = neighborhoodFill(shape, { pixelSize: 24, fade: 0, scatter: 0 });
    const painted = [...fill.paths[0].matchAll(/h(-?[\d.]+)v(-?[\d.]+)/g)].reduce((sum, [, w, h]) => sum + Number(w) * Number(h), 0);
    assert.ok(Math.abs(painted - polygonArea(shape)) < 1e-6);
  }
});
