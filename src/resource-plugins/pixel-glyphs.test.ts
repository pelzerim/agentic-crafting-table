import test from 'node:test';
import assert from 'node:assert/strict';
import { PIXEL_GLYPHS } from './pixel-glyphs.ts';

const glyphs: Record<string, readonly string[]> = PIXEL_GLYPHS[8];
const rotate = (rows: readonly string[]) => rows.map((_, y) => rows.map((_, x) => rows[rows.length - 1 - x][y]).join(''));
const mirror = (rows: readonly string[]) => rows.map(row => [...row].reverse().join(''));

test('the working spark is its own 8×8 glyph, distinct from the plus, the Claude mark and every other status shape', () => {
  const working = glyphs.working;
  assert.ok(working, 'PIXEL_GLYPHS[8].working exists');
  assert.equal(working.length, 8);
  assert.ok(working.every(row => row.length === 8 && /^[.X]+$/.test(row)));
  for (const [name, rows] of Object.entries(glyphs)) if (name !== 'working') assert.notDeepEqual(working, rows, `working differs from ${name}`);
});

test('the working spark is a tilted four-point star: it survives a quarter turn but not a mirror, so it never reads as a plus', () => {
  const working = glyphs.working;
  assert.deepEqual(rotate(working), working);
  assert.notDeepEqual(mirror(working), working);
  assert.deepEqual(mirror(glyphs.plus), glyphs.plus);
  // No full row or column of lit cells: a plus's arms always make one.
  assert.ok(working.every(row => row !== 'XXXXXXXX'));
  assert.ok(working.every((_, x) => working.some(row => row[x] === '.')));
});

test('the reminders bell is a 12×12 glyph of its own, symmetric like a bell', () => {
  const bell: readonly string[] = (PIXEL_GLYPHS[12] as Record<string, readonly string[]>).bell;
  assert.ok(bell, 'PIXEL_GLYPHS[12].bell exists');
  assert.equal(bell.length, 12);
  assert.ok(bell.every(row => row.length === 12 && /^[.X]+$/.test(row)));
  assert.deepEqual(mirror(bell), bell);
  for (const [name, rows] of Object.entries(PIXEL_GLYPHS[12])) if (name !== 'bell') assert.notDeepEqual(rows, bell, `bell differs from ${name}`);
});

test('the plot pin is an 8×8 glyph of its own, symmetric like a push pin', () => {
  const pin = glyphs.pin;
  assert.ok(pin, 'PIXEL_GLYPHS[8].pin exists');
  assert.equal(pin.length, 8);
  assert.ok(pin.every(row => row.length === 8 && /^[.X]+$/.test(row)));
  assert.deepEqual(mirror(pin), pin);
  for (const [name, rows] of Object.entries(glyphs)) if (name !== 'pin') assert.notDeepEqual(pin, rows, `pin differs from ${name}`);
});
