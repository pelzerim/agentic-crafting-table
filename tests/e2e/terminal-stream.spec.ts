import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from './visual-fixture.ts';
import { terminalPaintProbe } from './terminal-paint.ts';

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

test('long token stream preserves every packet, stays interactive and distinguishes a paused source from lost output', async ({ visual: { page } }, testInfo) => {
  test.setTimeout(60_000);
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision,
      pluginId: 'terminal.session', title: 'Streaming terminal', projectId: 'billing', position: { x: 700, y: 650 }, data: { cwd: '/tmp' } });
  });
  await page.getByRole('article', { name: 'Streaming terminal', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/streaming-terminal.mjs'))}\n`);
  const output = page.locator('.xterm-accessibility-tree'), surface = page.locator('.terminal-surface');
  const sessionId = (await surface.getAttribute('data-terminal-id'))!, mount = (await surface.getAttribute('data-mount-id'))!;
  const pid = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid;
  await expect(output).toContainText('STREAM_READY');
  const phases: Record<string, unknown> = {}, echoMs: number[] = [];
  try {
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.keyboard.type('start\n');
    await expect(output).toContainText('STREAM_ACTIVE');
    const painted = await terminalPaintProbe(page, 13, 12);
    for (let i = 0; i < 6; i++) {
      const before = performance.now(); await page.keyboard.type(`ping${i}\n`); await painted(); echoMs.push(performance.now() - before);
    }
    await page.keyboard.type('pause\n'); await expect(output).toContainText('SOURCE_PAUSED');
    // Fixed idle observation window tests absence of unsolicited retries/input.
    await page.waitForTimeout(350);
    const paused = await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId);
    await page.waitForTimeout(350);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).lastSequence).toBe(paused.lastSequence);
    phases.paused = await page.evaluate(() => window.craftingPerformance.snapshot());
    await page.keyboard.press('Control+c'); await expect(output).toContainText('SOURCE_INTERRUPTED');
    await page.keyboard.type('resume\n');
    await expect(output).toContainText('FINAL_SENTENCE_COMPLETE.', { timeout: 20_000 });
    await expect(output).toContainText('part-0899'); await expect(output).toContainText('Grüße 世界 🛠 ┌─┐ —');
    await expect(output).toContainText('STREAM_COMPLETE replies=5');
    const report = await page.evaluate(() => window.craftingPerformance.snapshot()); phases.complete = report;
    expect(report.metrics['terminal.output-gap'].count).toBe(0);
    expect(report.metrics['terminal.backlog-chunks'].count).toBeGreaterThan(10);
    expect(report.metrics['terminal.backlog-chunks'].p95).toBe(0);
    expect(report.metrics['terminal.read-inflight'].max).toBe(1);
    expect(report.metrics['terminal.write'].p95).toBeLessThan(50);
    expect(report.metrics['frame.interval'].p95).toBeLessThan(50);
    expect(report.metrics['frame.interval'].p99).toBeLessThan(150);
    expect(echoMs.sort((a, b) => a - b)[Math.ceil(echoMs.length * .95) - 1]).toBeLessThan(200);
    // Re-read the entire recording through production pagination. Final-marker
    // alone is not proof that the intervening tokens survived.
    const recorded = await page.evaluate(async id => {
      let after = 0, text = '', contiguous = true;
      for (;;) {
        const page = await window.craftingTable.sessionRead(id, after, true);
        for (const chunk of page.chunks) { contiguous &&= chunk.sequence === after + 1; after = chunk.sequence; text += chunk.data; }
        if (!page.hasMore) break;
      }
      return { contiguous, parts: [...text.matchAll(/part-(\d{4})/g)].map(match => Number(match[1])), corrupt: text.includes('\uFFFD') };
    }, sessionId);
    expect(recorded.contiguous).toBe(true); expect(recorded.corrupt).toBe(false);
    expect(recorded.parts).toEqual(Array.from({ length: 900 }, (_, i) => i));
    await expect(surface).toHaveAttribute('data-mount-id', mount);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(pid);
  } finally {
    const path = testInfo.outputPath('stream-performance.json');
    await writeFile(path, JSON.stringify({ fixture: '900 token lines, fragmented UTF-8/ANSI, source pause, interrupt and resume', windowMode: 'hidden-unthrottled', echoMs, phases }, null, 2));
    await testInfo.attach('stream-performance', { path, contentType: 'application/json' });
  }
});
