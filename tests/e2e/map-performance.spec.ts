import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { denseMap } from '../fixtures/dense-map.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { observeWorkspaceStartup } from '../../packages/diagnostics/startup-observer.ts';
import { resizeItemOnMap } from './resize-item.ts';

for (const itemCount of [200, 500] as const) test(`map performance: ${itemCount} items, ${itemCount * 2.5} links, pan/zoom and committed updates`, async ({}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = denseMap(itemCount), directory = await mkdtemp(join(tmpdir(), 'craft-dense-map-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => fixture); await store.writeView('desktop', { camera: { x: 60, y: 100, zoom: .2 } });
    // This journey measures every item card at far zoom; the dashboards journey below covers the default.
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { enabled: false, belowZoom: .45 } } });
  } finally { store.close(); }
  const startupStarted = performance.now(), startupProbe = observeWorkspaceStartup(directory);
  const startup: { launchMs?: number; windowMs?: number; connectedMs?: number; graphMs?: number; service?: ReturnType<typeof startupProbe.snapshot> } = {};
  const startupElapsed = () => Math.round((performance.now() - startupStarted) * 10) / 10;
  const scrollbars = process.platform === 'darwin' ? ['-AppleShowScrollBars', 'WhenScrolling'] : [];
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbars], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }).catch(async error => { await startupProbe.stop(); throw error; });
  startup.launchMs = startupElapsed();
  const phases: Record<string, unknown> = { startup };
  try {
    const page = await app.firstWindow();
    startup.windowMs = startupElapsed();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await expect(page.getByText('Desktop connected')).toBeVisible();
    startup.connectedMs = startupElapsed();
    await expect(page.locator('[data-item-id^="item-"]')).toHaveCount(itemCount);
    await expect(page.locator('.explicit-edge')).toHaveCount(itemCount * 2.5);
    await expect(page.locator('[data-project-outline]')).toHaveCount(10);
    await expect.poll(() => page.locator('[data-item-id^="item-"]').evaluateAll(items => items.filter(item => { const r = item.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }).length)).toBe(itemCount);
    startup.graphMs = startupElapsed(); startup.service = await startupProbe.stop();
    expect(await page.locator('[data-plot-patch]').count()).toBeGreaterThan(0);
    const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const paths = await page.locator('[data-project-outline]').evaluateAll(items => items.map(item => item.getAttribute('d')));
    const profiler = process.env.ACT_PROFILE_MAP === '1' ? await page.context().newCDPSession(page) : undefined;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    // Dragging a dashboard moves its project, so the pan grabs bare map: a point whose whole drag path stays clear of dashboards.
    const grab = await page.evaluate(() => {
      const bare = (x: number, y: number) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane');
      for (let y = 980; y > 100; y -= 20) for (let x = 1500; x > 300; x -= 20) if ([0, 50, 100, 150].every(dx => bare(x - dx, y) && bare(x - dx, y - 30))) return { x, y };
      throw new Error('No bare map to pan');
    });
    await page.evaluate(() => window.craftingPerformance.reset());
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.mouse.move(grab.x, grab.y); await page.mouse.down(); await page.mouse.move(grab.x - 150, grab.y - 30, { steps: 30 }); await page.mouse.up();
      await page.mouse.down(); await page.mouse.move(grab.x, grab.y, { steps: 30 }); await page.mouse.up();
    }
    phases.pan = await page.evaluate(() => window.craftingPerformance.snapshot());
    expect((phases.pan as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>).metrics['map.card-render'].count).toBe(0);
    expect((phases.pan as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>).metrics['map.plots'].count).toBe(0);
    await page.mouse.move(800, 450);
    for (const delta of [-500, -500, -500, 500, 500, 500]) {
      await page.mouse.wheel(0, delta);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    phases.navigation = await page.evaluate(() => window.craftingPerformance.snapshot());
    if (profiler) { const result = await profiler.send('Profiler.stop'); const path = testInfo.outputPath('map-navigation.cpuprofile'); await writeFile(path, JSON.stringify(result.profile)); await testInfo.attach('map-cpu-profile', { path, contentType: 'application/json' }); await profiler.detach(); }
    const navigation = phases.navigation as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>;
    expect(navigation.metrics['map.geometry'].count).toBe(0);
    expect(navigation.metrics['map.placement'].count).toBe(0);
    expect(navigation.metrics['map.plots'].count).toBe(0);
    expect(navigation.metrics['map.frame-interval'].count).toBeGreaterThan(100);
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes).toEqual(before.nodes);
    expect(await page.locator('[data-project-outline]').evaluateAll(items => items.map(item => item.getAttribute('d')))).toEqual(paths);
    // Measure the complete local command round trip plus the first observable DOM frame.
    phases.updateMs = await page.evaluate(async () => {
      const timings: number[] = []; let state = (await window.craftingTable.workspaceRead()).state;
      for (let i = 0; i < 12; i++) {
        const title = `Visible update ${i}`, start = performance.now();
        const result = await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'performance-fixture' }, commands: [{ type: 'node.update', id: 'item-0', title }] });
        state = result.state;
        await new Promise<void>((resolve, reject) => {
          const check = () => { if (document.querySelector('[data-item-id="item-0"]')?.getAttribute('aria-label') === title) resolve(); else if (performance.now() - start > 3000) reject(new Error('Committed update was not rendered')); else requestAnimationFrame(check); };
          requestAnimationFrame(check);
        });
        timings.push(performance.now() - start);
      }
      return timings;
    });
    // Navigation gates are evaluated after gathering diagnostics, even when slow.
    expect(navigation.metrics['map.frame-interval'].p95).toBeLessThan(itemCount === 200 ? 33 : 50);
    expect(navigation.metrics['map.frame-interval'].p99).toBeLessThan(150);
    const sorted = (phases.updateMs as number[]).slice().sort((a, b) => a - b);
    expect(sorted[Math.ceil(sorted.length * .95) - 1]).toBeLessThan(250);
    // A dense fixture must still retain exact item/link counts after repeated writes.
    const saved = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    expect(saved.nodes).toHaveLength(itemCount + 10); expect(saved.links).toEqual(fixture.links);
    expect(saved.nodes.find(node => node.id === 'item-0')).toEqual({ ...before.nodes.find(node => node.id === 'item-0'), title: 'Visible update 11' });
    // Real drag into an occupied slot must remain responsive and commit its preview.
    const zoom = page.getByRole('slider', { name: 'Map zoom' }); await zoom.focus(); await page.keyboard.press('Home');
    await page.getByRole('article', { name: 'Project 1', exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.8');
    if (itemCount === 200) {
      await page.mouse.move(1590, 990);
      await expect(page.locator('.map-area')).toHaveScreenshot('map-dense-neighborhood.png');
    }
    const member = itemCount / 20, source = page.locator(`[data-item-id="item-${member}"]`), target = page.locator(`[data-item-id="item-${member + 1}"]`);
    const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await expect.poll(() => target.evaluate(item => ({ x: Number(item.getAttribute('data-world-x')), y: Number(item.getAttribute('data-world-y')) }))).not.toEqual(saved.nodes.find(node => node.id === `item-${member + 1}`)!.position);
    const preview = await source.evaluate(item => ({ x: Number(item.getAttribute('data-world-x')), y: Number(item.getAttribute('data-world-y')) }));
    phases.drag = await page.evaluate(() => window.craftingPerformance.snapshot());
    await page.mouse.up();
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.revision).toBe(saved.revision + 1);
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(node => node.id === `item-${member}`)!.position).toEqual(preview);
    const drag = phases.drag as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>;
    expect(drag.metrics['map.placement'].count).toBeGreaterThan(5);
    expect(drag.metrics['map.placement'].p95).toBeLessThan(16);
    expect(drag.metrics['map.frame-interval'].p95).toBeLessThan(itemCount === 200 ? 33 : 50);
    // Continuous resize includes live collision layout and neighborhood geometry.
    const dimensions = await source.evaluate(card => ({ width: parseFloat(getComputedStyle(card).width), height: parseFloat(getComputedStyle(card).height) }));
    await page.evaluate(() => window.craftingPerformance.reset());
    await resizeItemOnMap(page, `item-${member}`, dimensions.width + 80, dimensions.height);
    phases.resize = await page.evaluate(() => window.craftingPerformance.snapshot());
    const resize = phases.resize as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>;
    expect(resize.metrics['map.placement'].count).toBeGreaterThan(5);
    expect(resize.metrics['map.placement'].p95).toBeLessThan(16);
    expect(resize.metrics['map.frame-interval'].p95).toBeLessThan(itemCount === 200 ? 33 : 50);
  } catch (error) {
    for (const file of ['service.log', 'runtime/service.log']) {
      const log = await readFile(join(directory, file), 'utf8').catch(() => undefined);
      if (log) await testInfo.attach(file.replaceAll('/', '-'), { body: log.slice(-65536), contentType: 'text/plain' });
    }
    throw error;
  } finally {
    startup.service ??= await startupProbe.stop();
    const report = { fixture: { items: itemCount, projects: 10, links: itemCount * 2.5 }, windowMode: process.env.ACT_TEST_SHOW_WINDOW === '1' ? 'visible' : 'hidden-unthrottled', machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, phases };
    const path = testInfo.outputPath('map-performance.json'); await writeFile(path, JSON.stringify(report, null, 2));
    await testInfo.attach('map-performance', { path, contentType: 'application/json' });
    console.log(`Map performance report: ${path}`);
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('map performance: 500 items with project dashboards, pan/zoom across the threshold', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = denseMap(500), directory = await mkdtemp(join(tmpdir(), 'craft-dense-dashboards-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(() => fixture); await store.writeView('desktop', { camera: { x: 60, y: 100, zoom: .2 } }); } finally { store.close(); }
  const scrollbars = process.platform === 'darwin' ? ['-AppleShowScrollBars', 'WhenScrolling'] : [];
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbars], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const phases: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.locator('[data-dashboard]')).toHaveCount(10);
    await expect(page.locator('[data-item-id^="item-"]')).toHaveCount(0);
    await expect(page.locator('.explicit-edge')).toHaveCount(0);
    // Dragging a dashboard moves its project, so the pan grabs bare map: a point whose whole drag path stays clear of dashboards.
    const grab = await page.evaluate(() => {
      const bare = (x: number, y: number) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane');
      for (let y = 980; y > 100; y -= 20) for (let x = 1500; x > 300; x -= 20) if ([0, 50, 100, 150].every(dx => bare(x - dx, y) && bare(x - dx, y - 30))) return { x, y };
      throw new Error('No bare map to pan');
    });
    await page.evaluate(() => window.craftingPerformance.reset());
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.mouse.move(grab.x, grab.y); await page.mouse.down(); await page.mouse.move(grab.x - 150, grab.y - 30, { steps: 30 }); await page.mouse.up();
      await page.mouse.down(); await page.mouse.move(grab.x, grab.y, { steps: 30 }); await page.mouse.up();
    }
    phases.pan = await page.evaluate(() => window.craftingPerformance.snapshot());
    const pan = phases.pan as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>;
    expect(pan.metrics['map.card-render'].count).toBe(0);
    expect(pan.metrics['map.plots'].count).toBe(0);
    // Wheel steps cross the threshold both ways: items return, then dashboards again.
    await page.mouse.move(800, 450);
    let crossed = false;
    for (const delta of [-500, -500, -500, 500, 500, 500]) {
      await page.mouse.wheel(0, delta);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      crossed ||= await page.locator('.map-area[data-dashboards]').count() === 0;
    }
    phases.navigation = await page.evaluate(() => window.craftingPerformance.snapshot());
    const navigation = phases.navigation as Awaited<ReturnType<Window['craftingPerformance']['snapshot']>>;
    expect(crossed).toBe(true);
    await expect(page.locator('[data-dashboard]')).toHaveCount(10);
    expect(navigation.metrics['map.geometry'].count).toBe(0);
    expect(navigation.metrics['map.placement'].count).toBe(0);
    expect(navigation.metrics['map.plots'].count).toBe(0);
    expect(navigation.metrics['map.frame-interval'].count).toBeGreaterThan(100);
    expect(navigation.metrics['map.frame-interval'].p95).toBeLessThan(50);
    expect(navigation.metrics['map.frame-interval'].p99).toBeLessThan(150);
  } finally {
    const path = testInfo.outputPath('map-performance.json'); await writeFile(path, JSON.stringify({ fixture: { items: 500, projects: 10, links: 1250, dashboards: true }, phases }, null, 2));
    await testInfo.attach('map-performance', { path, contentType: 'application/json' });
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
