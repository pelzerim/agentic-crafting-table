import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { plotProject } from '../fixtures/plot-project.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

/** The plots sample plus two items outside any project, so far zoom keeps cards instead of dashboards. */
function grabMap() {
  const state = plotProject();
  return { ...state,
    nodes: [...state.nodes, { id: 'loose-pr', resourceId: 'loose-pr-r', title: 'Loose PR', position: { x: 1900, y: 420 }, activity: 'idle' },
      { id: 'loose-agent', resourceId: 'loose-agent-r', title: 'Loose agent', position: { x: 1900, y: 640 }, activity: 'working', summary: 'Reading logs' }],
    resources: [...state.resources, { id: 'loose-pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Loose PR', data: { owner: 'example', repo: 'web', number: 9 } },
      { id: 'loose-agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Loose agent', data: { sessionId: 'static-loose', provider: 'claude' } }] } as typeof state;
}
async function launch(run: (app: ElectronApplication, page: Page) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-item-grab-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => grabMap()); await store.writeView('desktop', { camera: { x: 80, y: 70, zoom: .8 } });
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { enabled: false, belowZoom: .45 } } });
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1440, 900);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.locator('.map-card[data-item-id="loose-agent"]')).toHaveCount(1);
    await run(app, page);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 60)));
const card = (page: Page, id: string) => page.locator(`.map-card[data-item-id="${id}"]`);
const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => (element as HTMLElement).style.transform);
async function zoomTo(page: Page, zoom: number) {
  await page.getByRole('slider', { name: 'Map zoom' }).evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, zoom);
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(zoom));
  await settle(page);
}
/** Drags bare map so the card sits in the middle of the window. */
async function centre(page: Page, id: string) {
  for (let pass = 0; pass < 2; pass++) {
    const box = (await card(page, id).boundingBox())!, dx = 720 - (box.x + box.width / 2), dy = 450 - (box.y + box.height / 2);
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const from = await page.evaluate(() => {
      for (let y = 140; y < innerHeight - 100; y += 17) for (let x = 140; x < innerWidth - 140; x += 23) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
      const seen: Record<string, number> = {};
      for (let y = 140; y < innerHeight - 100; y += 50) for (let x = 140; x < innerWidth - 140; x += 50) { const t = document.elementFromPoint(x, y); const k = `${t?.tagName}.${t?.getAttribute('class')}`; seen[k] = (seen[k] ?? 0) + 1; }
      throw new Error(`No bare map to pan ${JSON.stringify(seen)}`);
    });
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 }); await page.mouse.up(); await settle(page);
  }
}
type Gesture = 'fast' | 'slow' | 'trackpad' | 'hover';
/** Real pointer input: a press, a travel past the click slip, a release. */
async function drag(page: Page, x: number, y: number, dx: number, gesture: Gesture = 'fast') {
  if (gesture === 'hover') { await page.mouse.move(x - 30, y - 20); await page.mouse.move(x, y, { steps: 4 }); await page.waitForTimeout(700); } else await page.mouse.move(x, y);
  await page.mouse.down();
  if (gesture === 'slow') for (let step = 1; step <= 16; step++) { await page.mouse.move(x + dx * step / 16, y + (step % 4 ? 1 : 0)); await page.waitForTimeout(16); }
  else if (gesture === 'trackpad') { for (const step of [1, 1, 2, 3, 4, 5, 7, 9]) { await page.mouse.move(x + Math.sign(dx) * step, y); await page.waitForTimeout(24); } await page.mouse.move(x + dx, y, { steps: 4 }); }
  else { await page.mouse.move(x + Math.sign(dx) * 12, y + 2); await page.mouse.move(x + dx, y, { steps: 3 }); }
  await page.mouse.up(); await settle(page);
}
type Point = { name: string; x: number; y: number; strict?: boolean };
/** Points on the card's face: middle, words, marks, every edge and corner, and the strip beside the + tab. */
const facePoints = (page: Page, id: string, zoom: number, names?: string[]) => card(page, id).evaluate((element, { zoom, names }) => {
  const r = element.getBoundingClientRect(), points: Point[] = [];
  const add = (name: string, x: number, y: number, strict = false) => { if (!names || names.includes(name)) points.push({ name, x: Math.round(x), y: Math.round(y), strict }); };
  const middle = (name: string, selector: string) => { const part = element.querySelector(selector)?.getBoundingClientRect(); if (part?.width) add(name, part.x + part.width / 2, part.y + part.height / 2); };
  add('centre', r.x + r.width / 2, r.y + r.height / 2);
  middle('title', '.card-label strong,.paper-text,.paper-face'); middle('body', '.card-summary,.item-indicators,.map-size-fields'); middle('badge', '.attention-indicator,.status-badge'); middle('sheep', '.working-mark');
  const inset = 2;
  for (const [name, fx, fy] of [['top-left', 0, 0], ['top-right', 1, 0], ['bottom-left', 0, 1], ['bottom-right', 1, 1], ['top', .5, 0], ['bottom', .5, 1], ['left', 0, .5], ['right', 1, .5]] as const)
    add(name, r.x + inset + fx * (r.width - 2 * inset), r.y + inset + fy * (r.height - 2 * inset), name === 'left');
  if (zoom >= .5) add('beside-plus', r.right - 10 * zoom, r.y + r.height / 2 - 11 * zoom, true);
  return points;
}, { zoom, names });

/** What a press at the point lands on; a real control inside the card may keep the press. */
const landing = (page: Page, id: string, point: Point) => page.evaluate(({ id, point }) => {
  const top = document.elementFromPoint(point.x, point.y), own = top?.closest('.react-flow__node')?.getAttribute('data-id') === id;
  const control = own && Boolean(top?.closest('button,input,textarea,select,a[href],[contenteditable="true"],.item-resize-handle'));
  return { own, control, top: top ? `${top.tagName.toLowerCase()}${[...top.classList].slice(0, 2).map(name => `.${name}`).join('')}` : 'nothing' };
}, { id, point });

async function grab(page: Page, id: string, point: Point, gesture: Gesture, dx: number) {
  const hit = await landing(page, id, point);
  if (hit.control && !point.strict) return { result: 'control', hit };
  const before = await camera(page), start = (await card(page, id).boundingBox())!;
  await drag(page, point.x, point.y, dx, gesture);
  const panned = await camera(page) !== before, end = await card(page, id).boundingBox(), moved = end ? Math.round(end.x - start.x) : 0;
  return { result: panned ? 'map panned' : Math.sign(moved) === Math.sign(dx) && Math.abs(moved) >= Math.abs(dx) / 2 ? 'item moved' : `nothing moved${await page.locator('.map-area').getAttribute('data-focus') ? ', item opened' : ''}`, hit, panned };
}
/** Closes whatever a failed grab opened instead: the item, a link picker, a menu. */
async function dismiss(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!await page.locator('.map-area').getAttribute('data-focus') && !await page.locator('.picker-backdrop,.canvas-menu').count()) return;
    await page.keyboard.press('Escape'); await settle(page);
  }
}
async function record(testInfo: TestInfo, rows: string[]) {
  await testInfo.attach('grab-grid', { body: ['zoom\titem\tgesture\tpoint\tresult\tpress lands on', ...rows].join('\n'), contentType: 'text/tab-separated-values' });
}

const ITEMS = ['thumb-agent', 'thumb-pr', 'thumb-ticket', 'billing-rollout', 'thumb-note', 'loose-pr', 'loose-agent'];

test('a press anywhere on a card face drags the item, never the map, at near, mid and far zoom', async ({}, testInfo) => {
  test.setTimeout(240_000);
  await launch(async (_app, page) => {
    const rows: string[] = [], failures: string[] = [];
    for (const zoom of [1, .5, .3]) {
      await zoomTo(page, zoom);
      for (const id of ITEMS) {
        await centre(page, id);
        for (const name of (await facePoints(page, id, zoom, zoom < .5 ? ['centre', 'title', 'top-left', 'bottom-right', 'left', 'bottom'] : undefined)).map(point => point.name)) {
          const point = (await facePoints(page, id, zoom, [name]))[0];
          const { result, hit } = await grab(page, id, point, 'fast', 40);
          rows.push(`${zoom}\t${id}\tfast\t${point.name}\t${result}\t${hit.top}`);
          if (result !== 'item moved' && result !== 'control') failures.push(`${zoom} ${id} ${point.name}: ${result} (press landed on ${hit.top})`);
          if (result !== 'item moved' && result !== 'control') { await dismiss(page); await centre(page, id); }
          else if (result === 'item moved') await drag(page, point.x + 40, point.y, -40);
        }
      }
    }
    await record(testInfo, rows);
    expect(failures).toEqual([]);
  });
});

test('slow, fast, trackpad-like and after-hover drags all move the item', async ({}, testInfo) => {
  test.setTimeout(120_000);
  await launch(async (_app, page) => {
    const rows: string[] = [], failures: string[] = [];
    for (const id of ['thumb-pr', 'thumb-note', 'thumb-agent', 'billing-rollout']) {
      await centre(page, id);
      for (const gesture of ['slow', 'trackpad', 'hover', 'fast'] as const) for (const point of await facePoints(page, id, .8, ['centre', 'title'])) {
        const { result, hit } = await grab(page, id, point, gesture, 40);
        rows.push(`0.8\t${id}\t${gesture}\t${point.name}\t${result}\t${hit.top}`);
        if (result !== 'item moved') failures.push(`${id} ${gesture} ${point.name}: ${result}`);
        else await drag(page, point.x + 40, point.y, -40);
      }
    }
    await record(testInfo, rows);
    expect(failures).toEqual([]);
  });
});

test('pressing a card again while its last move is still saving drags it instead of panning the map', async () => {
  await launch(async (app, page) => {
    // Every save takes 400 ms, as on a large workspace, so the second press lands while the first is in flight.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers, original = handlers.get('workspace:request')!;
      handlers.set('workspace:request', async (event, request) => { if ((request as { method: string }).method === 'apply') await new Promise(resolve => setTimeout(resolve, 400)); return original(event, request); });
    });
    await centre(page, 'thumb-pr');
    const start = (await card(page, 'thumb-pr').boundingBox())!, x = start.x + start.width / 2, y = start.y + start.height / 2, before = await camera(page);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y, { steps: 3 }); await page.mouse.move(x + 60, y, { steps: 3 }); await page.mouse.up();
    await page.mouse.move(x + 60, y); await page.mouse.down(); await page.mouse.move(x + 80, y, { steps: 3 }); await page.mouse.move(x + 120, y, { steps: 3 }); await page.mouse.up();
    expect(await camera(page)).toBe(before);
    // Another card pressed in the same window moves too, and the first keeps its new place.
    const other = (await card(page, 'thumb-ticket').boundingBox())!, ox = other.x + other.width / 2, oy = other.y + other.height / 2;
    await page.mouse.move(ox, oy); await page.mouse.down(); await page.mouse.move(ox, oy + 20, { steps: 3 }); await page.mouse.move(ox, oy + 50, { steps: 3 }); await page.mouse.up();
    expect(await camera(page)).toBe(before);
    await expect.poll(async () => Math.round((await card(page, 'thumb-pr').boundingBox())!.x - start.x), { timeout: 5000 }).toBeGreaterThan(90);
    await expect.poll(async () => Math.round((await card(page, 'thumb-ticket').boundingBox())!.y - other.y), { timeout: 5000 }).toBeGreaterThan(30);
    const saved = await page.evaluate(async () => Object.fromEntries((await window.craftingTable.workspaceRead()).state.nodes.filter(node => ['thumb-pr', 'thumb-ticket'].includes(node.id)).map(node => [node.id, node.position])));
    const zoom = Number(await page.locator('.map-area').getAttribute('data-zoom'));
    expect(saved['thumb-pr'].x - 470).toBeGreaterThan(90 / zoom);
    expect(saved['thumb-ticket'].y - 330).toBeGreaterThan(30 / zoom);
  });
});

test('a card can be grabbed while its view is still flying back after closing', async () => {
  await launch(async (_app, page) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await centre(page, 'thumb-pr');
    const start = (await card(page, 'thumb-pr').boundingBox())!, x = start.x + start.width / 2, y = start.y + start.height / 2;
    await page.mouse.click(x, y);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'thumb-pr');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    const before = await camera(page);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y, { steps: 2 }); await page.mouse.move(x + 60, y, { steps: 3 }); await page.mouse.up();
    expect(await camera(page)).toBe(before);
    await expect.poll(async () => Math.round((await card(page, 'thumb-pr').boundingBox())!.x - start.x)).toBeGreaterThan(30);
  });
});
