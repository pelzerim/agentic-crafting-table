import { expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test, resize, scrollbarArgs, chooseMapCorner } from './visual-fixture.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import type { MapCorner } from '../../packages/core/settings.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
/** The world point at the centre of the map area. */
async function centre(page: Page) {
  const view = await camera(page), area = (await page.locator('.map-area').boundingBox())!;
  return { x: (area.width / 2 - view.x) / view.zoom, y: (area.height / 2 - view.y) / view.zoom, zoom: view.zoom };
}
const needsMe = (page: Page, count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });

/** Six projects on the Map and one muted: two need me, one works, one was active recently, two are quiet. */
function workspace() {
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const project = (id: string, title: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, title, position: { x, y }, ...extra });
  const nodes: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [];
  const item = (id: string, projectId: string, title: string, x: number, y: number, extra: Record<string, unknown>, agent = false) => {
    resources.push({ id: `${id}-r`, schemaVersion: 1, title, ...(agent ? { pluginId: 'agent.session', data: { sessionId: `static-${id}`, provider: 'claude' } } : { pluginId: 'linear.ticket', data: { issueId: id.toUpperCase() } }) });
    nodes.push({ id, resourceId: `${id}-r`, projectId, title, position: { x, y }, ...extra });
  };
  nodes.push(project('billing', 'Billing', 0, 0, { color: '#e3c55a' }), project('runner', 'Edge runtime', 1600, 0, { color: '#5b7fd6' }), project('infra', 'Infra', 0, 1200, { color: '#6fd6cf' }),
    project('recent', 'Recent', 1600, 1200, { color: '#d0564c' }), project('docs', 'Docs', 3200, 0, { color: '#a884d8' }), project('archive', 'Archive', 3200, 1200), project('night', 'Night', 4800, 0, { mutedAt: ago(60), color: '#b8945f' }));
  item('ask', 'billing', 'Webhook agent', 120, 0, { attention: 'input', attentionAt: ago(4), activityAt: ago(4) }, true);
  item('refund', 'billing', 'PR 812 refunds', 120, 170, { attention: 'review', activityAt: ago(40) });
  item('fixer', 'billing', 'Refund fixer', 450, 0, { activity: 'working', activityAt: ago(3) }, true);
  item('capacity', 'runner', 'PR 904 capacity', 1720, 0, { attention: 'review', activityAt: ago(120) });
  item('budget', 'runner', 'Budget agent', 2050, 0, { activity: 'working', activityAt: ago(1) }, true);
  item('plan', 'infra', 'Terraform plan', 120, 1200, { activity: 'working', summary: 'Planning the API LB', activityAt: ago(8) }, true);
  item('notes', 'recent', 'Release notes', 1720, 1200, { activityAt: ago(30) });
  item('guide', 'docs', 'Style guide', 3320, 0, { activityAt: ago(3 * 1440) });
  item('old', 'archive', 'Old ticket', 3320, 1200, {});
  item('question', 'night', 'Night agent', 4920, 0, { attention: 'input', activityAt: ago(2) }, true);
  return stateSchema.parse({ version: 1, revision: 0, nodes, resources, links: [], todos: [], view: {} });
}

async function launch(run: (page: Page) => Promise<void>, options: { mapCorner?: MapCorner; prepare?(store: SqliteStore): void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-project-column-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => workspace()); await store.writeView('desktop', { camera: { x: 200, y: 120, zoom: .4 } });
    chooseMapCorner(store, options.mapCorner ?? 'projects'); options.prepare?.(store);
  } finally { store.close(); }
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

test('by default the corner is the project column: one icon per project that is not muted, most urgent first', async () => {
  await launch(async page => {
    const column = page.getByRole('group', { name: /^Projects: 6, 3 waiting on me\./ });
    await expect(column).toBeVisible();
    await expect(page.locator('.map-locator.atlas')).toHaveCount(0);
    expect(await column.locator('[data-project-icon]').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-project-icon')))).toEqual(['billing', 'runner', 'infra', 'recent', 'docs', 'archive']);
    expect(await column.locator('[data-project-icon]').evaluateAll(icons => icons.map(icon => [icon.getAttribute('data-mark'), icon.textContent]))).toEqual([['asking', '1'], ['turn', '1'], ['working', '1'], ['idle', ''], ['idle', ''], ['idle', '']]);
    expect((await column.boundingBox())!.width).toBe(44);
    // The zoom bar sits in the bottom-left corner, right of the rail, clear of the column.
    const bar = (await page.locator('.zoom-markers').boundingBox())!, corner = (await column.boundingBox())!, area = (await page.locator('.map-area').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(70); expect(bar.x + bar.width).toBeLessThan(corner.x);
    expect(area.y + area.height - (bar.y + bar.height)).toBeLessThan(40);
    // Hovering an icon names the project and says where it stands.
    await column.locator('[data-project-icon="billing"]').hover();
    const tip = page.getByRole('tooltip');
    await expect(tip.locator('strong')).toHaveText('Billing');
    await expect(tip).toContainText('1 asking · 1 my turn · 1 working · active 3 min ago');
    await page.mouse.move(4, 4);
    await expect(column).toHaveScreenshot('project-column-folded.png');
    // Moving the camera does not touch the column.
    const changes = await column.evaluate(element => { const observer = new MutationObserver(() => {}); observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true }); (window as any).columnObserver = observer; return true; });
    expect(changes).toBe(true);
    await page.getByRole('slider', { name: 'Map zoom' }).fill('0.8');
    await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(.8, 2);
    expect(await page.evaluate(() => (window as any).columnObserver.takeRecords().length)).toBe(0);
    // Clicking an icon flies to the project.
    await column.locator('[data-project-icon="infra"]').click();
    await expect.poll(async () => { const point = await centre(page); return Math.abs(point.x - 100) < 500 && Math.abs(point.y - 1200) < 400; }).toBe(true);
  });
});

test('unfolded, each project has a counts line and its Needs me rows; a row centres its item without opening it', async () => {
  await launch(async page => {
    await expect(needsMe(page, 3)).toBeVisible();
    await page.keyboard.press('m');
    const panel = page.getByRole('region', { name: 'Projects', exact: true });
    await expect(panel).toBeVisible();
    await expect(page.locator('.map-locator.project-column')).toBeHidden();
    await expect(page.locator('.zoom-markers')).toBeHidden();
    expect(await panel.locator('[data-project-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-project-row')))).toEqual(['billing', 'runner', 'infra', 'recent']);
    const billing = panel.locator('[data-project-row="billing"]');
    await expect(billing.locator('.project-column-line')).toHaveText('1 asking · 1 my turn · 1 working · active 3 min ago');
    await expect(billing.locator('.project-column-line')).not.toHaveAttribute('title', /.+/);
    await expect(billing.locator('.project-column-pen')).toHaveCount(0);
    await expect(billing.getByRole('button', { name: /^Webhook agent: Asking me, Waiting for your input, 4m\. Go to item on map$/ })).toBeVisible();
    await expect(billing.getByRole('button', { name: /^PR 812 refunds: My turn, Ready for your review/ })).toBeVisible();
    await expect(panel.locator('[data-project-row="night"]')).toHaveCount(0);
    // Quiet projects fold into one line that expands.
    const quiet = panel.getByRole('button', { name: /2 quiet projects/ });
    await expect(quiet).toHaveAttribute('aria-expanded', 'false');
    await quiet.click();
    expect(await panel.locator('[data-quiet] [data-project-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-project-row')))).toEqual(['docs', 'archive']);
    // Arrow keys move through rows; the first row has focus on opening.
    await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
    await page.keyboard.press('m');
    await expect(panel.getByRole('button', { name: /^Billing: / })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('button', { name: /^Webhook agent: / })).toBeFocused();
    // A Needs me row centres its item at 100%; it is neither opened nor marked seen.
    await panel.getByRole('button', { name: /^PR 812 refunds: / }).press('Enter');
    await expect.poll(async () => { const point = await centre(page); return Math.round(point.zoom * 100) === 100 && Math.abs(point.x - 120) < 30 && Math.abs(point.y - 170) < 30; }).toBe(true);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await expect(needsMe(page, 3)).toBeVisible();
    await expect(panel).toBeVisible();
    // The column and the Needs me sheet are never open together.
    await page.keyboard.press('n');
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('m');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toHaveCount(0);
    await page.mouse.move(4, 4);
    await expect(panel).toHaveScreenshot('project-column-open.png', { mask: [panel.locator('small'), panel.locator('.project-column-line')] });
  });
});

test('a written summary replaces the counts line, marked as written by the summary model', async () => {
  await launch(async page => {
    const panel = page.getByRole('region', { name: 'Projects', exact: true });
    await page.keyboard.press('m');
    const line = panel.locator('[data-project-row="billing"] .project-column-line');
    await expect(line).toHaveText('Refund PR waits on your review; the webhook agent asks about retries. (written by the summary model)');
    await expect(line).toHaveAttribute('title', 'Written by the summary model');
    await expect(line.locator('.project-column-pen')).toBeVisible();
    await expect(panel.locator('[data-project-row="runner"] .project-column-line')).toContainText('1 my turn · 1 working');
  }, { prepare: store => {
    const current = store.readSettings();
    store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, projectSummaries: true } } });
    // Attempted now, so the helper waits ten minutes before it would ask again.
    store.reserveProjectSummary('billing', 'seeded', store.readSettings().value.summaries, Date.now(), 0);
    store.finishProjectSummary('billing', 'seeded', 'Refund PR waits on your review; the webhook agent asks about retries.', 'haiku');
  } });
});

test('with mapCorner set to atlas the corner is the Atlas, and on the Undermap the project column is not shown', async () => {
  await launch(async page => {
    const atlas = page.locator('.map-locator.atlas');
    await expect(atlas).toBeVisible();
    await expect(page.locator('.project-column')).toHaveCount(0);
    const bar = (await page.locator('.zoom-markers').boundingBox())!, corner = (await atlas.boundingBox())!;
    expect(bar.x + bar.width).toBeLessThan(corner.x);
    await page.keyboard.press('m');
    await expect(page.getByRole('region', { name: 'Map overview' })).toBeVisible();
  }, { mapCorner: 'atlas' });
  await launch(async page => {
    await expect(page.locator('.map-locator.project-column')).toBeVisible();
    await page.getByRole('button', { name: 'Go to Undermap' }).click();
    await expect(page.locator('.live-workspace')).toHaveAttribute('data-layer', 'below');
    await expect(page.locator('.project-column')).toHaveCount(0);
    await page.keyboard.press('m');
    await expect(page.getByRole('region', { name: 'Projects', exact: true })).toHaveCount(0);
    await expect(page.locator('.zoom-markers')).toBeVisible();
    const bar = (await page.locator('.zoom-markers').boundingBox())!, area = (await page.locator('.map-area').boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(area.y + area.height - 16);
  });
});
