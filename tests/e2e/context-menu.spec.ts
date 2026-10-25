import { expect } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';
import { openProjectPicker, projectEmptyPoint } from './project-picker.ts';

test('menus are scoped, short and identical through project options and keyboard access', async ({ visual: { page } }) => {
  const labels = () => page.getByRole('menuitem').allTextContents();
  await page.mouse.click(100, 650, { button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveText(['New item', 'New project', 'Open archive']);
  await page.keyboard.press('Escape');
  const point = await projectEmptyPoint(page, 'Billing redesign');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  expect(await labels()).toEqual(['New item', 'Mute project (Needs me: 2)']);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click({ button: 'right' });
  expect(await labels()).toEqual(['Open', 'Connect to…', 'Settings', 'Move to project', 'Auto-name from activity', 'Mark done', 'Send to Undermap']);
  const menu = page.getByRole('menu', { name: 'Context actions' });
  expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  await expect(menu.getByRole('menuitem').locator('.item-icon')).toHaveCount(7);
  for (const item of await menu.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeLessThan(36);
  await capture(page, 'context-menu-item.png');
  await page.keyboard.press('Escape');
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).focus();
  await page.keyboard.press('Delete'); await page.keyboard.press('Backspace');
  await expect(page.getByRole('article', { name: 'Claude · implementation', exact: true })).toBeVisible();
  await page.mouse.click(100, 650); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('button', { name: 'Project options: Billing redesign' }).click();
  const projectActions = ['Project settings…', 'Mark done', 'Mute project (Needs me: 2)', 'Send project to Undermap'];
  expect(await labels()).toEqual(projectActions);
  await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'Send project to Undermap' })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('menuitem', { name: 'Project settings…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__node[data-id="billing"]').focus(); await page.keyboard.press('Shift+F10');
  expect(await labels()).toEqual(projectActions); await page.keyboard.press('Escape');
  await page.locator('.react-flow__edge[data-id="ticket-agent"]').focus(); await page.keyboard.press('Shift+F10');
  expect(await labels()).toEqual(['Make blocking', 'Remove connection']); await page.keyboard.press('Escape');
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark done' }).click();
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click({ button: 'right' });
  expect(await labels()).toEqual(['Open', 'Connect to…', 'Settings', 'Move to project', 'Auto-name from activity', 'Reopen', 'Send to Undermap']);
});

test('item settings keep provider titles authoritative and move membership only on save', async ({ visual: { app, page } }) => {
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Item settings…' }).click();
  const form = page.getByRole('form', { name: 'Item settings' });
  await expect(form.getByLabel('Title', { exact: true })).toHaveAttribute('readonly', '');
  await expect(form.getByLabel('Owner', { exact: true })).toHaveCount(0);
  await form.getByLabel('Project membership').selectOption('');
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
  await form.getByRole('button', { name: 'Save changes' }).click();
  const after = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  expect(after.nodes.find(node => node.id === 'pr')?.projectId).toBeUndefined();
  expect(after.resources).toEqual(before.resources); expect(after.links).toEqual(before.links);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Open', 'Connect to…', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', 'Open on GitHub', 'Copy URL', 'Settings', 'Move to project', 'Mark done', 'Send to Undermap']);
  await app.evaluate(({ shell }) => { (globalThis as any).openedUrl = ''; shell.openExternal = async url => { (globalThis as any).openedUrl = url; }; });
  await page.getByRole('menuitem', { name: 'Open on GitHub', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrl)).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('PR review submenu supports hover, keyboard back/dismissal and viewport edges without launching on inspection', async ({ visual: { page } }) => {
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const trigger = page.getByRole('menuitem', { name: 'Trigger review', exact: true });
  const children = page.getByRole('menu', { name: 'Trigger review', exact: true });
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  await trigger.hover();
  expect(await children.getByRole('menuitem').allTextContents()).toEqual(['Claude', 'Codex', 'Claude + Codex', '/review']);
  await expect(trigger).toHaveAttribute('data-remote', 'true');
  await expect(page.getByRole('menuitem', { name: 'Open on GitHub', exact: true })).not.toHaveAttribute('data-remote');
  await expect(children.getByRole('menuitem', { name: '/review', exact: true })).toHaveAttribute('title', /Posts \/review on GitHub/);
  await page.mouse.move(4, 4); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await expect(page).toHaveScreenshot('context-menu-pr-review.png');
  const bounds = (await children.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.x + bounds.width).toBeLessThanOrEqual(1268);
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="pr"]').focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect(trigger).toBeFocused(); await page.keyboard.press('ArrowRight');
  await expect(children.getByRole('menuitem', { name: 'Claude', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(children.getByRole('menuitem', { name: '/review', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(children).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter'); await expect(children).toBeVisible();
  await page.keyboard.press('Escape'); await expect(children).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
  // A near-bottom-right invocation flips the submenu left and keeps both in view.
  await page.evaluate(async () => {
    const state = (await window.craftingTable.workspaceRead()).state;
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.move', id: 'pr', position: { x: 1490, y: 690 } }] });
  });
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' }); await trigger.hover();
  const main = (await page.getByRole('menu', { name: 'Context actions', exact: true }).boundingBox())!, sub = (await children.boundingBox())!;
  expect(sub.x).toBeLessThan(main.x); expect(sub.x).toBeGreaterThanOrEqual(12);
  const canvas = (await page.locator('.map-area').boundingBox())!;
  for (const rect of [main, sub]) { expect(rect.y).toBeGreaterThanOrEqual(12); expect(rect.y + rect.height).toBeLessThanOrEqual(canvas.y + canvas.height - 12); }
  await page.mouse.click(100, 650, { button: 'right' }); await expect(page.getByRole('menu')).toHaveCount(0);
});

test('radial skills appear only inside projects, go back through the ring and never create on inspection', async ({ visual: { page } }) => {
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  await page.mouse.dblclick(100, 650);
  await expect(page.getByRole('button', { name: 'Run skill', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openProjectPicker(page, 'Billing redesign');
  const picker = page.getByRole('form', { name: 'New item' });
  await expect(picker.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Run skill', exact: true }).hover();
  await expect(picker.locator('.picker-center')).toHaveAttribute('data-preview-choice', 'run-skill');
  await capture(page, 'creation-picker-project-skill.png');
  await picker.getByRole('button', { name: 'Run skill', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Run project skill' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Run project skill' }).getByLabel('Provider', { exact: true })).toBeFocused();
  await page.mouse.click(100, 650, { button: 'right' });
  await expect(picker.getByRole('button', { name: 'Run skill', exact: true })).toBeVisible();
  const bounds = (await picker.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.y).toBeGreaterThanOrEqual(12);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 12);
  await page.mouse.click(100, 650, { button: 'right' });
  await expect(picker).toHaveCount(0); await expect(page.getByRole('menu')).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
});

test('Settings keeps its draft while the archive is open and exposes workspace overlap repair', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await page.getByLabel('Neighborhood padding').fill('555');
  await page.getByRole('button', { name: 'Open archive', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Archive', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close archive' }).click();
  await expect(page.getByLabel('Neighborhood padding')).toHaveValue('555');
  await page.getByRole('button', { name: 'Clear overlaps…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Clear overlaps', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Overlaps cleared.' })).toBeVisible();
  await expect(page.getByLabel('Neighborhood padding')).toHaveValue('555');
});

test('the item menu leads with Open and Connect to…, focused first and acting on the item', async ({ visual: { page } }) => {
  const agent = page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true });
  await agent.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused();
  await page.getByRole('menuitem', { name: 'Connect to…', exact: true }).click();
  const connect = page.getByRole('form', { name: 'Connect items' });
  await expect(connect).toBeVisible(); await expect(connect.getByLabel('Connect to')).toBeFocused();
  await connect.getByRole('button', { name: 'Close connection' }).click();
  await agent.click({ button: 'right' }); await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('[data-expanded-item-id="ticket"]')).toBeVisible();
});
