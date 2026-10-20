import { test as launched, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, capture, resize } from './visual-fixture.ts';
import { showAdvanced } from './settings-helpers.ts';
import { travel } from './undermap-fixture.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';

// The suite pins plain neighborhoods; here the setting decides.
const env = { ACT_TEST_NEIGHBORHOOD_STYLE: '' };
test.use({ launchEnv: env });

/** The baked ground of a project: its bitmap size, where it lies in the world and a hash of every pixel. */
const ground = (page: Page, id = 'billing') => page.locator(`[data-biome-ground="${id}"]`).evaluate((canvas: HTMLCanvasElement) => {
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261, opaque = 0;
  for (let index = 0; index < pixels.length; index++) { hash = Math.imul(hash ^ pixels[index], 16777619); if (index % 4 === 3 && pixels[index]) opaque++; }
  return { width: canvas.width, height: canvas.height, left: canvas.style.left, top: canvas.style.top, shown: canvas.style.width, hash: hash >>> 0, opaque };
});
const field = (page: Page, id = 'billing') => page.locator(`[data-biome-field="${id}"]`);
const plainPaths = (page: Page, id = 'billing') => page.locator(`[data-project-field="${id}"] .neighborhood-paint > path`);
const openMap = async (page: Page, advanced = false) => { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Map', exact: true }).click(); if (advanced) await showAdvanced(page); };
const save = (page: Page) => page.getByRole('button', { name: 'Save settings' }).click();
const choice = (page: Page, group: string, name: string) => page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name, exact: true });
const appearance = (page: Page, patch: Record<string, unknown>) => page.evaluate(async patch => {
  const settings = await window.craftingTable.settingsRead();
  return window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, neighborhoodAppearance: { ...settings.value.neighborhoodAppearance, ...patch } as typeof settings.value.neighborhoodAppearance } });
}, patch);
const recolor = (page: Page, color: string) => page.evaluate(async color => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [{ type: 'node.update', id: 'billing', color }] });
}, color);

test('a preset neighborhood is a biome; style and texture save, discard, reset and apply live from Settings', async ({ visual: { app, page } }) => {
  await expect(field(page)).toHaveAttribute('data-biome', 'grass');
  await expect(field(page)).toHaveAttribute('data-texture', 'quiet');
  await expect(page.locator('[data-project-field="billing"]')).toHaveAttribute('data-biome', 'grass');
  await expect(plainPaths(page)).toHaveCount(0);
  expect(await page.locator('.neighborhood-biomes').evaluate(layer => getComputedStyle(layer).opacity)).toBe('0.24');
  const quiet = await ground(page), cell = Number(await page.locator('[data-project-field="billing"]').getAttribute('data-cell-size'));
  expect(quiet.opaque).toBeGreaterThan(1000); expect(parseFloat(quiet.shown)).toBe(quiet.width / 6 * cell);
  const quietGrowth = Number(await field(page).getAttribute('data-growth'));
  expect(quietGrowth).toBeGreaterThan(0);
  const before = await page.evaluate(async () => ({ graph: (await window.craftingTable.workspaceRead()).state, view: await window.craftingTable.viewRead() }));
  await capture(page, 'map-biome-grassland-quiet.png');

  await openMap(page);
  await expect(choice(page, 'Neighborhood style', 'Biomes')).toBeChecked(); await expect(choice(page, 'Texture', 'Quiet')).toBeChecked();
  await choice(page, 'Texture', 'Full').click();
  expect((await ground(page)).hash).toBe(quiet.hash);
  await save(page);
  await expect(field(page)).toHaveAttribute('data-texture', 'full');
  const full = await ground(page);
  expect(full.hash).not.toBe(quiet.hash); expect({ ...full, hash: 0 }).toEqual({ ...quiet, hash: 0 });
  expect(Number(await field(page).getAttribute('data-growth'))).toBeGreaterThan(quietGrowth);
  await capture(page, 'map-biome-grassland-full.png');

  await openMap(page);
  await page.getByRole('slider', { name: 'Ground brightness' }).fill('60');
  await save(page);
  expect(await page.locator('.neighborhood-biomes').evaluate(layer => getComputedStyle(layer).opacity)).toBe('0.6');

  await openMap(page);
  await expect(choice(page, 'Texture', 'Full')).toBeChecked();
  await choice(page, 'Neighborhood style', 'Plain colour').click();
  for (const name of ['Quiet', 'Medium', 'Full']) await expect(choice(page, 'Texture', name)).toBeDisabled();
  await resize(app, page, 900, 640);
  await page.getByRole('group', { name: 'Neighborhoods', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'settings-neighborhood-biomes.png');
  await resize(app, page, 1280, 800);
  await expect(field(page)).toHaveCount(1);
  await save(page);
  await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
  await expect(plainPaths(page)).toHaveCount(4);
  await expect(page.locator('[data-project-field="billing"] .neighborhood-paint')).toHaveAttribute('data-color', '#91b78b');
  expect(await page.locator('[data-project-field="billing"]').getAttribute('data-biome')).toBeNull();

  await openMap(page);
  await choice(page, 'Neighborhood style', 'Biomes').click(); await expect(choice(page, 'Texture', 'Full')).toBeEnabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
  await openMap(page, true);
  await expect(choice(page, 'Neighborhood style', 'Plain colour')).toBeChecked();
  await page.getByRole('button', { name: 'Reset appearance' }).click();
  await expect(choice(page, 'Neighborhood style', 'Biomes')).toBeChecked(); await expect(choice(page, 'Texture', 'Quiet')).toBeChecked();
  await save(page);
  await expect(field(page)).toHaveAttribute('data-texture', 'quiet');
  expect(await ground(page)).toEqual(quiet);
  expect(await page.locator('.neighborhood-biomes').evaluate(layer => getComputedStyle(layer).opacity)).toBe('0.24');

  // A change from outside the window, as through MCP, applies at once; an unknown value is refused.
  await appearance(page, { texture: 'medium' });
  await expect(field(page)).toHaveAttribute('data-texture', 'medium');
  const medium = await ground(page);
  expect(medium.hash).not.toBe(quiet.hash); expect(medium.hash).not.toBe(full.hash);
  expect(await appearance(page, { style: 'fancy' }).then(() => 'saved', () => 'refused')).toBe('refused');
  expect(await appearance(page, { texture: 'loud' }).then(() => 'saved', () => 'refused')).toBe('refused');
  expect(await appearance(page, { brightness: 5 }).then(() => 'saved', () => 'refused')).toBe('refused');
  await expect(field(page)).toHaveAttribute('data-texture', 'medium');
  const after = await page.evaluate(async () => ({ graph: (await window.craftingTable.workspaceRead()).state, view: await window.craftingTable.viewRead() }));
  expect(after).toEqual(before);
});

test('the ground is baked once: pan and zoom reuse it, and the overview draws the flat colour', async ({ visual: { page } }) => {
  await expect(field(page)).toHaveAttribute('data-biome', 'grass');
  const baked = await ground(page);
  await page.evaluate(() => window.craftingPerformance.reset());
  const bare = await page.evaluate(() => {
    for (let y = 760; y > 100; y -= 20) for (let x = 1200; x > 200; x -= 20) if ([0, 60, 120].every(dx => document.elementFromPoint(x - dx, y)?.classList.contains('react-flow__pane'))) return { x, y };
    throw new Error('No bare map to pan');
  });
  await page.mouse.move(bare.x, bare.y); await page.mouse.down(); await page.mouse.move(bare.x - 120, bare.y - 40, { steps: 12 }); await page.mouse.up();
  for (const delta of [-300, -300, 300, 300]) { await page.mouse.wheel(0, delta); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
  const navigation = await page.evaluate(() => window.craftingPerformance.snapshot());
  expect(navigation.metrics['map.biome'].count).toBe(0); expect(navigation.metrics['map.geometry'].count).toBe(0);
  expect(await ground(page)).toEqual(baked);

  const zoom = page.getByRole('slider', { name: 'Map zoom' });
  await zoom.focus(); await page.keyboard.press('Home');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.2');
  await expect(page.locator('.neighborhood-biomes')).toHaveAttribute('data-flat', 'true');
  await expect(page.locator('[data-biome-ground="billing"]')).toBeHidden();
  const flat = page.locator('[data-biome-field="billing"] svg[data-biome-flat]');
  await expect(flat.locator('path')).toHaveCount(4);
  expect(await flat.evaluate(svg => getComputedStyle(svg).fill)).toBe('rgb(145, 183, 139)');
  await page.keyboard.press('End');
  await expect(page.locator('.neighborhood-biomes')).not.toHaveAttribute('data-flat', 'true');
  await expect(page.locator('[data-biome-ground="billing"]')).toBeVisible();
  await expect(flat).toHaveCount(0);
  expect(await ground(page)).toEqual(baked);
});

test('growth keeps clear of items: dragging one changes the ground only where it covers or uncovers a cell or the edge moves', async ({ visual: { page } }) => {
  await appearance(page, { texture: 'full' });
  await expect(field(page)).toHaveAttribute('data-texture', 'full');
  /** Per world cell: a hash of its 6×6 pixels and its faintest alpha, which is its shade. */
  const cells = () => page.locator('[data-biome-ground="billing"]').evaluate((canvas: HTMLCanvasElement) => {
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height), columns = canvas.width / 6, size = parseFloat(canvas.style.width) / columns;
    const x0 = Math.round(parseFloat(canvas.style.left) / size), y0 = Math.round(parseFloat(canvas.style.top) / size), found: Record<string, { hash: number; shade: number }> = {};
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const at = (y * canvas.width + x) * 4, cell = found[`${x0 + Math.floor(x / 6)},${y0 + Math.floor(y / 6)}`] ??= { hash: 7, shade: 255 };
      cell.hash = Math.imul(cell.hash ^ (data[at] << 16 | data[at + 1] << 8 | data[at + 2]), 16777619) ^ data[at + 3]; cell.shade = Math.min(cell.shade, data[at + 3]);
    }
    return { size, found };
  });
  const item = page.locator('[data-item-id="ticket"]');
  const world = () => item.evaluate(card => {
    const zoom = Number(document.querySelector('.map-area')!.getAttribute('data-zoom')), box = card.getBoundingClientRect();
    return { x: Number(card.getAttribute('data-world-x')), y: Number(card.getAttribute('data-world-y')), width: box.width / zoom, height: box.height / zoom };
  });
  const before = await cells(), from = await world(), card = (await item.boundingBox())!, grab = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
  await page.mouse.move(grab.x, grab.y); await page.mouse.down();
  await page.mouse.move(grab.x - 20, grab.y + 15, { steps: 4 }); await page.mouse.move(grab.x - 110, grab.y + 90, { steps: 8 });
  await expect.poll(async () => (await world()).x).not.toBe(from.x);
  const during = await cells(), to = await world();
  await page.mouse.up();
  expect(during.size).toBe(before.size);
  // An item's layout footprint can be larger than its card at this zoom, so allow two cells around the card.
  const reach = before.size * 2, beside = (column: number, row: number, box: typeof from) => {
    const x = column * before.size, y = row * before.size;
    return x + before.size > box.x - box.width / 2 - reach && x < box.x + box.width / 2 + reach && y + before.size > box.y - box.height / 2 - reach && y < box.y + box.height / 2 + reach;
  };
  let kept = 0, uncovered = 0;
  for (const [id, cell] of Object.entries(during.found)) {
    const old = before.found[id], [column, row] = id.split(',').map(Number);
    if (!old || old.shade !== cell.shade) continue;
    if (beside(column, row, from) || beside(column, row, to)) { if (old.hash !== cell.hash) uncovered++; continue; }
    expect(cell.hash, `cell ${id} away from the dragged item`).toBe(old.hash); kept++;
  }
  expect(kept).toBeGreaterThan(400); expect(uncovered).toBeGreaterThan(0);
});

test('Tundra and Desert are biomes; a custom colour, the Undermap and a muted project stay plain', async ({ visual: { page } }) => {
  await recolor(page, '#6fd6cf');
  await expect(field(page)).toHaveAttribute('data-biome', 'diamond');
  const tundra = await ground(page);
  await capture(page, 'map-biome-tundra-quiet.png');
  await recolor(page, '#e3c55a');
  await expect(field(page)).toHaveAttribute('data-biome', 'gold');
  expect((await ground(page)).hash).not.toBe(tundra.hash);
  await capture(page, 'map-biome-desert-quiet.png');
  await recolor(page, '#c06fb0');
  await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
  await expect(plainPaths(page)).toHaveCount(4);
  await expect(page.locator('[data-project-field="billing"] .neighborhood-paint')).toHaveAttribute('data-color', '#c06fb0');
  await capture(page, 'map-biome-custom-colour.png');
  await recolor(page, '#6FD6CF');
  await expect(field(page)).toHaveAttribute('data-biome', 'diamond');
  expect(await ground(page)).toEqual(tundra);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Send to Undermap', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toHaveCount(0);
  await travel(page, 'below');
  await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
  await expect(plainPaths(page)).toHaveCount(4);
  await expect(page.locator('[data-project-field="billing"] .neighborhood-paint')).toHaveAttribute('data-color', '#2a514f');
  await travel(page, 'map');
  await expect(field(page)).toHaveAttribute('data-biome', 'diamond');
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [{ type: 'project.mute', id: 'billing', muted: true }] });
  });
  await expect(page.locator('[data-mute-cover="billing"]')).toHaveCount(1);
  await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
  await expect(plainPaths(page)).toHaveCount(4);
});

launched('style and texture persist across a restart and bake the same ground again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-biomes-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(state => stateSchema.parse({ ...state, nodes: [
      { id: 'billing', title: 'Billing redesign', color: '#63a99c', position: { x: 300, y: 300 }, workingDirectory: '/tmp' },
      { id: 'note', resourceId: 'note-resource', projectId: 'billing', title: 'Notes', position: { x: 640, y: 320 } },
      { id: 'below', title: 'Archive', color: '#63a99c', position: { x: 1500, y: 300 }, workingDirectory: '/tmp' },
    ], resources: [{ id: 'note-resource', pluginId: 'workspace.note', schemaVersion: 1, title: 'Notes', data: { text: 'Swamp' } }] }));
    await store.writeView('desktop', { camera: { x: 140, y: 100, zoom: .7 } });
  } finally { store.close(); }
  const launch = () => electron.launch({ args: ['.', '--force-device-scale-factor=1'], env: { ...process.env, ...env, ACT_TEST_DATA_DIR: directory } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(field(page)).toHaveAttribute('data-biome', 'prismarine');
    await expect(field(page)).toHaveAttribute('data-texture', 'quiet');
    await openMap(page);
    await choice(page, 'Texture', 'Medium').click(); await save(page);
    await expect(field(page)).toHaveAttribute('data-texture', 'medium');
    const medium = await ground(page), saved = await page.evaluate(() => window.craftingTable.settingsRead());
    expect(saved.value.neighborhoodAppearance).toEqual({ pixelSize: 24, fade: 96, scatter: 0, style: 'biome', texture: 'medium', brightness: 24 });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(field(page)).toHaveAttribute('data-texture', 'medium');
    expect(await ground(page)).toEqual(medium);
    expect(await page.evaluate(() => window.craftingTable.settingsRead())).toEqual(saved);
    await openMap(page);
    await expect(choice(page, 'Texture', 'Medium')).toBeChecked();
    await choice(page, 'Neighborhood style', 'Plain colour').click(); await save(page);
    await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(plainPaths(page)).toHaveCount(4);
    await expect(page.locator('.neighborhood-biomes')).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.neighborhoodAppearance).toEqual({ pixelSize: 24, fade: 96, scatter: 0, style: 'plain', texture: 'medium', brightness: 24 });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
