import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('opening an item from Needs me first centres the map on it, at the current zoom', async ({ visual: { page } }) => {
  const viewport = () => page.locator('.react-flow__viewport').evaluate(node => { const matrix = new DOMMatrix(getComputedStyle(node).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
  const pane = await page.locator('.react-flow').boundingBox();
  await page.getByRole('button', { name: /^Needs me/ }).first().click();
  const row = page.locator('.attention-entry').first();
  await expect(row).toBeVisible();
  const id = await row.evaluate(node => node.closest('[data-node-id], [data-id]')?.getAttribute('data-node-id') ?? node.closest('[data-id]')?.getAttribute('data-id'));
  const title = (await row.locator('strong').first().textContent())!.trim();
  const nodes = (await page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes)) as { id: string; title: string; position: { x: number; y: number } }[];
  const node = nodes.find(candidate => candidate.id === id) ?? nodes.find(candidate => candidate.title === title)!;
  const before = await viewport();
  await row.click();
  await expect(page.locator(`[data-expanded-item-id="${node.id}"]`)).toBeVisible();
  const after = await viewport();
  expect(after.zoom).toBeCloseTo(before.zoom, 3);
  const centre = { x: (pane!.width / 2 - after.x) / after.zoom, y: (pane!.height / 2 - after.y) / after.zoom };
  expect(Math.abs(centre.x - node.position.x)).toBeLessThan(2);
  expect(Math.abs(centre.y - node.position.y)).toBeLessThan(2);
});
