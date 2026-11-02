import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeSpot, offscreenBoxes, offscreenMarks } from './offscreen-attention.ts';

const camera = { x: 0, y: 0, zoom: 1 }, screen = { width: 1000, height: 600 };
const box = (id: string, x: number, y: number, resourceId?: string) => ({ id, resourceId, x, y, width: 200, height: 100 });

const ids = (boxes: readonly { id: string }[]) => boxes.map(box => box.id);

test('nothing is off-screen while every waiting item shows', () => {
  assert.deepEqual(offscreenBoxes([box('a', 500, 300)], camera, screen), []);
  assert.deepEqual(offscreenBoxes([], camera, screen), []);
});

test('an item with any part inside the view counts as seen on the map', () => {
  assert.deepEqual(ids(offscreenBoxes([box('a', 1090, 300)], camera, screen)), []);
  assert.deepEqual(ids(offscreenBoxes([box('a', 1110, 300)], camera, screen)), ['a']);
});

test('off-screen items come nearest the centre of the view first', () => {
  assert.deepEqual(ids(offscreenBoxes([box('far', 3000, 300), box('near', -400, 300), box('shown', 500, 300)], camera, screen)), ['near', 'far']);
});

test('the camera decides what is off-screen', () => {
  const panned = { x: -2000, y: 0, zoom: 1 };
  assert.deepEqual(ids(offscreenBoxes([box('a', 500, 300)], panned, screen)), ['a']);
  assert.deepEqual(ids(offscreenBoxes([box('a', 2500, 300)], panned, screen)), []);
  // Zoomed in, the same world point falls outside a smaller window on the world.
  assert.deepEqual(ids(offscreenBoxes([box('a', 800, 300)], camera, screen)), []);
  assert.deepEqual(ids(offscreenBoxes([box('a', 800, 300)], { x: 0, y: 0, zoom: 2 }, screen)), ['a']);
});

test('a resource counts once: not at all with a card in view, else by its nearest card', () => {
  assert.deepEqual(ids(offscreenBoxes([box('here', 500, 300, 'pr'), box('there', 4000, 300, 'pr')], camera, screen)), []);
  assert.deepEqual(ids(offscreenBoxes([box('here', 500, 300, 'pr'), box('there', 4000, 300, 'other')], camera, screen)), ['there']);
  assert.deepEqual(ids(offscreenBoxes([box('far', 4000, 300, 'pr'), box('near', 2000, 300, 'pr')], camera, screen)), ['near']);
});

const waiting = (id: string, x: number, y: number, tier: 'asking' | 'turn' | 'finished' = 'turn') => ({ ...box(id, x, y), tier });
const spots = (marks: { spot: { x: number; y: number } }[]) => marks.map(mark => mark.spot);

test('items in different directions get a mark each', () => {
  const marks = offscreenMarks([waiting('left', -3000, 300), waiting('right', 4000, 300), waiting('below', 500, 5000)], camera, { x: 0, y: 0, ...screen }, []);
  assert.deepEqual(marks.map(mark => ids(mark.boxes)), [['left'], ['right'], ['below']]);
  assert.deepEqual(spots(marks), [{ x: 16, y: 300 }, { x: 984, y: 300 }, { x: 500, y: 584 }]);
});

test('items in nearly one direction group: nearest first, at its spot, in the highest tier', () => {
  const marks = offscreenMarks([waiting('near', 3000, 300), waiting('close', 3400, 380, 'asking'), waiting('other', -3000, 300)], camera, { x: 0, y: 0, ...screen }, []);
  assert.equal(marks.length, 2);
  assert.deepEqual(ids(marks[0].boxes), ['near', 'close']); assert.equal(marks[0].tier, 'asking');
  assert.deepEqual(marks[0].spot, { x: 984, y: 300 });
});

test('marks pushed to one place by chrome group too', () => {
  const items = [waiting('a', 3000, 100), waiting('b', 3000, 900)], whole = { x: 0, y: 0, ...screen };
  assert.equal(offscreenMarks(items, camera, whole, []).length, 2);
  assert.equal(offscreenMarks(items, camera, whole, [{ x: 960, y: 300, width: 40, height: 300 }]).length, 1);
});

test('marks that end up apart stay apart', () => {
  const marks = offscreenMarks([waiting('a', 3000, 300), waiting('b', 3000, 900)], camera, { x: 0, y: 0, ...screen }, []);
  assert.equal(marks.length, 2);
  assert.ok(Math.hypot(marks[0].spot.x - marks[1].spot.x, marks[0].spot.y - marks[1].spot.y) >= 56);
});

const area = { x: 0, y: 0, ...screen };
test('the spot is where the line from the centre to the item crosses the edge', () => {
  assert.deepEqual(edgeSpot({ x: 3000, y: 300 }, area, []), { x: 984, y: 300 });
  assert.deepEqual(edgeSpot({ x: -3000, y: 300 }, area, []), { x: 16, y: 300 });
  assert.deepEqual(edgeSpot({ x: 500, y: 5000 }, area, []), { x: 500, y: 584 });
  assert.deepEqual(edgeSpot({ x: 500, y: -5000 }, area, []), { x: 500, y: 16 });
});

test('a diagonal item puts the spot on the diagonal, and it slides as the camera moves', () => {
  const first = edgeSpot({ x: 1100, y: 1500 }, area, []);
  assert.equal(first.y, 584); assert.ok(first.x > 500 && first.x < 984, `x ${first.x}`);
  const second = edgeSpot({ x: 2900, y: 900 }, area, []);
  assert.equal(second.x, 984); assert.ok(second.y > 300 && second.y < 584, `y ${second.y}`);
});

test('the spot keeps the centre of the area it is given, so a left inset moves the left edge', () => {
  const inset = { x: 80, y: 0, width: 920, height: 600 };
  assert.deepEqual(edgeSpot({ x: -3000, y: 300 }, inset, []), { x: 96, y: 300 });
});

test('chrome pushes the spot along the edge to the nearest clear place', () => {
  const zoom = { x: 400, y: 560, width: 200, height: 40 };
  const spot = edgeSpot({ x: 450, y: 5000 }, area, [zoom]);
  assert.equal(spot.y, 584); assert.ok(spot.x < 400 - 9, `x ${spot.x}`);
  const other = edgeSpot({ x: 560, y: 5000 }, area, [zoom]);
  assert.equal(other.y, 584); assert.ok(other.x > 600 + 9, `x ${other.x}`);
});

test('chrome past a corner moves the spot round onto the next edge', () => {
  const corner = { x: 400, y: 400, width: 600, height: 200 };
  const spot = edgeSpot({ x: 2200, y: 1500 }, area, [corner]);
  assert.equal(spot.x, 984); assert.ok(spot.y < 400 - 9, `y ${spot.y}`);
});

test('chrome over the whole edge leaves the plain crossing rather than no spot', () => {
  assert.deepEqual(edgeSpot({ x: 3000, y: 300 }, area, [area]), { x: 984, y: 300 });
});
