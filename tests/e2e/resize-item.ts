import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';

export async function resizeItemOnMap(page: Page, id: string, width: number, height: number) {
  const { state, settings } = await page.evaluate(async () => ({ state: (await window.craftingTable.workspaceRead()).state, settings: (await window.craftingTable.settingsRead()).value.itemMapSizes }));
  const node = state.nodes.find(node => node.id === id)!;
  const before = itemFootprint(node, state.resources, createResourcePluginRegistry(), settings);
  const zoom = Number(await page.locator('.map-area').getAttribute('data-zoom'));
  const detail = Math.max(0, Math.min(1, (zoom - .45) / .3));
  const card = page.locator(`[data-item-id="${id}"]`), handle = card.getByRole('button', { name: `Resize ${node.title}`, exact: true });
  await handle.hover(); const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + (width - before.width) * zoom * detail, y + (height - before.height) * zoom * detail, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(node => node.id === id)?.mapDimensions).toEqual({ width, height });
  await expect(card).toHaveAttribute('data-resizing', 'false');
}
