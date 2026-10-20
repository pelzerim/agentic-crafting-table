import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

/** VIS-03 States: each agent state on the fixture's agent card, set as plain node state the way the service writes it. */
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function update(page: Page, patch: Record<string, unknown>, id = 'agent') {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'sheep-states' }, commands }); }, JSON.stringify([{ type: 'node.update', id, ...patch }]));
}
const card = (page: Page, id = 'agent') => page.locator(`[data-item-id="${id}"]`);
const mark = (page: Page, id = 'agent') => page.locator(`[data-item-id="${id}"] > .working-mark`);
const token = (page: Page, name: string) => card(page).evaluate((element, name) => { const probe = document.createElement('i'); probe.style.color = `var(${name})`; element.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, name);
/** What the item's own paddock draws: its animations, its sheep sprite and what its pose adds. */
const lead = (page: Page) => mark(page).locator('> i').first().evaluate(item => { const style = getComputedStyle(item), sheep = getComputedStyle(item, '::after'), grass = getComputedStyle(item, '::before'), added = item.querySelector('u'), prop = added ? getComputedStyle(added, '::after') : { content: 'none' } as CSSStyleDeclaration, head = added ? getComputedStyle(added, '::before') : { content: 'none' } as CSSStyleDeclaration;
  return { names: style.animationName, x: style.getPropertyValue('--graze-x'), sheep: sheep.content === 'none' ? 'none' : sheep.maskSize.split(',')[0].trim(), sprite: sheep.maskImage, head: head.content === 'none' ? 'none' : head.maskImage, prop: prop.content === 'none' ? 'none' : `${prop.backgroundImage === 'none' ? prop.backgroundColor : 'drawn'} ${prop.maskImage === 'none' ? 'plain' : 'masked'}`, bitten: grass.maskImage.split('data:image/svg+xml').length - 1 === 2, grass: grass.height }; });
async function shot(page: Page, name: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.mouse.move(4, 4);
  const box = (await card(page).boundingBox())!;
  await expect(page).toHaveScreenshot(`sheep-${name}.png`, { clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
  expect(await mark(page).evaluate(element => element.getAnimations({ subtree: true }).length), 'still').toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
test.beforeEach(async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('a prompt, a question and an error each pose the sheep on a card that is not working', async ({ visual: { page } }) => {
  const amber = await token(page, '--act-attention');
  // Permission prompt: the standing sheep at a closed amber gate, nudging it.
  await update(page, { activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', summary: 'Waiting for your input', pose: 'gate' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'gate'); await expect(mark(page)).toHaveAttribute('data-variant', 'graze'); await expect(mark(page).locator('> i')).toHaveCount(1);
  await expect(mark(page)).toHaveAccessibleName('Needs your permission'); await expect(card(page)).toHaveAttribute('title', 'Needs your permission');
  const gate = await lead(page);
  expect(gate).toMatchObject({ names: 'graze-beat', sheep: '14px 8px', prop: `${amber} masked`, bitten: false });
  const nudge = (time: number) => mark(page).locator('> i').first().evaluate((item, time) => { for (const animation of item.getAnimations()) animation.currentTime = time; return getComputedStyle(item).getPropertyValue('--graze-x'); }, time);
  expect([await nudge(100), await nudge(1_000), await nudge(1_250)]).toEqual(['8px', '8px', '10px']);
  await shot(page, 'gate');
  // A question, or waiting for me: it faces out of the card, five pixels wide, and blinks.
  await update(page, { attentionNote: 'Agent asked a question', pose: 'asking' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'asking'); await expect(mark(page)).toHaveAccessibleName('Waiting for your input');
  const asking = await lead(page);
  expect(asking).toMatchObject({ names: 'graze-beat', sheep: '10px 8px', x: '8px', bitten: false }); expect(asking.prop).toMatch(/ masked$/); expect(asking.prop).not.toContain(amber);
  const eyes = (time: number) => mark(page).locator('> i').first().evaluate((item, time) => { for (const animation of item.getAnimations()) animation.currentTime = time; return getComputedStyle(item.querySelector('u')!, '::after').maskSize.split(' ')[0]; }, time);
  expect([await eyes(100), await eyes(2_000), await eyes(2_200)]).toEqual(['10px', '10px', '0px']);
  await shot(page, 'asking');
  // Stopped with an error: on its back, a leg twitching above it now and then. Nothing is red or amber.
  await update(page, { attention: 'error', attentionNote: 'Agent hit an error', summary: 'Claude reported an error', pose: 'fallen' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'fallen'); await expect(mark(page)).toHaveAccessibleName('Stopped with an error');
  const fallen = await lead(page);
  expect(fallen).toMatchObject({ names: 'graze-beat', sheep: '14px 8px', prop: 'drawn plain', bitten: false });
  expect(new Set([gate.sprite, asking.sprite, fallen.sprite]).size).toBe(3); expect(new Set([gate.head, asking.head, fallen.head]).size).toBe(3);
  await shot(page, 'fallen');
  // The pose goes with what it stands for: answering clears the attention and the reducer takes the pose in the same revision.
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'graze'); await expect(mark(page)).toHaveAccessibleName('Working');
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.pose).toBeUndefined();
  expect(await lead(page)).toMatchObject({ names: 'graze-walk, graze-face, graze-leg', sheep: '14px 48px', head: 'none', bitten: true });
});

test('running a command pushes a block; a prompt outranks it; helpers graze beside it', async ({ visual: { page } }) => {
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working', pose: 'command', helpers: 1 });
  await expect(mark(page)).toHaveAttribute('data-pose', 'command'); await expect(mark(page)).toHaveAccessibleName('Working, running a command, 1 subagent');
  await expect(mark(page).locator('> i')).toHaveCount(2);
  const pushing = await lead(page);
  expect(pushing).toMatchObject({ names: 'graze-push, graze-leg', sheep: '14px 48px', prop: 'drawn plain', bitten: true });
  // The block stays 16px ahead of the sheep, and the sheep stops five steps short of the end of its paddock for it.
  const run = await mark(page).locator('> i').first().evaluate(item => { const steps = Number(getComputedStyle(item).getPropertyValue('--graze-steps')), [push] = item.getAnimations(); push.currentTime = Number(push.effect!.getTiming().duration) - 10; return [steps, getComputedStyle(item).getPropertyValue('--graze-x'), getComputedStyle(item.querySelector('u')!, '::after').backgroundPosition.split(',')[0].trim().split(' ')[0]]; });
  expect(run[1]).toBe(`${(Number(run[0]) - 6) * 2}px`); expect(run[2]).toBe(`${(Number(run[0]) - 6) * 2 + 16}px`);
  expect(await mark(page).locator('> i').nth(1).evaluate(item => getComputedStyle(item).animationName)).toBe('graze-walk, graze-face, graze-leg');
  await shot(page, 'command');
  // A permission prompt while the command runs: the gate.
  await update(page, { attention: 'input', attentionNote: 'Agent needs permission', pose: 'gate' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'gate'); await expect(mark(page)).toHaveAccessibleName('Needs your permission, 1 subagent');
  await update(page, { attention: 'none', pose: 'none' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'graze');
});

test('an idle agent beside a watcher shows a pinwheel, an ended one tall grass, and any other idle card nothing', async ({ visual: { page } }) => {
  await update(page, { activity: 'idle', attention: 'none', summary: 'Ready for your next prompt' });
  await expect(mark(page)).toHaveCount(0);
  await update(page, { beside: 2 });
  await expect(mark(page)).toHaveAttribute('data-pose', 'mill'); await expect(mark(page)).toHaveAccessibleName('Idle, 2 background tasks running'); await expect(card(page)).toHaveAttribute('title', 'Idle, 2 background tasks running');
  expect(await lead(page)).toMatchObject({ names: 'none', sheep: 'none', bitten: false });
  const mill = mark(page).locator('> b[data-prop=mill]');
  await expect(mill).toHaveCount(1);
  const turning = () => mill.evaluate(element => getComputedStyle(element, '::after').maskPosition);
  expect(await mill.evaluate(element => { const style = getComputedStyle(element, '::after'); return [style.animationName, style.animationTimingFunction, style.maskSize]; })).toEqual(['graze-mill', 'steps(4)', '6px 24px']);
  const first = await turning(); await expect.poll(turning).not.toBe(first);
  const box = (await card(page).boundingBox())!, post = (await mill.boundingBox())!;
  expect(Math.round(box.x + box.width - (post.x + post.width))).toBe(29); expect(Math.round(post.height)).toBe(10);
  await shot(page, 'mill');
  // The session ended: no sheep, no pinwheel, the grass grown tall. The decorations go with it.
  await update(page, { pose: 'ended', summary: 'Conversation closed' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'ended'); await expect(mark(page)).toHaveAccessibleName('Session ended'); await expect(mill).toHaveCount(0);
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.beside).toBeUndefined();
  expect(await lead(page)).toMatchObject({ names: 'none', sheep: 'none', grass: '6px' });
  await shot(page, 'ended');
  await update(page, { pose: 'none' });
  await expect(mark(page)).toHaveCount(0);
  // An item that is not an agent never carries these states: idle, it has no mark.
  await expect(mark(page, 'pr')).toHaveCount(0); await expect(mark(page, 'ticket')).toHaveCount(0);
});

test('a helper that finished trots out past the right edge once; an old moment is not replayed', async ({ visual: { page } }) => {
  await update(page, { activity: 'working', attention: 'none', summary: 'Waiting on 2 subagents', helpers: 2 });
  await expect(mark(page).locator('> i')).toHaveCount(3); await expect(mark(page).locator('> b')).toHaveCount(0);
  const visit = () => mark(page).evaluate(element => getComputedStyle(element).getPropertyValue('--graze-visit'));
  // The fixture holds the app's clock still; a moment is timed on that clock, each a millisecond after the last.
  let tick = 0;
  const now = async () => await page.evaluate(() => Date.now()) + tick++;
  await update(page, { helpers: 1, moment: { kind: 'leave', at: await now() } });
  const visitor = mark(page).locator('> b[data-prop=visitor]');
  await expect(visitor).toHaveCount(1); await expect(mark(page)).toHaveAttribute('data-moment', 'leave'); await expect(mark(page).locator('> i')).toHaveCount(2);
  // It starts inside the card and steps to the right until the card's edge has clipped it.
  const seen: number[] = [];
  await expect.poll(async () => { seen.push(parseFloat(await visit())); return seen.at(-1); }, { intervals: [40] }).toBeGreaterThan(-24);
  await expect.poll(async () => { seen.push(parseFloat(await visit())); return seen.at(-1); }, { intervals: [60], timeout: 4_000 }).toBe(-24);
  const walk = seen.slice(seen.findIndex(value => value !== -24)).filter(value => value !== -24);
  expect(walk.length).toBeGreaterThan(3); expect(Math.max(...walk)).toBeLessThanOrEqual(30); expect([...walk].sort((a, b) => b - a)).toEqual(walk);
  // The next one plays again; one that happened a minute ago does not.
  await update(page, { helpers: 0, moment: { kind: 'leave', at: await now() } });
  await expect.poll(async () => parseFloat(await visit())).toBeGreaterThan(-24);
  await expect.poll(async () => parseFloat(await visit()), { timeout: 4_000 }).toBe(-24);
  await update(page, { helpers: 1 }); await update(page, { helpers: 0, moment: { kind: 'leave', at: await now() - 60_000 } });
  await page.waitForTimeout(400);
  expect(parseFloat(await visit())).toBe(-24);
  // Still: no moment is played.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await update(page, { helpers: 1 }); await update(page, { helpers: 0, moment: { kind: 'leave', at: await now() } });
  await page.waitForTimeout(300);
  expect(parseFloat(await visit())).toBe(-24);
});

test('compacting shears the sheep: wool flies, it stands thin, the wool is back', async ({ visual: { page } }) => {
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working', pose: 'shearing' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'shearing'); await expect(mark(page)).toHaveAccessibleName('Compacting'); await expect(card(page)).toHaveAttribute('title', 'Compacting');
  expect(await lead(page)).toMatchObject({ names: 'graze-beat', x: '8px', bitten: false });
  const at = (time: number) => mark(page).locator('> i').first().evaluate((item, time) => { for (const animation of item.getAnimations()) animation.currentTime = time; const wool = getComputedStyle(item.querySelector('u')!, '::after'); return { sheep: getComputedStyle(item, '::after').maskSize, head: getComputedStyle(item.querySelector('u')!, '::before').maskSize, wool: `${wool.maskSize} at ${wool.maskPosition}` }; }, time);
  // 3.67 s in eleven beats: woolly, wool in the air for two beats, thin for beats three to seven, woolly again.
  expect(await at(100)).toEqual({ sheep: '14px 8px, 0px 8px', head: '14px 8px', wool: '14px 4px at 10px 2px' });
  expect(await at(450)).toMatchObject({ sheep: '14px 8px, 0px 8px', wool: '14px 4px at 8px 0px' });
  expect(await at(800)).toMatchObject({ sheep: '14px 8px, 0px 8px', wool: '0px 4px at 6px -2px' });
  expect(await at(1_200)).toMatchObject({ sheep: '0px 8px, 14px 8px', head: '0px 8px' });
  expect(await at(2_500)).toMatchObject({ sheep: '0px 8px, 14px 8px', head: '0px 8px' });
  expect(await at(2_800)).toMatchObject({ sheep: '14px 8px, 0px 8px', head: '14px 8px' });
  await shot(page, 'shearing');
});

test('finished tasks flower at the right end, another model rings a bell, a worktree pens the sheep', async ({ visual: { page } }) => {
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working', tasks: { done: 3, total: 5 } });
  const flowers = mark(page).locator('> b[data-prop=flowers]'), paddocks = mark(page).locator('> i');
  await expect(mark(page)).toHaveAccessibleName('Working, 3 of 5 tasks done'); await expect(card(page)).toHaveAttribute('title', 'Working, 3 of 5 tasks done');
  // Three flowers, 12px each, at the right end of a 222px edge; the sheep keeps to the 186px left of them.
  const box = (await mark(page).boundingBox())!, bed = (await flowers.boundingBox())!, paddock = (await paddocks.first().boundingBox())!;
  expect([Math.round(bed.width), Math.round(box.x + box.width - (bed.x + bed.width)), Math.round(paddock.width)]).toEqual([36, 0, 186]);
  expect(await paddocks.first().evaluate(item => getComputedStyle(item).getPropertyValue('--graze-steps'))).toBe('87');
  expect(await flowers.evaluate(element => { const grown = getComputedStyle(element, '::before'), newest = getComputedStyle(element, '::after'); return [grown.width, grown.maskSize, newest.width, newest.animationName, newest.maskSize]; })).toEqual(['24px', '12px 8px', '12px', 'graze-bloom', '12px 16px']);
  // More tasks than a third of the edge has room for: six flowers here, and the words keep the real numbers.
  await update(page, { tasks: { done: 40, total: 41 } });
  await expect(mark(page)).toHaveAccessibleName('Working, 40 of 41 tasks done');
  expect(Math.round((await flowers.boundingBox())!.width)).toBe(72);
  await update(page, { tasks: { done: 0, total: 4 } });
  await expect(flowers).toHaveCount(0); await expect(mark(page)).toHaveAccessibleName('Working, 0 of 4 tasks done');
  // Another model: a bell under the neck, in mint.
  await update(page, { tasks: { done: 2, total: 4 }, bell: true });
  await expect(mark(page)).toHaveAttribute('data-bell', 'true'); await expect(mark(page)).toHaveAccessibleName('Working, 2 of 4 tasks done, on another model');
  const belled = await paddocks.first().evaluate(item => { const sheep = getComputedStyle(item, '::after'); return [sheep.maskSize, sheep.backgroundImage.split('linear-gradient').length - 1]; });
  expect(belled).toEqual(['2px 2px, 14px 48px', 2]);
  // A worktree: the sheep's paddock is a 68px pen and the grass beyond it has no sheep.
  await update(page, { pen: true });
  await expect(mark(page)).toHaveAccessibleName('Working, 2 of 4 tasks done, on another model, in a worktree');
  await expect(paddocks).toHaveCount(2); await expect(paddocks.first()).toHaveAttribute('data-pen', 'true'); await expect(paddocks.nth(1)).toHaveAttribute('data-empty', 'true');
  expect(Math.round((await paddocks.first().boundingBox())!.width)).toBe(68); expect(Math.round((await paddocks.first().locator('em').boundingBox())!.height)).toBe(10);
  expect(await paddocks.nth(1).evaluate(item => [getComputedStyle(item).animationName, getComputedStyle(item, '::after').content])).toEqual(['none', 'none']);
  await shot(page, 'decorated');
  // Helpers graze outside the pen.
  await update(page, { helpers: 2 });
  await expect(paddocks).toHaveCount(3);
  expect(await paddocks.evaluateAll(items => items.map(item => [Math.round(item.getBoundingClientRect().width), item.hasAttribute('data-pen'), getComputedStyle(item).animationName.split(', ')[0]]))).toEqual([[68, true, 'graze-walk'], [64, false, 'graze-walk'], [66, false, 'graze-walk']]);
  // The end of the session takes the flowers, the bell and the pen with it.
  await update(page, { activity: 'idle', helpers: 0, pose: 'ended' });
  await expect(mark(page)).toHaveAccessibleName('Session ended'); await expect(flowers).toHaveCount(0); await expect(paddocks).toHaveCount(1); await expect(mark(page)).not.toHaveAttribute('data-bell');
});

test('a failed tool is a stumble, a denied one a bump off a fence, a new helper walks in; each plays once', async ({ visual: { page } }) => {
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working' });
  let tick = 0;
  const now = async () => await page.evaluate(() => Date.now()) + tick++;
  const value = (name: string) => mark(page).evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), name);
  const played = async (name: string, resting: string) => { const seen = new Set<string>(); await expect.poll(async () => { seen.add(await value(name)); return seen.size; }, { intervals: [30] }).toBeGreaterThan(1); await expect.poll(() => value(name), { timeout: 4_000 }).toBe(resting); return [...seen]; };
  // Stumble: the head-down frame, a step lower at first.
  await update(page, { moment: { kind: 'stumble', at: await now() } });
  await expect(mark(page)).toHaveAttribute('data-moment', 'stumble');
  expect(await played('--graze-trip', '0')).toContain('1');
  const frame = () => mark(page).locator('> i').first().evaluate(item => getComputedStyle(item, '::after').maskPosition.split(' ')[1]);
  expect(['0px', '-8px', '-16px', '-24px']).toContain(await frame());
  await update(page, { moment: { kind: 'stumble', at: await now() } });
  await expect.poll(frame, { intervals: [20] }).toMatch(/^-(32|40)px$/);
  await expect.poll(() => value('--graze-trip'), { timeout: 3_000 }).toBe('0');
  // Bump: a fence for a moment, and the sheep pushed back from it.
  await update(page, { moment: { kind: 'bump', at: await now() } });
  await expect(mark(page)).toHaveAttribute('data-moment', 'bump');
  const fence = () => mark(page).locator('> i').first().evaluate(item => getComputedStyle(item.querySelector('u')!, '::after').maskSize);
  await expect.poll(fence, { intervals: [30] }).toBe('10px 10px');
  const recoil = new Set<string>();
  await expect.poll(async () => { recoil.add(await mark(page).locator('> i').first().evaluate(item => getComputedStyle(item, '::after').translate)); return fence(); }, { intervals: [40], timeout: 4_000 }).toBe('0px 10px');
  expect([...recoil].some(offset => /^-?4px/.test(offset))).toBe(true);
  // A helper arrives: its paddock is there at once and a sheep walks in from beyond the right edge, facing left.
  await update(page, { helpers: 1, moment: { kind: 'enter', at: await now() } });
  await expect(mark(page).locator('> i')).toHaveCount(2); await expect(mark(page).locator('> b[data-prop=visitor]')).toHaveCount(1);
  const walked = (await played('--graze-visit', '-24px')).map(parseFloat).filter(offset => offset !== -24);
  expect(Math.max(...walked)).toBeLessThanOrEqual(30); expect(walked.length).toBeGreaterThan(0);
  // On a card that is not grazing none of them plays, and nothing plays in the still state.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await update(page, { moment: { kind: 'bump', at: await now() } });
  await page.waitForTimeout(300);
  expect([await value('--graze-fence'), await mark(page).evaluate(element => element.getAnimations().length)]).toEqual(['0', 0]);
});
