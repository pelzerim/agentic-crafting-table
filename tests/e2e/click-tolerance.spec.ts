import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import { travel } from './undermap-fixture.ts';

const card = (page: Page) => page.getByRole('article', { name: 'Plan switcher', exact: true });
const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => (element as HTMLElement).style.transform);
/** A press that travels `distance` pixels before the release, the way a hand does. */
async function press(page: Page, distance: number) {
  const box = (await card(page).boundingBox())!, x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await page.mouse.move(20, 20); await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.down(); await page.mouse.move(x + distance, y); await page.mouse.up();
}

test('a click whose pointer slips a few pixels still opens the item and leaves the map where it is', async ({ visual: { page } }) => {
  const before = await camera(page);
  await press(page, 4);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  expect(await camera(page)).toBe(before);
});

test('a press that travels further drags the item and opens nothing', async ({ visual: { page } }) => {
  const before = (await card(page).boundingBox())!;
  await press(page, 40);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await expect.poll(async () => Math.round((await card(page).boundingBox())!.x - before.x)).toBeGreaterThan(20);
});

test('in Undermap a slipping click opens the item and does not pan the map', async ({ visual: { page } }) => {
  await card(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Send to Undermap', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await travel(page, 'below');
  await expect(card(page)).toBeVisible();
  const before = await camera(page);
  await press(page, 4);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  expect(await camera(page)).toBe(before);
});
