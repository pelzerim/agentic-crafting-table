import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

const megabytes = 48;

test('remounting a huge TUI recording replays a bounded tail without blocking the renderer', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-huge-replay-'));
  const profile = join(directory, 'profile'); await mkdir(profile);
  await writeFile(join(profile, '.zshrc'), "PROMPT='HUGE> '\nunset HISTFILE\n");
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/zsh', ZDOTDIR: profile } });
  const report: Record<string, unknown> = { fixture: `${megabytes} MiB Ink-style redraws with periodic screen+scrollback clears`, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model } };
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const sessionId = await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Huge terminal', position: { x: 250, y: 230 }, data: { cwd } });
      return id;
    }, directory);
    const card = page.getByRole('article', { name: 'Huge terminal' });
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const screen = page.locator('.xterm-accessibility-tree');
    await expect(screen).toContainText('HUGE>');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/huge-tui-terminal.mjs'))} ${megabytes}\n`);
    // Record while no view consumes the stream, like a long session left in the background.
    await page.getByRole('button', { name: 'Back to project' }).click();
    const generated = performance.now();
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('').match(/HUGE_DONE frames=(\d+) bytes=(\d+)/)?.slice(1).map(Number),
      { timeout: 180_000, intervals: [500] }).toBeTruthy();
    report.generateMs = performance.now() - generated;
    const tail = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('');
    const [frames, bytes] = tail.match(/HUGE_DONE frames=(\d+) bytes=(\d+)/)!.slice(1).map(Number);
    report.recordedBytes = bytes; expect(bytes).toBeGreaterThan(megabytes * 1024 * 1024);

    await page.reload();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => {
      window.craftingPerformance.reset();
      const probe = { worst: 0, last: performance.now(), timer: 0 };
      probe.timer = window.setInterval(() => { const now = performance.now(); probe.worst = Math.max(probe.worst, now - probe.last); probe.last = now; }, 10);
      (window as unknown as { replayProbe: typeof probe }).replayProbe = probe;
    });
    const opened = performance.now();
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await page.locator('.xterm-helper-textarea').focus();
    report.replayingWhileTyping = await page.locator('.terminal-content[aria-busy]').count() > 0;
    await page.keyboard.type('during\n');
    await page.waitForFunction(() => document.querySelector('.terminal-content:not([aria-busy])'), undefined, { polling: 'raf', timeout: 120_000 });
    report.caughtUpMs = performance.now() - opened;
    const typed = performance.now();
    await page.keyboard.type('after\n');
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join(''), { intervals: [10] }).toContain('HUGE_ECHO:after');
    report.echoMs = performance.now() - typed;
    report.worstGapMs = await page.evaluate(() => { const probe = (window as unknown as { replayProbe: { worst: number; timer: number } }).replayProbe; clearInterval(probe.timer); return probe.worst; });
    const metrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;
    report.replayedBytes = metrics['terminal.output']?.total; report.longTaskMax = metrics['renderer.long-task']?.max; report.longTasks = metrics['renderer.long-task']?.count;
    report.reads = metrics['terminal.read']?.count; report.readMs = metrics['terminal.read']?.total; report.writeMs = metrics['terminal.write']?.total;
    console.log(`Huge replay: ${JSON.stringify(report)}`);
    await expect(screen).toContainText('HUGE_ECHO:during'); await expect(screen).toContainText('HUGE_ECHO:after');
    await expect(screen).toContainText(`Turn ${Math.floor(frames / 40)}:`);
    // Bracketed paste was enabled 48 MiB earlier; the skipped output's modes still apply.
    await page.locator('.xterm-helper-textarea').evaluate(element => {
      const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
      event.clipboardData!.setData('text/plain', 'pasted'); element.dispatchEvent(event);
    });
    await page.keyboard.press('Enter');
    await expect(screen).toContainText('HUGE_ECHO:<paste>pasted</paste>');
    await expect(page.getByText('Earlier output skipped')).toBeVisible();
    expect(report.caughtUpMs as number).toBeLessThan(1500);
    expect(report.worstGapMs as number).toBeLessThan(200);
    expect(metrics['renderer.long-task']?.max ?? 0).toBeLessThan(200);
    expect(metrics['terminal.output'].total).toBeLessThan(4 * 1024 * 1024);
  } finally {
    const path = testInfo.outputPath('huge-replay.json');
    await writeFile(path, JSON.stringify(report, null, 2));
    await testInfo.attach('huge-replay', { path, contentType: 'application/json' });
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
