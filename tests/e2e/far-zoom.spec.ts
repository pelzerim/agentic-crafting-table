import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { photoLibraryProject } from '../fixtures/photo-library-project.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../src/resource-plugins/pixel-glyphs.ts';

const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
async function zoomTo(page: Page, zoom: number) {
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  await slider.evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, zoom);
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(zoom));
  await settle(page);
}
async function launch(run: (page: Page) => Promise<void>, view = { x: -120, y: -110, zoom: .4 }) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-far-zoom-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => photoLibraryProject()); await store.writeView('desktop', { camera: view });
    // These journeys cover the icons that show when project dashboards are off.
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { enabled: false, belowZoom: .45 } } });
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1600, 760);
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
test('the project header gives Needs me and working counts under its title, and no pipeline line', async () => {
  await launch(async page => {
    const header = page.locator('[data-project-label="project"]');
    await expect(header.locator('.project-counts')).toHaveText('2 asking · 2 my turn · 2 working');
    // Working is the drawn spark, not a typed "+" from CSS content.
    const working = header.locator('.tier-count[data-kind="working"]');
    await expect(working.locator('.status-glyph[data-glyph="working"] path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
    expect(await working.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
    await expect(header.locator('small')).toHaveCount(1);
    await expect(header).not.toContainText('PRs');
    await expect(header).not.toContainText('0 working');
    expect(await header.evaluate(element => (element as HTMLElement).offsetHeight)).toBe(48);
  });
});

test('far zoom keeps 46 px icons with a status badge from the first indicator and dims finished work', async ({}, testInfo) => {
  await launch(async page => {
    await zoomTo(page, .45);
    const failing = page.locator('[data-item-id="pr-64"]');
    await expect(failing).toHaveClass(/compact/);
    const bounds = (await failing.boundingBox())!; expect(Math.round(bounds.width / .45)).toBe(46); expect(Math.round(bounds.height / .45)).toBe(46);
    await expect(failing.locator('.status-badge')).toHaveAttribute('aria-label', 'Checks failing');
    await expect(failing.locator('.status-badge .status-glyph')).toHaveAttribute('data-glyph', 'x');
    await expect(failing.locator('.card-label')).toHaveCount(0);
    await expect(page.locator('[data-item-id="pr-63"] .status-badge .status-glyph')).toHaveAttribute('data-glyph', 'check');
    await expect(page.locator('[data-item-id="app-31"] .status-badge .status-glyph')).toHaveAttribute('data-glyph', 'clock');
    await expect(page.locator('[data-item-id="ordering"] .status-badge .status-glyph')).toHaveAttribute('data-glyph', 'working');
    await expect(page.locator('[data-item-id="ordering"] .status-badge .status-glyph path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
    await expect(page.locator('.react-flow__node:has(> [data-item-id="split"]) > .working-mark[data-icon]')).toHaveCount(1);
    await expect(page.locator('[data-item-id="resizer"] .status-badge')).toHaveCount(0);
    await expect(page.locator('[data-item-id="pr-9"]')).toHaveAttribute('data-dimmed', 'true');
    await expect(page.locator('[data-item-id="app-8"]')).toHaveAttribute('data-dimmed', 'true');
    await expect(page.locator('[data-item-id="upload"]')).toHaveAttribute('data-dimmed', 'true');
    await expect(page.locator('[data-item-id="pr-9"]')).toHaveCSS('opacity', '0.45');
    await expect(page.locator('[data-item-id="pr-62"]')).not.toHaveAttribute('data-dimmed', 'true');
    await expect(page.locator('.map-card[data-dimmed="true"] .attention-indicator')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('far-zoom-045.png') });
    await zoomTo(page, .3);
    await expect(failing.locator('.status-badge .status-glyph')).toHaveAttribute('data-glyph', 'x');
    await page.screenshot({ path: testInfo.outputPath('far-zoom-030.png') });
    // Near zoom keeps full cards: indicator labels, no badge, no dimming.
    await zoomTo(page, .8);
    await expect(failing).not.toHaveClass(/compact/);
    await expect(page.locator('.status-badge')).toHaveCount(0);
    await expect(failing.locator('[data-indicator="state"]')).toHaveAttribute('aria-label', 'Checks failing');
    await expect(page.locator('[data-dimmed]')).toHaveCount(0);
  });
});

test('clicking a far-zoom item flies to it without opening; a second click or Enter opens it', async () => {
  await launch(async page => {
    await zoomTo(page, .45);
    const item = page.locator('[data-item-id="pr-64"]');
    await item.click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    const box = (await item.boundingBox())!, canvas = (await page.locator('.map-area').boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(4);
    await item.click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr-64');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await zoomTo(page, .45);
    await page.locator('[data-item-id="pr-63"]').click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await page.keyboard.press('Enter');
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr-63');
  });
});

test('a PR with failing head checks shows Checks failing, enters Needs me and clears when checks pass', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(join(tmpdir(), 'craft-far-checks-')), providers = githubFixture();
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', summary: '', position: { x: 300, y: 200 } },
    { type: 'item.add', id: 'pr', resourceId: 'pull', projectId: 'project', pluginId: 'github.pull-request', title: 'Saved pull request', data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } },
    { type: 'view.set', view: { mode: 'workspace', archive: false, todosOpen: false, camera: { x: 300, y: 200, zoom: .45 } } },
  ] });
  const settings = service.store.readSettings();
  service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { enabled: false, belowZoom: .65 } } });
  const tick = async () => { const db = new DatabaseSync(service.store.file); db.exec('UPDATE resource_cache SET checked_at=0'); db.close(); await service.resources.poll(); };
  providers.checks = [{ name: 'unit', conclusion: 'FAILURE' }, { name: 'lint', conclusion: 'SUCCESS' }];
  await tick();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const badge = page.locator('[data-item-id="pr"] .status-badge');
    await expect(badge).toHaveAttribute('aria-label', 'Checks failing');
    await expect(badge.locator('.status-glyph')).toHaveAttribute('data-glyph', 'x');
    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
    await expect(list).toContainText('Checks failing');
    await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
    providers.checks = [{ name: 'unit', conclusion: 'SUCCESS' }]; await tick();
    await expect(badge.locator('.status-glyph')).toHaveAttribute('data-glyph', 'git-pull-request');
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toHaveCount(0);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
