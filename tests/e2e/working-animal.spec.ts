import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import type { WorkingMarkSettings } from '../../packages/core/settings.ts';

/** VIS-03 Working animal: Settings → Map chooses a sheep or a raccoon for every card's Working mark. */
async function update(page: Page, patch: Record<string, unknown>, id = 'agent') {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'working-animal' }, commands }); }, JSON.stringify([{ type: 'node.update', id, ...patch }]));
}
async function choose(page: Page, workingMark: WorkingMarkSettings) {
  await page.evaluate(async workingMark => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, workingMark } }); }, workingMark);
}
const card = (page: Page, id = 'agent') => page.locator(`[data-item-id="${id}"]`);
const mark = (page: Page, id = 'agent') => page.locator(`[data-item-id="${id}"] > .working-mark`);
/** Each paddock's animal: the size of its fur mask and whether it has tone layers. */
const animals = (page: Page) => mark(page).locator('> i').evaluateAll(items => items.map(item => { const fur = getComputedStyle(item, '::after'), tones = item.querySelector('s'); return `${fur.maskSize.split(',').at(-1)!.trim()}${tones ? ` ${getComputedStyle(tones, '::before').content === 'none' ? 'bare' : 'toned'}` : ''}`; }));
async function shot(page: Page, name: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.mouse.move(4, 4);
  const box = (await card(page).boundingBox())!;
  await expect(page).toHaveScreenshot(`raccoon-${name}.png`, { clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
  expect(await mark(page).evaluate(element => element.getAnimations({ subtree: true }).length), 'still').toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
test.beforeEach(async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('the working animal is a sheep by default; choosing a raccoon in Settings → Map switches every card at once and lasts', async ({ visual: { page } }) => {
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working', helpers: 1 });
  await expect(mark(page)).toHaveAttribute('data-animal', 'sheep'); await expect(mark(page)).not.toHaveAttribute('data-kits');
  expect(await animals(page)).toEqual(['14px 48px', '14px 48px']);
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.workingMark).toEqual({ animal: 'sheep', helpers: 'kits' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('treeitem', { name: 'Map', exact: true }).click();
  const animal = dialog.getByRole('radiogroup', { name: 'Working animal' }), helpers = dialog.getByRole('radiogroup', { name: 'Raccoon helpers' });
  await expect(animal.getByRole('radio', { name: 'Sheep' })).toHaveAttribute('aria-checked', 'true');
  await expect(helpers).toHaveCount(0);
  await animal.getByRole('radio', { name: 'Raccoon' }).click();
  await expect(helpers.getByRole('radio', { name: 'Kits' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('status').filter({ hasText: '1 unsaved change · Map' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  // No reload: the mark that was a sheep is a raccoon, its helper a kit, each with its dark and light layer.
  await expect(mark(page)).toHaveAttribute('data-animal', 'raccoon'); await expect(mark(page)).toHaveAttribute('data-kits', 'true');
  expect(await animals(page)).toEqual(['18px 48px toned', '14px 32px toned']);
  expect(await mark(page).locator('> i').first().evaluate(item => getComputedStyle(item, '::before').maskSize)).toBe('128px 6px, 36px 8px');
  // Helpers the same size are raccoons too.
  await choose(page, { animal: 'raccoon', helpers: 'same' });
  await expect(mark(page)).not.toHaveAttribute('data-kits');
  expect(await animals(page)).toEqual(['18px 48px toned', '18px 48px toned']);
  await choose(page, { animal: 'raccoon', helpers: 'kits' });
  await expect(mark(page)).toHaveAttribute('data-kits', 'true');
  await page.reload();
  await expect(mark(page)).toHaveAttribute('data-animal', 'raccoon');
  expect(await animals(page)).toEqual(['18px 48px toned', '14px 32px toned']);
  // Back to the sheep: its paddocks and sprites are exactly as before.
  await choose(page, { animal: 'sheep', helpers: 'kits' });
  await expect(mark(page)).toHaveAttribute('data-animal', 'sheep');
  expect(await animals(page)).toEqual(['14px 48px', '14px 48px']);
});

test('the raccoon\'s poses: gate, asking, on its back, washing its paws, pushing a can, asleep, and kits beside it', async ({ visual: { page } }) => {
  await choose(page, { animal: 'raccoon', helpers: 'kits' });
  const lead = mark(page).locator('> i').first();
  await update(page, { activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', summary: 'Waiting for your input', pose: 'gate' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'gate'); await expect(mark(page)).toHaveAttribute('data-animal', 'raccoon');
  expect(await lead.evaluate(item => [getComputedStyle(item, '::after').maskSize, getComputedStyle(item.querySelector('u')!, '::before').content, getComputedStyle(item.querySelector('u')!, '::after').maskPosition])).toEqual(['18px 8px', 'none', '30px 100%']);
  await shot(page, 'gate');
  // Asking: it faces out; the blink closes its band on the last of nine beats.
  await update(page, { attentionNote: 'Agent asked a question', pose: 'asking' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'asking');
  const blink = (time: number) => lead.evaluate((item, time) => { for (const animation of item.getAnimations()) animation.currentTime = time; return getComputedStyle(item.querySelector('u')!, '::after').maskSize.split(' ')[0]; }, time);
  expect([await blink(100), await blink(2_000), await blink(2_200)]).toEqual(['0px', '0px', '10px']);
  await shot(page, 'asking');
  await update(page, { attention: 'error', attentionNote: 'Agent hit an error', summary: 'Claude reported an error', pose: 'fallen' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'fallen');
  await shot(page, 'fallen');
  // Compacting: paws up and two drops rising for seven beats of eleven, then standing as before.
  await update(page, { activity: 'working', attention: 'none', summary: 'Claude is working', pose: 'shearing' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'shearing'); await expect(mark(page)).toHaveAccessibleName('Compacting');
  const washing = (time: number) => lead.evaluate((item, time) => { for (const animation of item.getAnimations()) animation.currentTime = time; const drops = getComputedStyle(item.querySelector('u')!, '::after'); return [getComputedStyle(item, '::after').maskSize, drops.backgroundSize]; }, time);
  expect(await washing(100)).toEqual(['0px 8px, 18px 8px', '2px 2px, 2px 2px']);
  expect(await washing(2_800)).toEqual(['18px 8px, 0px 8px', '0px 2px, 0px 2px']);
  await shot(page, 'washing');
  await update(page, { pose: 'command' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'command');
  expect(await lead.evaluate(item => getComputedStyle(item.querySelector('u')!, '::after').maskSize)).toBe('8px 8px');
  await shot(page, 'command');
  await update(page, { pose: 'none', helpers: 2, waiting: true, summary: 'Waiting on 2 subagents' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'asleep');
  expect(await animals(page)).toEqual(['18px 6px toned', '14px 32px toned', '14px 32px toned']);
  await shot(page, 'asleep');
  await update(page, { waiting: false, summary: 'Claude is working' });
  await expect(mark(page)).toHaveAttribute('data-pose', 'graze');
  await shot(page, 'kits');
});
