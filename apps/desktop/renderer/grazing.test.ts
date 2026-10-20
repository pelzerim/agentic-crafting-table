import test from 'node:test';
import assert from 'node:assert/strict';
import { ANIMALS, BACK, BITE, DOWN, FENCE, FLOWER, FRONT, GRAZE_ROOM, LYING, SHEEP, SHORN, TRASH_CAN, TUFTS, ZED, animalRows, biteRows, flockSize, grazeSteps, leadPose, markLabel, meadow, millRows, paddockPixels, pixelMask, sheepRows, tallGrass, workingVariant } from './grazing.ts';

const mirrored = (row: string) => [...row].reverse().join('');

test('the sheep is 7×4 with two walk frames that differ only in the legs', () => {
  assert.equal(SHEEP.length, 2);
  for (const frame of SHEEP) { assert.equal(frame.length, 4); for (const row of frame) assert.equal(row.length, 7); }
  assert.deepEqual(SHEEP[0].slice(0, 3), SHEEP[1].slice(0, 3));
  assert.notEqual(SHEEP[0][3], SHEEP[1][3]);
  // The body keeps to the first five columns and the head to the last two: one colour split draws both.
  for (const frame of SHEEP) for (const row of frame) { assert.doesNotMatch(row.slice(0, 5), /H/); assert.doesNotMatch(row.slice(5), /X/); }
  assert.match(SHEEP[0].join(''), /H/);
  assert.equal(GRAZE_ROOM, SHEEP[0].length * 2);
});

test('the sheep strip stacks both frames facing right, then both mirrored to face left', () => {
  const rows = sheepRows();
  assert.equal(rows.length, 24);
  assert.deepEqual(rows.slice(0, 4), [...SHEEP[0]]); assert.deepEqual(rows.slice(4, 8), [...SHEEP[1]]);
  assert.deepEqual(rows.slice(8, 12), SHEEP[0].map(mirrored)); assert.deepEqual(rows.slice(12, 16), SHEEP[1].map(mirrored));
  // The stumble keeps the body in the first five columns, so the same colour split draws it.
  assert.deepEqual(rows.slice(16, 20), [...DOWN]); assert.deepEqual(rows.slice(20), DOWN.map(mirrored));
  for (const row of DOWN) { assert.doesNotMatch(row.slice(0, 5), /H/); assert.doesNotMatch(row.slice(5), /X/); }
  for (const row of FENCE) assert.equal(row, mirrored(row));
  assert.deepEqual(FLOWER[0].slice(1), ['.X....', '.X....', '.X....']); assert.deepEqual(FLOWER[1].slice(2), FLOWER[0].slice(2));
});

test('tufts are irregular and one or two pixels tall', () => {
  const [top, bottom] = TUFTS;
  assert.equal(top.length, 64); assert.equal(bottom.length, 64);
  const grown = [...bottom].filter(cell => cell === 'X').length, tall = [...top].filter(cell => cell === 'X').length;
  assert.ok(grown >= 22 && grown <= 36, `${grown} of 64 columns grow a tuft`);
  assert.ok(tall >= 6 && tall < grown, `${tall} tufts are two pixels tall`);
  // A second pixel only ever stands on a first one.
  for (let column = 0; column < 64; column++) if (top[column] === 'X') assert.equal(bottom[column], 'X');
  // Neither a lawn nor a bald patch, also across the seam where the tile repeats.
  const lap = bottom + bottom;
  assert.doesNotMatch(lap, /X{5}/); assert.doesNotMatch(lap, /\.{7}/);
  // Not a period-two or period-four stripe.
  assert.notEqual(bottom, bottom.slice(2) + bottom.slice(0, 2)); assert.notEqual(bottom, bottom.slice(4) + bottom.slice(0, 4));
});

test('the bite clears the grass at the mouth and behind it, and leaves stubs further back', () => {
  const rows = biteRows(), width = BITE.regrow + BITE.eaten + BITE.ahead;
  assert.equal(rows.length, 4); for (const row of rows) assert.equal(row.length, width);
  const [top, bottom, leftTop, leftBottom] = rows;
  // Facing right the mouth leads: everything from the stubs to just past the mouth is gone.
  assert.equal(top, 'X'.repeat(width));
  assert.equal(bottom.slice(BITE.regrow), 'X'.repeat(BITE.eaten + BITE.ahead));
  // Every other column behind that keeps its first pixel: the grass is coming back.
  assert.match(bottom.slice(0, BITE.regrow), /^(\.X)+$|^(X\.)+$/);
  assert.equal(leftTop, mirrored(top)); assert.equal(leftBottom, mirrored(bottom));
});

test('a pixel mask is one black square per lit pixel, whatever the letter', () => {
  const uri = pixelMask(['X.', '.H']), svg = decodeURIComponent(uri.slice('url("data:image/svg+xml,'.length, -2));
  assert.match(uri, /^url\("data:image\/svg\+xml,/);
  assert.match(svg, /viewBox="0 0 2 2"/); assert.match(svg, /preserveAspectRatio="none"/); assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /d="M0 0h1v1h-1zM1 1h1v1h-1z"/);
});

test('a card gets the sheep only when it has room for one', () => {
  assert.equal(workingVariant({ width: 200, height: 84 }), 'graze');
  assert.equal(workingVariant({ width: 150, height: 48 }), 'graze');
  assert.equal(workingVariant({ width: 120, height: 44 }), 'graze');
  // Too narrow, too low, or the tiny tier: tufts with a glint.
  assert.equal(workingVariant({ width: 119, height: 84 }), 'glint');
  assert.equal(workingVariant({ width: 200, height: 43 }), 'glint');
  assert.equal(workingVariant({ width: 144, height: 32, tiny: true }), 'glint');
  assert.equal(workingVariant({ width: 300, height: 60, tiny: true }), 'glint');
  // A far-zoom icon keeps its stripe.
  assert.equal(workingVariant({ width: 48, height: 48, icon: true }), 'icon');
  assert.equal(workingVariant({ width: 200, height: 84, icon: true }), 'icon');
});

test('steps cover the track in 2px pixels: the sheep stays inside, the glint runs in and out', () => {
  // A 200px card has a 182px track, 91 pixels; the 7-pixel sheep has 85 places to stand.
  assert.equal(grazeSteps('graze', 200), 85);
  assert.equal(grazeSteps('graze', 201), 85);
  assert.equal(grazeSteps('graze', 120), 45);
  // The glint starts hidden left of the track and ends hidden right of it.
  assert.equal(grazeSteps('glint', 100), 41 + 4);
  assert.equal(grazeSteps('glint', 144), 63 + 4);
  assert.equal(grazeSteps('icon', 48), 0);
  assert.ok(grazeSteps('glint', 10) >= 1);
});

test('the flock is one sheep plus one per busy helper, capped so every sheep has a 44px paddock', () => {
  assert.equal(flockSize(200), 1); assert.equal(flockSize(200, 0), 1);
  assert.equal(flockSize(200, 1), 2); assert.equal(flockSize(200, 2), 3); assert.equal(flockSize(200, 3), 4);
  // A 200px card has 182px of edge: four paddocks, however many helpers.
  assert.equal(flockSize(200, 4), 4); assert.equal(flockSize(200, 40), 4);
  assert.equal(flockSize(150, 9), 3); assert.equal(flockSize(120, 9), 2); assert.equal(flockSize(312, 9), 6);
  // Never fewer than one, whatever the width or the number says.
  assert.equal(flockSize(60, 3), 1); assert.equal(flockSize(200, -1), 1);
});

test('each sheep walks its own paddock: equal stretches of the edge in whole pixels', () => {
  assert.equal(paddockPixels(200, 1), 91); assert.equal(grazeSteps('graze', 200, 1), 85);
  assert.equal(paddockPixels(200, 2), 45); assert.equal(grazeSteps('graze', 200, 2), 39);
  assert.equal(paddockPixels(200, 4), 22); assert.equal(grazeSteps('graze', 200, 4), 16);
  // The glint runs the whole edge whatever the flock would be.
  assert.equal(grazeSteps('glint', 200, 4), grazeSteps('glint', 200));
  for (const [width, helpers] of [[120, 5], [150, 2], [200, 3], [240, 7], [640, 30]] as const) {
    const sheep = flockSize(width, helpers);
    assert.ok(paddockPixels(width, sheep) >= 22, `${width}px with ${sheep} sheep`);
    assert.ok(paddockPixels(width, sheep) * sheep * 2 <= width - 18);
    assert.ok(grazeSteps('graze', width, sheep) >= 16);
  }
});


test('the lying sheep is three pixels tall and as long as the standing one; the z is two by three', () => {
  assert.equal(LYING.length, 3); for (const row of LYING) assert.equal(row.length, SHEEP[0][0].length);
  assert.deepEqual(LYING.slice(0, 2), SHEEP[0].slice(0, 2), 'the same back and head, without legs');
  assert.match(LYING[2], /^X+H$/);
  assert.deepEqual([...ZED], ['XX', '.X', 'XX']);
});



test('the item\'s own sheep takes the first pose that applies; an idle item shows a mark only when ended or beside a shell', () => {
  const working = { working: true }, idle = { working: false };
  assert.equal(leadPose({ ...idle, pose: 'gate' }), 'gate'); assert.equal(leadPose({ ...idle, pose: 'asking' }), 'asking'); assert.equal(leadPose({ ...idle, pose: 'fallen' }), 'fallen');
  assert.equal(leadPose({ ...working, pose: 'shearing', helpers: 2, waiting: true }), 'shearing');
  assert.equal(leadPose({ ...working, pose: 'command', helpers: 2, waiting: true }), 'command');
  assert.equal(leadPose({ ...working, helpers: 2, waiting: true }), 'asleep'); assert.equal(leadPose({ ...working, helpers: 0, waiting: true }), 'graze');
  assert.equal(leadPose(working), 'graze'); assert.equal(leadPose({ ...working, beside: 2 }), 'graze');
  assert.equal(leadPose({ ...idle, pose: 'ended' }), 'ended'); assert.equal(leadPose({ ...idle, pose: 'ended', beside: 1 }), 'ended');
  assert.equal(leadPose({ ...idle, beside: 1 }), 'mill');
  assert.equal(leadPose(idle), undefined); assert.equal(leadPose({ ...idle, helpers: 3, tasks: { done: 1, total: 2 }, bell: true, pen: true }), undefined, 'decorations alone do not put a mark on an idle card');
});

test('the mark says the state in words', () => {
  const working = { working: true }, idle = { working: false };
  assert.equal(markLabel({ ...idle, pose: 'gate' }), 'Needs your permission'); assert.equal(markLabel({ ...idle, pose: 'asking' }), 'Waiting for your input');
  assert.equal(markLabel({ ...idle, pose: 'fallen' }), 'Stopped with an error'); assert.equal(markLabel({ ...idle, pose: 'ended' }), 'Session ended');
  assert.equal(markLabel({ ...idle, beside: 1 }), 'Idle, 1 background task running'); assert.equal(markLabel({ ...idle, beside: 3 }), 'Idle, 3 background tasks running');
  assert.equal(markLabel({ ...working, pose: 'shearing' }), 'Compacting'); assert.equal(markLabel({ ...working, pose: 'command' }), 'Working, running a command');
  assert.equal(markLabel({ ...working, pose: 'command', helpers: 2 }), 'Working, running a command, 2 subagents');
  assert.equal(markLabel(working), 'Working'); assert.equal(markLabel({ ...working, helpers: 1 }), 'Working, 1 subagent');
  assert.equal(markLabel({ ...working, helpers: 2, waiting: true }), 'Working, waiting on 2 subagents');
  assert.equal(markLabel({ ...working, tasks: { done: 3, total: 5 }, bell: true, pen: true }), 'Working, 3 of 5 tasks done, on another model, in a worktree');
  assert.equal(markLabel({ ...idle, pose: 'gate', tasks: { done: 1, total: 2 } }), 'Needs your permission, 1 of 2 tasks done');
});

test('the meadow divides the edge: flowers at the right end, a pen for the lead, equal paddocks for the rest', () => {
  // 200px: 91 pixels of edge.
  assert.deepEqual(meadow(200, { helpers: 1 }), { flowers: 0, paddocks: [{ span: 90, steps: 39, offset: 0 }, { span: 90, steps: 39, offset: 90 }] });
  assert.deepEqual(meadow(200, {}), { flowers: 0, paddocks: [{ span: 182, steps: 85, offset: 0 }] });
  // Flowers take 6 pixels each, at most a third of the edge; the sheep keep to the rest.
  const flowered = meadow(200, { helpers: 9, flowers: 9 });
  assert.equal(flowered.flowers, 5); assert.equal(flowered.paddocks.length, 2); assert.deepEqual(flowered.paddocks[0], { span: 60, steps: 24, offset: 0 });
  assert.equal(meadow(200, { flowers: 2 }).paddocks[0].steps, 91 - 12 - 6);
  assert.equal(meadow(120, { flowers: 9 }).flowers, 2);
  // The pen is at most 34 pixels of the first paddock; the grass beyond it has no sheep.
  assert.deepEqual(meadow(200, { pen: true }), { flowers: 0, paddocks: [{ span: 68, steps: 26, offset: 0, pen: true }, { span: 114, steps: 0, offset: 68, empty: true }] });
  const penned = meadow(240, { helpers: 9, pen: true });
  assert.deepEqual(penned.paddocks.map(paddock => paddock.span), [68, 50, 50, 50]); assert.deepEqual(penned.paddocks[1], { span: 50, steps: 19, offset: 68 });
  for (const [width, options] of [[120, { helpers: 5, pen: true, flowers: 4 }], [150, { helpers: 2, flowers: 1 }], [640, { helpers: 30, pen: true, flowers: 40 }]] as const) {
    const { flowers, paddocks } = meadow(width, options), edge = Math.floor((width - 18) / 2) * 2;
    assert.ok(paddocks.reduce((sum, paddock) => sum + paddock.span, 0) + flowers * 12 <= edge, `${width}px fits`);
    for (const paddock of paddocks.filter(paddock => !paddock.empty)) assert.ok(paddock.steps >= 14 && paddock.span >= 44, `${width}px paddock`);
  }
});

test('the pose sprites share the sheep\'s size and the tall grass stands one to three pixels high', () => {
  for (const sprite of [BACK, SHORN]) { assert.equal(sprite.length, 4); for (const row of sprite) assert.equal(row.length, 7); }
  assert.equal(FRONT.length, 4); for (const row of FRONT) assert.equal(row.length, 5);
  assert.deepEqual([...BACK].reverse(), [...SHEEP[0]], 'the standing sheep, upside down');
  const [body, tips] = tallGrass();
  assert.equal(body.length, 3); assert.equal(tips.length, 3); for (const row of [...body, ...tips]) assert.equal(row.length, 64);
  for (let column = 0; column < 64; column++) {
    const stalk = body.map(row => row[column]).join(''), tip = tips.map(row => row[column]).join('');
    assert.match(stalk + '|' + tip, /^(\.\.\.\|\.\.\.|\.\.\.\|\.\.X|\.\.X\|\.X\.|\.XX\|X\.\.)$/, `column ${column}`);
  }
  assert.ok(body.at(-1)!.replaceAll('.', '').length + tips.at(-1)!.replaceAll('.', '').length >= 36, 'denser than the grazed tufts');
  assert.deepEqual(millRows().length, 12);
  const mask = pixelMask(['XH', 'H.'], 'H'), svg = decodeURIComponent(mask.slice('url("data:image/svg+xml,'.length, -2));
  assert.match(svg, /d="M1 0h1v1h-1zM0 1h1v1h-1z"/);
});

const RACCOON_TONES = /^[.BDL]+$/;
const sized = (rows: readonly string[], width: number, height: number) => { assert.equal(rows.length, height); for (const row of rows) { assert.equal(row.length, width); assert.match(row, RACCOON_TONES); } };

test('the raccoon is 9×4 in three tones, walks in two frames that differ only in the legs, and its legs are body tone', () => {
  const { walk, down } = ANIMALS.raccoon;
  assert.equal(walk.length, 2); for (const frame of walk) sized(frame, 9, 4);
  assert.deepEqual(walk[0].slice(0, 3), walk[1].slice(0, 3)); assert.notEqual(walk[0][3], walk[1][3]);
  for (const frame of walk) assert.match(frame[3], /^[.B]+$/);
  for (const tone of ['B', 'D', 'L']) assert.match(walk[0].join(''), new RegExp(tone));
  sized(down, 9, 4); assert.match(down[0], /^\.+$/, 'the stumble drops the head a row');
  assert.equal(ANIMALS.raccoon.width, 9); assert.equal(ANIMALS.sheep.width, 7);
});

test('the raccoon\'s poses: facing out with a blink, on its back, curled up, washing its paws; a kit is 7×4', () => {
  const { walk, front, blink, back, lying, odd, kit } = ANIMALS.raccoon;
  sized(front, 5, 4); sized(blink!, 5, 4);
  assert.deepEqual(front.filter((row, index) => row !== blink![index]).length, 1, 'a blink changes one row');
  sized(back, 9, 4); assert.deepEqual([...back].reverse(), [...walk[0]], 'the standing raccoon, upside down');
  sized(lying, 9, 3);
  sized(odd!, 9, 4); assert.deepEqual(odd!.slice(0, 3), walk[0].slice(0, 3)); assert.match(odd![3], /L/, 'its paws are up and pale');
  assert.equal(kit!.length, 2); for (const frame of kit!) sized(frame, 7, 4);
  assert.deepEqual(kit![0].slice(0, 3), kit![1].slice(0, 3));
  for (const row of TRASH_CAN) assert.equal(row.length, 4); assert.equal(TRASH_CAN.length, 4);
  assert.equal(ANIMALS.sheep.kit, undefined);
});

test('a strip per animal: both walk frames facing right, both facing left, then the stumble both ways; a kit strip has no stumble', () => {
  assert.deepEqual(animalRows('sheep'), sheepRows());
  const rows = animalRows('raccoon'), { walk, down, kit } = ANIMALS.raccoon;
  assert.equal(rows.length, 24); for (const row of rows) assert.equal(row.length, 9);
  assert.deepEqual(rows.slice(0, 8), [...walk[0], ...walk[1]]); assert.deepEqual(rows.slice(8, 16), [...walk[0], ...walk[1]].map(mirrored));
  assert.deepEqual(rows.slice(16), [...down, ...down.map(mirrored)]);
  assert.deepEqual(animalRows('raccoon', true), [...kit![0], ...kit![1], ...[...kit![0], ...kit![1]].map(mirrored)]);
});

test('the raccoon bites a wider swathe: eaten is its width plus one, the stubs and the lead are the sheep\'s', () => {
  assert.deepEqual(biteRows(), biteRows('sheep'));
  const rows = biteRows('raccoon'), width = BITE.regrow + 10 + BITE.ahead;
  assert.equal(rows.length, 4); for (const row of rows) assert.equal(row.length, width);
  assert.equal(rows[1].slice(BITE.regrow), 'X'.repeat(10 + BITE.ahead)); assert.equal(rows[2], mirrored(rows[0]));
});

test('room per animal: a raccoon\'s paddock is 50px; the sheep\'s numbers do not change', () => {
  for (const [width, helpers] of [[120, 5], [150, 2], [200, 3], [240, 7], [640, 30]] as const) {
    assert.equal(flockSize(width, helpers, 'sheep'), flockSize(width, helpers));
    assert.equal(grazeSteps('graze', width, 1, 'sheep'), grazeSteps('graze', width, 1));
    for (const options of [{ helpers }, { helpers, pen: true }, { helpers, flowers: 3 }]) assert.deepEqual(meadow(width, { ...options, animal: 'sheep' }), meadow(width, options));
  }
  assert.equal(flockSize(200, 9, 'raccoon'), 3); assert.equal(flockSize(150, 9, 'raccoon'), 2); assert.equal(flockSize(120, 9, 'raccoon'), 2); assert.equal(flockSize(312, 9, 'raccoon'), 5);
  assert.equal(grazeSteps('graze', 200, 1, 'raccoon'), 83);
  // Kits are 7 pixels wide, so a kit has two more places to stand in the same paddock.
  assert.deepEqual(meadow(200, { helpers: 1, animal: 'raccoon' }), { flowers: 0, paddocks: [{ span: 90, steps: 37, offset: 0 }, { span: 90, steps: 39, offset: 90 }] });
  assert.deepEqual(meadow(200, { helpers: 1, animal: 'raccoon', kits: false }).paddocks[1], { span: 90, steps: 37, offset: 90 });
  assert.deepEqual(meadow(200, { pen: true, animal: 'raccoon' }).paddocks[0], { span: 68, steps: 24, offset: 0, pen: true });
  for (const [width, options] of [[120, { helpers: 5, pen: true, flowers: 4 }], [150, { helpers: 2, flowers: 1 }], [640, { helpers: 30, pen: true, flowers: 40 }]] as const) {
    const { paddocks } = meadow(width, { ...options, animal: 'raccoon' });
    for (const paddock of paddocks.filter(paddock => !paddock.empty && !paddock.pen)) assert.ok(paddock.span >= 50, `${width}px paddock`);
  }
});
