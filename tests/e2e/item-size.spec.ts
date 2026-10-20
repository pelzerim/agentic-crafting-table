import { resizeItemOnMap } from './resize-item.ts';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture, resize } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { showAdvanced } from './settings-helpers.ts';

async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async input => {
    const commands = JSON.parse(input);
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'size-fixture' }, commands });
  }, JSON.stringify(commands));
}
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
test('type presets have independent settings, saved defaults, cancel/reset and reachable validation', async ({ visual: { page, app } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  const before = await read(page), agent = page.locator('[data-item-id="agent"]');
  const settings = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
    await page.getByRole('treeitem', { name: 'Claude', exact: true }).click(); await showAdvanced(page);
    return page.getByRole('group', { name: 'Claude map sizes' });
  };
  let group = await settings();
  await expect(group.getByLabel('Large width')).toHaveValue('240');
  await expect(group.getByLabel('Small width')).toHaveValue('180');
  await group.getByLabel('Default map size').selectOption('small');
  await group.getByLabel('Small width').fill('340');
  await page.getByRole('treeitem', { name: 'Codex', exact: true }).click(); await showAdvanced(page);
  const codex = page.getByRole('group', { name: 'Codex map sizes' });
  await expect(codex.getByLabel('Default map size')).toHaveValue('large');
  await expect(codex.getByLabel('Small width')).toHaveValue('180');
  await page.getByRole('treeitem', { name: 'To-do', exact: true }).click(); await showAdvanced(page);
  const todo = page.getByRole('group', { name: 'To-do map sizes' });
  await expect(todo.getByRole('spinbutton')).toHaveCount(2);
  await expect(todo.getByLabel('Small width')).toHaveValue('220');
  await expect(todo.getByLabel('Default map size')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Claude', exact: true }).click();
  await group.getByLabel('Small width').fill('10');
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(group.getByLabel('Small width')).toBeFocused();
  await group.getByLabel('Small width').fill('340');
  await group.scrollIntoViewIfNeeded();
  await capture(page, 'settings-map-size-presets.png');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(agent).toHaveAttribute('data-map-size', 'small'); await expect(agent).toHaveCSS('width', '340px');
  const after = await read(page); expect(after.resources).toEqual(before.resources); expect(after.links).toEqual(before.links);
  expect(after.nodes.find(node => node.id === 'agent')?.mapSize).toBeUndefined();
  await page.reload(); await expect(agent).toHaveCSS('width', '340px');
  group = await settings(); await group.getByLabel('Small width').fill('450');
  await page.getByRole('button', { name: 'Discard', exact: true }).click(); await expect(agent).toHaveCSS('width', '340px');
  group = await settings();
  await resize(app, page, 900, 640); await group.getByLabel('Small width').scrollIntoViewIfNeeded();
  await capture(page, 'settings-map-size-presets-narrow.png');
  await group.getByRole('button', { name: 'Reset map sizes' }).click();
  await expect(group.getByLabel('Default map size')).toHaveValue('large');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(agent).toHaveCSS('width', '240px');
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.itemMapSizes).toEqual({});
});

test('native defaults stay intact and item menus no longer offer sizes', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  const before = await read(page);
  for (const [id, width, height] of [['agent', 240, 112], ['pr', 200, 84], ['ticket', 240, 64]] as const) {
    const card = page.locator(`[data-item-id="${id}"]`);
    await expect(card).toHaveCSS('width', `${width}px`); await expect(card).toHaveCSS('height', `${height}px`);
    await card.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Size', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  expect(await read(page)).toEqual(before);
  await page.locator('[data-item-id="ticket"]').hover(); await expect(page).toHaveScreenshot('map-resize-grip.png');
});

test('pointer sizing pins the visible top-left, clears neighbors and persists without changing resource or camera', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  const agent = page.locator('[data-item-id="agent"]');
  await apply(page, [{ type: 'item.add', id: 'neighbor', resourceId: 'neighbor-r', pluginId: 'workspace.note', title: 'Nearby note', data: { text: 'Leave room for the growing agent.' }, projectId: 'billing', position: { x: 905, y: 150 } }]);
  const before = await read(page), bounds = (await agent.boundingBox())!, field = await page.locator('[data-project-outline="billing"]').getAttribute('d');
  await resizeItemOnMap(page, 'agent', 365, 177);
  const grown = (await agent.boundingBox())!;
  expect(grown.x).toBeCloseTo(bounds.x, 0); expect(grown.y).toBeCloseTo(bounds.y, 0);
  await expect(agent).toHaveCSS('width', '365px'); await expect(agent).toHaveCSS('height', '177px');
  const after = await read(page);
  expect(after.nodes.find(node => node.id === 'neighbor')?.position).not.toEqual(before.nodes.find(node => node.id === 'neighbor')?.position);
  for (const key of ['resources', 'links', 'todos', 'view'] as const) expect(after[key]).toEqual(before[key]);
  expect(await page.locator('[data-project-outline="billing"]').getAttribute('d')).not.toEqual(field);
  const neighbor = (await page.locator('[data-item-id="neighbor"]').boundingBox())!;
  expect(neighbor.x + neighbor.width + 19 <= grown.x || grown.x + grown.width + 19 <= neighbor.x || neighbor.y + neighbor.height + 19 <= grown.y || grown.y + grown.height + 19 <= neighbor.y).toBe(true);
  await capture(page, 'map-pointer-resized.png');
  await page.reload(); await expect(agent).toHaveCSS('width', '365px'); await expect(agent).toHaveCSS('height', '177px');
  await expect(agent).toHaveAttribute('data-preview', 'false');
});

test('resize accounts for zoom, cancels on Escape, supports keyboard and preserves the map camera', async ({ visual: { page } }) => {
  const card = page.locator('[data-item-id="agent"]');
  for (const zoom of [.65, 1.2]) {
    await page.getByRole('slider', { name: 'Map zoom' }).fill(String(zoom));
    const before = (await card.boundingBox())!;
    await resizeItemOnMap(page, 'agent', zoom === .65 ? 280 : 310, zoom === .65 ? 140 : 160);
    const after = (await card.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0); expect(after.y).toBeCloseTo(before.y, 0);
    expect(Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBe(zoom);
  }
  const beforeCancel = await read(page), handle = card.getByRole('button', { name: /Resize/ });
  await handle.hover(); await page.mouse.down(); await page.mouse.move(1100, 600, { steps: 6 });
  await expect(card).toHaveAttribute('data-resizing', 'true');
  await page.keyboard.press('ArrowRight'); await page.mouse.wheel(0, -400);
  expect(await read(page)).toEqual(beforeCancel);
  expect(Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBe(1.2);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(card).toHaveAttribute('data-resizing', 'false'); expect(await read(page)).toEqual(beforeCancel);
  expect(Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBe(1.2);
  for (const cancellation of ['pointercancel', 'blur']) {
    await handle.hover(); await page.mouse.down(); await page.mouse.move(1100, 600, { steps: 3 });
    await expect(card).toHaveAttribute('data-resizing', 'true');
    await page.evaluate(type => window.dispatchEvent(type === 'blur' ? new Event(type) : new PointerEvent(type)), cancellation);
    await page.mouse.up(); await expect(card).toHaveAttribute('data-resizing', 'false');
    expect(await read(page)).toEqual(beforeCancel);
  }
  await handle.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'agent')?.mapDimensions?.width).toBe(318);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'agent')?.mapDimensions?.height).toBe(184);
  await expect(page.locator('.map-card.expanded')).toHaveCount(0);
});

test('notes take a resized width and keep their text height, to-dos remain inline and done items restore their saved footprint', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [
    { type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', title: 'Decision', data: { text: 'Keep the public API stable while replacing the billing internals. Ship the migration in small steps and retain a rollback path. Verify existing sessions, project links and customer workflows before enabling the new behavior. Record the reasoning beside the implementation so future reviews can follow the decision.' }, projectId: 'billing', position: { x: 570, y: 650 } },
    { type: 'item.add', id: 'todo', resourceId: 'todo-r', pluginId: 'workspace.todo', title: 'Check migration', data: {}, projectId: 'billing', position: { x: 950, y: 650 } },
  ]);
  const note = page.locator('[data-item-id="note"]');
  // The resize hit area must leave the vertically centered + usable.
  await note.hover();
  const plus = (await note.getByRole('button', { name: 'Connect Decision', exact: true }).boundingBox())!;
  const start = { x: plus.x + plus.width / 2, y: plus.y + plus.height / 2 };
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('button')?.getAttribute('aria-label'), start)).toBe('Connect Decision');
  const agent = (await page.locator('[data-item-id="agent"]').boundingBox())!;
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(agent.x + agent.width / 2, agent.y + agent.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await read(page)).links.some(link => link.sourceId === 'note' && link.targetId === 'agent' && link.kind === 'context')).toBe(true);
  const resting = (await note.boundingBox())!;
  await resizeItemOnMap(page, 'note', 280, 160);
  await expect(note.locator('.paper-face')).toContainText('Keep the public API stable');
  await expect(note).toHaveCSS('width', '280px');
  const wide = (await note.boundingBox())!;
  expect(wide.height).toBeLessThan(resting.height); expect(wide.height).not.toBeCloseTo(160, 0);
  expect(await note.locator('.paper-face').evaluate(face => face.scrollHeight <= face.clientHeight)).toBe(true);
  await resizeItemOnMap(page, 'todo', 300, 56);
  const todo = page.locator('[data-item-id="todo"]');
  await expect(todo).toHaveAttribute('data-map-size', 'small');
  await todo.click(); await expect(todo.getByRole('textbox', { name: 'Edit title' })).toBeFocused();
  await todo.getByRole('textbox').fill('Check resumed sessions'); await page.keyboard.press('Enter');
  await expect(page.locator('.map-card.expanded')).toHaveCount(0); await expect(todo.locator('.card-summary')).toHaveCount(0);
  await todo.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Mark done' }).click();
  await expect(todo).toContainText('Check resumed sessions'); await expect(todo.getByRole('button', { name: /Resize/ })).toHaveCount(1);
  await expect(todo).toHaveCSS('width', '300px'); await expect(todo).toHaveCSS('height', '56px');
  await todo.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Reopen' }).click();
  await expect(todo).toHaveCSS('width', '300px'); await expect(todo).toHaveCSS('height', '56px');
});
