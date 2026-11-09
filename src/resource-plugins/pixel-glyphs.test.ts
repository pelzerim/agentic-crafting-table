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

test('the agent is a 12×12 glyph of its own, a symmetric head with an antenna, drawn like the other item icons', () => {
  const agent: readonly string[] = (PIXEL_GLYPHS[12] as Record<string, readonly string[]>).agent;
  assert.ok(agent, 'PIXEL_GLYPHS[12].agent exists');
  assert.equal(agent.length, 12);
  assert.ok(agent.every(row => row.length === 12 && /^[.X]+$/.test(row)));
  assert.deepEqual(mirror(agent), agent);
  for (const [name, rows] of Object.entries(PIXEL_GLYPHS[12])) if (name !== 'agent') assert.notDeepEqual(rows, agent, `agent differs from ${name}`);
});

test('the interface draws pixel glyphs, never emoji', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const files = execFileSync('git', ['ls-files', 'apps/desktop/renderer', 'src/resource-plugins', 'packages/plugin-sdk'], { encoding: 'utf8' }).split('\n')
    .filter(file => /\.(tsx?|css|mjs)$/.test(file) && !file.includes('.test.'));
  const emoji = /[\u{1F000}-\u{1FAFF}]|️/u;
  const found = files.flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) => emoji.test(line) ? [`${file}:${index + 1}`] : []));
  assert.deepEqual(found, [], 'draw icons as glyphs in src/resource-plugins/pixel-glyphs.ts; see the design guide in AGENTS.md');
});

test('the GitHub issue is a 12×12 glyph of its own: a ring around a dot, symmetric both ways', () => {
  const issue: readonly string[] = (PIXEL_GLYPHS[12] as Record<string, readonly string[]>)['circle-dot'];
  assert.ok(issue, 'PIXEL_GLYPHS[12][circle-dot] exists');
  assert.equal(issue.length, 12);
  assert.ok(issue.every(row => row.length === 12 && /^[.X]+$/.test(row)));
  assert.deepEqual(mirror(issue), issue);
  assert.deepEqual([...issue].reverse(), [...issue]);
  assert.equal(issue[0], '............'); assert.equal(issue[11], '............');
  for (const [name, rows] of Object.entries(PIXEL_GLYPHS[12])) if (name !== 'circle-dot') assert.notDeepEqual(rows, issue, `circle-dot differs from ${name}`);
});
