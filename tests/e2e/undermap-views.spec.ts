import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { test } from './visual-fixture.ts';

const createTerminal = (page: Page, title: string) => page.evaluate(async title => {
  for (let attempt = 0; ; attempt++) {
    const { state } = await window.craftingTable.workspaceRead();
    try {
      return await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision,
        pluginId: 'terminal.session', title, projectId: 'billing', position: { x: 700, y: 650 }, data: { cwd: '/tmp' } });
    } catch (error) { if (attempt === 3 || (error as { code?: string }).code !== 'REVISION_CONFLICT') throw new Error(JSON.stringify(error)); }
  }
}, title);
const travel = async (page: Page, layer: 'map' | 'below') => {
  await page.locator('.below-portal').click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', layer);
};
const metrics = async (page: Page) => (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;

test('travelling to the Undermap and back neither reopens a closed view nor multiplies terminal reads', async ({ visual: { page } }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  await createTerminal(page, 'Ticking terminal');
  const terminal = page.getByRole('article', { name: 'Ticking terminal', exact: true }), map = page.locator('.map-area');
  await terminal.click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.05; done\n');
  const sessionId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const surface = page.locator(`.terminal-surface[data-terminal-id="${sessionId}"]`), screen = surface.locator('.xterm-accessibility-tree');
  await expect(screen).toContainText('tick 5');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  // Needs me opens an item through the map's reveal request; closing it again must stick.
  await page.getByRole('button', { name: /^Needs me: \d/ }).click();
  await page.getByRole('button', { name: 'Open Claude · implementation', exact: true }).click();
  await expect(map).toHaveAttribute('data-focus', 'agent');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(map).toHaveAttribute('data-focus', '');

  const evidence: Record<string, unknown>[] = [];
  for (let trip = 0; trip < 4; trip++) {
    await terminal.click();
    await expect(map).toHaveAttribute('data-focus', /.+/);
    await travel(page, 'below');
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.waitForTimeout(1_000);
    const below = await metrics(page);
    await travel(page, 'map');
    await page.waitForTimeout(500);
    const focus = await map.getAttribute('data-focus');
    if (focus) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await terminal.click();
    await expect(page.locator('.map-card.expanded .native-terminal')).toHaveAttribute('data-session-state', 'running');
    const before = Number((await screen.textContent())!.match(/tick (\d+)(?![\s\S]*tick \d)/)?.[1] ?? 0);
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.waitForTimeout(1_000);
    const open = await metrics(page);
    await expect.poll(async () => Number((await screen.textContent())!.match(/tick (\d+)(?![\s\S]*tick \d)/)?.[1] ?? 0)).toBeGreaterThan(before);
    evidence.push({ trip, focusAfterReturn: focus, belowReads: below['terminal.read'].count, openReads: open['terminal.read'].count, inflight: open['terminal.read-inflight'].max, surfaces: await surface.count() });
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  }
  console.log(`Undermap travel: ${JSON.stringify(evidence)}`);
  for (const trip of evidence) {
    expect(trip.focusAfterReturn).toBe('');
    expect(trip.belowReads).toBe(0);
    expect(trip.inflight).toBe(1);
    expect(trip.surfaces).toBe(1);
  }
  const reads = evidence.map(trip => trip.openReads as number);
  expect(Math.max(...reads)).toBeLessThan(Math.min(...reads) * 1.5);
});

test('a retained terminal view reopened after a large backlog replays a bounded tail and keeps its session', async ({ visual: { page } }) => {
  test.setTimeout(200_000);
  await createTerminal(page, 'Busy terminal');
  const card = page.getByRole('article', { name: 'Busy terminal', exact: true });
  await card.click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  const sessionId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const surface = page.locator(`.terminal-surface[data-terminal-id="${sessionId}"]`), mount = (await surface.getAttribute('data-mount-id'))!;
  const input = page.locator('.map-card.expanded .xterm-helper-textarea'), screen = surface.locator('.xterm-accessibility-tree');
  await input.focus();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/huge-tui-terminal.mjs'))} 16\n`);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join(''),
    { timeout: 120_000, intervals: [500] }).toContain('HUGE_DONE');
  await page.evaluate(() => {
    window.craftingPerformance.reset();
    const probe = { worst: 0, last: performance.now(), timer: 0 };
    probe.timer = window.setInterval(() => { const now = performance.now(); probe.worst = Math.max(probe.worst, now - probe.last); probe.last = now; }, 10);
    (window as unknown as { replayProbe: typeof probe }).replayProbe = probe;
  });
  const opened = performance.now();
  await card.click();
  await expect(screen).toContainText('HUGE_DONE', { timeout: 60_000 });
  const caughtUpMs = performance.now() - opened;
  const worstGapMs = await page.evaluate(() => { const probe = (window as unknown as { replayProbe: { worst: number; timer: number } }).replayProbe; clearInterval(probe.timer); return probe.worst; });
  const replayed = (await metrics(page))['terminal.output'].total;
  console.log(`Retained replay: ${JSON.stringify({ caughtUpMs: Math.round(caughtUpMs), worstGapMs: Math.round(worstGapMs), replayed })}`);
  await expect(surface).toHaveAttribute('data-mount-id', mount);
  expect(replayed).toBeLessThan(5 * 1024 * 1024);
  await expect(page.getByText('Earlier output skipped')).toBeVisible();
  await input.focus();
  await page.keyboard.type('after\n');
  await expect(screen).toContainText('HUGE_ECHO:after');
  // Bracketed paste was enabled at the start of the skipped output.
  await input.evaluate(element => {
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    event.clipboardData!.setData('text/plain', 'pasted'); element.dispatchEvent(event);
  });
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('HUGE_ECHO:<paste>pasted</paste>');
});
