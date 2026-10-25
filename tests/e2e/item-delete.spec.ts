import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const allowDelete = (page: Page) => page.evaluate(async () => {
  const saved = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, itemDelete: true } });
});
const onMap = (page: Page) => page.evaluate(async () => { const { state } = await window.craftingTable.workspaceRead(); return { nodes: state.nodes.map(node => node.id), resources: state.resources.map(resource => resource.id) }; });
const menu = (page: Page) => page.getByRole('menu', { name: 'Context actions' });
const card = (page: Page) => page.getByRole('article', { name: 'Plan switcher', exact: true });

test('Delete… is off by default; turned on, its submenu cancels or deletes the item and its resource for good', async ({ visual: { page } }) => {
  await card(page).click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem', { name: 'Send to Undermap' })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: 'Delete…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await allowDelete(page);
  await card(page).click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem').last()).toHaveText('Delete…');
  await menu(page).getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('menuitem', { name: 'Cancel', exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  expect((await onMap(page)).nodes).toContain('pr');
  await card(page).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('menuitem', { name: 'Delete permanently', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  const after = await onMap(page);
  expect(after.nodes).not.toContain('pr'); expect(after.resources).not.toContain('pr-resource');
});

test('Settings → Map → Removing items has the Delete in item menus switch, off by default', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Delete in item menus', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.itemDelete).toBe(true);
});
