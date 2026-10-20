import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

async function stubNative(app: ElectronApplication) {
  await app.evaluate(({ Notification }) => {
    const fixture = globalThis as typeof globalThis & { notices: Electron.Notification[] };
    fixture.notices = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { fixture.notices.push(this); this.emit('show'); };
    Notification.prototype.close = function () { this.emit('close'); };
    process.env.ACT_TEST_NOTIFICATIONS = '1'; // Only after delivery has been stubbed.
  });
}
const count = (app: ElectronApplication) => app.evaluate(() => (globalThis as typeof globalThis & { notices: unknown[] }).notices.length);
async function finish(page: Page, eventId: string) {
  await page.evaluate(async eventId => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'attention.set', id: 'pr', source: 'completion', reason: 'finished', eventId }] });
  }, eventId);
}

test('native needs-me notification opens the item without acknowledging it', async ({ visual: { app, page } }) => {
  await stubNative(app); expect(await count(app)).toBe(0);
  await finish(page, 'first'); await expect.poll(() => count(app)).toBe(1);
  expect(await app.evaluate(() => { const n = (globalThis as typeof globalThis & { notices: Electron.Notification[] }).notices[0]; return { title: n.title, body: n.body }; })).toEqual({ title: 'My turn · Plan switcher', body: 'Ready for your review · Finished · ready to view' });
  // OS banner dismissal must not acknowledge an unseen item.
  await app.evaluate(() => (globalThis as typeof globalThis & { notices: Electron.Notification[] }).notices[0].emit('close'));
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await finish(page, 'first'); expect(await count(app)).toBe(1);
  await finish(page, 'second'); await expect.poll(() => count(app)).toBe(2);
  await app.evaluate(() => (globalThis as typeof globalThis & { notices: Electron.Notification[] }).notices[1].emit('click'));
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(false);
});

test('a native notification click marks the item seen when its type is set to be seen on open', async ({ visual: { app, page } }) => {
  await stubNative(app);
  await page.evaluate(async () => {
    const settings = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, notifications: { ...settings.value.notifications, seenOnOpen: ['github.pull-request'] } } });
  });
  await finish(page, 'first'); await expect.poll(() => count(app)).toBe(1);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await app.evaluate(() => (globalThis as typeof globalThis & { notices: Electron.Notification[] }).notices[0].emit('click'));
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark seen', exact: true })).toHaveCount(0);
});

test('Notifications lists every item type once for marking it seen on open, and saves the choice', async ({ visual: { page } }) => {
  const saved = async () => (await page.evaluate(() => window.craftingTable.settingsRead())).value.notifications.seenOnOpen;
  expect(await saved()).toEqual([]);
  await page.evaluate(async () => {
    const settings = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, notifications: { ...settings.value.notifications, seenOnOpen: ['removed.plugin-type'] } } });
  });
  const openSettings = async () => { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Notifications', exact: true }).click(); };
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true });
  const group = panel.getByRole('group', { name: 'Opening an item marks it seen', exact: true });
  await openSettings();
  const names = await group.locator('label').allTextContents();
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  expect(new Set(names).size).toBe(names.length);
  for (const name of ['Agent session', 'Claude artifact', 'Code review', 'GitHub pull request', 'Linear ticket', 'Note', 'Notion page', 'Terminal', 'To-do', 'Workflow review']) expect(names).toContain(name);
  for (const box of await group.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/seen-on-open-settings.png' });
  await group.getByRole('button', { name: 'All', exact: true }).click();
  for (const box of await group.getByRole('checkbox').all()) await expect(box).toBeChecked();
  await group.getByRole('button', { name: 'None', exact: true }).click();
  for (const box of await group.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
  await group.getByLabel('GitHub pull request', { exact: true }).check();
  await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(saved).toEqual(['removed.plugin-type', 'github.pull-request']);
  // The saved choice is the one in effect on the map.
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'agent');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await openSettings();
  await expect(group.getByLabel('GitHub pull request', { exact: true })).toBeChecked();
  await expect(group.getByLabel('Agent session', { exact: true })).not.toBeChecked();
  await group.getByRole('button', { name: 'None', exact: true }).click();
  await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(saved).toEqual(['removed.plugin-type']);
});

test('notification settings persist, announcements respect them and native errors are visible', async ({ visual: { app, page } }) => {
  await stubNative(app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Notifications', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(panel.getByLabel('Show notifications')).toHaveValue('background');
  await page.screenshot({ path: '.local/mac-notifications-settings.png' });
  await panel.getByLabel('Play a sound').uncheck();
  await panel.getByLabel('Show notifications').selectOption('off');
  await expect(panel.getByLabel('Play a sound')).toBeDisabled();
  await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
  await finish(page, 'muted'); expect(await count(app)).toBe(0);
  expect(await page.evaluate(() => window.craftingTable.notifyAnnouncement({ key: 'announcement:test', title: 'Restored', body: '' }))).toBe(false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Notifications', exact: true }).click();
  await expect(panel.getByLabel('Show notifications')).toHaveValue('off');
  await expect(panel.getByLabel('Play a sound')).not.toBeChecked();
  await panel.getByRole('button', { name: 'Send test notification' }).click();
  await expect(panel.getByText(/Test requested/)).toBeVisible(); expect(await count(app)).toBe(1);
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { notices: Electron.Notification[] }).notices[0].silent)).toBe(true);
  await app.evaluate(({ Notification }) => { Notification.prototype.show = function () { this.emit('failed', {}, 'permission denied'); }; });
  await panel.getByRole('button', { name: 'Send test notification' }).click();
  await expect(panel.getByText(/macOS could not deliver/)).toBeVisible();
  await panel.getByLabel('Show notifications').selectOption('always');
  await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
  await stubNative(app);
  expect(await page.evaluate(() => window.craftingTable.notifyAnnouncement({ key: 'announcement:new', title: '1 session restored', body: '' }))).toBe(true);
  expect(await count(app)).toBe(1);
});

test('an open item does not acknowledge background updates, even when ACT regains focus', async ({ visual: { app, page } }) => {
  await stubNative(app);
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await page.getByRole('button', { name: 'Open Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true }).click();
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
  await finish(page, 'while-away');
  await expect.poll(() => count(app)).toBe(1);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
});
