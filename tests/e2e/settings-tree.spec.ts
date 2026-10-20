import { expect } from '@playwright/test';
import { test, capture, resize } from './visual-fixture.ts';
import { showAdvanced } from './settings-helpers.ts';
import { STANDUP_ENABLED } from '../../packages/core/standup.ts';

test('settings tree selects nested item pages, supports keyboard navigation and keeps invalid drafts reachable', async ({ visual: { page, app } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' }), tree = dialog.getByRole('tree', { name: 'Settings', exact: true });
  const item = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  await expect(dialog.getByRole('tablist')).toHaveCount(0);
  await expect(item('Items')).toHaveAttribute('aria-expanded', 'false');
  // Only branches carry a chevron; leaves have no bullet.
  await expect(item('Connections').locator('.settings-tree-toggle')).toHaveCount(0);
  await expect(item('Items').locator(':scope > .settings-tree-row .settings-tree-toggle')).toHaveCount(1);
  await expect(item('Connections').locator(':scope > .settings-tree-row')).toHaveText('Connections');
  // In forced colours, pixel edges drawn with border-image fall back to a plain system border.
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toHaveCSS('border-image-source', 'none');
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toHaveCSS('border-top-style', 'solid');
  await page.emulateMedia({ forcedColors: 'none' });
  await item('Connections').focus(); await page.keyboard.press('ArrowDown');
  await expect(item('Items')).toBeFocused(); await page.keyboard.press('ArrowRight');
  await expect(item('Items')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('c'); await expect(item('Claude')).toBeFocused(); await page.keyboard.press('Enter');
  const claude = dialog.getByRole('group', { name: 'Claude settings' });
  await expect(item('Claude')).toHaveAttribute('aria-selected', 'true'); await showAdvanced(page);
  await expect(claude.getByLabel('Remote Control', { exact: true })).toBeVisible();
  await expect(claude.getByLabel('Auto mode', { exact: true })).toBeChecked();
  await claude.getByLabel('Width', { exact: true }).fill('960');
  await capture(page, 'settings-tree-claude.png');
  await item('Claude').focus(); await page.keyboard.press('ArrowDown');
  await expect(item('Claude artifact')).toBeFocused(); // Visible alphabetical siblings.
  await page.keyboard.press('End'); await expect(item('Data & diagnostics')).toBeFocused();
  await page.keyboard.press('Home'); await expect(item('Connections')).toBeFocused();
  await item('Linear ticket').click(); const note = dialog.getByRole('group', { name: 'Linear ticket settings' }); await showAdvanced(page);
  await note.getByLabel('Width', { exact: true }).fill('700');
  await item('Linear ticket').focus(); await page.keyboard.press('ArrowLeft'); await expect(item('Items')).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(item('Items')).toHaveAttribute('aria-expanded', 'false');
  await expect(note).toBeVisible(); // Collapsing navigation never discards the selected page/draft.
  await page.keyboard.press('ArrowRight'); await item('Claude').click();
  await expect(claude.getByLabel('Width', { exact: true })).toHaveValue('960');
  await item('Linear ticket').click(); await expect(note.getByLabel('Width', { exact: true })).toHaveValue('700');
  await note.getByLabel('Height', { exact: true }).fill('10');
  await expect(dialog.getByRole('status').filter({ hasText: '1 field needs attention · Linear ticket' })).toBeVisible();
  await expect(item('Linear ticket').locator('.settings-tree-marker')).toHaveAttribute('data-marker', 'invalid');
  await item('Map').click(); await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(item('Linear ticket')).toHaveAttribute('aria-selected', 'true');
  await expect(note.getByLabel('Height', { exact: true })).toBeFocused();
  await note.getByLabel('Height', { exact: true }).fill('340');
  await resize(app, page, 900, 640);
  await capture(page, 'settings-tree-narrow.png');
  const panel = (await dialog.boundingBox())!, nav = (await dialog.locator('.settings-sidebar').boundingBox())!, content = (await dialog.locator('.settings-content').boundingBox())!;
  expect(nav.x + nav.width).toBeLessThanOrEqual(content.x + 1);
  for (const name of ['Save settings', 'Discard', 'Close settings']) {
    const control = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(panel.x); expect(control.y + control.height).toBeLessThanOrEqual(640);
  }
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.itemViews).toEqual({});
});

test('advanced details stay behind a per-page disclosure, item explanations remain visible and hidden invalid drafts can be corrected', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const advanced = dialog.getByRole('button', { name: /^Advanced settings/ });
  await expect(dialog.getByLabel('Advanced Settings', { exact: true })).toHaveCount(0);
  await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
  await expect(dialog.getByText('New item shortcuts', { exact: true })).toBeVisible();
  await dialog.getByRole('treeitem', { name: 'Claude', exact: true }).click();
  await expect(dialog.locator('.item-purpose:visible')).toContainText('Run Claude in a real terminal');
  await expect(dialog.getByLabel('Remote Control', { exact: true })).toBeVisible();
  const width = dialog.getByRole('group', { name: 'Claude settings', exact: true }).getByLabel('Width', { exact: true });
  const mapSizes = dialog.locator('fieldset[aria-label="Claude map sizes"]');
  await expect(mapSizes).toHaveCount(1); await expect(mapSizes).toBeHidden();
  await expect(width).toBeHidden(); await expect(advanced).toHaveAttribute('aria-expanded', 'false'); await advanced.click();
  await expect(mapSizes.getByText('Map bubble', { exact: true })).toBeVisible();
  for (const size of ['Small', 'Medium', 'Large']) await expect(mapSizes.getByLabel(`${size} width`, { exact: true })).toBeVisible();
  await mapSizes.getByLabel('Small width', { exact: true }).fill('260');
  await width.fill('10'); await advanced.click(); await expect(mapSizes).toBeHidden();
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(advanced).toHaveAttribute('aria-expanded', 'true'); await expect(width).toBeFocused();
  await width.fill('1000');
  await dialog.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await expect(dialog.getByLabel('Neighborhood padding')).toBeVisible();
  await expect(dialog.getByLabel('Pixel size')).toBeHidden(); await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await advanced.click(); await expect(dialog.getByLabel('Pixel size')).toBeVisible();
  await dialog.getByRole('treeitem', { name: 'Claude', exact: true }).click(); await expect(advanced).toHaveAttribute('aria-expanded', 'true');
  await advanced.click();
  await dialog.getByRole('treeitem', { name: 'Map', exact: true }).click(); await expect(advanced).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('button', { name: 'Clear overlaps…', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'Claude', exact: true }).click();
  await expect(advanced).toHaveAttribute('aria-expanded', 'false'); await advanced.click();
  await expect(width).toHaveValue('1000');
  await expect(mapSizes.getByLabel('Small width', { exact: true })).toHaveValue('260');
  await mapSizes.getByLabel('Small width', { exact: true }).fill('1'); await advanced.click();
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(advanced).toHaveAttribute('aria-expanded', 'true'); await expect(mapSizes.getByLabel('Small width', { exact: true })).toBeFocused();
  await mapSizes.getByLabel('Small width', { exact: true }).fill('260'); await advanced.click();
  await expect(mapSizes).toBeHidden();
});

test('AI features keep the shared request limits visible and editable whenever a consumer is on', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' }), tree = dialog.getByRole('tree', { name: 'Settings', exact: true });
  await expect(tree.getByRole('treeitem', { name: 'Display', exact: true })).toHaveCount(0);
  await tree.getByRole('treeitem', { name: 'AI features', exact: true }).click();
  const titles = dialog.getByRole('switch', { name: 'Auto-title agents', exact: true }), summaries = dialog.getByRole('switch', { name: 'Summarize agent and terminal activity', exact: true });
  const hourly = dialog.getByLabel('Summary requests per hour'), daily = dialog.getByLabel('Summary requests per day');
  await expect(titles).toBeChecked(); await expect(summaries).not.toBeChecked();
  await expect(hourly).toBeEditable(); await expect(daily).toHaveValue('100');
  await expect(dialog.getByLabel('Summary model', { exact: true })).toBeDisabled();
  await expect(dialog.getByText('Output leaves your machine.')).toBeVisible();
  await capture(page, 'settings-ai-features.png');
  const plotNames = dialog.getByRole('switch', { name: 'Name plots', exact: true });
  const slackTitles = dialog.getByRole('switch', { name: 'Auto-title Slack messages', exact: true });
  await expect(plotNames).toBeChecked(); await expect(slackTitles).toBeChecked();
  await titles.uncheck(); await expect(hourly).toBeEditable();
  const standup = dialog.getByRole('switch', { name: 'Standup digests', exact: true });
  await expect(standup).toHaveCount(STANDUP_ENABLED ? 1 : 0);
  await plotNames.uncheck(); await expect(hourly).toBeEditable();
  await slackTitles.uncheck();
  if (STANDUP_ENABLED) { await expect(hourly).toBeEditable(); await standup.uncheck(); }
  await expect(hourly).toBeVisible(); await expect(hourly).toBeDisabled();
  await summaries.check(); await expect(hourly).toBeEditable(); await expect(dialog.getByLabel('Summary model', { exact: true })).toBeEditable();
  await hourly.fill('30'); await expect(dialog.getByRole('button', { name: 'Reset to 12' })).toBeVisible();
  await tree.getByRole('treeitem', { name: 'General', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: 'Keep screen awake while the app is open' })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Warn before closing with active sessions' })).not.toBeChecked();
  await tree.getByRole('treeitem', { name: 'Notifications', exact: true }).click();
  await dialog.getByLabel('Show notifications').selectOption('off');
  await expect(dialog.getByRole('switch', { name: 'Play a sound' })).toBeDisabled();
  // Reminders keep their own delivery whatever the Needs me mode.
  const reminders = dialog.getByRole('combobox', { name: 'Reminders', exact: true });
  await expect(reminders).toBeEnabled(); await expect(reminders).toHaveValue('sound');
  await expect(reminders.locator('option')).toHaveText(['Notify with sound', 'Notify silently', 'In the app only']);
  await reminders.selectOption('app');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  const saved = (await page.evaluate(() => window.craftingTable.settingsRead())).value;
  expect(saved.summaries).toMatchObject({ enabled: true, agentTitles: false, plotNames: false, attachTitles: false, standupDigests: !STANDUP_ENABLED, requestsPerHour: 30 }); expect(saved.notifications).toMatchObject({ mode: 'off', reminders: 'app' });
});

test('Data & diagnostics shows sessions, recordings, log limits and support as sections without disclosures', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
  const region = dialog.getByRole('region', { name: 'Data & diagnostics' });
  await expect(region.locator('.settings-page-meta')).toHaveText(/^ACT v\d/);
  await expect(region.getByRole('button', { name: 'Sessions', exact: true })).toHaveCount(0);
  await expect(region.getByRole('button', { name: 'Current sessions' })).toHaveAttribute('aria-pressed', 'true');
  await region.getByRole('button', { name: 'Archived sessions' }).click();
  await expect(region.getByRole('list', { name: 'Archived sessions' })).toContainText('No archived sessions');
  await expect(region.getByRole('list', { name: 'Terminal recordings' })).toContainText('Recording database');
  await expect(region.getByLabel('Diagnostic log backups', { exact: true })).toHaveValue('2');
  await expect(region.getByRole('table')).toHaveCount(0);
  await region.getByRole('button', { name: 'Show measurements', exact: true }).click();
  await expect(region.getByRole('table')).toContainText('Measurement');
  await expect(region.getByRole('button', { name: 'Download performance report', exact: true })).toBeVisible();
  await capture(page, 'settings-data.png');
});

test('at the narrowest window the tree narrows, leaving Items collapses it and rows stack', async ({ visual: { app, page } }) => {
  await resize(app, page, 760, 520);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' }), item = (name: string) => dialog.getByRole('treeitem', { name, exact: true });
  expect((await dialog.locator('.settings-sidebar').boundingBox())!.width).toBeLessThanOrEqual(153);
  await item('Items').click(); await item('Claude').click(); await expect(item('Items')).toHaveAttribute('aria-expanded', 'true');
  await item('Map').click(); await expect(item('Items')).toHaveAttribute('aria-expanded', 'false');
  const row = dialog.locator('.setting-row', { has: page.getByLabel('Neighborhood padding') });
  const label = (await row.locator('.setting-row-label').boundingBox())!, field = (await row.locator('.settings-field').boundingBox())!;
  expect(field.y).toBeGreaterThan(label.y + label.height);
  const toggle = (await dialog.getByRole('switch', { name: 'Show project dashboards when zoomed out' }).boundingBox())!, title = (await dialog.getByText('Show project dashboards when zoomed out').boundingBox())!;
  expect(toggle.x).toBeGreaterThan(title.x + title.width);
  await capture(page, 'settings-map-narrowest.png');
});

test('rollout stage rules are a JSON setting, empty by default; a draft that does not parse is refused with its reason', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'Rollout', exact: true }).click();
  const rules = dialog.getByLabel('Rollout stage rules', { exact: true });
  await expect(rules).toHaveValue('');
  await expect(rules).toHaveAttribute('placeholder', /"delayMinutes": 10/);
  await rules.fill('[{ "id": "web", "workflow": "(", "stages": [{ "key": "live", "environment": "production" }] }]');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Rollout stages settings are invalid: stage rules at 0.workflow: workflow must be a valid regular expression');
  const valid = '[{ "id": "web", "workflow": "^web / release$", "stages": [{ "key": "live", "environment": "live", "delayMinutes": 5 }] }]';
  await rules.fill(valid);
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.plugins['github.rollout']).toEqual({ stageRules: valid });
});
