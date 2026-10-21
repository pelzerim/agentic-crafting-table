import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { stateLanguageProject } from '../fixtures/state-language.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

type Options = { view?: { x: number; y: number; zoom: number }; dashboards?: boolean; reducedMotion?: boolean; settings?(value: any): any };
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
/** Optional review captures: set ACT_STATE_CAPTURES to a directory to keep PNGs of each surface. */
async function keep(page: Page, name: string) {
  const directory = process.env.ACT_STATE_CAPTURES;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
}
async function zoomTo(page: Page, zoom: number) {
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  await slider.evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, zoom);
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(zoom));
  await settle(page);
}
async function launch(run: (page: Page, app: ElectronApplication) => Promise<void>, options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-state-language-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => stateLanguageProject()); await store.writeView('desktop', { camera: options.view ?? { x: -1180, y: -330, zoom: 1 } });
    const settings = store.readSettings();
    const value = { ...settings.value, mapDashboards: { ...settings.value.mapDashboards, enabled: options.dashboards === true, belowZoom: .45 } };
    store.writeSettings({ expectedRevision: settings.revision, value: options.settings ? options.settings(value) : value });
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: options.reducedMotion === false ? 'no-preference' : 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1600, 900);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    await run(page, app);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const card = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`);
/** A card's working mark is drawn inside the card, on its bottom edge; a far-zoom icon's stripe beside it, in the same map node. */
const workingMark = (page: Page, id: string) => page.locator(`.react-flow__node:has(> [data-item-id="${id}"]) .working-mark`);
const edge = (page: Page, id: string) => card(page, id).evaluate(element => ({ color: getComputedStyle(element, '::after').backgroundColor, width: getComputedStyle(element).getPropertyValue('--card-edge-width').trim(), mask: getComputedStyle(element, '::after').webkitMaskBoxImageSource.includes('stroke-width%3D%222%22') ? 'thick' : 'thin' }));
const token = (page: Page, name: string) => page.evaluate(name => { const probe = document.createElement('i'); probe.style.color = `var(${name})`; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, name);
const NEAR = { x: -1650, y: -840, zoom: 1 };

test('cards frame and mark their tier: Asking me 2px bright, My turn 1px amber, Finished unframed, each with its shape and reason', async () => {
  await launch(async page => {
    const [asking, turn, finished] = await Promise.all(['--act-attention-asking', '--act-attention', '--act-attention-finished'].map(name => token(page, name)));
    expect(new Set([asking, turn, finished]).size).toBe(3);
    // Asking me: something is stopped until I act.
    expect(await edge(page, 'metrics')).toEqual({ color: asking, width: '2px', mask: 'thick' });
    await expect(card(page, 'metrics')).toHaveAttribute('data-tier', 'asking');
    const diamond = card(page, 'metrics').getByRole('img', { name: 'Asking me: Needs permission to run npm test' });
    await expect(diamond.locator('.tier-mark')).toHaveAttribute('data-glyph', 'asking');
    expect(await diamond.locator('.tier-mark').evaluate(element => getComputedStyle(element).color)).toBe(asking);
    // My turn: work waits on me; the reason replaces the cue labels and the cues stay as icons.
    expect(await edge(page, 'pr-64')).toEqual({ color: turn, width: '1px', mask: 'thin' });
    await expect(card(page, 'pr-64').getByRole('img', { name: 'My turn: Checks failing' }).locator('.tier-mark')).toHaveAttribute('data-glyph', 'my-turn');
    await expect(card(page, 'pr-64').locator('.card-reason')).toHaveText(/^Checks failing · \d+m$/);
    await expect(card(page, 'pr-64').locator('.card-reason')).toHaveAttribute('data-tier', 'turn');
    await expect(card(page, 'pr-64').locator('.card-reason-row [data-indicator="state"]')).toHaveAttribute('aria-label', 'Checks failing');
    await expect(card(page, 'pr-62').locator('.card-reason')).toHaveText('Ready for your review · 1d');
    // Finished: marked with a dim dot, never framed.
    const plain = await edge(page, 'pr-67');
    expect(await edge(page, 'pr-66')).toEqual(plain);
    expect([asking, turn]).not.toContain(plain.color);
    await expect(card(page, 'pr-66')).toHaveAttribute('data-tier', 'finished');
    await expect(card(page, 'pr-66').getByRole('img', { name: 'Finished: Pull request approved' }).locator('.tier-mark')).toHaveAttribute('data-glyph', 'finished');
    await expect(card(page, 'pr-66').locator('.card-reason')).toHaveText(/^Pull request approved · 30m$/);
    // No text "!" is left on the map.
    expect(await page.locator('.attention-indicator').evaluateAll(marks => marks.map(mark => mark.textContent))).toEqual(Array(await page.locator('.attention-indicator').count()).fill(''));
    await keep(page, 'map-near-tiers');
  }, { view: NEAR });
});

test('hovering a card lifts its face and never changes the width of its edge', async () => {
  await launch(async page => {
    for (const id of ['pr-67', 'pr-64', 'metrics']) {
      const before = await edge(page, id), target = card(page, id);
      await target.hover(); await settle(page);
      const hovered = await target.evaluate(element => ({ shadow: getComputedStyle(element).boxShadow, lift: getComputedStyle(element).backgroundImage }));
      expect((await edge(page, id)).width).toBe(before.width); expect((await edge(page, id)).mask).toBe(before.mask);
      expect(hovered.shadow).not.toMatch(/0px 0px 0px 2px inset/); expect(hovered.lift).toContain('linear-gradient');
      await page.mouse.move(5, 5);
    }
    // A hovered card that needs me keeps its tier colour on the edge.
    await card(page, 'metrics').hover();
    expect((await edge(page, 'metrics')).color).toBe(await token(page, '--act-attention-asking'));
  }, { view: NEAR });
});

test('working is grass on the card\'s bottom edge and a sheep that eats it; reduced motion stands it still', async () => {
  const state = (page: Page, id: string) => workingMark(page, id).locator('i').first().evaluate(element => { const style = getComputedStyle(element), tufts = getComputedStyle(element, '::before'), sheep = getComputedStyle(element, '::after');
    return { name: style.animationName, play: [...new Set(style.animationPlayState.split(', '))].join(), steps: style.getPropertyValue('--graze-steps'), timing: style.animationTimingFunction, tufts: tufts.maskImage.split('data:image/svg+xml').length - 1, sheep: sheep.maskImage.split('data:image/svg+xml').length - 1, pointer: style.pointerEvents }; });
  const grass = (page: Page, id: string) => workingMark(page, id).locator('i').first().evaluate(element => getComputedStyle(element, '::before').backgroundImage);
  await launch(async page => {
    // Working cards carry the mark; nothing else does, and no rim, underline pip or gear is left.
    await expect(page.locator('.working-mark')).toHaveCount(4);
    await expect(page.locator('.working-border,.working-pip,[data-gear]')).toHaveCount(0);
    for (const id of ['split', 'ordering', 'upload']) { await expect(workingMark(page, id)).toHaveAttribute('data-variant', 'graze'); await expect(workingMark(page, id)).toHaveAccessibleName('Working'); }
    await expect(workingMark(page, 'metrics')).toHaveCount(0); await expect(workingMark(page, 'pr-64')).toHaveCount(0);
    // The tufts and the bite that travels with the sheep are one masked layer; the sheep is another. Three stepped animations move them.
    const split = await state(page, 'split');
    expect(split).toEqual({ name: 'graze-walk, graze-face, graze-leg', play: 'running', steps: split.steps, timing: `steps(${split.steps}), steps(2), steps(2)`, tufts: 2, sheep: 1, pointer: 'none' });
    // The mark is part of the card: an 8px band on the inside of its bottom edge, clear of the stepped corners.
    const box = (await card(page, 'split').boundingBox())!, mark = (await workingMark(page, 'split').boundingBox())!;
    expect(Math.round(box.y + box.height - (mark.y + mark.height))).toBe(1); expect(Math.round(mark.height)).toBe(8);
    expect(Math.round(mark.x - box.x)).toBe(9); expect(Math.round(box.x + box.width - (mark.x + mark.width))).toBe(9);
    expect(Number(split.steps)).toBe(Math.floor((box.width - 18) / 2) - 6);
    // Working and Asking me at once: the amber frame, and grass in the card's own tone. Nothing in the mark is amber.
    const amber = await token(page, '--act-attention-asking');
    expect(await edge(page, 'ordering')).toMatchObject({ color: amber, width: '2px' });
    expect((await state(page, 'ordering')).name).toBe('graze-walk, graze-face, graze-leg');
    expect(await grass(page, 'ordering')).toBe(await grass(page, 'split')); expect(await grass(page, 'ordering')).not.toContain(amber);
    expect(await grass(page, 'split')).toContain(await card(page, 'split').evaluate(element => { const probe = document.createElement('i'); probe.style.color = 'var(--tone)'; element.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }));
    await expect(card(page, 'ordering').getByRole('img', { name: 'Asking me: Needs permission to push' })).toBeVisible();
    // It moves: two captures a few steps apart differ along the card's bottom edge.
    const clip = { x: box.x, y: box.y + box.height - 10, width: box.width, height: 10 };
    const first = await page.screenshot({ clip }); await page.waitForTimeout(600);
    expect((await page.screenshot({ clip })).equals(first)).toBe(false);
    // Behind an expanded item the map pauses.
    await card(page, 'pr-67').dblclick();
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', '');
    expect((await state(page, 'split')).play).toBe('paused');
  }, { view: NEAR, reducedMotion: false });
  await launch(async page => {
    expect((await state(page, 'split')).name).toBe('none');
    // Tufts and a standing sheep are drawn and do not move.
    const position = () => workingMark(page, 'split').locator('i').first().evaluate(element => [getComputedStyle(element, '::after').maskPosition, getComputedStyle(element, '::before').maskPosition, getComputedStyle(element).getPropertyValue('--graze-x'), element.getAnimations({ subtree: true }).length]);
    const first = await position(); await page.waitForTimeout(500);
    expect(await position()).toEqual(first); expect(first.slice(2)).toEqual(['24px', 0]);
    expect(await state(page, 'split')).toMatchObject({ tufts: 2, sheep: 1 });
    await expect(workingMark(page, 'split')).toHaveAttribute('data-variant', 'graze');
    await keep(page, 'map-near-working');
  }, { view: NEAR });
});

test('Finished is listed and marked but not counted on the rail, the Dock or the plate; Seen clears it', async () => {
  await launch(async (page, app) => {
    const rail = page.getByRole('button', { name: /^Needs me/ }), badge = () => app.evaluate(({ app }) => app.getBadgeCount());
    // 4 asking + 4 my turn are counted; 3 finished are not.
    await expect(rail).toHaveAccessibleName('Needs me: 8');
    await expect(rail).toHaveAttribute('title', 'Needs me · 4 asking · 4 my turn · 3 finished · Right-click to hold open');
    await expect(rail.locator('.needs-me-count')).toHaveText('8');
    await expect(rail.locator('.tier-mark')).toHaveAttribute('data-tier', 'asking');
    await expect.poll(badge).toBe(8);
    await expect(page.locator('[data-project-label="project"] .project-counts')).toHaveText('3 asking · 3 my turn · 3 finished · 3 working');
    await rail.click();
    const sheet = page.locator('.attention-list');
    // One list, three groups in order, the longest wait first inside each.
    await expect(sheet.locator('.attention-tier h3')).toHaveText(['Asking me · 4', 'My turn · 4', 'Finished · 3not counted']);
    await expect(sheet.getByRole('group', { name: 'Asking me' }).locator('.attention-entry strong')).toHaveText(['Cache metrics agent', 'Invoice agent', 'Rollout preview', 'Ordering fixes']);
    await expect(sheet.getByRole('group', { name: 'My turn' }).locator('.attention-entry strong')).toHaveText(['Album table migration', 'Upload ordering', 'Invoice rounding', 'Thumbnail refresh loop']);
    await expect(sheet.getByRole('group', { name: 'Finished' }).locator('.attention-entry strong')).toHaveText(['Cache metrics', 'Resizer cleanup', 'Upload fix']);
    await expect(sheet.getByRole('group', { name: 'Asking me' }).locator('.attention-reason').first()).toHaveText('Needs permission to run npm test · 4h');
    await expect(sheet.getByRole('button', { name: 'Open Cache metrics agent' })).toHaveAttribute('aria-description', 'Asking me: Needs permission to run npm test');
    await keep(page, 'needs-me-sheet-tiers');
    // Seen clears a Finished entry like any other, and the number does not move.
    await sheet.getByRole('button', { name: 'Dismiss Resizer cleanup from Needs me' }).click();
    await expect(sheet.locator('.attention-tier h3').last()).toHaveText('Finished · 2not counted');
    await expect(card(page, 'resizer').locator('.attention-indicator')).toHaveCount(0);
    await expect(rail).toHaveAccessibleName('Needs me: 8'); expect(await badge()).toBe(8);
    // Seen on a counted entry lowers the number everywhere.
    await sheet.getByRole('button', { name: 'Dismiss Rollout preview from Needs me' }).click();
    await expect(rail).toHaveAccessibleName('Needs me: 7'); await expect.poll(badge).toBe(7);
    // With only Finished left the slot stops being amber-filled and shows the dim dot, without a number.
    for (const title of ['Cache metrics agent', 'Invoice agent', 'Ordering fixes', 'Album table migration', 'Upload ordering', 'Invoice rounding', 'Thumbnail refresh loop']) await sheet.getByRole('button', { name: `Dismiss ${title} from Needs me` }).click();
    await expect(rail).toHaveAccessibleName('Needs me'); await expect(rail).toHaveClass(/needs-me-quiet/); await expect(rail).toHaveClass(/needs-me-tier-finished/);
    await expect(rail.locator('.needs-me-count')).toHaveCount(0); await expect(rail.locator('.tier-mark')).toHaveAttribute('data-tier', 'finished');
    await expect.poll(badge).toBe(0);
    await expect(page.locator('[data-project-label="project"] .project-counts')).toHaveText('2 finished · 3 working');
  });
});

test('“Also count finished work” adds Finished to the number', async () => {
  await launch(async (page, app) => {
    await expect(page.getByRole('button', { name: /^Needs me/ })).toHaveAccessibleName('Needs me: 11');
    await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount())).toBe(11);
  }, { settings: value => ({ ...value, notifications: { ...value.notifications, countFinished: true } }) });
});

test('far zoom: from 16px the tier shape sits in the corner with a ring; under 16px it replaces the icon', async () => {
  await launch(async page => {
    await zoomTo(page, .45);
    const asking = card(page, 'metrics'), size = async () => Math.round((await asking.boundingBox())!.width);
    expect(await size()).toBeGreaterThanOrEqual(16);
    await expect(asking).toHaveClass(/compact/); await expect(asking).not.toHaveAttribute('data-takeover', /.+/);
    await expect(asking.locator('.item-glyph')).toBeVisible();
    const corner = (await asking.locator('.attention-indicator').boundingBox())!, icon = (await asking.boundingBox())!;
    expect(corner.x + corner.width / 2).toBeGreaterThan(icon.x + icon.width / 2); expect(corner.y + corner.height / 2).toBeLessThan(icon.y + icon.height / 2);
    expect(await asking.evaluate(element => getComputedStyle(element).boxShadow)).toMatch(/inset/);
    // Working icons keep a still mint stripe under the icon.
    await expect(workingMark(page, 'split')).toHaveAttribute('data-icon', 'true');
    expect((await workingMark(page, 'split').boundingBox())!.y).toBeGreaterThanOrEqual(Math.floor((await card(page, 'split').boundingBox())!.y + (await card(page, 'split').boundingBox())!.height));
    await zoomTo(page, .3);
    expect(await size()).toBeLessThan(16);
    await expect(asking).toHaveAttribute('data-takeover', 'true');
    await expect(asking.locator('.item-glyph')).toBeHidden();
    await expect(asking.getByRole('img', { name: 'Asking me: Needs permission to run npm test' })).toBeVisible();
    const taken = (await asking.locator('.attention-indicator').boundingBox())!, small = (await asking.boundingBox())!;
    expect(taken.width).toBeGreaterThanOrEqual(small.width); expect(Math.abs(taken.x + taken.width / 2 - (small.x + small.width / 2))).toBeLessThan(1);
    expect(await asking.evaluate(element => getComputedStyle(element).boxShadow)).toBe('none');
    // Items that do not need me keep their icons, and working ones their stripe, now solid.
    await expect(card(page, 'pr-67').locator('.item-glyph')).toBeVisible();
    await expect(workingMark(page, 'split')).toHaveAttribute('data-solid', 'true');
  });
});

test('dashboards, plot chips and the Atlas use the tier shapes and the counted number', async () => {
  await launch(async page => {
    const board = page.locator('[data-dashboard="billing"]');
    await expect(board.locator('h4[data-section="needs"]')).toHaveText('Needs me · 2');
    await expect(board.locator('.dashboard-row[data-kind="needs"]')).toHaveCount(2);
    const row = board.locator('.dashboard-row[data-row="invoice-agent"]');
    await expect(row).toHaveAttribute('data-tier', 'asking'); await expect(row).toHaveAccessibleName('Invoice agent: Asking me: Needs an answer about rounding, 12m');
    // Marks lead the row.
    expect(await row.evaluate(element => element.firstElementChild?.getAttribute('data-glyph'))).toBe('asking');
    await expect(board.locator('.dashboard-row[data-kind="working"]').first().locator('.status-glyph').first()).toHaveAttribute('data-glyph', 'working');
    const library = page.locator('[data-dashboard="project"]');
    await expect(library.locator('[data-block] .dashboard-plot-tally').first().locator('.tier-count')).toHaveText(['2 asking', '3 my turn', '2 finished']);
    const atlas = page.locator('.map-locator.atlas');
    await expect(atlas.locator('.atlas-badge[data-tier="asking"]')).toHaveCount(1); await expect(atlas.locator('.atlas-badge[data-tier="finished"]')).toHaveCount(1);
    await expect(atlas.locator('.atlas-counts')).toHaveText('3 asking · 3 my turn · 3 finished · 3 working');
    await expect(atlas).toHaveAccessibleName(/^Map atlas: Photo library, 3 asking, 3 my turn, 3 finished, 3 working, on screen/);
  }, { dashboards: true, view: { x: -420, y: -60, zoom: .4 } });
});

test('a ticket card shows its title without the reference, which sits left of the status; icons keep the whole title', async () => {
  await launch(async page => {
    const ticket = page.getByRole('article', { name: 'APP-40 · Split the importer', exact: true });
    // The article keeps its full name; the title line drops the reference and keeps it in its tooltip.
    await expect(ticket.locator('.card-label strong')).toHaveText('Split the importer');
    await expect(ticket.locator('.card-label strong')).toHaveAttribute('title', 'APP-40 · Split the importer');
    const reference = ticket.locator('.item-indicators .card-reference'), status = ticket.locator('.item-indicators [data-indicator="state"]');
    await expect(reference).toHaveText('APP-40'); await expect(status).toHaveAttribute('aria-label', 'In progress');
    const tag = (await reference.boundingBox())!, cue = (await status.boundingBox())!, box = (await ticket.boundingBox())!;
    expect(tag.x + tag.width).toBeLessThanOrEqual(cue.x); expect(Math.abs(tag.y + tag.height / 2 - (cue.y + cue.height / 2))).toBeLessThan(3);
    expect(tag.y + tag.height / 2).toBeGreaterThan(box.y + box.height / 2); expect(tag.x - box.x).toBeLessThan(box.width / 3);
    // Never truncated, and not amber.
    expect(await reference.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await reference.evaluate(element => getComputedStyle(element).color)).not.toBe(await token(page, '--act-attention'));
    // A title without a reference is untouched; a pull request shows the number its type declares as the same tag.
    await expect(card(page, 'pr-67').locator('.card-reference')).toHaveText('#67');
    await expect(card(page, 'pr-67').locator('.card-label strong')).toHaveText('Remove old resizer');
    await keep(page, 'ticket-reference');
    // As an icon the card has no status row, so its name is the only place for the reference.
    await zoomTo(page, .45);
    await expect(ticket).toHaveClass(/compact/); await expect(ticket.locator('.card-reference')).toHaveCount(0);
    await expect(ticket).toHaveAccessibleName('APP-40 · Split the importer');
  }, { view: { x: -1500, y: -640, zoom: 1 } });
});

test('captures: the state language on the map at near, mid and far zoom', async () => {
  test.skip(!process.env.ACT_STATE_CAPTURES, 'review captures are opt-in');
  await launch(async page => {
    await keep(page, 'map-near');
    await page.locator('.react-flow__pane').click({ position: { x: 800, y: 300 } });
    await zoomTo(page, .7); await keep(page, 'map-mid');
    await zoomTo(page, .45); await keep(page, 'map-far-26px');
    await zoomTo(page, .3); await keep(page, 'map-far-14px');
    await zoomTo(page, 1);
    await page.getByRole('button', { name: /^Needs me/ }).click();
    await expect(page.locator('.attention-list')).toBeVisible(); await settle(page);
    await keep(page, 'needs-me-sheet');
  });
  await launch(async page => {
    await keep(page, 'dashboard');
    await page.keyboard.press('m'); await settle(page);
    await keep(page, 'atlas-overview');
  }, { dashboards: true, view: { x: -420, y: -60, zoom: .4 } });
});
