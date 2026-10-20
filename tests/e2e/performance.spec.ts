import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { terminalPaintProbe } from './terminal-paint.ts';
import { replayTailBytes } from '../../apps/desktop/renderer/terminal-preferences.ts';
import { DEFAULT_TERMINAL_SCROLLBACK } from '../../packages/core/settings.ts';

test('terminal performance: ANSI stream, input echo, burst, idle and hidden view', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-performance-'));
  const profile = join(directory, 'profile'); await mkdir(profile);
  await writeFile(join(profile, '.zshrc'), "PROMPT='PERF> '\nunset HISTFILE\n");
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/zsh', ZDOTDIR: profile } });
  const phases: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const { sessionId } = await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Performance terminal', position: { x: 250, y: 230 }, data: { cwd } });
      return { sessionId: id };
    }, directory);
    const card = page.getByRole('article', { name: 'Performance terminal' });
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const screen = page.locator('.xterm-accessibility-tree'), surface = page.locator('.terminal-surface');
    phases.renderer = await surface.locator('.terminal-host').getAttribute('data-terminal-renderer');
    let mount = await surface.getAttribute('data-mount-id');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/performance-terminal.mjs'))}\n`);
    await expect(screen).toContainText('PERF_READY');
    await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toBeEnabled();
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.keyboard.type('stream\n');
    await expect(screen).toContainText('PERF_STREAM');
    const painted = await terminalPaintProbe(page, 24, 16);
    const echoes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      await page.keyboard.type(`ping${i}\n`);
      await painted();
      echoes.push(performance.now() - start);
    }
    await expect(screen).toContainText('ECHO:ping11');
    // Fixed observation window gives CI enough frame/output samples under sustained load.
    await page.waitForTimeout(1800);
    phases.stream = await page.evaluate(() => window.craftingPerformance.snapshot());
    phases.echoMs = echoes;
    await page.keyboard.type('burst\n');
    const burstStart = performance.now();
    await expect(screen).toContainText('BURST_DONE', { timeout: 10_000 });
    phases.burstMs = performance.now() - burstStart;
    phases.busy = await page.evaluate(() => window.craftingPerformance.snapshot());
    // Resizing a live view must fit the existing terminal without rebuilding it
    // or changing the graph. Keep its costs separate from the stream/burst gate.
    const pid = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid;
    const handle = page.getByRole('button', { name: 'Resize view: Performance terminal' }), grip = (await handle.boundingBox())!;
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.mouse.move(grip.x + 10, grip.y + 10); await page.mouse.down();
    await page.mouse.move(grip.x - 190, grip.y - 110, { steps: 30 }); await page.mouse.up();
    await expect.poll(() => page.locator('.terminal-host').evaluate(host => {
      const screen = host.querySelector('.xterm-screen')!.getBoundingClientRect(), box = host.getBoundingClientRect();
      return screen.bottom <= box.bottom && screen.right <= box.right;
    })).toBe(true);
    const resized = await page.evaluate(() => window.craftingPerformance.snapshot()); phases.resize = resized;
    expect(resized.metrics['terminal.fit'].count).toBeGreaterThan(0);
    expect(resized.metrics['terminal.fit'].count).toBeLessThanOrEqual(32);
    expect(resized.metrics['terminal.fit'].p95).toBeLessThan(32);
    expect(resized.metrics['frame.interval'].count).toBeGreaterThan(10);
    expect(resized.metrics['frame.interval'].p95).toBeLessThan(50);
    expect(resized.metrics['frame.interval'].p99).toBeLessThan(150);
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(pid);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('idle\n');
    await expect(screen).toContainText('PERF_IDLE');
    await page.waitForTimeout(250);
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.waitForTimeout(1200);
    phases.idle = await page.evaluate(() => window.craftingPerformance.snapshot());
    await page.evaluate(() => window.craftingPerformance.reset());
    const replayStart = performance.now();
    // Reopening after a renderer reload reconstructs the terminal from a bounded
    // tail of its recording. There is no separate History/player surface.
    await page.reload(); await card.click();
    await expect(screen).toContainText('PERF_IDLE', { timeout: 10_000 });
    phases.replayMs = performance.now() - replayStart;
    const replay = await page.evaluate(() => window.craftingPerformance.snapshot()); phases.replay = replay;
    // The default scrollback's tail (about 1 MB); this fixture's output is ASCII-sized.
    const tail = replayTailBytes(DEFAULT_TERMINAL_SCROLLBACK);
    expect(replay.metrics['terminal.output'].total).toBeGreaterThan(.9 * tail); expect(replay.metrics['terminal.output'].total).toBeLessThan(1.25 * tail);
    mount = await surface.getAttribute('data-mount-id');
    await page.getByRole('button', { name: 'Back to project' }).click();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.waitForTimeout(500);
    const hidden = await page.evaluate(() => window.craftingPerformance.snapshot()); phases.hidden = hidden;
    expect(hidden.metrics['terminal.read'].count).toBe(0);
    expect(hidden.metrics['frame.interval'].count).toBe(0);
    await card.click();
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
    await expect(screen).toContainText('PERF_IDLE');
    const busy = phases.busy as typeof hidden;
    const idle = phases.idle as typeof hidden;
    expect(idle.metrics['terminal.commit'].count).toBe(0);
    expect(idle.metrics['terminal.write'].count).toBe(0);
    expect(idle.metrics['terminal.read'].count).toBeLessThanOrEqual(15);
    expect(busy.metrics['terminal.output'].total).toBeGreaterThan(4 * 1024 * 1024);
    expect(busy.metrics['terminal.read-inflight'].max).toBe(1);
    expect(busy.metrics['terminal.commit'].count).toBeLessThanOrEqual(2);
    expect(busy.metrics['frame.interval'].count).toBeGreaterThan(30);
    expect(busy.metrics['frame.interval'].p95).toBeLessThan(50);
    expect(busy.metrics['frame.interval'].p99).toBeLessThan(150);
    expect(busy.metrics['terminal.read'].p95).toBeLessThan(100);
    expect(busy.metrics['terminal.write'].p95).toBeLessThan(50);
    expect(echoes.sort((a, b) => a - b)[Math.ceil(echoes.length * .95) - 1]).toBeLessThan(200);
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
    await page.getByRole('button', { name: 'Show measurements', exact: true }).click(); await expect(page.getByRole('table')).toContainText('terminal.read');
    await expect(page.getByRole('button', { name: 'Download performance report' })).toBeVisible();
    const exportedPath = join(directory, 'performance-export.json');
    const downloaded = app.evaluate(({ session }, file) => new Promise<string>(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(file); item.once('done', (_event, state) => resolve(state));
      });
    }), exportedPath);
    await page.getByRole('button', { name: 'Download performance report' }).click();
    expect(await downloaded).toBe('completed');
    const exported = await readFile(exportedPath, 'utf8');
    expect(JSON.parse(exported).metrics['terminal.read']).toBeDefined();
    expect(exported).not.toContain(directory); expect(exported).not.toContain(sessionId); expect(exported).not.toContain('PERF_IDLE');
    await page.screenshot({ path: testInfo.outputPath('performance-settings.png') });
    // Stop through the actual runtime; test cleanup must never target user sessions.
    await page.evaluate(id => window.craftingTable.sessionStop(id), sessionId);
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.waitForTimeout(250);
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.waitForTimeout(400);
    const stopped = await page.evaluate(() => window.craftingPerformance.snapshot()); phases.stopped = stopped;
    expect(stopped.metrics['terminal.read'].count).toBe(0);
    await expect(screen).toContainText('PERF_IDLE');
  } finally {
    const report = { fixture: 'ANSI 30Hz + >4MiB burst + 12 input echoes', windowMode: process.env.ACT_TEST_SHOW_WINDOW === '1' ? 'visible' : 'hidden-unthrottled', machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, phases };
    const path = testInfo.outputPath('performance.json');
    await writeFile(path, JSON.stringify(report, null, 2));
    await testInfo.attach('performance', { path, contentType: 'application/json' });
    console.log(`Performance report: ${path}`);
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
