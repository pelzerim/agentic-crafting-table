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

const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, zoom: matrix.a };
});
/** Sends wheel events the way Chromium reports a trackpad: sideways movement, or wheelDeltaY of -3 × deltaY, and ctrlKey for a pinch. */
const trackpad = (page: Page, events: { deltaX?: number; deltaY?: number; ctrlKey?: boolean }[]) => page.locator('.react-flow__pane').evaluate((pane, list) => {
  const box = pane.getBoundingClientRect();
  for (const event of list) pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, deltaMode: 0, deltaX: 0, deltaY: 0, ...event }));
}, events);

test('two fingers on a trackpad pan the map, a pinch and a mouse wheel zoom it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-trackpad-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(() => photoLibraryProject()); await store.writeView('desktop', { camera: { x: 0, y: 0, zoom: .8 } }); } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await resize(app, page, 1400, 800);
    await expect(page.getByText('Desktop connected')).toBeVisible();

    const box = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const start = await camera(page);
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(start.zoom);
    await page.waitForTimeout(400);

    const zoomed = await camera(page);
    await trackpad(page, [{ deltaX: 30, deltaY: 20 }, { deltaX: 10, deltaY: 40 }]);
    await expect.poll(() => camera(page)).toEqual({ x: zoomed.x - 40, y: zoomed.y - 60, zoom: zoomed.zoom });
    await page.waitForTimeout(400);

    await trackpad(page, [{ ctrlKey: true, deltaY: 20 }]);
    await expect.poll(async () => (await camera(page)).zoom).toBeLessThan(zoomed.zoom);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
