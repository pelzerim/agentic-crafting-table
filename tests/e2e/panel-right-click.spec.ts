import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const EMPTY_MAP = { x: 640, y: 720 };
const panels: { name: string; open(page: Page): Promise<void>; shown(page: Page): Locator; inside(page: Page): Locator }[] = [
  { name: 'Needs me', open: page => page.getByRole('button', { name: 'Needs me: 2', exact: true }).click(),
    shown: page => page.getByRole('dialog', { name: 'Needs me', exact: true }), inside: page => page.locator('.attention-list .rail-panel-header h2') },
  { name: 'the pinned to-do list', open: page => page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click(),
    shown: page => page.locator('.todo-overlay[data-open="true"]'), inside: page => page.locator('.todo-overlay .todo-title') },
  { name: 'the pinned GitHub inbox', open: page => page.getByRole('button', { name: /^GitHub inbox/ }).click(),
    shown: page => page.getByRole('dialog', { name: 'GitHub inbox', exact: true }), inside: page => page.locator('.github-inbox .rail-panel-header strong') },
  { name: 'the pinned Reminders', open: page => page.getByRole('button', { name: /^Reminders/ }).click(),
    shown: page => page.getByRole('dialog', { name: 'Reminders', exact: true }), inside: page => page.locator('.reminders-tool .rail-panel-header h2') },
];

for (const panel of panels) test(`a right click on the map only closes ${panel.name}, the next one opens the map menu; one on the sheet itself closes it too`, async ({ visual: { page } }) => {
  const menu = page.getByRole('menu', { name: 'Context actions' });
  await panel.open(page); await expect(panel.shown(page)).toBeVisible();
  await panel.inside(page).click({ button: 'right' });
  await expect(menu).toHaveCount(0); await expect(panel.shown(page)).toHaveCount(0);
  await expect(page.locator('.tool-rail-slot[data-pinned]')).toHaveCount(0);

  await panel.open(page); await expect(panel.shown(page)).toBeVisible();
  await page.mouse.click(EMPTY_MAP.x, EMPTY_MAP.y, { button: 'right' });
  await expect(panel.shown(page)).toHaveCount(0); await expect(menu).toHaveCount(0);
  await page.mouse.click(EMPTY_MAP.x, EMPTY_MAP.y, { button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveText(['New item', 'New project', 'Open archive']);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);

  await panel.open(page); await expect(panel.shown(page)).toBeVisible();
  const card = page.getByRole('article', { name: 'Claude · implementation', exact: true });
  await card.click({ button: 'right' });
  await expect(panel.shown(page)).toHaveCount(0); await expect(menu).toHaveCount(0);
  await card.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
});

for (const panel of panels) test(`a left click on the map leaves ${panel.name} open, and so does a right click inside Settings`, async ({ visual: { page } }) => {
  await panel.open(page); await expect(panel.shown(page)).toBeVisible();
  await page.mouse.click(EMPTY_MAP.x, EMPTY_MAP.y);
  await expect(panel.shown(page)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).click({ button: 'right', position: { x: 200, y: 20 } });
  await expect(panel.shown(page)).toBeVisible();
});

test('a right click that returns from an open item leaves the panels open', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click();
  await page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true }).dblclick();
  await expect(page.locator('.expanded')).toBeVisible();
  await page.mouse.click(EMPTY_MAP.x, EMPTY_MAP.y, { button: 'right' });
  await expect(page.locator('.expanded')).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.todo-overlay[data-open="true"]')).toBeVisible();
});

test('a right click on a to-do row opens its menu and one in a field keeps the list open', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click();
  const list = page.locator('.todo-overlay[data-open="true"]');
  await list.locator('.todo-new input').fill('Call the plumber'); await page.keyboard.press('Enter');
  const row = list.locator('.todo-row').filter({ hasText: 'Call the plumber' });
  await row.click({ button: 'right', position: { x: 60, y: 8 } });
  await expect(page.getByRole('menu')).toBeVisible(); await expect(list).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  await list.locator('.todo-new input').click({ button: 'right' });
  await expect(list).toBeVisible();
});

for (const panel of panels) test(`${panel.name} has the same close button top right, and closing unpins it`, async ({ visual: { page } }) => {
  await panel.open(page); await expect(panel.shown(page)).toBeVisible();
  const close = page.locator('.rail-panel[data-open="true"] .rail-panel-header > .rail-panel-close'), header = page.locator('.rail-panel[data-open="true"] .rail-panel-header');
  await expect(close).toHaveCount(1); await expect(close.locator('svg[data-glyph="close"]')).toHaveCount(1);
  const button = (await close.boundingBox())!, bar = (await header.boundingBox())!;
  expect(bar.x + bar.width - (button.x + button.width)).toBeLessThanOrEqual(10);
  await close.click();
  await expect(panel.shown(page)).toHaveCount(0);
  await expect(page.locator('.tool-rail-slot[data-pinned]')).toHaveCount(0);
});

test('a closed to-do list is not kept pinned: it peeks on hover, hides again and does not come back after a reload', async ({ visual: { page } }) => {
  const overlay = page.locator('.todo-overlay'), slot = page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ });
  await slot.click(); await expect(overlay).toHaveAttribute('data-open', 'true');
  await overlay.locator('.rail-panel-close').click(); await expect(overlay).toHaveAttribute('data-open', 'false');
  await slot.hover(); await expect(overlay).toHaveAttribute('data-open', 'true');
  await page.mouse.move(900, 600); await expect(overlay).toHaveAttribute('data-open', 'false');
  await slot.click(); await expect(page.locator('.tool-rail-slot[data-slot="todos"][data-pinned]')).toHaveCount(1);
  await page.waitForTimeout(400); await page.reload();
  await expect(page.locator('.tool-rail')).toBeVisible();
  await expect(overlay).toHaveAttribute('data-open', 'false');
  await expect(page.locator('.tool-rail-slot[data-pinned]')).toHaveCount(0);
});
