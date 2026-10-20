import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

const SHOTS = process.env.ACT_IMPLIED_LINK_SHOTS;
const shot = (page: Page, name: string) => page.screenshot({ path: SHOTS ? resolve(SHOTS, name) : test.info().outputPath(name) });
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const middle = (edge: Locator) => edge.locator('.react-flow__edge-path').evaluate((path: SVGPathElement) => {
  const point = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM()!;
  return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f };
});
const todo = (id: string, title: string, x: number, y: number) => ({ node: { id, resourceId: `${id}-resource`, projectId: 'board', title, position: { x, y } }, resource: { id: `${id}-resource`, pluginId: 'workspace.todo', schemaVersion: 1, title, data: {} } });
const link = (id: string, sourceId: string, targetId: string, kind: 'reference' | 'blocks' = 'reference') => ({ id, sourceId, targetId, kind, label: '' });

async function launch(run: (page: Page) => Promise<void>, links = [link('ab', 'a', 'b'), link('bc', 'b', 'c'), link('ac', 'a', 'c')]) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-implied-links-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  const items = [todo('a', 'Draft the schema', 260, 220), todo('b', 'Write the migration', 760, 220), todo('c', 'Backfill old rows', 510, 560)];
  try {
    await store.update(state => stateSchema.parse({ ...state, nodes: [{ id: 'board', title: 'Storage', position: { x: 510, y: 380 }, workingDirectory: '/tmp' }, ...items.map(item => item.node)], resources: items.map(item => item.resource), links }));
    await store.writeView('desktop', { camera: { x: 0, y: 0, zoom: 1 } });
    const settings = store.readSettings();
    store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { ...settings.value.mapDashboards, enabled: false } } });
  } finally { store.close(); }
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1280, 800);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await run(page);
  } finally {
    if (app) await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const edge = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);
const drawn = async (page: Page, id: string) => { await expect(edge(page, id)).not.toHaveClass(/link-concealed/); await expect(edge(page, id)).toHaveCSS('opacity', '1'); };
const concealed = async (page: Page, id: string) => { await expect(edge(page, id)).toHaveClass(/link-concealed/); await expect(edge(page, id)).toHaveCSS('opacity', '0'); };
const away = (page: Page) => page.mouse.move(40, 760);

test('a link a path already joins waits until an end is hovered, and returns when the path breaks', async () => {
  await launch(async page => {
    const a = page.locator('[data-item-id="a"]'), b = page.locator('[data-item-id="b"]');
    await expect(a).toBeVisible(); await away(page);
    await drawn(page, 'ab'); await drawn(page, 'bc'); await concealed(page, 'ac');
    await shot(page, 'after-chain.png');

    await a.hover(); await drawn(page, 'ac');
    await shot(page, 'after-hover-a.png');
    await b.hover(); await concealed(page, 'ac');
    await away(page); await concealed(page, 'ac');
    await page.locator('[data-item-id="c"]').hover(); await drawn(page, 'ac');

    // From an end along the shown line its menu still opens and keeps it drawn.
    const box = (await a.boundingBox())!;
    await a.hover(); const point = await middle(edge(page, 'ac'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(point.x, point.y, { steps: 16 }); await drawn(page, 'ac');
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Remove connection' })).toBeVisible(); await drawn(page, 'ac');
    await page.keyboard.press('Escape'); await away(page); await concealed(page, 'ac');

    // Removing B's link breaks the path, so the line from A to C is drawn again.
    const bc = await middle(edge(page, 'bc'));
    await page.mouse.click(bc.x, bc.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove connection' }).click();
    await expect.poll(async () => (await read(page)).links.map(link => link.id).sort()).toEqual(['ab', 'ac']);
    await away(page); await drawn(page, 'ac'); await drawn(page, 'ab');
  });
});

test('a blocking link stays drawn beside a reference path but is a path for references, and with the setting off every link is drawn', async () => {
  await launch(async page => {
    await expect(page.locator('[data-item-id="a"]')).toBeVisible(); await away(page);
    await drawn(page, 'ab'); await drawn(page, 'block'); await concealed(page, 'bc');
  }, [link('ab', 'a', 'b'), link('bc', 'b', 'c'), link('block', 'a', 'c', 'blocks')]);
  await launch(async page => {
    await expect(page.locator('[data-item-id="a"]')).toBeVisible(); await away(page); await concealed(page, 'ac');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Hide implied connections' });
    await expect(toggle).toBeChecked(); await toggle.uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.hideImpliedLinks).toBe(false);
    await away(page); await drawn(page, 'ab'); await drawn(page, 'bc'); await drawn(page, 'ac');
    await shot(page, 'before-all-drawn.png');
  });
});
