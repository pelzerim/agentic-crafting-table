import { test, expect } from '@playwright/test';
import { dom, history, launchWorkspace, travel } from './undermap-fixture.ts';

/** An audit measured the Classic layout
 * on this history: one mounted card per item below (106 / 306 / 1,005) and travel of 104 / 190 / 384 ms. */
const SIZES = [100, 300, 1000], PROJECTS = 4, BUDGET = 28;

test('Mirror keeps mounted cards bounded at 100, 300 and 1,000 items below; Classic still mounts every one', async () => {
  test.setTimeout(600_000);
  const states = await history(SIZES), report: Record<string, unknown>[] = [];
  for (const size of SIZES) for (const layout of ['mirror', 'classic'] as const) {
    if (layout === 'classic' && size !== 1000) continue;
    const app = await launchWorkspace(states.get(size)!, { zoom: .7, x: 120, y: 190 }, { layout });
    try {
      const { page } = app;
      await page.waitForTimeout(600);
      const map = await dom(page);
      // The median of three trips down, each from the map.
      const trips: number[] = [];
      for (let trip = 0; trip < 3; trip++) { trips.push(await travel(page, 'below')); await page.waitForTimeout(500); if (trip < 2) { await travel(page, 'map'); await page.waitForTimeout(300); } }
      const arrived = await dom(page), below = Number((await page.locator('.below-bar [role=status]').innerText()).replace(/\D/g, ''));
      const frame = await page.evaluate(() => new Promise<number>(resolve => { let last = performance.now(), worst = 0, frames = 0; const tick = (now: number) => { worst = Math.max(worst, now - last); last = now; if (++frames < 30) requestAnimationFrame(tick); else resolve(Math.round(worst)); }; requestAnimationFrame(tick); }));
      const entry = { layout, below, travelMs: trips.sort((a, b) => a - b)[1], trips, mapCards: map.nodes, cards: arrived.cards, nodes: arrived.nodes, elements: arrived.elements, worstFrameMs: frame };
      report.push(entry); console.log(`Undermap ${JSON.stringify(entry)}`);
      expect(below).toBeGreaterThanOrEqual(size);
      if (layout === 'mirror') {
        expect(arrived.cards, 'at most the budget per project').toBeLessThanOrEqual(PROJECTS * BUDGET);
        expect(arrived.elements).toBeLessThan(4000);
        expect(entry.travelMs, 'travel does not grow with what lies below').toBeLessThan(400);
      } else expect(arrived.cards, 'Classic is unchanged: one card per item').toBeGreaterThanOrEqual(size);
    } finally { await app.close(); }
  }
  await test.info().attach('undermap-performance', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});
