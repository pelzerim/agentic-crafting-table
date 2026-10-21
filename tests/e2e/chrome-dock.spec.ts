import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const bounds = (page: Page, id: string, rect: { x: number; y: number; width: number; height: number } | undefined) =>
  page.evaluate(async ({ id, rect }) => {
    const view = await window.craftingTable.viewRead();
    const itemViewBounds = { ...(view.itemViewBounds ?? {}) };
    if (rect) itemViewBounds[id] = rect; else delete itemViewBounds[id];
    await window.craftingTable.viewWrite({ ...view, itemViewBounds });
  }, { id, rect });

test('an item view that reaches the rail or the trail sends both off their edges until it closes; a view clear of them leaves them alone', async ({ visual: { page } }) => {
  const workspace = page.locator('.live-workspace'), rail = page.locator('.tool-rail'), trail = page.locator('.map-trail'), settings = page.getByRole('button', { name: 'Settings', exact: true });
  const right = (selector: string) => page.locator(selector).evaluate(element => element.getBoundingClientRect().right);
  const bottom = (selector: string) => page.locator(selector).evaluate(element => element.getBoundingClientRect().bottom);
  await bounds(page, 'agent', { x: 12, y: 12, width: 1200, height: 760 });
  await page.reload(); await expect(settings).toBeVisible();
  await expect(workspace).not.toHaveAttribute('data-chrome-docked', /.+/);
  const railRight = await right('.tool-rail');
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-chrome-docked', 'true');
  await expect.poll(() => right('.tool-rail')).toBeLessThan(0);
  await expect.poll(() => bottom('.map-trail')).toBeLessThan(0);
  for (const slot of ['.rail-panel.needs-me-tool', '.below-portal']) await expect.poll(() => right(slot)).toBeLessThan(0);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(workspace).not.toHaveAttribute('data-chrome-docked', /.+/);
  await expect.poll(() => right('.tool-rail')).toBe(railRight);
  await expect(trail).toHaveCount(0);
  // The default view keeps clear of both: nothing moves.
  await bounds(page, 'agent', undefined);
  await page.reload(); await expect(settings).toBeVisible();
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await expect(workspace).not.toHaveAttribute('data-chrome-docked', /.+/);
  expect(await right('.tool-rail')).toBe(railRight);
  await expect(page.locator('.map-trail')).toBeVisible();
});
