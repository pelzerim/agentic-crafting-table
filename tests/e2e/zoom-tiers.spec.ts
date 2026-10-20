import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { photoLibraryProject } from '../fixtures/photo-library-project.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
async function zoomTo(page: Page, zoom: number) {
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  await slider.evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, zoom);
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(zoom));
  await settle(page);
}
async function launch(dashboards: { enabled: boolean; belowZoom: number }, run: (page: Page) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-zoom-tiers-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => photoLibraryProject()); await store.writeView('desktop', { camera: { x: -120, y: -110, zoom: .8 } });
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { ...dashboards, placement: 'center' } } });
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1600, 760);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await run(page);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const thresholds = (page: Page) => page.locator('.zoom-markers [data-zoom-threshold]').evaluateAll(marks => marks.map(mark => Number(mark.getAttribute('data-zoom-threshold'))));

test('with dashboards on there is no icon-only band: cards stay neighborhood down to the dashboard threshold', async () => {
  await launch({ enabled: true, belowZoom: .55 }, async page => {
    const map = page.locator('.map-area'), bar = page.locator('.zoom-markers');
    await expect(bar.locator('.zoom-tick-label[data-tier=icon]')).toHaveCount(0);
    await expect(bar.locator('.zoom-tick-label[data-tier=board]')).toHaveAttribute('title', '55% · Dashboards below');
    expect(await thresholds(page)).toEqual([.55, 1.15]);
    await zoomTo(page, .6);
    await expect(map).toHaveAttribute('data-level', 'neighborhood');
    await expect(map).not.toHaveAttribute('data-dashboards', 'true');
    const card = page.locator('[data-item-id="pr-64"]');
    await expect(card).not.toHaveClass(/compact/);
    await expect(card.locator('.card-label')).toHaveCount(1);
    await zoomTo(page, .5);
    await expect(map).toHaveAttribute('data-dashboards', 'true');
  });
});

test('with dashboards off the icon band and its zoom bar marker remain', async () => {
  await launch({ enabled: false, belowZoom: .55 }, async page => {
    const map = page.locator('.map-area'), bar = page.locator('.zoom-markers');
    await expect(bar.locator('.zoom-tick-label[data-tier=icon]')).toHaveAttribute('title', '65% · Icons below');
    await expect(bar.locator('.zoom-tick-label[data-tier=board]')).toHaveCount(0);
    expect(await thresholds(page)).toEqual([.65, 1.15]);
    await zoomTo(page, .6);
    await expect(map).toHaveAttribute('data-level', 'overview');
    await zoomTo(page, .45);
    await expect(page.locator('[data-item-id="pr-64"]')).toHaveClass(/compact/);
  });
});
