import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('Cmd+K opens the command menu; typing finds an item and Enter flies there and opens it', async ({ visual: { page } }) => {
  const menu = page.getByRole('dialog', { name: 'Command menu' }), field = menu.getByRole('combobox'), area = page.locator('.map-area');
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await expect(field).toBeFocused();
  await expect(menu.getByRole('group', { name: 'Commands' }).getByRole('option').first()).toHaveText('New item…');
  await page.screenshot({ path: 'test-results/pr/command-menu-idle.png' });
  await field.fill('plan sw');
  await expect(menu.getByRole('group', { name: 'Items' }).getByRole('option')).toHaveText([/Plan switcher\s*Billing redesign/]);
  await page.screenshot({ path: 'test-results/pr/command-menu-items.png' });
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(area).toHaveAttribute('data-focus', 'pr');
  await page.keyboard.press('Escape');
  await expect(area).toHaveAttribute('data-focus', '');
});

test('the command menu runs commands with the arrows, finds projects, and leaves Cmd+F as find only', async ({ visual: { page } }) => {
  const menu = page.getByRole('dialog', { name: 'Command menu' }), field = menu.getByRole('combobox');
  await page.keyboard.press('Meta+k');
  await field.fill('controls');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Show controls');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Controls' })).toContainText('Command menu');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Meta+k');
  await field.fill('billing');
  await expect(menu.getByRole('group', { name: 'Projects' }).getByRole('option')).toHaveText([/Billing redesign\s*Project/]);
  await page.screenshot({ path: 'test-results/pr/command-menu-projects.png' });
  await page.keyboard.press('Meta+k');
  await expect(menu).toHaveCount(0, { timeout: 2000 });

  await page.keyboard.press('Meta+f');
  await expect(page.getByRole('combobox', { name: 'Find on map' })).toBeFocused();
  await expect(menu).toHaveCount(0);
});

test('Escape, a click outside or an unknown query never runs anything', async ({ visual: { page } }) => {
  const menu = page.getByRole('dialog', { name: 'Command menu' }), field = menu.getByRole('combobox'), area = page.locator('.map-area');
  await page.keyboard.press('Meta+k');
  await field.fill('zzzz no such thing');
  await expect(menu.getByText('Nothing matches “zzzz no such thing”.')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await page.mouse.click(20, 20);
  await expect(menu).toHaveCount(0);
  await expect(area).toHaveAttribute('data-focus', '');
});

test('going back from New project or New item returns to the command menu with the query kept', async ({ visual: { page } }) => {
  const menu = page.getByRole('dialog', { name: 'Command menu' }), field = menu.getByRole('combobox'), form = page.locator('.inline-editor');
  await page.keyboard.press('Meta+k');
  await field.fill('new project');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Create project' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('new project');

  await field.fill('new item');
  await page.keyboard.press('Enter');
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(field).toHaveValue('new item');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('a project created from the command menu closes the form without reopening the menu', async ({ visual: { page } }) => {
  const menu = page.getByRole('dialog', { name: 'Command menu' }), field = menu.getByRole('combobox'), form = page.locator('.inline-editor');
  await page.keyboard.press('Meta+k');
  await field.fill('new project');
  await page.keyboard.press('Enter');
  await form.getByRole('textbox').first().fill('Fresh project');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(form).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await expect(page.locator('[data-project-label]').filter({ hasText: 'Fresh project' })).toHaveCount(1);
});

test('New project and New item open where the command menu was, not in a corner', async ({ visual: { page } }) => {
  const menu = page.getByRole('dialog', { name: 'Command menu' }), field = menu.getByRole('combobox'), form = page.locator('.inline-editor');
  for (const query of ['new project', 'new item']) {
    await page.keyboard.press('Meta+k');
    await field.fill(query);
    const panel = (await menu.boundingBox())!;
    await page.keyboard.press('Enter');
    await expect(form).toBeVisible();
    await page.waitForTimeout(400);
    const opened = (await form.boundingBox())!;
    await page.screenshot({ path: `test-results/pr/command-menu-${query.replace(' ', '-')}.png` });
    expect(Math.abs(opened.x + opened.width / 2 - (panel.x + panel.width / 2)), `${query}: centred under the menu`).toBeLessThan(24);
    if (query === 'new project') expect(Math.abs(opened.y - panel.y), 'the project form starts at the menu\'s top').toBeLessThan(24);
    else expect(opened.y, 'the item ring starts at the menu\'s top, never above it').toBeGreaterThanOrEqual(panel.y - 24);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
});
