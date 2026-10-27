/** The public example plugin (examples/plugins/reading-list) builds, loads through Load from folder,
 * creates an item, raises Needs me with its short reason, shows its view and runs its operation.
 * ACT_DOC_SCREENSHOTS=1 also writes the plugin guide's screenshots to docs/plugins/images. */
import { test, expect, _electron as electron } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';

const root = join(import.meta.dirname, '../..'), images = join(root, 'docs/plugins/images');
/** A fixed build folder, so the review screenshot shows the same path on every machine. */
const SOURCES = '/tmp/example-plugin';
type Clip = { x: number; y: number; width: number; height: number };
const capture = async (target: Page | Locator, name: string, clip?: Clip) => { if (process.env.ACT_DOC_SCREENSHOTS) await target.screenshot({ path: join(images, name), animations: 'disabled', ...(clip ? { clip } : {}) }); };
/** The locator's box with a margin, for screenshots of one card with its badges. */
const around = async (locator: Locator, margin = 20): Promise<Clip> => { const box = (await locator.boundingBox())!; return { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 }; };
const VIEW: Clip = { x: 364, y: 190, width: 576, height: 436 };
const reloadsAfter = async (page: Page, action: () => Promise<void>) => {
  const reloaded = page.waitForEvent('load', { timeout: 30_000 });
  await action(); await reloaded;
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 20_000 });
};
const openSettings = async (page: Page, ...path: string[]) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of path) await page.getByRole('treeitem', { name, exact: true }).click();
};

/** Extra states for docs/plugins/design.md: sizes, zoom levels, selection, the empty state and the menu. */
async function documentationShots(page: Page, first: { id: string; position: { x: number; y: number } }) {
  const apply = async (commands: unknown[]) => {
    const { revision } = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    await page.evaluate(envelope => window.craftingTable.workspaceApply(envelope as never), { commandId: crypto.randomUUID(), expectedRevision: revision, actor: { kind: 'user', id: 'docs' }, commands });
  };
  const at = (dx: number) => ({ x: first.position.x + dx, y: first.position.y });
  await apply([
    { type: 'node.move', id: first.id, position: at(-380) },
    { type: 'item.add', id: 'grid', resourceId: 'grid-resource', pluginId: 'reading-list.link', title: 'Grid systems', data: { url: 'https://example.org/grids', tags: 'layout' }, position: at(-100) },
    { type: 'item.add', id: 'dither', resourceId: 'dither-resource', pluginId: 'reading-list.link', title: 'Dithering', data: { url: 'https://example.net/dither', note: 'Ordered dithering for the field fade.', tags: 'pixels, colour' }, position: at(220) },
    { type: 'node.resize', id: 'grid', size: 'medium' }, { type: 'node.resize', id: 'dither', size: 'large' },
  ]);
  for (const nodeId of ['grid', 'dither']) await page.evaluate(id => window.craftingTable.runtimeRun({ action: 'resource.read', nodeId: id, arguments: { refresh: true } }), nodeId);
  await expect(page.getByRole('article', { name: 'Grid systems', exact: true })).toContainText('Unread · example.org');
  await expect(page.getByRole('article', { name: 'Pixel fonts', exact: true })).toContainText('Pixel fonts');
  const zoomTo = async (zoom: number) => {
    await page.getByRole('slider', { name: 'Map zoom' }).evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, zoom);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(zoom));
  };
  const shots: [number, string, Clip][] = [[1, 'zoom-near.png', { x: 120, y: 340, width: 900, height: 160 }], [.6, 'zoom-mid.png', { x: 260, y: 365, width: 620, height: 110 }], [.45, 'zoom-icons.png', { x: 380, y: 375, width: 520, height: 70 }]];
  for (const [zoom, name, clip] of shots) { await zoomTo(zoom); await page.waitForTimeout(400); await capture(page, name, clip); }
  await zoomTo(1);
  const grid = page.getByRole('article', { name: 'Grid systems', exact: true });
  await grid.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Read state' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Read', exact: true })).toBeVisible();
  const menus = await Promise.all((await page.getByRole('menu').all()).map(menu => menu.boundingBox()));
  const left = Math.min(...menus.map(box => box!.x)), top = Math.min(...menus.map(box => box!.y));
  await capture(page, 'reading-link-menu.png', { x: left - 12, y: top - 12, width: Math.max(...menus.map(box => box!.x + box!.width)) - left + 24, height: Math.max(...menus.map(box => box!.y + box!.height)) - top + 24 });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await grid.click();
  await expect(page.locator('.reading-link .view-empty')).toContainText('No note yet');
  await capture(page, 'reading-link-empty.png', VIEW);
  await page.keyboard.press('Escape');
}

test('the reading list example loads from a folder, raises Needs me, shows its view and marks a link read', async () => {
  test.setTimeout(150_000);
  const data = await mkdtemp(join(tmpdir(), 'craft-example-')), sources = SOURCES, folder = join(sources, 'reading-list');
  await rm(sources, { recursive: true, force: true }); await mkdir(sources, { recursive: true });
  execFileSync(process.execPath, [join(root, 'examples/plugins/reading-list/scripts/build.mjs'), '--out', folder]);
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: data } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByText('Desktop connected')).toBeVisible({ timeout: 20_000 });

    // Settings → Plugins → Advanced → Load from folder… (the native dialog is stubbed to the build).
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, folder);
    await openSettings(page, 'Plugins');
    let plugins = page.getByRole('region', { name: 'Plugins' });
    await plugins.getByRole('button', { name: /^Advanced settings/ }).click();
    await plugins.getByRole('button', { name: 'Load from folder…', exact: true }).click();
    const review = plugins.getByRole('group', { name: 'Review Reading list' });
    await expect(review).toContainText('Item type reading-list.link');
    await expect(review).toContainText('reading_list_unread');
    await capture(review, 'plugin-review.png');
    await reloadsAfter(page, () => review.getByRole('button', { name: 'Trust and load from folder', exact: true }).click());
    await openSettings(page, 'Plugins');
    plugins = page.getByRole('region', { name: 'Plugins' });
    await expect(plugins.locator('[data-plugin-id="reading-list"]')).toContainText('Running');
    // A type loaded from a plugin gets its menu order in Settings → Items like every built-in type.
    await page.getByRole('treeitem', { name: 'Items', exact: true }).click();
    const menus = page.getByRole('group', { name: 'Right-click menus', exact: true });
    await menus.getByLabel('Item type', { exact: true }).selectOption({ label: 'Reading link' });
    await expect(menus.getByRole('listitem').locator('.menu-order-label')).toHaveText(['Open', 'Connect to…', 'Read state', 'Open in browser', 'Copy URL', 'Settings', 'Move to project', 'Move to plot', 'Remove from plot', 'Mark done / Reopen', 'Send to Undermap']);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();

    // Create an item through the creation ring, from the definition's fields.
    await page.mouse.dblclick(640, 420);
    const form = page.getByRole('form', { name: 'New item' });
    await form.getByRole('button', { name: 'All', exact: true }).click();
    await form.getByRole('button', { name: 'Reading link', exact: true }).click();
    await form.getByLabel('Title', { exact: true }).fill('Pixel fonts');
    await form.getByLabel('URL', { exact: true }).fill('https://example.invalid/pixel-fonts');
    await form.getByLabel('Note', { exact: true }).fill('Compare bitmap fonts for the map labels.');
    await form.getByLabel('Tags', { exact: true }).fill('Design, type');
    await form.getByRole('button', { name: 'Add to reading list', exact: true }).click();
    await expect(form).toHaveCount(0);
    const state = async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    await expect.poll(async () => (await state()).resources.find(resource => resource.pluginId === 'reading-list.link')?.data.tags).toBe('Design, type');
    const saved = await state(), resource = saved.resources.find(record => record.pluginId === 'reading-list.link')!, node = saved.nodes.find(candidate => candidate.resourceId === resource.id)!;

    // A recent broken check in plugin_records is reused by the next read, without the network.
    const store = new SqliteStore(join(data, 'workspace.sqlite'));
    try { store.pluginStorage('reading-list').put('links', resource.id, { lastCheck: { state: 'broken', status: 404, checkedAt: new Date().toISOString() } }); } finally { store.close(); }
    await page.evaluate(nodeId => window.craftingTable.runtimeRun({ action: 'resource.read', nodeId, arguments: { refresh: true } }), node.id);
    const card = page.getByRole('article', { name: 'Pixel fonts', exact: true });
    await expect(card.getByRole('img', { name: 'Asking me: Link is broken' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Needs me: 1' })).toBeVisible();
    await capture(page, 'reading-link-card-needs-me.png', await around(card));
    await page.getByRole('button', { name: 'Needs me: 1' }).click();
    await expect(page.getByText('Link is broken').first()).toBeVisible();
    await capture(page, 'needs-me-reason.png', { x: 0, y: 96, width: 660, height: 300 });
    await page.keyboard.press('Escape');

    // The package's settings section: turn link checks off, which also clears the broken state.
    await openSettings(page, 'Items', 'Reading link');
    const checks = page.getByRole('switch', { name: 'Check links online' });
    await expect(checks).toBeChecked();
    await capture(page.getByRole('dialog', { name: 'Settings' }), 'plugin-settings-section.png');
    await checks.uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

    // The view: header contract in the frame bar, then the human-only operation.
    await card.click();
    const view = page.locator('.reading-link'), bar = page.locator('.view-header.in-frame');
    // Reads within a minute reuse the host's cached snapshot; ↻ asks the connector again.
    await expect(view.locator('.reading-link-check')).toContainText('HTTP 404');
    await bar.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(view.locator('.reading-link-check')).toHaveText('Link checks are off in Settings.');
    await expect(bar.locator('.view-chip')).toHaveText('Unread');
    await expect(bar.locator('.view-meta')).toHaveText('example.invalid · design, type');
    await expect(view.locator('.reading-link-note')).toHaveText('Compare bitmap fonts for the map labels.');
    await expect(card.getByRole('img', { name: /^Needs me/ })).toHaveCount(0);
    await capture(page, 'reading-link-view.png', VIEW);
    await bar.getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(bar.locator('.view-chip')).toHaveText('Read');
    await expect(bar.getByRole('button', { name: 'Mark unread', exact: true })).toBeVisible();
    const unread = await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'reading-list.unread' as 'resource.read', nodeId: 'reading-list', arguments: {} }));
    expect(unread).toEqual({ links: [], total: 0 });
    await page.keyboard.press('Escape');
    await expect(card).toContainText('Pixel fonts');
    if (process.env.ACT_DOC_SCREENSHOTS) await documentationShots(page, node);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(data), () => connectSupervisor(join(data, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) {
        try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; }
        finally { client.close(); }
      }
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await rm(sources, { recursive: true, force: true });
  }
});
