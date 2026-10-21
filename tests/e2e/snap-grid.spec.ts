import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const position = (page: Page, id: string) => page.evaluate(async id => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.id === id)!.position, id);
const snapping = (page: Page, enabled: boolean) => page.evaluate(async enabled => {
  const saved = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, snapToGrid: enabled } });
}, enabled);
const onGrid = ({ x, y }: { x: number; y: number }) => x % 48 === 0 && y % 48 === 0;
/** Drags the card by a small, odd number of screen pixels and releases it. */
async function nudge(page: Page, dx: number, dy: number) {
  const box = (await page.getByRole('article', { name: 'Plan switcher', exact: true }).boundingBox())!, x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
}

test('with Snap to grid on, a dropped card and an arrow-key nudge land on the 48 px grid; off, the card stays where it was let go', async ({ visual: { page } }) => {
  await snapping(page, true);
  await nudge(page, 37, 23);
  await expect.poll(() => position(page, 'pr')).not.toEqual({ x: 960, y: 300 });
  const dropped = await position(page, 'pr');
  expect(onGrid(dropped), `${dropped.x},${dropped.y}`).toBe(true);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => position(page, 'pr')).toEqual({ x: dropped.x + 48, y: dropped.y });
  await snapping(page, false);
  await nudge(page, 37, 23);
  await expect.poll(() => position(page, 'pr')).not.toEqual({ x: dropped.x + 48, y: dropped.y });
  const free = await position(page, 'pr');
  expect(onGrid(free), `${free.x},${free.y}`).toBe(false);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => position(page, 'pr')).toEqual({ x: free.x + 10, y: free.y });
});

test('Settings → Map has the Snap to grid switch, off by default', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Snap to grid', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.snapToGrid).toBe(true);
});
