import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { apply, camera, dom, history, launchWorkspace, monthsState, mountedCards, read, setLayout, travel, world } from './undermap-fixture.ts';

const card = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`);
const month = (page: Page, area: string, key: string) => page.locator(`[data-undermap-month="${area}:${key}"]`);
const label = (page: Page, id: string) => page.locator(`[data-project-label="${id}"]`);
const screen = async (page: Page, id: string) => (await card(page, id).boundingBox())!;
const stored = async (page: Page, id: string) => (await read(page)).nodes.find(node => node.id === id)!;
async function withApp(state: Parameters<typeof launchWorkspace>[0], run: (page: Page) => Promise<void>, view?: Parameters<typeof launchWorkspace>[1]) {
  const app = await launchWorkspace(state, view);
  try { await run(app.page); } finally { await app.close(); }
}

test('an item sent from a project lands under that project, with the camera kept, and returns to its map position', async () => {
  await withApp(monthsState(), async page => {
    const before = (await stored(page, 'billing-live-2')).position;
    const view = await camera(page);
    await card(page, 'billing-live-2').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Undermap', exact: true }).click();
    await expect(card(page, 'billing-live-2')).toHaveCount(0);
    // The project's place is where its remaining members are.
    await page.waitForTimeout(300);
    const plate = (await label(page, 'billing').boundingBox())!;
    await travel(page, 'below');
    await expect(page.locator('.map-area')).toHaveAttribute('data-undermap-layout', 'mirror');
    expect(await camera(page), 'travelling keeps the camera').toEqual(view);
    // The plate is where it was on the map.
    const below = (await label(page, 'billing').boundingBox())!;
    expect(Math.abs(below.x + below.width / 2 - plate.x - plate.width / 2)).toBeLessThan(40); expect(Math.abs(below.y - plate.y)).toBeLessThan(40);
    // Sent now, it is the newest item: first place under the newest month's line, inside the window.
    await expect(card(page, 'billing-live-2')).toBeVisible();
    const sent = await screen(page, 'billing-live-2'), line = (await month(page, 'billing', '2026-10').boundingBox())!, next = await screen(page, 'bil-oct-39');
    expect(sent.y).toBeGreaterThan(line.y); expect(sent.y - line.y).toBeLessThan(60);
    expect(sent.x).toBeLessThan(next.x); expect(sent.y).toBe(next.y);
    expect(sent.y).toBeGreaterThan(0); expect(sent.y + sent.height).toBeLessThan(900);
    await expect(month(page, 'billing', '2026-10')).toContainText('OCTOBER · 41');
    expect((await stored(page, 'billing-live-2')).belowAt).toEqual(expect.any(String));
    // The menu below is unchanged.
    await card(page, 'billing-live-2').click({ button: 'right' });
    const entries = await page.getByRole('menuitem').allTextContents();
    expect(entries).toEqual(expect.arrayContaining(['Bring back to map', 'Item settings…', 'Archive'])); expect(entries).not.toContain('Send to Undermap');
    await page.getByRole('menuitem', { name: 'Bring back to map', exact: true }).click();
    await expect(card(page, 'billing-live-2')).toHaveCount(0);
    await expect(month(page, 'billing', '2026-10')).toContainText('OCTOBER · 40');
    const returned = await stored(page, 'billing-live-2');
    expect(returned.belowAt).toBeUndefined(); expect(returned.position).toEqual(before);
    await travel(page, 'map');
    expect(await camera(page)).toEqual(view);
    await expect(card(page, 'billing-live-2')).toBeVisible();
  });
});

test('each project area is cut by month lines with a label, a count and the days; older months are a line alone', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    await expect(page.locator('.below-bar')).toContainText('Undermap · 133 items');
    await expect(page.locator('[data-undermap-month^="docs:"]')).toHaveText([/^OCTOBER · 3\s*2 Oct$/, /^SEPTEMBER · 25\s*10 Sep – 16 Sep$/, /^DECEMBER 2025 · 24\s*5 Dec – 11 Dec/]);
    await expect(page.locator('[data-undermap-month^="billing:"]')).toHaveText([/^OCTOBER · 40\s*1 Oct – 4 Oct$/, /^SEPTEMBER · 30\s*2 Sep – 9 Sep/, /^JUNE · 9\s*3 Jun – 5 Jun/]);
    // Lines belong to the layer: they run the width of the area and move with a pan.
    const line = (await month(page, 'billing', '2026-10').boundingBox())!;
    expect(line.width).toBeGreaterThan(1200);
    await page.mouse.move(700, 700); await page.mouse.down(); await page.mouse.move(640, 660, { steps: 4 }); await page.mouse.up();
    const panned = (await month(page, 'billing', '2026-10').boundingBox())!;
    expect(panned.x - line.x).toBeCloseTo(-60, 0); expect(panned.y - line.y).toBeCloseTo(-40, 0);
    // Docs: the two recent months fill the budget, the older one mounts nothing.
    await expect(month(page, 'docs', '2026-09')).toHaveAttribute('data-open', 'true');
    await expect(month(page, 'docs', '2025-12')).toHaveAttribute('data-open', 'false');
    await expect(page.locator('[data-item-id^="doc-dec"]')).toHaveCount(0);
    // Newest first inside a month.
    const first = await world(page, 'bil-oct-39'), second = await world(page, 'bil-oct-38');
    expect(first.y).toBe(second.y); expect(first.x).toBeLessThan(second.x);
  });
});

test('a collapsed month opens in place on a click and closes on a second click or Escape; one open month per project', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    // Bring the older lines into the window first.
    await page.mouse.move(700, 700); await page.mouse.down(); await page.mouse.move(700, 500, { steps: 4 }); await page.mouse.up();
    await expect.poll(async () => (await camera(page)).y).toBe(-100);
    const view = await camera(page), june = month(page, 'billing', '2026-06'), september = month(page, 'billing', '2026-09');
    const before = await mountedCards(page);
    await expect(june.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    await june.getByRole('button').click();
    await expect(june).toHaveAttribute('data-open', 'true'); await expect(june.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-item-id^="bil-jun"]')).toHaveCount(9);
    expect(await camera(page), 'opening a month does not move the camera').toEqual(view);
    const lineY = Number(await june.getAttribute('data-world-y'));
    expect((await world(page, 'bil-jun-08')).y).toBeGreaterThan(lineY);
    await september.getByRole('button').click();
    await expect(september).toHaveAttribute('data-open', 'true'); await expect(june).toHaveAttribute('data-open', 'false');
    await expect(page.locator('[data-item-id^="bil-jun"]')).toHaveCount(0);
    await expect(page.locator('[data-item-id^="bil-sep"]').first()).toBeVisible();
    // June's line moved down under September's cards: the area grew downward.
    expect(Number(await june.getAttribute('data-world-y'))).toBeGreaterThan(lineY);
    await september.getByRole('button').click();
    await expect(september).toHaveAttribute('data-open', 'false');
    expect(await mountedCards(page)).toBe(before);
    await june.getByRole('button').click(); await expect(june).toHaveAttribute('data-open', 'true');
    await page.keyboard.press('Escape');
    await expect(june).toHaveAttribute('data-open', 'false');
    await page.waitForTimeout(400);
    expect(await camera(page), 'Escape closes the month before it steps the map back').toEqual(view);
    // Enter on a focused line opens it too.
    await june.getByRole('button').focus(); await page.keyboard.press('Enter');
    await expect(june).toHaveAttribute('data-open', 'true');
  });
});

test('the newest month shows the budget and ends with “+N more”, which opens the rest', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    await expect(page.locator('[data-item-id^="bil-oct"]')).toHaveCount(28);
    const more = page.locator('[data-undermap-more="billing"]');
    await expect(more).toHaveText('+12 more ▸');
    await expect(card(page, 'bil-oct-12')).toBeVisible(); await expect(card(page, 'bil-oct-11')).toHaveCount(0);
    expect((await more.boundingBox())!.y).toBeGreaterThan((await screen(page, 'bil-oct-12')).y);
    await more.click();
    await expect(page.locator('[data-item-id^="bil-oct"]')).toHaveCount(40);
    await expect(more).toHaveText('Show the newest 28 ▾');
    await more.click();
    await expect(page.locator('[data-item-id^="bil-oct"]')).toHaveCount(28);
    await expect(page.locator('[data-undermap-more="docs"]')).toHaveCount(0);
    // A card below opens on a click as it always did; Escape closes the view and leaves the months alone.
    await more.click(); await expect(page.locator('[data-item-id^="bil-oct"]')).toHaveCount(40);
    await card(page, 'bil-oct-30').click();
    await expect(page.locator('[data-expanded-item-id="bil-oct-30"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-expanded-item-id="bil-oct-30"]')).toBeHidden();
    await expect(page.locator('[data-item-id^="bil-oct"]')).toHaveCount(40);
  });
});

test('when a project moves on the map its area below follows', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    const before = await world(page, 'bil-oct-39'), line = Number(await month(page, 'billing', '2026-10').getAttribute('data-world-y'));
    await travel(page, 'map');
    await apply(page, [{ type: 'nodes.move', positions: [{ id: 'billing-live-1', position: { x: 650 + 200, y: 240 + 300 } }, { id: 'billing-live-2', position: { x: 1000 + 200, y: 410 + 300 } }] }]);
    const moved = await read(page), shift = { x: moved.nodes.find(node => node.id === 'billing-live-1')!.position.x - 650, y: moved.nodes.find(node => node.id === 'billing-live-1')!.position.y - 240 };
    expect(shift).toEqual({ x: 200, y: 300 });
    await travel(page, 'below');
    await expect.poll(() => world(page, 'bil-oct-39')).toEqual({ x: before.x + 200, y: before.y + 300 });
    expect(Number(await month(page, 'billing', '2026-10').getAttribute('data-world-y'))).toBe(line + 300);
  });
});

test('items of no project lie in one Loose area at the lower left, with the same month lines', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    await page.getByRole('combobox', { name: 'Find in Undermap' }).fill('OPS-232'); await page.keyboard.press('Enter');
    await expect(card(page, 'loose-00')).toBeVisible();
    await expect(month(page, 'undermap:loose', '2026-10')).toHaveText(/^OCTOBER · 2\s*3 Oct$/);
    await expect(label(page, 'undermap:loose')).toContainText('Loose');
    const at = await world(page, 'loose-00');
    // The map's items end at y 442; Billing's area below starts at its place and Loose lies under everything, at the left edge.
    expect(at.y).toBeGreaterThan(442 + 480);
    expect(at.x).toBeLessThan(1000);
    // The Loose plate is not a project: its menu is the layer's.
    await label(page, 'undermap:loose').click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Open archive']);
    await page.keyboard.press('Escape');
    await card(page, 'loose-00').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Bring back to map', exact: true })).toBeEnabled();
  });
});

test('search in the Undermap bar lists matches and flies to an item in a collapsed month, opening it', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    const field = page.getByRole('combobox', { name: 'Find in Undermap' });
    await expect(field).toBeVisible(); await expect(field).not.toBeFocused();
    await page.keyboard.press('/');
    await expect(field).toBeFocused();
    await page.keyboard.type('rate limiter 4');
    const options = page.getByRole('listbox', { name: 'Items in Undermap' }).getByRole('option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('rate limiter 4'); await expect(options.first()).toContainText('Billing redesign · JUNE');
    await expect(month(page, 'billing', '2026-06')).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('Enter');
    await expect(month(page, 'billing', '2026-06')).toHaveAttribute('data-open', 'true');
    await expect(card(page, 'bil-jun-03')).toBeVisible();
    await expect(page.locator('[data-map-highlight="bil-jun-03"]')).toHaveCount(1);
    // It flew there: the card is near the middle of the window.
    await expect.poll(async () => { const box = await screen(page, 'bil-jun-03'); return Math.abs(box.x + box.width / 2 - 720) < 80 && Math.abs(box.y + box.height / 2 - 450) < 80; }).toBe(true);
    await expect(page.getByRole('listbox', { name: 'Items in Undermap' })).toHaveCount(0);
    // Project and month names match too; arrows choose, a click flies as well.
    await page.keyboard.press('/'); await page.keyboard.type('docs december');
    await expect(options).toHaveCount(8); await expect(page.locator('.undermap-search-count')).toHaveText('8 of 24');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await options.nth(2).click();
    await expect(month(page, 'docs', '2025-12')).toHaveAttribute('data-open', 'true');
    await expect(card(page, 'doc-dec-21')).toBeVisible();
    // Nothing found says so; Escape leaves the field. The key does nothing on the map.
    await page.keyboard.press('/'); await page.keyboard.type('zzz');
    await expect(page.locator('.undermap-search-empty')).toHaveText('Nothing below matches “zzz”.');
    await page.keyboard.press('Escape');
    await expect(field).not.toBeFocused(); await expect(field).toHaveValue('');
    await travel(page, 'map');
    await page.keyboard.press('/');
    await expect(page.getByRole('combobox', { name: 'Find in Undermap' })).toHaveCount(0);
  });
});

test('dragging below does nothing in Mirror; Classic shows the stored positions again and lets you drag', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    const saved = (await stored(page, 'bil-oct-39')).position, computed = await world(page, 'bil-oct-39');
    expect(computed).not.toEqual(saved);
    const box = await screen(page, 'bil-oct-39');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 120, { steps: 6 }); await page.mouse.up();
    // The card is not picked up: at most the layer pans under the pointer, as it does on empty ground.
    expect(await world(page, 'bil-oct-39')).toEqual(computed);
    await expect(card(page, 'bil-oct-39')).toHaveAttribute('data-dragging', 'false');
    expect((await stored(page, 'bil-oct-39')).position).toEqual(saved);
    // Arrow keys do not move it either, and it has no resize grip.
    await page.locator('.react-flow__node[data-id="bil-oct-39"]').focus(); await page.keyboard.press('ArrowRight');
    expect((await stored(page, 'bil-oct-39')).position).toEqual(saved);
    await expect(page.locator('.item-resize-handle')).toHaveCount(0);

    await setLayout(page, 'classic');
    await expect(page.locator('.map-area')).toHaveAttribute('data-undermap-layout', 'classic');
    await expect(page.locator('[data-undermap-month]')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Find in Undermap' })).toHaveCount(0);
    // Every item below is a card again, at the position saved when it was sent.
    await expect.poll(() => mountedCards(page)).toBe(133);
    for (const id of ['bil-oct-39', 'bil-jun-00', 'doc-dec-05', 'loose-01']) expect(await world(page, id), id).toEqual((await stored(page, id)).position);
    // Dragging works as it did: put one in view and move it.
    await apply(page, [{ type: 'node.move', id: 'bil-oct-39', position: { x: 900, y: 700 } }]);
    await expect.poll(() => world(page, 'bil-oct-39')).toEqual({ x: 900, y: 700 });
    const classic = await screen(page, 'bil-oct-39');
    await page.mouse.move(classic.x + classic.width / 2, classic.y + classic.height / 2); await page.mouse.down();
    await page.mouse.move(classic.x + classic.width / 2 + 140, classic.y + classic.height / 2 + 70, { steps: 6 }); await page.mouse.up();
    await expect.poll(async () => { const at = (await stored(page, 'bil-oct-39')).position; return Math.hypot(at.x - 1100, at.y - 800); }).toBeLessThan(4);

    await setLayout(page, 'mirror');
    await expect(page.locator('.map-area')).toHaveAttribute('data-undermap-layout', 'mirror');
    await expect.poll(() => world(page, 'bil-oct-39')).toEqual(computed);
    await expect(page.locator('[data-item-id^="bil-oct"]')).toHaveCount(28);
  });
});

test('below the dashboard zoom each area is a plate with “N below” and its months; no card is mounted', async () => {
  await withApp(monthsState(), async page => {
    await travel(page, 'below');
    const area = page.locator('.map-area');
    await page.mouse.move(700, 420);
    for (let i = 0; i < 40 && Number(await area.getAttribute('data-zoom')) > .3; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30); }
    await expect(area).toHaveAttribute('data-dashboards', 'true');
    const plate = page.locator('[data-undermap-plate="billing"]');
    await expect(plate).toContainText('Billing redesign · 79 below');
    await expect(plate.locator('li')).toHaveText(['OCTOBER40', 'SEPTEMBER30', 'JUNE9']);
    await expect(page.locator('[data-undermap-plate="docs"]')).toContainText('Docs site · 52 below');
    await expect(page.locator('[data-undermap-plate="undermap:loose"]')).toContainText('Loose · 2 below');
    await expect(page.locator('[data-undermap-month]')).toHaveCount(0);
    expect(await mountedCards(page)).toBe(0);
    await expect(page.locator('.project-dashboard')).toHaveCount(0);
  });
});

test('1,000 items below mount a bounded number of cards', async () => {
  test.setTimeout(240_000);
  const state = (await history([1000])).get(1000)!;
  await withApp(state, async page => {
    await page.waitForTimeout(500);
    const map = await dom(page), ms = await travel(page, 'below');
    await page.waitForTimeout(500);
    const arrived = await dom(page);
    console.log(`Undermap mirror, 1,001 below: travel ${ms} ms, map ${JSON.stringify(map)}, arrived ${JSON.stringify(arrived)}`);
    await expect(page.locator('.below-bar')).toContainText('Undermap · 1,001 items');
    // Four projects with at most 28 cards each, and of those only the ones near the window are mounted.
    expect(arrived.cards).toBeLessThanOrEqual(4 * 28); expect(arrived.cards).toBeGreaterThan(0);
    expect(arrived.elements).toBeLessThan(4000);
    await expect(page.locator('[data-undermap-month^="billing:"]').first()).toContainText('OCTOBER');
    // An opened old month adds only its cards near the window.
    const line = page.locator('[data-undermap-month^="billing:"][data-open="false"]').first(), count = Number(await line.getAttribute('data-count'));
    await line.getByRole('button').click();
    await page.waitForTimeout(300);
    const opened = await dom(page);
    console.log(`opened a month of ${count}: ${JSON.stringify(opened)}`);
    expect(opened.cards).toBeLessThanOrEqual(4 * 28 + count);
  }, { zoom: .7, x: 120, y: 190 });
});
