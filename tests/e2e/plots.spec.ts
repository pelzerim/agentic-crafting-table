import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { plotProject } from '../fixtures/plot-project.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../src/resource-plugins/pixel-glyphs.ts';
import { plotPalette, plotSwatch } from '../../src/graph/plot-palette.ts';
import type { PlotColor } from '../../src/graph/plots.ts';

type Launch = { page: Page; directory: string; requests(): Promise<{ evidence: Record<string, unknown> }[]> };
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
/** The design sample at 100%; `titles` routes the title helper to the local fixture, never a provider. */
async function launch(run: (launched: Launch) => Promise<void>, options: { view?: { x: number; y: number; zoom: number }; titles?: boolean; color?: string; prepare?(store: SqliteStore): void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plots-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), env: Record<string, string> = {};
  const log = join(directory, 'title-requests.jsonl');
  try { await store.update(() => plotProject(options.color)); await store.writeView('desktop', { camera: options.view ?? { x: 80, y: 70, zoom: .8 } }); options.prepare?.(store); } finally { store.close(); }
  if (options.titles) {
    const bin = join(directory, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-summary.mjs')).href)};\n`, { mode: 0o700 });
    Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, ACT_SUMMARY_FIXTURE_LOG: log });
  }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ...env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1440, 900);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await run({ page, directory, requests: () => readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(() => []) });
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const sign = (page: Page, name: string | RegExp) => page.locator('[data-plot-sign]').filter({ hasText: name });
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
/** A sign's slot with its patch fill and sprout color as computed. */
const paint = (page: Page, name: string) => sign(page, name).evaluate(element => {
  const id = element.getAttribute('data-plot-sign')!, patch = document.querySelector(`[data-plot-patch="${id}"] path`)!;
  return { color: element.getAttribute('data-plot-color'), fill: getComputedStyle(patch).fill, sprout: getComputedStyle(element.querySelector('.plot-sign-button>svg')!).color };
});
const PLOT_NAMES = ['Thumbnail · 4 items', 'Billing · 4 items', 'Upload · 3 items'];
/** Every plot shows its slot's color in `neighborhood`: the patch in the color, the sprout in the sign tone. */
async function expectPalette(page: Page, neighborhood: string) {
  const wrong = async () => (await Promise.all(PLOT_NAMES.map(async name => {
    const { color, fill, sprout } = await paint(page, name), swatch = plotSwatch(neighborhood, color as PlotColor);
    return fill === rgb(swatch.color) && sprout === rgb(swatch.tone) ? [] : [`${name}: ${color} ${fill} ${sprout}`];
  }))).flat();
  await expect.poll(wrong).toEqual([]);
}
const recolor = (page: Page, color: string) => page.evaluate(async color => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [{ type: 'node.update', id: 'photos', color }] });
}, color);

test('three groups become plots with a lighter patch and one signpost each; panning never recomputes them', async () => {
  await launch(async ({ page }) => {
    await expect(page.locator('[data-plot-patch]')).toHaveCount(3);
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    await expect(sign(page, 'Thumbnail · 4 items')).toBeVisible(); await expect(sign(page, 'Billing · 4 items')).toBeVisible(); await expect(sign(page, 'Upload · 3 items')).toBeVisible();
    // No sign covers a card or another sign.
    const overlaps = await page.evaluate(() => {
      const rect = (element: Element) => element.getBoundingClientRect(), hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const signs = [...document.querySelectorAll('[data-plot-sign]')].map(rect), cards = [...document.querySelectorAll('.map-card[data-item-id]')].map(rect);
      return signs.filter((a, i) => cards.some(b => hit(a, b)) || signs.some((b, j) => i !== j && hit(a, b))).length;
    });
    expect(overlaps).toBe(0);
    await settle(page); await page.mouse.move(1430, 600);
    await expect(page.locator('.map-area')).toHaveScreenshot('map-plots.png');
    await page.evaluate(() => window.craftingPerformance.reset());
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.mouse.move(1000, 600); await page.mouse.down(); await page.mouse.move(900, 560, { steps: 20 }); await page.mouse.up();
      await page.mouse.down(); await page.mouse.move(1000, 600, { steps: 20 }); await page.mouse.up();
    }
    const pan = await page.evaluate(() => window.craftingPerformance.snapshot());
    expect(pan.metrics['map.frame-interval'].count).toBeGreaterThan(10);
    expect(pan.metrics['map.plots'].count).toBe(0); expect(pan.metrics['map.card-render'].count).toBe(0);
  });
});

test('plots stay on the map while an item is open', async () => {
  await launch(async ({ page }) => {
    await page.locator('.map-card[data-item-id="billing-pr"]').click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'billing-pr');
    for (const id of await page.locator('[data-plot-patch]').evaluateAll(patches => patches.map(patch => patch.getAttribute('data-plot-patch'))))
      await expect(page.locator(`[data-plot-patch="${id}"]`)).toBeVisible();
    await expect(page.locator('[data-plot-patch]')).toHaveCount(3);
    await expect(sign(page, 'Thumbnail · 4 items')).toBeVisible();
  });
});

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()));
const positions = async (page: Page, ids: string[]) => { const { state } = await read(page); return ids.map(id => state.nodes.find(node => node.id === id)!.position); };
const billing = ['billing-agent', 'billing-pr', 'billing-rollout', 'billing-terminal'];

test('the signpost highlights, selects and moves its members together, and Escape cancels a move', async () => {
  await launch(async ({ page }) => {
    const post = sign(page, 'Billing · 4 items').getByRole('button');
    await post.hover();
    await expect(page.locator('[data-plot-patch][data-hover]')).toHaveCount(1);
    await expect(page.getByRole('tooltip')).toHaveText(/Billing · 4 items\s*4 items · 1 my turn · 1 working/);
    await expect(page.locator('.react-flow__node[data-id="billing-pr"]')).not.toHaveAttribute('data-plot-dim');
    await expect(page.locator('.react-flow__node[data-id="thumb-pr"]')).toHaveAttribute('data-plot-dim', 'true');
    await post.click();
    await expect(page.locator('[data-selected-id]')).toHaveCount(4);
    expect((await page.locator('[data-selected-id]').evaluateAll(rects => rects.map(rect => rect.getAttribute('data-selected-id')))).sort()).toEqual(billing);
    const before = await positions(page, billing), revision = (await read(page)).state.revision, box = (await post.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 50, { steps: 10 }); await page.keyboard.press('Escape'); await page.mouse.up();
    await settle(page);
    expect(await positions(page, billing)).toEqual(before); expect((await read(page)).state.revision).toBe(revision);
    await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 60, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await read(page)).state.revision).toBe(revision + 1);
    const after = await positions(page, billing), delta = { x: after[0].x - before[0].x, y: after[0].y - before[0].y };
    expect(delta.x).toBeGreaterThan(50);
    expect(after).toEqual(before.map(point => ({ x: point.x + delta.x, y: point.y + delta.y })));
    await expect(sign(page, 'Billing · 4 items')).toBeVisible();
  });
});

test('double-click renames inline; the menu selects, renames and hides', async () => {
  await launch(async ({ page }) => {
    await sign(page, 'Thumbnail · 4 items').getByRole('button').dblclick();
    const input = page.getByRole('textbox', { name: 'Plot name' });
    await expect(input).toBeFocused(); await input.fill('Q4 pricing'); await input.press('Enter');
    await expect(sign(page, 'Q4 pricing')).toHaveAttribute('data-source', 'user');
    await sign(page, 'Upload · 3 items').getByRole('button').click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Select items', 'Rename plot…', 'Name automatically', 'Move plot to', 'Send plot to Undermap', 'Hide this plot']);
    await page.getByRole('menuitem', { name: 'Select items' }).click();
    await expect(page.locator('[data-selected-id]')).toHaveCount(3);
    await sign(page, 'Upload · 3 items').getByRole('button').focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Rename plot…' }).click();
    await page.getByRole('textbox', { name: 'Plot name' }).press('Escape');
    await expect(sign(page, 'Upload · 3 items')).toBeVisible();
    await sign(page, 'Upload · 3 items').getByRole('button').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide this plot' }).click();
    await expect(page.locator('[data-plot-sign]')).toHaveCount(2); await expect(page.locator('[data-plot-patch]')).toHaveCount(2);
  });
});

test(`the sign's menu moves a whole plot to another project or to none, and sends one to Undermap`, async () => {
  await launch(async ({ page }) => {
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [{ type: 'project.create', id: 'video', title: 'Video', summary: '', position: { x: 640, y: 2600 } },
        ...[0, 1, 2, 3, 4].map(i => ({ type: 'item.add' as const, id: `spare-${i}`, resourceId: `spare-${i}-r`, pluginId: 'workspace.note', title: `Spare ${i}`, data: { text: `Spare ${i}` }, projectId: 'photos', position: { x: -400 + i * 400, y: 1300 } }))] });
    });
    const projects = (ids: string[]) => page.evaluate(async ids => { const { state } = await window.craftingTable.workspaceRead(); return ids.map(id => { const node = state.nodes.find(node => node.id === id)!; return node.belowAt ? 'below' : node.projectId ?? 'none'; }); }, ids);
    const choose = async (plot: string, ...path: string[]) => {
      await sign(page, plot).getByRole('button').focus(); await page.keyboard.press('Shift+F10');
      for (const name of path) await page.getByRole('menuitem', { name, exact: true }).click();
    };
    await sign(page, 'Upload · 3 items').getByRole('button').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move plot to', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Photos', exact: true })).toBeDisabled();
    await page.getByRole('menuitemradio', { name: 'Video', exact: true }).click();
    await expect.poll(() => projects(['upload-terminal', 'upload-ticket', 'upload-note'])).toEqual(['video', 'video', 'video']);
    await choose('Billing · 4 items', 'Move plot to', 'No project');
    await expect.poll(() => projects(['billing-pr', 'billing-agent', 'billing-rollout', 'billing-terminal'])).toEqual(['none', 'none', 'none', 'none']);
    await choose('Thumbnail · 4 items', 'Send plot to Undermap');
    await expect.poll(() => projects(['thumb-agent', 'thumb-pr', 'thumb-ticket', 'thumb-note'])).toEqual(['below', 'below', 'below', 'below']);
    await expect(projects(['changelog', 'ideas'])).resolves.toEqual(['photos', 'photos']);
  });
});

test('plots get distinct patch and sprout colors; a swatch in the sign menu recolors one across a reload and Automatic hands it back', async () => {
  await launch(async ({ page }) => {
    const [thumbs, billing, uploads] = [await paint(page, 'Thumbnail · 4 items'), await paint(page, 'Billing · 4 items'), await paint(page, 'Upload · 3 items')];
    expect(new Set([thumbs.color, billing.color, uploads.color]).size).toBe(3);
    expect(new Set([thumbs.fill, billing.fill, uploads.fill]).size).toBe(3); expect(new Set([thumbs.sprout, billing.sprout, uploads.sprout]).size).toBe(3);
    await expectPalette(page, '#91b78b');
    const names = Object.fromEntries(plotPalette('#91b78b').map(swatch => [swatch.slot, swatch.name]));
    await sign(page, 'Billing · 4 items').getByRole('button').click({ button: 'right' });
    const swatches = page.getByRole('radiogroup', { name: 'Color' }).getByRole('radio');
    await expect(swatches).toHaveCount(6);
    await expect(page.getByRole('radio', { checked: true })).toHaveAccessibleName(names[billing.color!]);
    await expect(page.getByRole('menuitemradio', { name: `Automatic · ${names[billing.color!]}` })).toHaveAttribute('aria-checked', 'true');
    // Arrow keys walk the row; Enter picks.
    await page.getByRole('menuitem', { name: 'Name automatically' }).focus(); await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: names[billing.color!] })).toBeFocused();
    const target = Object.keys(names).find(color => color !== billing.color && color !== thumbs.color && color !== uploads.color)!;
    const order = Object.keys(names), steps = (order.indexOf(target) - order.indexOf(billing.color!) + 6) % 6;
    for (let step = 0; step < steps; step++) await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: names[target] })).toBeFocused();
    await expect(page.getByRole('radio', { name: names[target] })).toHaveAttribute('title', names[target]);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(sign(page, 'Billing · 4 items')).toHaveAttribute('data-plot-color', target);
    expect((await paint(page, 'Billing · 4 items')).fill).toBe(rgb(plotSwatch('#91b78b', target as PlotColor).color));
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(sign(page, 'Billing · 4 items')).toHaveAttribute('data-plot-color', target);
    await sign(page, 'Billing · 4 items').getByRole('button').click({ button: 'right' });
    await expect(page.getByRole('radio', { checked: true })).toHaveAccessibleName(names[target]);
    await page.getByRole('menuitemradio', { name: `Automatic · ${names[billing.color!]}` }).click();
    await expect(sign(page, 'Billing · 4 items')).toHaveAttribute('data-plot-color', billing.color!);
    expect(await paint(page, 'Billing · 4 items')).toEqual(billing);
  });
});

test(`plots take their neighborhood's palette: Desert colors and names, repainted when the project's color changes`, async () => {
  await launch(async ({ page }) => {
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    await expectPalette(page, '#e3c55a');
    const slots = await Promise.all(PLOT_NAMES.map(async name => (await paint(page, name)).color));
    expect(slots.map(slot => plotSwatch('#e3c55a', slot as PlotColor).name).sort()).toEqual(['Cactus', 'Dune', 'Terracotta']);
    const menu = async (expected: string[], automatic: string) => {
      await sign(page, 'Billing · 4 items').getByRole('button').click({ button: 'right' });
      expect(await page.getByRole('radiogroup', { name: 'Color' }).getByRole('radio').evaluateAll(list => list.map(radio => [radio.getAttribute('aria-label'), radio.getAttribute('title')]))).toEqual(expected.map(name => [name, name]));
      await expect(page.getByRole('menuitemradio', { name: `Automatic · ${automatic}` })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
    };
    const billing = (await paint(page, 'Billing · 4 items')).color as PlotColor;
    await menu(['Dune', 'Cactus', 'Terracotta', 'Turquoise', 'Dusk', 'Driftwood'], plotSwatch('#e3c55a', billing).name);
    await recolor(page, '#5b7fd6');
    await expectPalette(page, '#5b7fd6');
    expect(await Promise.all(PLOT_NAMES.map(async name => (await paint(page, name)).color))).toEqual(slots);
    await menu(['Foam', 'Lagoon', 'Coral', 'Kelp', 'Sandbar', 'Abyss'], plotSwatch('#5b7fd6', billing).name);
    await recolor(page, '#3366cc');
    await expectPalette(page, '#3366cc');
    await menu(['Sky', 'Blue', 'Teal', 'Violet', 'Green', 'Magenta'], plotSwatch('#3366cc', billing).name);
  }, { color: '#e3c55a' });
});

test('a seen plot gets a short AI name from titles only after it settles; Name automatically may keep the local name', async () => {
  test.setTimeout(120_000);
  await launch(async ({ page, requests }) => {
    const plots = async () => (await requests()).filter(entry => Array.isArray(entry.evidence.items));
    await expect(sign(page, 'Billing · 4 items')).toBeVisible();
    await expect(sign(page, 'Billing plan switch')).toHaveAttribute('data-source', 'generated', { timeout: 60_000 });
    const sent = await plots();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const entry of sent) {
      expect(entry.evidence.project).toBe('Photos');
      for (const item of entry.evidence.items as { type: string; title: string; summary?: string }[]) {
        expect(Object.keys(item).every(key => ['type', 'title', 'summary'].includes(key))).toBe(true);
        if (item.summary) expect(item.type).toBe('Agent session');
      }
    }
    const thumbs = sign(page, /^Thumbnail/);
    await expect(thumbs).toHaveAttribute('data-source', 'local');
    const before = (await plots()).length;
    await thumbs.getByRole('button').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Name automatically' }).click();
    await expect.poll(async () => (await plots()).length, { timeout: 15_000 }).toBe(before + 1);
    await expect(thumbs).toHaveAttribute('data-source', 'local');
  }, { titles: true, prepare: store => { const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, requestsPerHour: 60 } } }); } });
});

test('below the dashboard threshold three plots split the dashboard into plot blocks with their own rows, PR lines when on, then Loose', async () => {
  await launch(async ({ page }) => {
    await expect(page.locator('.map-area')).toHaveAttribute('data-dashboards', 'true');
    await expect(page.locator('[data-plot-sign]')).toHaveCount(0); await expect(page.locator('[data-plot-patch]')).toHaveCount(0);
    const board = page.locator('[data-dashboard="photos"]');
    await expect(board).toHaveAttribute('data-split', 'plots');
    await expect(board.locator('[data-section="plots"], [data-section="needs"], [data-section="working"], [data-section="pipeline"]')).toHaveCount(0);
    const blocks = board.locator('.dashboard-block'), headers = board.locator('.dashboard-row[data-kind="plot"]');
    await expect(blocks).toHaveCount(4);
    await expect(headers).toHaveText([/Billing · 4 items\s*1 my turn\s*1\s*4/, /Thumbnail · 4 items\s*1\s*4/, /Upload · 3 items\s*3/]);
    // Working counts are the spark glyph and a number; "+" keeps meaning more.
    await expect(headers.locator('.dashboard-plot-working')).toHaveText(['1', '1']);
    await expect(headers.locator('.dashboard-plot-working .status-glyph[data-glyph="working"]')).toHaveCount(2);
    await expect(headers.locator('.dashboard-plot-working .status-glyph path').first()).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
    await expect(headers.first()).toHaveAccessibleName('Billing · 4 items: 4 items, 1 my turn, 1 working');
    await expect(blocks.last()).toHaveAttribute('data-block', 'loose');
    await expect(blocks.last().locator('.dashboard-block-label')).toHaveText(/Loose\s*2/);
    const [billing, thumbs, uploads] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];
    await expect(billing.locator('.dashboard-row[data-kind="needs"]')).toHaveText([/Plan switcher\s*Ready for your review/]);
    await expect(billing.locator('.dashboard-row[data-kind="working"]')).toHaveText([/Billing proration\s*Writing invoice tests/]);
    await expect(thumbs.locator('.dashboard-row[data-kind="working"]')).toHaveText([/Fix thumbnail refresh loop\s*Patching retry delay/]);
    const hues = await blocks.evaluateAll(list => list.map(block => [block.getAttribute('data-plot-color'), getComputedStyle(block.querySelector('.dashboard-plot-glyph') ?? block).color]));
    expect(new Set(hues.slice(0, 3).map(([color]) => color)).size).toBe(3); expect(new Set(hues.slice(0, 3).map(([, glyph]) => glyph)).size).toBe(3);
    expect(hues[3][0]).toBeNull();
    // PR lines are off by default; blocks still split by plot.
    await expect(board.locator('.dashboard-block-pipeline')).toHaveCount(0);
    await page.mouse.move(5, 450); await settle(page);
    await expect(board).toHaveScreenshot('map-dashboard-plots.png');
    await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, sections: { ...saved.value.mapDashboards.sections, pipelines: true } } } }); });
    await expect(billing.locator('.dashboard-block-pipeline [data-cell="billing-pr"]')).toHaveCount(1);
    await expect(thumbs.locator('.dashboard-block-pipeline [data-cell="thumb-pr"]')).toHaveCount(1);
    await expect(thumbs.locator('.dashboard-block-pipeline [data-cell="billing-pr"]')).toHaveCount(0);
    await expect(uploads.locator('.dashboard-block-pipeline')).toHaveCount(0);
    await expect(blocks.last().locator('.dashboard-block-pipeline')).toHaveCount(0);
    await expect(blocks).toHaveCount(4);
    // Arrow keys walk headers and rows in visual order.
    await headers.first().focus(); await page.keyboard.press('ArrowDown');
    await expect(billing.locator('.dashboard-row[data-kind="needs"]')).toBeFocused();
    await page.keyboard.press('Escape');
    const before = (await read(page)).state;
    const box = (await headers.nth(1).boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 50, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await read(page)).state.revision).toBe(before.revision + 1);
    const moved = (await read(page)).state.nodes.find(node => node.id === 'billing-pr')!.position;
    expect(moved.x).toBeGreaterThan(before.nodes.find(node => node.id === 'billing-pr')!.position.x);
    await expect(headers).toHaveCount(3);
    await headers.first().click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.8');
    await expect(page.locator('[data-selected-id]')).toHaveCount(4);
    await expect(sign(page, 'Billing · 4 items')).toBeInViewport();
  }, { view: { x: 300, y: 200, zoom: .3 } });
});

test('a compact plot dashboard counts each chip with the amber ! or the working spark and a number, never a typed sign', async () => {
  await launch(async ({ page }) => {
    const board = page.locator('[data-dashboard="photos"]');
    await expect(board).toHaveAttribute('data-mode', 'compact');
    const chips = board.locator('.dashboard-chip');
    await expect(chips).toHaveText(['Billing1', 'Thumbnail1', 'Upload']);
    await expect(chips.nth(0).locator('b[data-tone="needs"] .tier-mark[data-glyph="my-turn"] path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8]['my-turn']));
    await expect(chips.nth(0)).toHaveAccessibleName('Billing · 4 items: 4 items, 1 my turn, 1 working');
    await expect(chips.nth(1).locator('b[data-tone="working"] .status-glyph[data-glyph="working"] path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
    await expect(chips.locator('b :is(.status-glyph, .tier-mark)')).toHaveCount(2);
  }, { view: { x: -140, y: 200, zoom: .3 } });
});

test('a rename keeps the block order; hiding plots down to one returns today’s dashboard and showing one splits it again', async () => {
  await launch(async ({ page }) => {
    const board = page.locator('[data-dashboard="photos"]'), headers = board.locator('.dashboard-row[data-kind="plot"]');
    await expect(headers).toHaveCount(3);
    const ids = await headers.evaluateAll(rows => rows.map(row => row.getAttribute('data-row')!));
    const plot = (request: { operation: string; plotId: string; name?: string; hidden?: boolean }) => page.evaluate(request => window.craftingTable.runtimeRun({ action: 'plot', nodeId: 'photos', arguments: request }), request);
    await plot({ operation: 'rename', plotId: ids[2], name: 'Aardvark' });
    await expect(headers).toHaveText([/^Billing/, /^Thumbnail/, /^Aardvark/]);
    await plot({ operation: 'hide', plotId: ids[1], hidden: true });
    await expect(headers).toHaveText([/^Billing/, /^Aardvark/]);
    await expect(board.locator('.dashboard-block').last()).toHaveAttribute('data-block', 'loose');
    await expect(board.locator('.dashboard-block[data-block="loose"] .dashboard-row[data-kind="working"]')).toHaveText([/Fix thumbnail refresh loop/], { timeout: 5000 });
    await plot({ operation: 'hide', plotId: ids[2], hidden: true });
    await expect(board).not.toHaveAttribute('data-split');
    await expect(board.locator('.dashboard-block')).toHaveCount(0);
    await expect(board.locator('[data-section="plots"]')).toHaveText('Plots · 1');
    await expect(board.locator('[data-section="needs"]')).toHaveText('Needs me · 1');
    await plot({ operation: 'hide', plotId: ids[1], hidden: false });
    await expect(board).toHaveAttribute('data-split', 'plots');
    await expect(board.locator(`.dashboard-block[data-block="${ids[1]}"]`)).toHaveAttribute('data-new', 'true');
  }, { view: { x: 300, y: 200, zoom: .3 } });
});

test('linked items join a plot from afar with a patch per part; a link between plots never joins them', async () => {
  await launch(async ({ page }) => {
    const apply = (commands: unknown[]) => page.evaluate(async commands => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: commands as never });
    }, commands);
    const board = page.locator('[data-dashboard="photos"]'), rows = board.locator('.dashboard-row[data-kind="plot"]');
    await expect(rows).toHaveText([/Billing · 4 items/, /Thumbnail · 4 items\s*1\s*4/, /Upload · 3 items/]);
    await apply([
      { type: 'link.save', link: { id: 'linked-changelog', sourceId: 'changelog', targetId: 'thumb-note', kind: 'reference', label: '' } },
      { type: 'link.save', link: { id: 'linked-ideas', sourceId: 'ideas', targetId: 'changelog', kind: 'reference', label: '' } },
    ]);
    await expect(rows).toHaveText([/Billing · 4 items/, /Thumbnail · 6 items\s*1\s*6/, /Upload · 3 items/]);
    await rows.nth(1).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.8');
    await expect(page.locator('[data-selected-id]')).toHaveCount(6);
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    const thumbs = sign(page, 'Thumbnail · 6 items'), patch = page.locator(`[data-plot-patch="${await thumbs.getAttribute('data-plot-sign')}"]`);
    await expect(patch).toHaveAttribute('data-parts', '3');
    await expect(thumbs).toBeInViewport();
    await thumbs.getByRole('button').hover();
    for (const id of ['changelog', 'ideas', 'thumb-note']) await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).not.toHaveAttribute('data-plot-dim');
    await expect(page.locator('.react-flow__node[data-id="upload-ticket"]')).toHaveAttribute('data-plot-dim', 'true');
    await page.mouse.move(5, 450);
    await apply([{ type: 'link.remove', id: 'linked-changelog' }]);
    await expect(sign(page, 'Thumbnail · 4 items')).toBeVisible();
    await expect(patch).toHaveAttribute('data-parts', '1');
    // The two notes still linked to each other are a plot of their own.
    await expect(page.locator('[data-plot-sign]')).toHaveCount(4);
    const pair = sign(page, '2 items');
    await expect(page.locator(`[data-plot-patch="${await pair.getAttribute('data-plot-sign')}"]`)).toHaveAttribute('data-parts', '2');
    // A link added between two plots that exist joins nothing.
    await apply([{ type: 'link.save', link: { id: 'across', sourceId: 'billing-pr', targetId: 'thumb-note', kind: 'reference', label: '' } }, { type: 'link.save', link: { id: 'across-pair', sourceId: 'ideas', targetId: 'billing-terminal', kind: 'reference', label: '' } }]);
    await apply([{ type: 'link.save', link: { id: 'linked-changelog', sourceId: 'changelog', targetId: 'thumb-note', kind: 'reference', label: '' } }]);
    await apply([{ type: 'link.remove', id: 'across' }]);
    await expect(page.locator('[data-plot-sign]')).toHaveCount(4);
    for (const name of ['Billing · 4 items', 'Thumbnail · 4 items', 'Upload · 3 items', '2 items']) await expect(sign(page, name)).toBeVisible();
    await apply([{ type: 'link.remove', id: 'linked-ideas' }]);
    await expect(sign(page, 'Thumbnail · 5 items')).toBeVisible();
    await expect(sign(page, 'Billing · 5 items')).toBeVisible();
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
  }, { view: { x: 300, y: 200, zoom: .3 } });
});

test('a linked member a little apart shares the patch, so the plot has no dark gap inside it', async () => {
  await launch(async ({ page }) => {
    const apply = (commands: unknown[]) => page.evaluate(async commands => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: commands as never });
    }, commands);
    // The loose note sits 186 px below the thumbnail ticket: too far to cluster, near enough to paint as one field.
    await apply([{ type: 'node.move', id: 'changelog', position: { x: 100, y: 600 } }, { type: 'link.save', link: { id: 'near', sourceId: 'thumb-ticket', targetId: 'changelog', kind: 'reference', label: '' } }]);
    const thumbs = sign(page, 'Thumbnail · 5 items'), patch = page.locator(`[data-plot-patch="${await thumbs.getAttribute('data-plot-sign')}"]`);
    await expect(patch).toHaveAttribute('data-parts', '1');
    await page.mouse.move(1430, 300); await settle(page);
    await expect(page.locator('.map-area')).toHaveScreenshot('map-plots-bridged.png');
  }, { view: { x: 120, y: -140, zoom: .8 } });
});

test('two linked items far apart are a plot: a patch around each and the sign on one of them', async () => {
  await launch(async ({ page }) => {
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'link.save', link: { id: 'pair', sourceId: 'ideas', targetId: 'changelog', kind: 'reference', label: '' } }] });
    });
    const pair = sign(page, '2 items'), patch = page.locator(`[data-plot-patch="${await pair.getAttribute('data-plot-sign')}"]`);
    await expect(patch).toHaveAttribute('data-parts', '2');
    await expect(pair).toBeInViewport();
    await pair.getByRole('button').click();
    expect((await page.locator('[data-selected-id]').evaluateAll(rects => rects.map(rect => rect.getAttribute('data-selected-id')))).sort()).toEqual(['changelog', 'ideas']);
    await page.keyboard.press('Escape'); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(1430, 300); await settle(page);
    await expect(page.locator('.map-area')).toHaveScreenshot('map-plots-linked-pair.png');
  }, { view: { x: 120, y: -140, zoom: .8 } });
});

test('Settings → Map shows or hides plots, Name plots is on by default, and a project menu turns its plots off and brings hidden ones back', async () => {
  await launch(async ({ page }) => {
    const settings = async (page_: string, change: () => Promise<void>) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('treeitem', { name: page_, exact: true }).click();
      await change();
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    };
    await settings('AI features', async () => { await expect(page.getByRole('switch', { name: 'Name plots' })).toBeChecked(); await page.getByRole('switch', { name: 'Name plots' }).uncheck(); });
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.summaries.plotNames).toBe(false);
    await sign(page, /^Upload/).getByRole('button').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Name automatically' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await settings('Map', async () => { await expect(page.getByRole('switch', { name: 'Show plots' })).toBeChecked(); await page.getByRole('switch', { name: 'Show plots' }).uncheck(); });
    await expect(page.locator('[data-plot-sign]')).toHaveCount(0); await expect(page.locator('[data-plot-patch]')).toHaveCount(0);
    await settings('Map', async () => { await page.getByRole('switch', { name: 'Show plots' }).check(); });
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    const projectMenu = async () => { await page.getByRole('button', { name: 'Project options: Photos' }).click(); };
    await projectMenu();
    await expect(page.getByRole('menuitemradio', { name: 'Show plots' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: 'Show plots' }).click();
    await expect(page.locator('[data-plot-sign]')).toHaveCount(0);
    await projectMenu();
    await expect(page.getByRole('menuitemradio', { name: 'Show plots' })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('menuitemradio', { name: 'Show plots' }).click();
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
    await sign(page, /^Upload/).getByRole('button').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide this plot' }).click();
    await expect(page.locator('[data-plot-sign]')).toHaveCount(2);
    await projectMenu();
    await page.getByRole('menuitem', { name: 'Show hidden plots (1)' }).click();
    await expect(page.locator('[data-plot-sign]')).toHaveCount(3);
  });
});
