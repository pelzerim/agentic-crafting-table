import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

const PR_URL = 'https://github.com/example/billing/pull/48', LINEAR_URL = 'https://linear.app/acme/issue/BIL-128';

async function launch(run: (page: Page, app: ElectronApplication) => Promise<void>, { web = true, zoom = 1, dashboards = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-double-click-web-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(state => stateSchema.parse({ ...state, nodes: [
      { id: 'billing', title: 'Billing redesign', position: { x: 300, y: 300 }, workingDirectory: '/tmp' },
      { id: 'pr', resourceId: 'pr-resource', projectId: 'billing', title: 'Plan switcher', position: { x: 300, y: 200 }, attention: 'review' },
      { id: 'ticket', resourceId: 'ticket-resource', projectId: 'billing', title: 'BIL-128 · Plan changes', position: { x: 300, y: 560 } },
      { id: 'local', resourceId: 'local-resource', projectId: 'billing', title: 'BIL-129 · No workspace', position: { x: 900, y: 200 } },
      { id: 'todo', resourceId: 'todo-resource', projectId: 'billing', title: 'Write the migration note', position: { x: 900, y: 560 } },
    ], resources: [
      { id: 'pr-resource', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan switcher', data: { owner: 'example', repo: 'billing', number: 48 } },
      { id: 'ticket-resource', pluginId: 'linear.ticket', schemaVersion: 1, title: 'BIL-128 · Plan changes', data: { issueId: 'BIL-128', workspaceKey: 'acme' } },
      { id: 'local-resource', pluginId: 'linear.ticket', schemaVersion: 1, title: 'BIL-129 · No workspace', data: { issueId: 'BIL-129' } },
      { id: 'todo-resource', pluginId: 'workspace.todo', schemaVersion: 1, title: 'Write the migration note', data: {} },
    ], links: [] }));
    await store.writeView('desktop', { camera: { x: 0, y: 0, zoom } });
    const settings = store.readSettings();
    store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, doubleClickOpensWeb: web, mapDashboards: { enabled: dashboards, belowZoom: .45 } } });
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1280, 800);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async url => { (globalThis as any).openedUrls.push(url); }; });
    await run(page, app);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).openedUrls as string[]);
const card = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`);
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));

test('with the setting off, double-clicking an item keeps opening its view', async () => {
  await launch(async (page, app) => {
    await card(page, 'pr').dblclick();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
    await settle(page);
    expect(await opened(app)).toEqual([]);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await card(page, 'ticket').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open on Linear', exact: true }).click();
    await expect.poll(() => opened(app)).toEqual([LINEAR_URL]);
    await card(page, 'local').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Open on Linear' })).toHaveCount(0);
  }, { web: false });
});

test('with the setting on, double-click opens the web page; a single click, Enter and items without one still open the view', async () => {
  await launch(async (page, app) => {
    const map = page.locator('.map-area');
    await card(page, 'pr').dblclick();
    await expect.poll(() => opened(app)).toEqual([PR_URL]);
    await settle(page);
    await expect(map).toHaveAttribute('data-focus', '');
    await card(page, 'ticket').dblclick();
    await expect.poll(() => opened(app)).toEqual([PR_URL, LINEAR_URL]);
    await settle(page);
    await expect(map).toHaveAttribute('data-focus', '');
    await card(page, 'pr').click();
    await expect(map).toHaveAttribute('data-focus', 'pr');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(map).toHaveAttribute('data-focus', '');
    await page.locator('.react-flow__node[data-id="ticket"]').focus(); await page.keyboard.press('Enter');
    await expect(map).toHaveAttribute('data-focus', 'ticket');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(map).toHaveAttribute('data-focus', '');
    await card(page, 'local').dblclick();
    await expect(map).toHaveAttribute('data-focus', 'local');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await card(page, 'todo').getByRole('button', { name: 'Edit Write the migration note' }).dblclick();
    await expect(card(page, 'todo').getByRole('textbox', { name: 'Edit title' })).toBeFocused();
    await settle(page);
    expect(await opened(app)).toEqual([PR_URL, LINEAR_URL]);
  });
});

test('at far zoom a double-click opens the web page without flying to the item', async () => {
  await launch(async (page, app) => {
    const map = page.locator('.map-area');
    await expect(map).toHaveAttribute('data-level', 'overview');
    await card(page, 'pr').dblclick();
    await expect.poll(() => opened(app)).toEqual([PR_URL]);
    await settle(page);
    await expect(map).toHaveAttribute('data-zoom', '0.4');
    await expect(map).toHaveAttribute('data-focus', '');
    await card(page, 'local').dblclick();
    await expect.poll(async () => Number(await map.getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    expect(await opened(app)).toEqual([PR_URL]);
  }, { zoom: .4 });
});

test('double-clicking a dashboard row opens the web page; a single click still flies to the item', async () => {
  await launch(async (page, app) => {
    const row = page.locator('[data-dashboard="billing"] .dashboard-row[data-row="pr"]');
    await row.dblclick();
    await expect.poll(() => opened(app)).toEqual([PR_URL]);
    await settle(page);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.4');
    await row.click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    expect(await opened(app)).toEqual([PR_URL]);
  }, { zoom: .4, dashboards: true });
});

test('the Map settings page turns double-click web opening on and saves it', async () => {
  await launch(async page => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Double-click opens the item on the web' });
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('[data-settings-section="Map"]')).toContainText('Off by default');
    await toggle.check();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.doubleClickOpensWeb).toBe(true);
  }, { web: false });
});
