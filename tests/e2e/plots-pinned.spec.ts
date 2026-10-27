import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { plotProject } from '../fixtures/plot-project.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../src/resource-plugins/pixel-glyphs.ts';

/** The plots sample, zoomed out far enough to show its loose items, still above the dashboard threshold. */
async function launch(run: (page: Page) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plots-pinned-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(() => plotProject()); await store.writeView('desktop', { camera: { x: 80, y: -140, zoom: .7 } }); } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1440, 900);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await run(page);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
/** Applies as the user; a background write can take the revision first, so a conflict is retried on a fresh read. */
const apply = (page: Page, commands: unknown[]) => page.evaluate(async commands => {
  for (let attempt = 0; ; attempt++) {
    const { state } = await window.craftingTable.workspaceRead();
    try { await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never }); return; }
    catch (error) { if (attempt >= 4 || !String((error as Error).message).includes('Revision conflict')) throw error; }
  }
}, commands);
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
const card = (page: Page, id: string) => page.locator(`.map-card[data-item-id="${id}"]`);
const menu = (page: Page) => page.getByRole('menu', { name: 'Context actions', exact: true });
const plotMenu = (page: Page) => page.getByRole('menu', { name: 'Move to plot', exact: true });
const pinned = (page: Page) => page.locator('[data-plot-sign][data-pinned]');
/** Each pinned plot's pinned members, as the service reports them. */
const pins = (page: Page) => page.evaluate(async () => {
  const snapshot = await window.craftingTable.workspaceRead() as unknown as { plots?: { list: { pinnedMemberIds: string[] }[] } };
  return (snapshot.plots?.list ?? []).filter(plot => plot.pinnedMemberIds.length).map(plot => plot.pinnedMemberIds.join(','));
});
const openPlotMenu = async (page: Page, id: string) => {
  await card(page, id).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Move to plot', exact: true }).click();
  await expect(plotMenu(page)).toBeVisible();
};

test('Move to plot: a new plot of two far-apart items gets a patch per part and a pinned sign; a third item joins it, leaves it, and items of two projects are refused', async () => {
  await launch(async page => {
    await apply(page, [{ type: 'item.add', id: 'spare', resourceId: 'spare-r', pluginId: 'workspace.note', title: 'Spare thought', data: { text: 'Spare thought' }, projectId: 'photos', position: { x: 700, y: 1150 } }]);
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    await card(page, 'changelog').click({ modifiers: ['Shift'] }); await card(page, 'ideas').click({ modifiers: ['Shift'] });
    await card(page, 'ideas').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Move to project', 'Move to plot', 'Mark done', 'Send selection to Undermap']);
    await menu(page).getByRole('menuitem', { name: 'Move to plot', exact: true }).click();
    await expect(plotMenu(page).getByRole('menuitemradio')).toHaveText(['Thumbnail · 4 items', 'Billing · 4 items', 'Upload · 3 items']);
    await plotMenu(page).getByRole('menuitem', { name: 'New plot', exact: true }).click();
    await expect(pinned(page)).toHaveCount(1);
    await expect.poll(() => pins(page)).toEqual(['changelog,ideas']);
    const sign = pinned(page), id = await sign.getAttribute('data-plot-sign');
    await expect(sign).toHaveText('2 items');
    await expect(page.locator(`[data-plot-patch="${id}"]`)).toHaveAttribute('data-parts', '2');
    await expect(sign.locator('.plot-sign-pin path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].pin));
    await expect(page.locator('[data-plot-sign]:not([data-pinned]) .plot-sign-pin')).toHaveCount(0);
    await sign.getByRole('button').hover();
    await expect(page.getByRole('tooltip')).toHaveText(/^2 items\s*Pinned · 2 items$/);
    await page.mouse.move(5, 450); await page.keyboard.press('Escape'); await settle(page);
    await expect(sign).toHaveScreenshot('plot-sign-pinned.png');

    await openPlotMenu(page, 'spare');
    await expect(plotMenu(page).getByRole('menuitemradio', { name: '2 items', exact: true })).toHaveAttribute('aria-checked', 'false');
    await plotMenu(page).getByRole('menuitemradio', { name: '2 items', exact: true }).click();
    await expect.poll(() => pins(page)).toEqual(['changelog,ideas,spare']);
    await expect(sign).toHaveText('3 items');
    await openPlotMenu(page, 'spare');
    await expect(plotMenu(page).getByRole('menuitemradio', { name: '3 items', exact: true })).toBeDisabled();
    await expect(plotMenu(page).getByRole('menuitemradio', { name: '3 items', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await card(page, 'spare').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Remove from plot', exact: true }).click();
    await expect.poll(() => pins(page)).toEqual(['changelog,ideas']);
    await expect(sign).toHaveText('2 items');
    await card(page, 'spare').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Remove from plot', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await apply(page, [{ type: 'project.create', id: 'video', title: 'Video', summary: '', position: { x: 1500, y: 1150 } },
      { type: 'item.add', id: 'clip', resourceId: 'clip-r', pluginId: 'workspace.note', title: 'Clip notes', data: { text: 'Clip notes' }, projectId: 'video', position: { x: 1500, y: 1150 } }]);
    await card(page, 'spare').click({ modifiers: ['Shift'] }); await card(page, 'clip').click({ modifiers: ['Shift'] });
    await openPlotMenu(page, 'clip');
    await expect(plotMenu(page).getByRole('menuitem')).toHaveText(['Items in one project only']);
    await expect(plotMenu(page).getByRole('menuitem', { name: 'Items in one project only' })).toBeDisabled();
  });
});
