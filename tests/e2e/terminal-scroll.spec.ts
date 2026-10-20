import { expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { test } from './visual-fixture.ts';
import { terminalPaintProbe } from './terminal-paint.ts';

async function openScrollingTerminal(page: Page, mode: string) {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
      expectedRevision: state.revision, pluginId: 'terminal.session', title: 'Scrolling terminal', projectId: 'billing', position: { x: 650, y: 650 }, data: { cwd: '/tmp' } });
  });
  await page.getByRole('article', { name: 'Scrolling terminal' }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/scrolling-terminal.mjs'))} ${mode}\n`);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText(mode === 'normal' ? 'HISTORY:249' : `MODE:${mode}`);
  // A CLI that asks which terminal it runs in gets the app's name; agent CLIs choose wheel handling by it.
  if (mode !== 'normal') await expect(page.locator('.xterm-accessibility-tree')).toContainText('TERM:Agentic Crafting Table(');
  // Pixel mouse coordinates are declined: the integer cell size a CLI can ask for cannot place them on fractional cells.
  if (mode !== 'normal') await expect(page.locator('.xterm-accessibility-tree')).toContainText('PIXELS:0');
  await page.locator('.xterm-screen').hover();
  return (await page.locator('.xterm-accessibility-tree > div').first().boundingBox())!.height;
}

for (const mode of ['mouse', 'legacy', 'arrows']) test(`terminal ${mode} scrolling preserves small wheel movements and multi-line gestures`, async ({ visual: { page } }, testInfo) => {
  const row = await openScrollingTerminal(page, mode), screen = page.locator('.xterm-accessibility-tree');
  const graph = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const camera = await page.locator('.react-flow__viewport').getAttribute('style');
  const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
  const id = (await surface.getAttribute('data-terminal-id'))!;
  const session = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  const bounds = (await page.locator('.xterm-screen').boundingBox())!;
  // In the legacy protocol this coordinate contains a byte above 127, which
  // must reach the PTY unchanged rather than becoming two UTF-8 bytes.
  const x = bounds.x + bounds.width / session.cols * (session.cols - 1.5), y = bounds.y + row * 3;
  await page.mouse.move(x, y);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -row / 4);
  await expect(screen).toContainText('SCROLL:98 UP:2 DOWN:0');
  if (mode !== 'arrows') await expect(screen).toContainText(`COL:${session.cols - 1}`);
  await page.mouse.wheel(0, -4 * row);
  await expect(screen).toContainText('SCROLL:94 UP:6 DOWN:0');
  await page.mouse.wheel(0, row);
  await expect(screen).toContainText('SCROLL:95 UP:6 DOWN:1');
  // Browser line/page delta modes use explicit DOM events; pixel gestures above
  // use actual Electron wheel input, rather than invoking a handler directly.
  await screen.dispatchEvent('wheel', { deltaY: 3, deltaMode: 1, clientX: (await screen.boundingBox())!.x + 40, clientY: (await screen.boundingBox())!.y + 40 });
  await expect(screen).toContainText('SCROLL:98 UP:6 DOWN:4');
  const echoes: number[] = [];
  // The open view watches its session: the CLI's redraw announces itself
  // instead of waiting for the next poll.
  await page.evaluate(id => { const seen: number[] = []; (window as any).sessionActivity = seen; window.craftingTable.onSessionActivity(ids => { if (ids.includes(id)) seen.push(performance.now()); }); }, id);
  const painted = await terminalPaintProbe(page);
  await page.evaluate(() => window.craftingPerformance.reset());
  for (let i = 0; i < 12; i++) {
    const start = performance.now(); await page.mouse.wheel(0, row * 4);
    await painted();
    echoes.push(performance.now() - start);
  }
  const performanceReport = await page.evaluate(() => window.craftingPerformance.snapshot());
  await expect(screen).toContainText('UP:6 DOWN:52 ');
  const reportPath = testInfo.outputPath('wheel-performance.json');
  await writeFile(reportPath, JSON.stringify({ mode, echoes, metrics: performanceReport.metrics }, null, 2));
  await testInfo.attach('wheel-performance', { path: reportPath, contentType: 'application/json' });
  expect(echoes.sort((a, b) => a - b)[Math.ceil(echoes.length * .95) - 1]).toBeLessThan(200);
  expect((await page.evaluate(() => (window as any).sessionActivity.length)) as number).toBeGreaterThanOrEqual(12);
  expect(performanceReport.metrics['frame.interval'].p95).toBeLessThan(50);
  expect(performanceReport.metrics['frame.interval'].count).toBeGreaterThan(10);
  // A notch is one write; nothing is paced out behind it.
  expect(performanceReport.metrics['terminal.input'].count).toBe(12);
  await screen.dispatchEvent('wheel', { deltaY: -1, deltaMode: 2, clientX: x, clientY: y });
  const finalCounts = `UP:${6 + session.rows} DOWN:52`;
  await expect(screen).toContainText(finalCounts);
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  await expect(surface).toHaveAttribute('data-mount-id', mount!);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.pid).toBe(session.pid);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(graph);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(camera);
});

test('normal scrollback stays anchored while new output arrives', async ({ visual: { page } }) => {
  await openScrollingTerminal(page, 'normal');
  const screen = page.locator('.xterm-accessibility-tree'), first = screen.locator(':scope > div').first();
  const bottom = await first.textContent();
  // Schedule output before scrolling, so keyboard input cannot legitimately
  // return us to the live prompt during this reading check.
  await page.keyboard.type('o');
  await page.mouse.wheel(0, -500);
  await expect(first).not.toHaveText(bottom!);
  // Establish a stable reading position before checking subsequent output.
  let previous = '', stable = 0;
  await expect.poll(async () => { const value = await first.textContent(); stable = value === previous ? stable + 1 : 0; previous = value!; return stable; }, { intervals: [30] }).toBeGreaterThanOrEqual(3);
  const reading = await first.textContent();
  const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).chunks.map(chunk => chunk.data).join('')).toContain('LATER_OUTPUT');
  await expect(first).toHaveText(reading!);
  await page.mouse.wheel(0, 20000);
  await expect(screen).toContainText('LATER_OUTPUT');
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
  await page.locator('.xterm-screen').hover(); await page.mouse.wheel(0, -500);
  await expect(screen).not.toContainText('LATER_OUTPUT');
});

test('each wheel event is written at once: a notch is one write, nothing queues behind a reversal or a hidden view', async ({ visual: { page } }) => {
  const row = await openScrollingTerminal(page, 'mouse'), screen = page.locator('.xterm-accessibility-tree');
  const writes = async () => (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics['terminal.input']?.count ?? 0;
  await page.evaluate(() => window.craftingPerformance.reset());
  const dispatch = (deltas: number[]) => page.evaluate(deltas => {
    const screen = document.querySelector('.xterm-screen')!, bounds = screen.getBoundingClientRect();
    for (const deltaY of deltas) screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: bounds.x + 20, clientY: bounds.y + 20 }));
  }, deltas);
  await dispatch([row * 12]);
  await expect(screen).toContainText('SCROLL:112 UP:0 DOWN:12');
  expect(await writes()).toBe(1);
  // Three events are three writes; the fractional reversal after them sends nothing and takes nothing back.
  await dispatch([row * 2, row * 3, row * 4, -row / 4]);
  await expect(screen).toContainText('SCROLL:121 UP:0 DOWN:21');
  await page.waitForTimeout(100);
  await expect(screen).toContainText('SCROLL:121 UP:0 DOWN:21');
  expect(await writes()).toBe(4);
  // Fractions left when the view is hidden do not come back with it.
  await page.evaluate(row => {
    const screen = document.querySelector('.xterm-screen')!;
    screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: row * .9 }));
    (document.querySelector('.item-view:not([hidden]) .item-close') as HTMLButtonElement).click();
  }, row);
  await expect(page.locator('.item-view:not([hidden])')).toHaveCount(0);
  await page.getByRole('article', { name: 'Scrolling terminal', exact: true }).click();
  await dispatch([row * .9]);
  await page.waitForTimeout(100);
  await expect(screen).toContainText('SCROLL:121 UP:0 DOWN:21');
  expect(await writes()).toBe(4);
});

test('wheel movement does not force a layout measurement per event or per report', async ({ visual: { page } }) => {
  const row = await openScrollingTerminal(page, 'mouse'), screen = page.locator('.xterm-accessibility-tree');
  // Measuring an element makes the browser lay out the whole page at once; on a
  // large map a trackpad's stream of events would spend the frame doing that.
  const measured = await page.evaluate(async row => {
    const screen = document.querySelector('.xterm-screen')!, bounds = screen.getBoundingClientRect();
    const original = Element.prototype.getBoundingClientRect; let calls = 0;
    Element.prototype.getBoundingClientRect = function (this: Element) { calls++; return original.call(this); };
    try {
      for (let frame = 0; frame < 10; frame++) {
        for (let i = 0; i < 6; i++) screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: row, clientX: bounds.x + 20, clientY: bounds.y + 20 }));
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    } finally { Element.prototype.getBoundingClientRect = original; }
    return calls;
  }, row);
  await expect(screen).toContainText('SCROLL:160 UP:0 DOWN:60');
  // One look at the cell size and one encoded report serve the whole gesture while the pointer rests.
  expect(measured).toBeLessThanOrEqual(3);
});
