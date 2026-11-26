import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { denseMap } from '../fixtures/dense-map.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

const ITEMS = 1500, UPDATES = 15;
// Far enough out for project dashboards, and close enough for every card: the two ways a large map is drawn.
for (const [view, zoom] of [['dashboards', .5], ['cards', .8]] as const) test(`one changed item on a map of ${ITEMS} items does not stall the window: ${view}`, async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = denseMap(ITEMS), directory = await mkdtemp(join(tmpdir(), 'craft-snapshot-apply-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(() => fixture); await store.writeView('desktop', { camera: { x: 60, y: 100, zoom } }); } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const measured: Record<string, unknown> = { items: ITEMS, zoom };
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await expect(page.getByText('Desktop connected')).toBeVisible();
    if (view === 'cards') await expect(page.locator('[data-item-id^="item-"]')).toHaveCount(ITEMS);
    else { await expect(page.locator('[data-dashboard]').first()).toBeVisible(); await expect(page.locator('[data-item-id^="item-"]')).toHaveCount(0); }
    await page.waitForTimeout(2000);
    const profiler = process.env.ACT_PROFILE_MAP === '1' ? await page.context().newCDPSession(page) : undefined;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    await page.evaluate(() => window.craftingPerformance.reset());
    // An item nobody looks at changes, as when an agent elsewhere on the map reports: the window takes a new snapshot each time.
    const stalls = await page.evaluate(async ({ id, updates }) => {
      const tasks: number[] = []; new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(Math.round(entry.duration)); }).observe({ entryTypes: ['longtask'] });
      let state = (await window.craftingTable.workspaceRead()).state;
      for (let i = 0; i < updates; i++) {
        state = (await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'performance-fixture' }, commands: [{ type: 'node.update', id, summary: `Changed ${i}` }] })).state;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return tasks;
    }, { id: `item-${ITEMS - 1}`, updates: UPDATES });
    const metrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;
    measured.stalls = stalls; measured.metrics = metrics;
    if (profiler) await writeFile(testInfo.outputPath('snapshot-apply.cpuprofile'), JSON.stringify((await profiler.send('Profiler.stop')).profile));
    // Before the fixes each change cost two tasks of about 150 and 60 ms with cards, one of about 125 ms with dashboards.
    expect(stalls.filter(duration => duration >= 100), `long tasks: ${stalls.join(', ')}`).toHaveLength(0);
    // One changed item renders its own card and what shows it, not every card on the map.
    expect(metrics['map.card-render'].count).toBeLessThan(UPDATES * 30);
    // A change to one item's text redraws no plot.
    expect(metrics['map.plots'].count).toBe(0);
  } finally {
    const path = testInfo.outputPath('snapshot-apply.json'); await writeFile(path, JSON.stringify(measured, null, 1));
    await testInfo.attach('snapshot-apply', { path, contentType: 'application/json' });
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
