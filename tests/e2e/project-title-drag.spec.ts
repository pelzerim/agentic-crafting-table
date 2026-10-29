import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

const viewport = (page: import('@playwright/test').Page) => page.locator('.react-flow__viewport').evaluate(node => getComputedStyle(node).transform);

test('a project title shows it can be dragged only on its plate; the space beside the plate pans the map', async ({ visual: { page } }) => {
  const label = page.locator('[data-project-label="billing"]'), plate = label.locator('.project-title-plate');
  await expect(plate).toBeVisible();
  const box = (await label.boundingBox())!, face = (await plate.boundingBox())!;
  expect(box.width - face.width, 'the label is wider than its plate').toBeGreaterThan(16);
  await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2);
  await expect(label.locator('.project-title-grip')).toBeVisible();
  expect(await plate.evaluate(node => getComputedStyle(node).cursor)).toBe('grab');
  const before = await page.evaluate(() => window.craftingTable.workspaceRead()), pan = await viewport(page);
  const beside = { x: box.x + 4, y: face.y + face.height / 2 };
  await page.mouse.move(beside.x, beside.y); await page.mouse.down();
  await page.mouse.move(beside.x + 160, beside.y + 40, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => viewport(page)).not.toBe(pan);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.revision).toBe(before.state.revision);
});
