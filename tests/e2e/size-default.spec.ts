import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import { resizeItemOnMap } from './resize-item.ts';
import { showAdvanced } from './settings-helpers.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async input => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'size-default-fixture' }, commands: JSON.parse(input) });
  }, JSON.stringify(commands));
}
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const mapSizes = (page: Page) => page.evaluate(async () => (await window.craftingTable.settingsRead()).value.itemMapSizes);
const agent = (id: string, provider: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: `${provider} ${id}`, data: { sessionId: `fixture-${id}`, provider }, projectId: 'billing', position: { x, y } });
const settingsEntry = (page: Page) => page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'Settings', exact: true });
const submenu = (page: Page) => page.getByRole('menu', { name: 'Settings', exact: true });

test('Settings ▸ holds the item settings entry and Use size as default, which is unavailable at the default size', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  const before = await read(page), card = page.locator('[data-item-id="agent"]');
  await card.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem')).toHaveText(['Open', 'Connect to…', 'Settings', 'Move to project', 'Move to plot', 'Auto-name from activity', 'Mark done', 'Send to Undermap']);
  await expect(settingsEntry(page)).toHaveAttribute('aria-haspopup', 'menu');
  await settingsEntry(page).hover();
  await expect(submenu(page).getByRole('menuitem')).toHaveText(['Item settings…', 'Use size as default']);
  const useSize = submenu(page).getByRole('menuitem', { name: 'Use size as default', exact: true });
  await expect(useSize).toBeDisabled(); await expect(useSize).toHaveAttribute('title', 'Already the default size for Claude');
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="agent"]').focus(); await page.keyboard.press('Shift+F10');
  await settingsEntry(page).focus(); await page.keyboard.press('ArrowRight');
  await expect(submenu(page).getByRole('menuitem', { name: 'Item settings…', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(submenu(page).getByRole('menuitem', { name: 'Item settings…', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('form', { name: 'Item settings' })).toBeVisible();
  expect(await read(page)).toEqual(before); expect(await mapSizes(page)).toEqual({});
});

test('Use size as default saves a hand-resized item as its type default, new items arrive at it and existing ones stay', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [agent('second', 'claude', 650, 620), agent('other', 'codex', 960, 620)]);
  const picked = page.locator('[data-item-id="agent"]'), second = page.locator('[data-item-id="second"]'), codex = page.locator('[data-item-id="other"]');
  await resizeItemOnMap(page, 'agent', 365, 177);
  const before = await read(page);
  await picked.click({ button: 'right' }); await settingsEntry(page).click();
  const useSize = submenu(page).getByRole('menuitem', { name: 'Use size as default', exact: true });
  await expect(useSize).toBeEnabled(); await useSize.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => mapSizes(page)).toEqual({ 'agent.session:claude': { defaultSize: 'large', sizes: { large: { width: 365, height: 177 } } } });
  for (const [card, width, height] of [[picked, 365, 177], [second, 240, 112], [codex, 240, 112]] as const) { await expect(card).toHaveCSS('width', `${width}px`); await expect(card).toHaveCSS('height', `${height}px`); }
  const after = await read(page), node = (state: typeof after, id: string) => state.nodes.find(node => node.id === id)!;
  expect(node(after, 'second').mapDimensions).toEqual({ width: 240, height: 112 });
  expect(node(after, 'other')).toEqual(node(before, 'other'));
  for (const id of ['agent', 'second', 'other', 'pr', 'ticket', 'brief']) expect(node(after, id).position).toEqual(node(before, id).position);
  expect(after.resources).toEqual(before.resources); expect(after.links).toEqual(before.links);
  await apply(page, [agent('fresh', 'claude', 300, 620), agent('fresh-codex', 'codex', 1300, 620)]);
  const fresh = page.locator('[data-item-id="fresh"]');
  await expect(fresh).toHaveCSS('width', '365px'); await expect(fresh).toHaveCSS('height', '177px');
  await expect(page.locator('[data-item-id="fresh-codex"]')).toHaveCSS('width', '240px');
  await page.reload();
  await expect(fresh).toHaveCSS('width', '365px'); await expect(second).toHaveCSS('width', '240px');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
  await page.getByRole('treeitem', { name: 'Claude', exact: true }).click(); await showAdvanced(page);
  const group = page.getByRole('group', { name: 'Claude map sizes' });
  await expect(group.getByLabel('Default map size')).toHaveValue('large');
  await expect(group.getByLabel('Large width')).toHaveValue('365'); await expect(group.getByLabel('Large height')).toHaveValue('177');
});

test('Use size as default makes another tier the default and pins the items that followed the old one', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [agent('second', 'claude', 650, 620), { type: 'node.resize', id: 'agent', size: 'small' }]);
  const picked = page.locator('[data-item-id="agent"]');
  await expect(picked).toHaveCSS('width', '180px');
  await picked.click({ button: 'right' }); await settingsEntry(page).hover();
  await submenu(page).getByRole('menuitem', { name: 'Use size as default', exact: true }).click();
  await expect.poll(() => mapSizes(page)).toEqual({ 'agent.session:claude': { defaultSize: 'small', sizes: {} } });
  expect((await read(page)).nodes.find(node => node.id === 'second')?.mapSize).toBe('large');
  await expect(page.locator('[data-item-id="second"]')).toHaveCSS('width', '240px');
  await apply(page, [agent('fresh', 'claude', 300, 620)]);
  await expect(page.locator('[data-item-id="fresh"]')).toHaveCSS('width', '180px'); await expect(page.locator('[data-item-id="fresh"]')).toHaveCSS('height', '48px');
  await picked.click({ button: 'right' }); await settingsEntry(page).hover();
  await expect(submenu(page).getByRole('menuitem', { name: 'Use size as default', exact: true })).toBeDisabled();
});

test('hiding the Settings entry of a type hides both of its entries', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, menus: { ...saved.value.menus, hidden: { 'agent.session': ['edit'] } } } });
  });
  await page.locator('[data-item-id="agent"]').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem')).toHaveText(['Open', 'Connect to…', 'Move to project', 'Move to plot', 'Auto-name from activity', 'Mark done', 'Send to Undermap']);
  await page.keyboard.press('Escape');
  await page.locator('[data-item-id="pr"]').click({ button: 'right' });
  await expect(settingsEntry(page)).toBeVisible();
});
