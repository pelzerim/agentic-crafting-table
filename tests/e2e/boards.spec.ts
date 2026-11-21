import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Boards' });
const tab = (page: Page, name: string) => tabs(page).getByRole('tab').filter({ has: page.locator('.board-tab-name').getByText(name, { exact: true }) });
const project = (page: Page) => page.locator('.react-flow__node[data-id="billing"]');
const zoom = (page: Page) => page.locator('.map-area').getAttribute('data-zoom');

test('a board made from the ground menu brings the tabs; a project moved there shows only there, each board keeps its camera, and ⌘1 switches back', async ({ visual: { page } }) => {
  await expect(tabs(page)).toHaveCount(0);
  const mainZoom = await zoom(page);
  expect(mainZoom).not.toBe('1');

  await page.mouse.click(100, 650, { button: 'right' });
  await page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'New board…' }).click();
  const name = page.getByRole('textbox', { name: 'Board name' });
  await expect(name).toHaveValue('Board 2');
  await name.fill('Side projects'); await name.press('Enter');
  await expect(tabs(page).locator('.board-tab-name')).toHaveText(['Main', 'Side projects']);
  await expect(tab(page, 'Side projects')).toHaveAttribute('aria-selected', 'true');
  await expect(project(page)).toHaveCount(0);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await expect.poll(() => zoom(page)).toBe('1');
  // The zoom slider keeps the keyboard while focused, as every input does.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('ControlOrMeta+1');
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect(project(page)).toBeVisible();
  await expect.poll(() => zoom(page), 'Main keeps its own camera').toBe(mainZoom);

  await page.getByRole('button', { name: 'Project options: Billing redesign' }).click();
  await page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'Move to board', exact: true }).click();
  await page.getByRole('menu', { name: 'Move to board' }).getByRole('menuitemradio', { name: 'Side projects', exact: true }).click();
  await expect(project(page)).toHaveCount(0);
  const state = await read(page), side = state.boards.find(board => board.name === 'Side projects')!;
  expect(state.nodes.filter(node => node.id === 'billing' || node.projectId === 'billing').every(node => node.board === side.id)).toBe(true);
  await expect(tab(page, 'Side projects').locator('.board-tab-count')).toHaveText('2');

  await tab(page, 'Side projects').click();
  await expect(project(page)).toBeVisible();
  await expect.poll(() => zoom(page), 'Side projects keeps its own camera').toBe('1');

  await page.keyboard.press('ControlOrMeta+1');
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect(project(page)).toHaveCount(0);
});
