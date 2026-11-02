import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import { projectEmptyPoint } from './project-picker.ts';
import { travel } from './undermap-fixture.ts';

const useRing = (page: Page, on: boolean, quickItemTypes?: string[]) => page.evaluate(async ({ on, quickItemTypes }) => {
  const saved = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, groundRightClickRing: on, ...(quickItemTypes ? { quickItemTypes } : {}) } });
}, { on, quickItemTypes });
const mutedAt = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.id === 'billing')?.mutedAt);
const ring = (page: Page) => page.getByRole('form', { name: 'New item' });

test('the setting is off by default and turned on in Settings → Map', async ({ visual: { page } }) => {
  await page.mouse.click(100, 650, { button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveText(['New item', 'New project', 'Open archive']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await page.getByRole('switch', { name: 'Right-click opens the radial menu' }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.settingsRead()).value.groundRightClickRing)).toBe(true);
});

test('right-clicking the ground opens the ring, with the menu entries among its items', async ({ visual: { page } }) => {
  await useRing(page, true);
  await page.mouse.click(420, 650, { button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(ring(page).getByRole('button', { name: 'Open archive', exact: true })).toBeVisible();
  await expect(ring(page).getByRole('button', { name: 'Project', exact: true })).toBeVisible();
  await expect(ring(page).getByRole('button', { name: 'New project', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('ground-ring-board.png') });
  await page.mouse.click(420, 650, { button: 'right' });
  await expect(ring(page)).toHaveCount(0);
  await page.mouse.click(420, 650, { button: 'right' });
  await ring(page).getByRole('button', { name: 'Open archive', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Archive', exact: true })).toBeVisible();
  await expect(ring(page)).toHaveCount(0);
});

test('a project ground mutes from the ring and keeps its placement', async ({ visual: { page } }) => {
  await useRing(page, true);
  const point = await projectEmptyPoint(page, 'Billing redesign');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(ring(page)).toHaveAttribute('data-project-id', point.id);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await ring(page).getByRole('button', { name: 'Mute project (Needs me: 2)', exact: true }).click();
  await expect.poll(() => mutedAt(page)).toBeTruthy();
  await expect(ring(page)).toHaveCount(0);
});

test('New project joins the ring when Project is not a quick item, every choice stays apart and on screen', async ({ visual: { page } }) => {
  await useRing(page, true, ['agent.session', 'terminal.session', 'from-url', 'workspace.todo', 'workspace.note', 'github.pull-request', 'linear.ticket']);
  await page.mouse.click(100, 650, { button: 'right' });
  await expect(ring(page).getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  const boxes = await Promise.all((await ring(page).locator('.picker-choice').all()).map(async choice => (await choice.boundingBox())!));
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  boxes.forEach((box, index) => {
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    for (const other of boxes.slice(index + 1)) expect(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y).toBe(true);
  });
  await ring(page).getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project summary' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ring(page).locator('.picker-choice').first()).toBeVisible();
});

test('the Undermap keeps its menu', async ({ visual: { page } }) => {
  await useRing(page, true);
  await travel(page, 'below');
  await page.mouse.click(420, 650, { button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveText(['Open archive']);
});
