import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('hover and keyboard focus highlight without changing item bounds or mounting previews', async ({ visual: { page } }) => {
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const agent = page.locator('[data-item-id="agent"]'), original = (await agent.boundingBox())!;
  await agent.hover();
  await expect(agent).toHaveAttribute('data-preview', 'false');
  expect(await agent.boundingBox()).toEqual(original);
  await expect(agent.getByLabel('Item preview')).toHaveCount(0);
  await expect(agent.locator('.card-detail')).toHaveCount(0);
  await expect(agent.getByRole('button', { name: /Resize/ })).toHaveCSS('opacity', '1');
  await expect(page).toHaveScreenshot('map-hover-highlight.png');
  await page.mouse.move(90, 80);
  await expect(page.locator('.connection-active,.connection-muted')).toHaveCount(0);
  await expect(agent.getByRole('button', { name: /Resize/ })).toHaveCSS('opacity', '0');
  await page.keyboard.press('Tab'); await page.locator('.react-flow__node[data-id="agent"]').focus();
  expect(await agent.boundingBox()).toEqual(original);
  await page.mouse.move(100, 85);
  await expect(page.locator('.connection-active,.connection-muted')).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
});

test('zoom retains ordinary map geometry under the pointer without enabling hover previews', async ({ visual: { page } }) => {
  // Covers item icons at far zoom, which show when project dashboards are off.
  await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, enabled: false, belowZoom: .45, placement: 'center' } } }); });
  const agent = page.locator('[data-item-id="agent"]');
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  for (const delta of [260, 180, -280, -180]) {
    await agent.hover();
    const zoom = Number(await page.locator('.map-area').getAttribute('data-zoom'));
    await page.mouse.wheel(0, delta);
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).not.toBe(zoom);
    await expect(agent).toHaveAttribute('data-preview', 'false');
    const bounds = (await agent.boundingBox())!;
    await page.mouse.move(70, 80); expect(await agent.boundingBox()).toEqual(bounds);
    await expect(page.locator('.connection-active,.connection-muted')).toHaveCount(0);
  }
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
});

test('to-do hover stays compact and clicking the body or keyboard opening edits in place', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'preview-todo', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check billing flows', data: {}, projectId: 'billing', position: { x: 650, y: 600 } },
    ] });
  });
  const todo = page.locator('[data-item-id="task"]'); await expect(todo).toBeVisible();
  const bounds = (await todo.boundingBox())!;
  await todo.hover(); expect(await todo.boundingBox()).toEqual(bounds);
  await expect(todo).toHaveAttribute('data-preview', 'false'); await expect(todo.getByLabel('Item preview')).toHaveCount(0);
  // The glyph is the completion checkbox, so the body is clicked beside it.
  await todo.click({ position: { x: bounds.width * .6, y: bounds.height / 2 } });
  await expect(todo).toHaveAttribute('data-completed', 'false');
  await expect(todo.getByRole('textbox', { name: 'Edit title' })).toBeFocused();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
  await page.locator('.react-flow__node[data-id="task"]').focus(); await page.keyboard.press('Enter');
  await expect(todo.getByRole('textbox', { name: 'Edit title' })).toBeFocused();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
});
