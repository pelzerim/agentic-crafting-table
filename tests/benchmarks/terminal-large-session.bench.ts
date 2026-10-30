import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from '../e2e/exit-without-shutdown.ts';

// Streams a synthetic Claude-like session (tests/fixtures/claude-like-terminal.mjs)
// into an open terminal view, wheel-scrolls its history and reopens it, under each
// screen reader / scrollback combination. Comparison only: no budgets are asserted.
const lines = Number(process.env.BENCH_LINES ?? 50_000), repeats = Number(process.env.BENCH_REPEATS ?? 2);
const variants = [
  { name: 'before: screen reader on, 10,000 lines', screenReader: true, scrollback: 10000 },
  { name: 'screen reader off, 10,000 lines', screenReader: false, scrollback: 10000 },
  { name: 'screen reader on, 5,000 lines', screenReader: true, scrollback: 5000 },
  { name: 'after: screen reader off, 5,000 lines', screenReader: false, scrollback: 5000 },
] as const;

type Probe = { frames: number[]; long: number[] };
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? 0, over50: sorted.filter(value => value > 50).length };
};
const summary = ({ frames, long }: Probe) => ({ frames: stats(frames), longTasks: { count: long.length, totalMs: long.reduce((a, b) => a + b, 0), max: Math.max(0, ...long) } });

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const probe = { frames: [] as number[], long: [] as number[], running: true, last: performance.now(), observer: new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.long.push(entry.duration); }) };
    const tick = (now: number) => { if (!probe.running) return; probe.frames.push(now - probe.last); probe.last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick); probe.observer.observe({ type: 'longtask' });
    (window as unknown as { benchProbe: typeof probe }).benchProbe = probe;
  });
}
const stopProbe = (page: Page) => page.evaluate(() => {
  const probe = (window as unknown as { benchProbe: { frames: number[]; long: number[]; running: boolean; observer: PerformanceObserver } }).benchProbe;
  probe.running = false; probe.observer.disconnect();
  return { frames: probe.frames.slice(1), long: probe.long };
});
const outputTotal = (page: Page) => page.evaluate(() => window.craftingPerformance.snapshot().metrics['terminal.output']?.total ?? 0);
async function settled(page: Page, started: number) {
  let total = await outputTotal(page), changed = performance.now();
  while (performance.now() - changed < 1500) {
    await page.waitForTimeout(100);
    const next = await outputTotal(page);
    if (next !== total) { total = next; changed = performance.now(); }
  }
  return { characters: total, ms: changed - started };
}

const results: Record<string, unknown>[] = [];
test.afterAll(async () => {
  const path = resolve('test-results/terminal-benchmark.json');
  await writeFile(path, JSON.stringify({ lines, repeats, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, results }, null, 2));
});

for (let repeat = 1; repeat <= repeats; repeat++) for (const variant of variants) test(`${variant.name} (run ${repeat})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-bench-'));
  const profile = join(directory, 'profile'); await mkdir(profile);
  await writeFile(join(profile, '.zshrc'), "PROMPT='BENCH> '\nunset HISTFILE\n");
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, ACT_TEST_ASSISTIVE_TECH: '0', SHELL: '/bin/zsh', ZDOTDIR: profile } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(async terminal => {
      const settings = await window.craftingTable.settingsRead();
      await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, terminal } });
    }, { screenReader: variant.screenReader, scrollback: variant.scrollback, rightClickCloses: 'anywhere' as const });
    const sessionId = await page.evaluate(async cwd => {
      const id = crypto.randomUUID(), { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision,
        pluginId: 'terminal.session', title: 'Benchmark terminal', position: { x: 250, y: 230 }, data: { cwd } });
      return id;
    }, directory);
    const card = page.getByRole('article', { name: 'Benchmark terminal' });
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const recorded = async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('');
    await expect.poll(recorded).toContain('BENCH>');
    const surface = page.locator('.terminal-surface');
    await expect(surface).toHaveAttribute('data-terminal-scrollback', String(variant.scrollback));
    expect(await page.locator('.terminal-surface .xterm-accessibility').count()).toBe(variant.screenReader ? 1 : 0);

    // Stream: the view consumes the session while it is produced.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await page.locator('.xterm-helper-textarea').focus();
    await page.evaluate(() => window.craftingPerformance.reset());
    await startProbe(page);
    const streamStarted = performance.now();
    await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/claude-like-terminal.mjs'))} ${lines}\n`);
    await expect.poll(recorded, { timeout: 10 * 60_000, intervals: [500] }).toMatch(/CLAUDE_LIKE_DONE lines=\d+ bytes=\d+/);
    const stream = await settled(page, streamStarted);
    const streamProbe = await stopProbe(page);
    const streamMetrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;
    const bytes = Number(/CLAUDE_LIKE_DONE lines=\d+ bytes=(\d+)/.exec(await recorded())![1]);

    // Scroll: wheel up and down through history with real Electron wheel input.
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.craftingPerformance.reset());
    await startProbe(page);
    const scrollStarted = performance.now(), events = 3 * 2 * 60;
    for (let cycle = 0; cycle < 3; cycle++) for (const direction of [-1, 1]) for (let i = 0; i < 60; i++) await page.mouse.wheel(0, direction * 100);
    const scrollMs = performance.now() - scrollStarted;
    await page.waitForTimeout(300);
    const scrollProbe = await stopProbe(page);

    // Reopen: a fresh view replays the recording tail sized to its scrollback.
    await page.getByRole('button', { name: 'Back to project' }).click();
    await page.reload();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => window.craftingPerformance.reset());
    await startProbe(page);
    const reopened = performance.now();
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await page.waitForFunction(() => document.querySelector('.terminal-content:not([aria-busy])'), undefined, { polling: 'raf', timeout: 120_000 });
    const reopenMs = performance.now() - reopened;
    const reopenProbe = await stopProbe(page);
    const reopenMetrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;

    const result = {
      variant: variant.name, repeat, screenReader: variant.screenReader, scrollback: variant.scrollback,
      stream: { bytes, characters: stream.characters, ms: stream.ms, megabytesPerSecond: bytes / 1024 / 1024 / (stream.ms / 1000), writeP95: streamMetrics['terminal.write'].p95, ...summary(streamProbe) },
      scroll: { events, ms: scrollMs, msPerEvent: scrollMs / events, ...summary(scrollProbe) },
      reopen: { ms: reopenMs, replayedCharacters: reopenMetrics['terminal.output'].total, ...summary(reopenProbe) },
    };
    results.push(result);
    console.log(`BENCH ${JSON.stringify(result)}`);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
