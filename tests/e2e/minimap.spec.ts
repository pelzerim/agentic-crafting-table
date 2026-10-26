import { expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test, resize, scrollbarArgs, chooseMapCorner } from './visual-fixture.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../src/resource-plugins/pixel-glyphs.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'minimap-fixture' }, commands }); }, JSON.stringify(commands));
}
const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function centreOf(page: Page, selector: string) { const box = (await page.locator(selector).boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }

const COLORS = ['#91b78b', '#5b7fd6', '#e3c55a', '#d0564c', '#6fd6cf', '#b8945f', '#a884d8', '#63a99c', '#9a9a9a', '#9a4e4e'];
const NAMES = ['Billing redesign', 'Payments API', 'Checkout web', 'Build infra', 'Mobile app', 'Data pipeline', 'Docs site', 'Search'];
const PLACES = [{ x: 0, y: 0 }, { x: 1500, y: -60 }, { x: 1100, y: 1000 }, { x: -1500, y: 560 }, { x: 2900, y: 600 }, { x: 350, y: 1900 }, { x: -900, y: -1000 }, { x: 2900, y: -1000 }];
/** Deterministic multi-project workspace: working agents and unread Needs me spread across projects. */
function workspace(projectCount: number, perProject: number, grid?: number) {
  const nodes: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [];
  for (let p = 0; p < projectCount; p++) {
    const id = `project-${p}`, origin = grid ? { x: (p % grid) * 1900, y: Math.floor(p / grid) * 1400 } : PLACES[p];
    nodes.push({ id, title: grid ? `Project ${p + 1}` : NAMES[p], color: COLORS[p % COLORS.length], position: origin });
    for (let i = 0; i < perProject; i++) {
      const item = `item-${p}-${i}`, working = (i + p) % 5 === 1, needs = grid ? i === 0 || i === perProject - 1 : (i + p * 2) % 7 === 0;
      resources.push({ id: `${item}-r`, schemaVersion: 1, title: `Work ${p}.${i}`, ...(working || needs ? { pluginId: 'agent.session', data: { sessionId: `static-${item}`, provider: 'claude' } } : { pluginId: 'linear.ticket', data: { issueId: `MAP-${p}${i}` } }) });
      nodes.push({ id: item, resourceId: `${item}-r`, projectId: id, title: `Work ${p}.${i}`, position: grid ? { x: origin.x + (i % 4) * 280 - 420, y: origin.y + Math.floor(i / 4) * 150 - 225 } : { x: origin.x + (i % 3) * 330 - 330, y: origin.y + Math.floor(i / 3) * 170 - 85 },
        activity: working ? 'working' : 'idle', attention: needs ? 'input' : 'none' });
    }
  }
  return stateSchema.parse({ version: 1, revision: 0, nodes, resources, links: [], todos: [], view: {} });
}
async function launch(state: ReturnType<typeof workspace>, view: { x: number; y: number; zoom: number }, run: (page: Page) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-minimap-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(() => state); await store.writeView('desktop', { camera: view }); chooseMapCorner(store, 'atlas'); } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1280, 800);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await run(page);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('the Atlas shows project blobs, working sparks and Needs me badges that follow item state', async ({ visual: { page } }) => {
  const atlas = page.getByRole('group', { name: /^Map atlas: Billing redesign/ });
  await expect(atlas).toBeVisible();
  expect(await atlas.boundingBox()).toMatchObject({ width: 220, height: 150 });
  await expect(page.locator('.atlas [data-atlas-project="billing"] path').first()).toHaveAttribute('d', /^M/);
  await expect(page.locator('.atlas [data-locator-id]')).toHaveCount(2);
  await expect(page.locator('.atlas [data-locator-id="agent"]')).toBeVisible(); await expect(page.locator('.atlas [data-locator-id="pr"]')).toBeVisible();
  await expect(page.locator('.atlas .atlas-working')).toHaveAttribute('d', '');
  await expect(page.locator('.atlas .atlas-idle')).toHaveAttribute('d', /^(M[^M]+){2}$/);
  await expect(atlas.locator('.atlas-footer')).toHaveText('Billing redesign1 asking · 1 my turn · 1 working');
  await apply(page, [{ type: 'node.update', id: 'ticket', activity: 'working' }, { type: 'node.update', id: 'brief', attention: 'error' }]);
  await expect(page.locator('.atlas [data-locator-id]')).toHaveCount(3);
  // One 6×6 tilted spark per working item, not a plus.
  await expect(page.locator('.atlas .atlas-working')).toHaveAttribute('d', /^M-?\d+,-?\d+h1v2h1v1h1v1h-2v1h-1v1h-1v-2h-1v-1h-1v-1h2v-1h1z$/);
  await expect(atlas.locator('.atlas-footer .tier-count[data-kind=working] path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
  await expect(page.locator('.atlas .atlas-idle')).toHaveAttribute('d', '');
  await expect(atlas.locator('.atlas-footer')).toHaveText('Billing redesign2 asking · 1 my turn · 2 working');
  await expect(page.getByRole('button', { name: 'Needs me: 3', exact: true })).toBeVisible();
  // Hovering a badge explains it without moving anything.
  await page.locator('.atlas [data-locator-id="agent"]').hover();
  await expect(page.getByRole('tooltip')).toContainText('Claude · implementation'); await expect(page.getByRole('tooltip')).toContainText('Waiting for your input');
});

test('clicking a badge centres its item without opening it or marking it seen', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1.2');
  await page.mouse.move(640, 200); await page.mouse.down(); await page.mouse.move(1100, 700, { steps: 8 }); await page.mouse.up();
  const before = await read(page);
  await page.locator('.atlas [data-locator-id="pr"]').click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1');
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  const item = await centreOf(page, '[data-item-id="pr"]'), canvas = (await page.locator('.map-area').boundingBox())!;
  expect(item.x).toBeCloseTo(canvas.x + canvas.width / 2, 0); expect(item.y).toBeCloseTo(canvas.y + canvas.height / 2, 0);
  const after = await read(page);
  expect(after.nodes.find(node => node.id === 'pr')!.attentionSeenVersion).toBe(before.nodes.find(node => node.id === 'pr')!.attentionSeenVersion);
  expect(after.revision).toBe(before.revision);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
});

test('clicking a blob fits its project, dragging the frame pans and empty space centres', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'project.create', id: 'far', title: 'Far project', summary: '', position: { x: 4200, y: 1800 } },
    { type: 'item.create', id: 'far-item', projectId: 'far', resource: { id: 'far-r', pluginId: 'linear.ticket', schemaVersion: 1, title: 'Far ticket', data: { issueId: 'FAR-1' } }, position: { x: 4300, y: 1900 } }]);
  await expect(page.locator('.atlas [data-atlas-project="far"]')).toHaveCount(1);
  const blob = (await page.locator('.atlas [data-atlas-project="far"]').boundingBox())!;
  await page.mouse.click(blob.x + blob.width / 2, blob.y + blob.height / 2);
  await expect.poll(async () => { const box = await page.locator('[data-item-id="far-item"]').boundingBox(); return Boolean(box && box.x > 0 && box.x + box.width < 1280 && box.y > 0 && box.y + box.height < 800); }).toBe(true);
  await expect(page.locator('[data-project-label="far"]')).toBeVisible();
  await expect(page.getByRole('group', { name: /^Map atlas: Far project, nothing needs me, 0 working, on screen/ })).toBeVisible();
  // Drag the camera frame: the world moves opposite to the frame by the Atlas scale.
  const start = await camera(page), frame = (await page.locator('.atlas [data-atlas-frame]').boundingBox())!;
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2); await page.mouse.down();
  await page.mouse.move(frame.x + frame.width / 2 - 30, frame.y + frame.height / 2 - 10, { steps: 6 }); await page.mouse.up();
  const panned = await camera(page);
  expect(panned.zoom).toBeCloseTo(start.zoom, 5); expect(panned.x).toBeGreaterThan(start.x + 100); expect(panned.y).toBeGreaterThan(start.y + 30);
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead())).camera?.x).toBeCloseTo(panned.x, 0);
  // Empty Atlas space centres the camera there without changing zoom.
  const map = (await page.locator('.atlas .atlas-map').boundingBox())!;
  await page.mouse.click(map.x + map.width - 4, map.y + 4);
  await settle(page);
  const centred = await camera(page);
  expect(centred.zoom).toBeCloseTo(start.zoom, 5); expect(centred.x).not.toBeCloseTo(panned.x, 0);
});

test('the Atlas is keyboard accessible: arrows choose a project, Enter flies, N visits Needs me', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'project.create', id: 'east', title: 'East project', summary: '', position: { x: 3600, y: 300 } },
    { type: 'item.create', id: 'east-item', projectId: 'east', resource: { id: 'east-r', pluginId: 'linear.ticket', schemaVersion: 1, title: 'East ticket', data: { issueId: 'EAST-1' } }, position: { x: 3700, y: 350 } }]);
  const atlas = page.locator('.map-locator.atlas');
  await atlas.focus();
  await page.keyboard.press('ArrowRight');
  await expect(atlas.locator('.atlas-live')).toHaveText(/^East project, nothing needs me, 0 working, off-screen right$/);
  await expect(atlas.locator('.atlas-cursor')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('group', { name: /^Map atlas: East project/ })).toBeVisible();
  await page.keyboard.press('n');
  await expect(atlas.locator('.atlas-live')).toHaveText('Claude · implementation: Waiting for your input');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1');
  const item = await centreOf(page, '[data-item-id="agent"]');
  expect(item.x).toBeCloseTo(640, 0); expect(item.y).toBeCloseTo(400, 0);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
});

test('M opens the overview, a project row flies there, the layer switch travels and Esc closes', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.below', id: 'brief' }]);
  await page.mouse.click(640, 700);
  await page.keyboard.press('m');
  const overview = page.getByRole('region', { name: 'Map overview' });
  await expect(overview).toBeVisible(); await expect(page.locator('.map-locator.atlas')).toBeHidden();
  await expect(overview).toContainText('Click to fly · drag frame · ←→ projects · M / Esc');
  await expect(overview.locator('[data-atlas-label="billing"]')).toHaveText('Billing redesign');
  await expect(overview.getByRole('button', { name: 'Undermap · 1' })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('m'); await expect(overview).toHaveCount(0);
  await page.getByRole('button', { name: 'Open map overview (M)' }).click();
  await expect(overview).toBeVisible();
  await overview.getByRole('button', { name: 'Billing redesign: 1 working, 1 asking, 1 my turn' }).click();
  await expect(overview).toHaveCount(0);
  await expect.poll(async () => { const label = await page.locator('[data-project-label="billing"]').boundingBox(); return Boolean(label && label.y > 0); }).toBe(true);
  // Map / Undermap travels with the overview still open.
  await page.keyboard.press('m');
  await overview.getByRole('button', { name: 'Undermap · 1' }).click();
  await expect(page.locator('.live-workspace')).toHaveAttribute('data-layer', 'below');
  const below = page.getByRole('region', { name: 'Map overview' });
  await expect(below).toBeVisible(); await expect(below.getByRole('heading', { name: 'Undermap' })).toBeVisible();
  await expect(below.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await below.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.live-workspace')).toHaveAttribute('data-layer', 'map');
  await expect(overview).toBeVisible();
  const before = await camera(page);
  await page.keyboard.press('Escape');
  await expect(overview).toHaveCount(0); await expect(page.locator('.map-locator.atlas')).toBeVisible();
  expect(await camera(page)).toEqual(before);
});

test('the overview and the Needs me popover are never open together', async ({ visual: { page } }) => {
  const overview = page.getByRole('region', { name: 'Map overview' }), needs = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await page.getByRole('button', { name: 'Open map overview (M)' }).click();
  await expect(overview).toBeVisible();
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await expect(needs).toBeVisible(); await expect(overview).toHaveCount(0);
  await page.getByRole('button', { name: 'Open map overview (M)' }).click();
  await expect(overview).toBeVisible(); await expect(needs).toHaveCount(0);
});

test('the Atlas hides in full item view and dims when everything already fits on screen', async ({ visual: { page } }) => {
  const atlas = page.locator('.map-locator.atlas');
  await expect(atlas).toHaveAttribute('data-fits', 'true');
  await expect(atlas).toHaveCSS('opacity', '0.62');
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1.35');
  await expect(atlas).not.toHaveAttribute('data-fits');
  await page.getByRole('article', { name: 'BIL-128 · Plan changes' }).click();
  await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', '');
  await expect(atlas).toBeHidden();
  await page.keyboard.press('m');
  await expect(page.getByRole('region', { name: 'Map overview' })).toHaveCount(0);
});

test('the Atlas in context: eight projects, Undermap, thirty projects and the overview', async () => {
  test.setTimeout(120_000);
  await launch(workspace(8, 6), { x: 330, y: 250, zoom: .42 }, async page => {
    await expect(page.locator('.atlas [data-atlas-project]')).toHaveCount(8);
    await page.mouse.move(4, 4);
    await expect(page).toHaveScreenshot('atlas-map.png');
    await expect(page.locator('.map-locator.atlas')).toHaveScreenshot('atlas-corner.png');
    await page.locator('.atlas [data-atlas-project="project-4"]').first().hover({ force: true });
    await page.keyboard.press('m');
    await page.mouse.move(4, 4);
    await expect(page.getByRole('region', { name: 'Map overview' })).toBeVisible();
    await expect(page).toHaveScreenshot('atlas-overview.png');
    await page.keyboard.press('Escape');
    await apply(page, [{ type: 'nodes.action', ids: ['project-3', 'project-6'], action: 'below' }]);
    await page.getByRole('button', { name: 'Go to Undermap' }).click();
    await expect(page.locator('.live-workspace')).toHaveAttribute('data-layer', 'below');
    await expect(page.locator('.map-locator.atlas')).toHaveAttribute('data-layer', 'below');
    await expect(page.locator('.map-locator.atlas .atlas-footer')).toHaveText(/Undermap\s*12 items below/);
    // The frame and its 2px corners, including half their stroke, stay inside the tile's viewBox.
    const inside = await page.locator('.map-locator.atlas .atlas-map').evaluate(svg => {
      const view = (svg as SVGSVGElement).viewBox.baseVal;
      return ['[data-atlas-frame]', '.atlas-frame-corners'].map(selector => {
        const shape = svg.querySelector<SVGGraphicsElement>(selector)!, box = shape.getBBox(), half = parseFloat(getComputedStyle(shape).strokeWidth) / 2;
        return box.x - half >= 0 && box.y - half >= 0 && box.x + box.width + half <= view.width && box.y + box.height + half <= view.height;
      });
    });
    expect(inside).toEqual([true, true]);
    await page.mouse.move(4, 4);
    await expect(page.locator('.map-locator.atlas')).toHaveScreenshot('atlas-undermap.png');
  });
  await launch(workspace(30, 16, 6), { x: 120, y: 120, zoom: .2 }, async page => {
    await expect(page.locator('.atlas [data-atlas-project]')).toHaveCount(30);
    await expect(page.locator('.atlas .atlas-idle')).toHaveAttribute('d', '');
    // Past twelve projects the corner marks Needs me with one amber pixel each; counts stay in the footer and overview.
    await expect(page.locator('.atlas .atlas-count')).toHaveCount(0);
    await expect(page.locator('.atlas .atlas-badge')).toHaveCount(0);
    expect((await page.locator('.atlas .atlas-pixel').getAttribute('d'))!.match(/M/g)).toHaveLength(30);
    await expect(page.locator('.atlas .atlas-counts .tier-count[data-tier]').first()).toBeVisible();
    expect(await page.locator('.atlas .atlas-map *').count()).toBeLessThan(250);
    await page.mouse.move(4, 4);
    await expect(page.locator('.map-locator.atlas')).toHaveScreenshot('atlas-thirty-projects.png');
    await page.keyboard.press('m');
    await expect(page.locator('.atlas-overview .atlas-count')).toHaveCount(30);
  });
});
