import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { cue, photoLibraryProject } from '../fixtures/photo-library-project.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { createHash } from 'node:crypto';
import { canonical } from '../../packages/core/control.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { DEFAULT_DASHBOARD_SECTIONS } from '../../src/graph/project-dashboard.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../src/resource-plugins/pixel-glyphs.ts';

/** The photo library project, a small two-item project and a floating PR with failing checks. */
function fixture() {
  const state = photoLibraryProject();
  state.nodes.push({ id: 'small', title: 'Billing', position: { x: 4600, y: 700 } } as never,
    { id: 'invoice', resourceId: 'invoice-r', projectId: 'small', title: 'Invoice rounding', position: { x: 4520, y: 700 }, activity: 'working', summary: 'fixing totals' } as never,
    { id: 'refund', resourceId: 'refund-r', projectId: 'small', title: 'Refund flow', position: { x: 4760, y: 700 }, indicators: cue('Approved', 'green', 'check', 'ready') } as never,
    { id: 'loose', resourceId: 'loose-r', title: 'Loose fix', position: { x: 4600, y: 1500 }, indicators: cue('Checks failing', 'red', 'x', 'failing') } as never);
  state.resources.push({ id: 'invoice-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Invoice rounding', data: { sessionId: 'static-invoice', provider: 'claude' } } as never,
    { id: 'refund-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Refund flow', data: { owner: 'example', repo: 'billing', number: 7 } } as never,
    { id: 'loose-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Loose fix', data: { owner: 'example', repo: 'billing', number: 8 } } as never);
  state.links.push({ id: 'loose-split', sourceId: 'loose', targetId: 'split', kind: 'reference' } as never);
  return stateSchema.parse(state);
}
const ALL_SECTIONS = { needsYou: true, working: true, todos: true, plots: true, pipelines: true, tallies: true };
/** Back to the sections a new install shows. */
const defaultSections = (store: SqliteStore) => { const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { ...settings.value.mapDashboards, sections: DEFAULT_DASHBOARD_SECTIONS } } }); };
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
async function zoomTo(page: Page, zoom: number) {
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  await slider.evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, zoom);
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(zoom));
  await settle(page);
}
async function launch(run: (page: Page) => Promise<void>, view = { x: 20, y: 40, zoom: .3 }, prepare?: (store: SqliteStore) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-dashboards-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => fixture()); await store.writeView('desktop', { camera: view });
    // The library's linked items form plots (MAP-24, covered in plots.spec.ts); these journeys are about the other sections,
    // including the PR and ticket lines that are off by default.
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapPlots: false, mapDashboards: { ...settings.value.mapDashboards, sections: ALL_SECTIONS } } });
    prepare?.(store);
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1600, 760);
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
const board = (page: Page, id = 'project') => page.locator(`[data-dashboard="${id}"]`);
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async payload => { const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: JSON.parse(payload) }); }, JSON.stringify(commands));
}
/** A saved PR snapshot, as the service keeps it after a GitHub read, so previews need no provider. */
function savePullSnapshot(store: SqliteStore, resourceId: string, detail: Record<string, unknown>) {
  const resource = fixture().resources.find(resource => resource.id === resourceId)!;
  const fingerprint = createHash('sha256').update(canonical({ plugin: resource.pluginId, schema: resource.schemaVersion, connection: resource.connectionId, data: resource.data })).digest('hex');
  store.cacheResource(resource.id, 'snapshot', fingerprint, { activity: 'idle', attention: 'none', connection: 'connected', label: 'Checks failing', observedAt: new Date().toISOString(),
    indicators: [{ id: 'review-state', label: 'Checks failing', tone: 'red', icon: 'x', stage: 'failing' }], detail }, Date.now());
}

test('below the threshold each neighbourhood becomes its dashboard; its items, links and title return above it', async ({}, testInfo) => {
  await launch(async page => {
    await expect(page.locator('.map-area')).toHaveAttribute('data-dashboards', 'true');
    const library = board(page);
    await expect(library).toHaveAttribute('data-mode', 'full');
    await expect(library.locator('.dashboard-title')).toHaveText('Photo library');
    await expect(library.locator('header small')).toHaveText(/^active [34]m ago · 26 items$/);
    await expect(page.locator('[data-item-id="pr-64"]')).toHaveCount(0);
    await expect(page.locator('[data-project-label="project"]')).toHaveCount(0);
    await expect(page.locator('.explicit-edge')).toHaveCount(0);
    // Floating items keep their far-zoom icon and badge.
    await expect(page.locator('[data-item-id="loose"] .status-badge')).toHaveAttribute('aria-label', 'Checks failing');
    // Needs you: the same unread entries and order as the Needs me list.
    await expect(library.locator('h4[data-section="needs"]')).toHaveText('Needs me · 4');
    await expect(library.locator('.dashboard-row[data-kind="needs"] .dashboard-row-title')).toHaveText(['Cache metrics agent', 'Rollout preview', 'Thumbnail refresh loop', 'Album table migration']);
    await expect(library.locator('.dashboard-row[data-kind="needs"] .dashboard-row-detail')).toHaveText(['Waiting for your input', 'Waiting for your input', 'Checks failing', 'Ready for your review']);
    await page.getByRole('button', { name: 'Needs me: 4', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true }).locator('.attention-entry')).toHaveCount(4);
    await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
    await expect(library.locator('h4[data-section="working"]')).toHaveText('Working · 2');
    await expect(library.locator('.dashboard-row[data-kind="working"] .dashboard-row-title')).toHaveText(['Importer split', 'Ordering fixes']);
    await expect(library.locator('.dashboard-row[data-kind="working"] .dashboard-row-detail')).toHaveText([/^editing importer\.ts · [34]m$/, 'running tests']);
    await expect(library.locator('.dashboard-row[data-kind="working"] .status-glyph[data-glyph="working"] path').first()).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
    const prs = library.locator('.dashboard-pipeline');
    await expect(prs.locator('h4')).toHaveText('PRs · 10');
    await expect(prs.locator('.dashboard-strip button')).toHaveCount(10);
    await expect(prs.locator('.dashboard-strip button').first()).toHaveAttribute('data-tone', 'red');
    await expect(prs.locator('.dashboard-groups')).toHaveText('1 checks failing (1 yours)1 changes requested1 draft1 open (1 yours)1 queued3 approved2 merged');
    await expect(prs.locator('.dashboard-groups .status-glyph')).toHaveCount(7);
    const tickets = library.locator('.dashboard-tally');
    await expect(tickets.locator('h4')).toHaveText('Tickets · 9');
    await expect(tickets.locator('.dashboard-groups')).toHaveText('3 in progress2 in review1 backlog1 to do2 done');
    // The small neighbourhood has room only for the compact form.
    const small = board(page, 'small');
    await expect(small).toHaveAttribute('data-mode', 'compact');
    await expect(small.locator('.dashboard-counts')).toHaveText('1 working2 items');
    await expect(small.locator('.dashboard-tiers .status-glyph[data-glyph="working"] path')).toHaveAttribute('d', glyphPath(PIXEL_GLYPHS[8].working));
    await expect(small.locator('.dashboard-summary')).toHaveText('1 PR1 ready');
    // Dashboards stay inside their neighbourhoods on screen and clear of the Atlas, tool rail and top actions.
    const obstacles = await page.locator('.map-locator,.tool-rail,.map-status').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    for (const id of ['project', 'small']) {
      const rect = (await board(page, id).boundingBox())!;
      for (const other of obstacles) expect(rect.x + rect.width <= other.x || other.x + other.width <= rect.x || rect.y + rect.height <= other.y || other.y + other.height <= rect.y, `${id} overlaps ${JSON.stringify(other)}`).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath('dashboards-030.png') });
    // Dragging the map beside a dashboard pans it; dragging the dashboard itself moves its project.
    const before = (await board(page).boundingBox())!;
    await page.mouse.move(before.x + before.width + 60, before.y + 40);
    await page.mouse.down(); await page.mouse.move(before.x + before.width, before.y + 40, { steps: 6 }); await page.mouse.up();
    await expect.poll(async () => (await board(page).boundingBox())!.x).toBeLessThan(before.x - 30);
    await zoomTo(page, .3);
    await zoomTo(page, .4);
    await expect(board(page)).toHaveAttribute('data-mode', 'full');
    await page.screenshot({ path: testInfo.outputPath('dashboards-040.png') });
    await zoomTo(page, .7);
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-dashboards', 'true');
    await expect(page.locator('[data-dashboard]')).toHaveCount(0);
    await expect(page.locator('[data-item-id="pr-64"]')).toHaveCount(1);
    await expect(page.locator('[data-project-label="project"]')).toHaveCount(1);
    await expect(page.locator('.explicit-edge')).toHaveCount(18);
  });
});

test('clicking or pressing Enter on a Needs you row flies to its item and opens it', async () => {
  await launch(async page => {
    await board(page).locator('.dashboard-row[data-row="pr-64"]').click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-dashboards', 'true');
    const item = page.locator('[data-item-id="pr-64"]'), canvas = (await page.locator('.map-area').boundingBox())!;
    const box = (await item.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(4);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr-64');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await zoomTo(page, .3);
    await board(page).locator('.dashboard-title').focus();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await expect(board(page).getByRole('button', { name: /^Rollout preview:/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('[data-item-id="rollout"]')).toHaveCount(1);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'rollout');
  });
});

test('a pipeline cell that needs you opens its item; other cells and Working rows only fly', async () => {
  await launch(async page => {
    await board(page).locator('.dashboard-strip button[data-cell="pr-64"]').click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr-64');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await zoomTo(page, .3);
    await board(page).locator('.dashboard-strip button[data-cell="pr-63"]').click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /./);
  });
});

test('Settings moves the dashboard threshold and its zoom-bar tick, and turning dashboards off keeps icons', async ({}, testInfo) => {
  await launch(async page => {
    const tick = page.locator('.zoom-markers [data-dashboard-threshold]');
    await expect(tick).toHaveAttribute('aria-label', 'Dashboards below 65%');
    const slider = (await page.getByRole('slider', { name: 'Map zoom' }).boundingBox())!;
    const at = async () => { const box = (await tick.boundingBox())!; return (box.x + box.width / 2 - slider.x) / slider.width; };
    expect(await at()).toBeCloseTo((.65 - .2) / (1.35 - .2), 1);
    await page.locator('.zoom-markers').screenshot({ path: testInfo.outputPath('zoom-tick-065.png') });
    const save = async (change: (page: Page) => Promise<void>) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
      await change(page);
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    };
    await save(async page => {
      const threshold = page.getByRole('slider', { name: 'Dashboard zoom threshold' });
      await threshold.evaluate(input => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '0.25'); element.dispatchEvent(new Event('input', { bubbles: true })); });
      await expect(page.locator('[data-settings-section="Map"] output').first()).toHaveText('25%');
    });
    await expect(tick).toHaveAttribute('aria-label', 'Dashboards below 25%');
    expect(await at()).toBeCloseTo((.25 - .2) / (1.35 - .2), 1);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.mapDashboards).toEqual({ enabled: true, belowZoom: .25, placement: 'center', sections: ALL_SECTIONS });
    await expect(page.locator('[data-dashboard]')).toHaveCount(0);
    await expect(page.locator('.map-area')).toHaveAttribute('data-level', 'neighborhood');
    await expect(page.locator('[data-item-id="pr-64"]')).not.toHaveClass(/compact/);
    await zoomTo(page, .22);
    await expect(board(page)).toBeVisible();
    await save(async page => { await page.getByRole('switch', { name: 'Show project dashboards when zoomed out' }).uncheck(); });
    await expect(tick).toHaveCount(0);
    await expect(page.locator('[data-dashboard]')).toHaveCount(0);
    await expect(page.locator('[data-item-id="pr-64"] .status-badge')).toHaveAttribute('aria-label', 'Checks failing');
    await expect(page.locator('[data-project-label="project"]')).toHaveCount(1);
  });
});

test('Undermap projects show their dashboard in the Undermap tint without Needs you or Working (Classic layout)', async ({}, testInfo) => {
  await launch(async page => {
    // Mirror, the default, shows its own plate below the threshold (undermap-mirror.spec.ts).
    await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, undermapLayout: 'classic' } }); });
    const state = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    await page.evaluate(revision => window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.below', id: 'project' }] }), state.revision);
    await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'below');
    const below = board(page);
    await expect(below).toBeVisible();
    await expect(below.locator('h4[data-section="needs"], h4[data-section="working"]')).toHaveCount(0);
    await expect(below.locator('.dashboard-pipeline h4')).toHaveText('PRs · 10');
    await page.screenshot({ path: testInfo.outputPath('dashboards-undermap.png') });
  });
});

test('panning moves dashboards without re-rendering them', async () => {
  await launch(async page => {
    await expect(board(page)).toBeVisible();
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.mouse.move(1100, 650); await page.mouse.down(); await page.mouse.move(1060, 630, { steps: 20 }); await page.mouse.up();
    const metrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;
    expect(metrics['map.card-render']?.count ?? 0).toBe(0);
    expect(metrics['map.dashboard-render']?.count ?? 0).toBe(0);
  });
});

test('hovering or focusing a PR in a dashboard previews it from saved data; clicking a PR that needs you opens it', async ({}, testInfo) => {
  await launch(async page => {
    const cell = board(page).locator('.dashboard-pipeline .dashboard-strip button[data-cell="pr-64"]');
    const preview = page.locator('.dashboard-preview[data-preview="pr-64"]');
    await cell.hover();
    await expect(preview).toBeVisible();
    await expect(preview.locator('strong')).toHaveText('Thumbnail refresh loop');
    await expect(preview.locator('.dashboard-preview-status')).toHaveText('Checks failing');
    await expect(preview.locator('.dashboard-preview-attention')).toHaveCount(0);
    await expect(preview.locator('.dashboard-preview-sub')).toHaveText('example/photos #64 · by octo');
    await expect(preview.locator('dl')).toContainText('Checks2 failing · unit, lint');
    await expect(preview.locator('dl')).toContainText('Comments1 unseen comment');
    await expect(preview.locator('dl')).toContainText('LinkedImporter split (Agent session)');
    await expect(preview.locator('small')).toHaveText(/^Updated \d+h ago$/);
    await expect(cell).toHaveAttribute('aria-describedby', await preview.getAttribute('id') ?? '');
    const panel = (await board(page).boundingBox())!, card = (await preview.boundingBox())!, strip = (await cell.boundingBox())!;
    expect(card.y).toBeGreaterThan(strip.y); expect(card.x + card.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    await page.screenshot({ path: testInfo.outputPath('dashboard-pr-preview.png') });
    // Moving within the cell renders nothing more.
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.mouse.move(strip.x + 2, strip.y + strip.height / 2); await page.mouse.move(strip.x + strip.width - 2, strip.y + strip.height / 2, { steps: 8 });
    const metrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;
    expect(metrics['map.dashboard-render']?.count ?? 0).toBe(0); expect(metrics['map.card-render']?.count ?? 0).toBe(0);
    await page.mouse.move(8, 700);
    await expect(preview).toHaveCount(0);
    // A PR under Needs you previews too; other rows keep their plain tooltip.
    await board(page).locator('.dashboard-row[data-row="pr-62"]').hover();
    await expect(page.locator('.dashboard-preview[data-preview="pr-62"] .dashboard-preview-attention')).toHaveText('Ready for your review');
    await expect(page.locator('.dashboard-preview[data-preview="pr-62"] .dashboard-preview-attention .tier-mark')).toHaveAttribute('data-tier', 'turn');
    await expect(board(page).locator('.dashboard-row[data-row="metrics"]')).toHaveAttribute('title', /Cache metrics agent/);
    await page.mouse.move(8, 700);
    // Keyboard focus shows the preview; Escape hides it.
    const approved = board(page).locator('.dashboard-strip button[data-cell="pr-63"]');
    await approved.focus();
    const other = page.locator('.dashboard-preview[data-preview="pr-63"]');
    await expect(other.locator('.dashboard-preview-status')).toHaveText('Approved');
    await expect(other.locator('.dashboard-preview-sub')).toHaveText('example/photos #63');
    await page.keyboard.press('Escape');
    await expect(other).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('[data-item-id="pr-63"]')).toHaveCount(1);
    await zoomTo(page, .3);
    await cell.click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr-64');
  }, undefined, store => savePullSnapshot(store, 'pr-64-r', { pull: { title: 'Thumbnail refresh loop', user: { login: 'octo' }, updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }, status: 'checks-failing', failingChecks: ['unit', 'lint'], discussion: [{ id: 1, kind: 'discussion', body: 'Why a loop?', author: 'reviewer', date: new Date().toISOString() }] }));
});

test('a dashboard lists its project’s open to-dos; checking one completes it and titles go to the task or the list', async ({}, testInfo) => {
  await launch(async page => {
    await apply(page, [
      { type: 'todo.save', todo: { id: 'docs', title: 'Write album docs', completed: false, nodeIds: ['split'] } },
      { type: 'todo.save', todo: { id: 'storage', title: 'Ask about storage limits', completed: false, nodeIds: ['split', 'pr-62'] } },
      { type: 'todo.save', todo: { id: 'shipped', title: 'Announce shutdown', completed: true, nodeIds: ['pr-9'] } },
      { type: 'todo.save', todo: { id: 'elsewhere', title: 'Round invoices', completed: false, nodeIds: ['invoice'] } },
      { type: 'item.add', id: 'tidy', resourceId: 'tidy-r', pluginId: 'workspace.todo', title: 'Tidy the importer', data: {}, projectId: 'project', position: { x: 2600, y: 700 } },
    ]);
    await zoomTo(page, .4);
    const todos = board(page).locator('h4[data-section="todos"]');
    await expect(todos).toHaveText('To-dos · 3 open · 1 done');
    await expect(board(page).locator('.dashboard-todo .dashboard-row-title')).toHaveText(['Write album docs', 'Ask about storage limits', 'Tidy the importer']);
    await expect(board(page, 'small').locator('.dashboard-counts')).toContainText('1 open to-do');
    await page.screenshot({ path: testInfo.outputPath('dashboard-todos.png') });
    const check = board(page).locator('.dashboard-check').first(), hit = (await check.boundingBox())!;
    expect(Math.min(hit.width, hit.height)).toBeGreaterThanOrEqual(24);
    // Pressing the box and wandering off never drags the project or completes the to-do.
    const placed = async () => (await read(page)).nodes.filter(node => node.projectId === 'project' || node.id === 'project').map(node => [node.id, node.position]);
    const resting = await placed();
    await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2); await page.mouse.down();
    await page.mouse.move(hit.x + 120, hit.y + 80, { steps: 6 }); await page.mouse.up();
    expect(await placed()).toEqual(resting);
    expect((await read(page)).todos.find(todo => todo.id === 'docs')?.completed).toBe(false);
    await check.click({ position: { x: 2, y: 2 } });
    await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'docs')?.completed).toBe(true);
    await apply(page, [{ type: 'todo.save', todo: { id: 'docs', title: 'Write album docs', completed: false, nodeIds: ['split'] } }]);
    await expect(todos).toHaveText('To-dos · 3 open · 1 done');
    await board(page).getByRole('checkbox', { name: 'Complete Write album docs' }).check();
    await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'docs')?.completed).toBe(true);
    await expect(todos).toHaveText('To-dos · 2 open · 2 done');
    await board(page).getByRole('checkbox', { name: 'Complete Tidy the importer' }).check();
    await expect.poll(async () => Boolean((await read(page)).nodes.find(node => node.id === 'tidy')?.completedAt)).toBe(true);
    await expect(todos).toHaveText('To-dos · 1 open · 3 done');
    await apply(page, [{ type: 'node.reopen', id: 'tidy' }]);
    // A checklist to-do with several items opens the list on its row.
    await board(page).locator('.dashboard-row[data-row="storage"]').click();
    const list = page.getByRole('form', { name: 'To-dos', exact: true });
    await expect(list.locator('[data-todo-id="storage"] input[type=checkbox]')).toBeFocused();
    await expect(list.locator('[data-todo-id="storage"]')).toHaveAttribute('data-spotlight', 'true');
    await page.keyboard.press('Escape');
    // A map task flies to its item.
    await board(page).locator('.dashboard-row[data-row="map:tidy"]').click();
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(.8, 2);
    await expect(page.locator('[data-item-id="tidy"]')).toHaveCount(1);
  });
});

const positions = async (page: Page, ids: string[]) => { const { nodes } = await read(page); return ids.map(id => nodes.find(node => node.id === id)!.position); };
const offset = async (page: Page, from: { x: number; y: number }) => { const [at] = await positions(page, ['project']); return { x: Math.round(at.x - from.x), y: Math.round(at.y - from.y) }; };
const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => (element as HTMLElement).style.transform);

test('dragging a dashboard by its background moves the whole project without panning the map', async () => {
  await launch(async page => {
    const library = board(page), other = (await board(page, 'small').boundingBox())!, view = await camera(page);
    const [project, member] = await positions(page, ['project', 'pr-64']);
    const grip = (await library.locator('header small').boundingBox())!, start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    const before = (await library.boundingBox())!, field = page.locator('[data-project-outline="project"]'), fieldBefore = (await field.boundingBox())!;
    await page.evaluate(() => window.craftingPerformance.reset());
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x - 60, start.y + 60, { steps: 12 });
    await expect(page.locator('.project-dashboard-anchor[data-dragging]')).toHaveCount(1);
    // Twelve pointer moves do not re-render the dashboard or cards per frame.
    const metrics = (await page.evaluate(() => window.craftingPerformance.snapshot())).metrics;
    expect(metrics['map.dashboard-render']?.count ?? 0).toBeLessThanOrEqual(2);
    expect(metrics['map.card-render']?.count ?? 0).toBeLessThanOrEqual(2);
    const during = (await library.boundingBox())!, fieldDuring = (await field.boundingBox())!;
    // The field keeps to its world grid, and the dashboard centres on it, so both follow within one 24 px cell.
    const cell = 24 * Number(await page.locator('.map-area').getAttribute('data-zoom')) + 2;
    expect(Math.abs(fieldDuring.x - (fieldBefore.x - 60))).toBeLessThan(cell); expect(Math.abs(fieldDuring.y - (fieldBefore.y + 60))).toBeLessThan(cell);
    expect(Math.abs(during.x - (before.x - 60))).toBeLessThan(4 + cell); expect(Math.abs(during.y - (before.y + 60))).toBeLessThan(4 + cell);
    await page.mouse.up();
    await expect.poll(() => offset(page, project)).toEqual({ x: -200, y: 200 });
    const [moved, movedMember] = await positions(page, ['project', 'pr-64']);
    expect(movedMember.x - member.x).toBeCloseTo(moved.x - project.x, 6); expect(movedMember.y - member.y).toBeCloseTo(moved.y - project.y, 6);
    await expect(page.locator('.project-dashboard-anchor[data-dragging]')).toHaveCount(0);
    expect(await camera(page)).toBe(view);
    expect((await board(page, 'small').boundingBox())!).toEqual(other);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.3');
    // Wheel over a dashboard still zooms the map.
    await page.mouse.move(start.x - 60, start.y + 60); await page.mouse.wheel(0, -120);
    await expect.poll(async () => Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeGreaterThan(.3);
  });
});

test('dragging a dashboard by a row or cell moves the project and swallows the click; a tiny movement still clicks', async () => {
  await launch(async page => {
    const library = board(page), [project] = await positions(page, ['project']);
    const cell = (await library.locator('.dashboard-strip button[data-cell="pr-64"]').boundingBox())!;
    await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2);
    await expect(page.locator('.dashboard-preview')).toHaveCount(1);
    await page.mouse.down(); await page.mouse.move(cell.x + cell.width / 2 + 30, cell.y + cell.height / 2 - 30, { steps: 6 });
    await expect(page.locator('.dashboard-preview')).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => offset(page, project)).toEqual({ x: 100, y: -100 });
    const row = (await library.locator('.dashboard-row[data-row="pr-62"]').boundingBox())!;
    await page.mouse.move(row.x + 40, row.y + row.height / 2); await page.mouse.down();
    await page.mouse.move(row.x + 40, row.y + row.height / 2 + 30, { steps: 6 }); await page.mouse.up();
    await expect.poll(() => offset(page, project)).toEqual({ x: 100, y: 0 });
    await page.waitForTimeout(400);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.3');
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /./);
    // Under the drag threshold the press stays a click: the Needs you row flies and opens.
    const again = (await library.locator('.dashboard-row[data-row="pr-64"]').boundingBox())!;
    await page.mouse.move(again.x + 40, again.y + again.height / 2); await page.mouse.down();
    await page.mouse.move(again.x + 42, again.y + again.height / 2 + 1); await page.mouse.up();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr-64');
    expect(await offset(page, project)).toEqual({ x: 100, y: 0 });
  });
});

test('Escape mid-drag puts a dragged dashboard back and keeps the click from firing', async () => {
  await launch(async page => {
    const library = board(page), [project] = await positions(page, ['project']), before = (await library.boundingBox())!;
    const row = (await library.locator('.dashboard-row[data-row="pr-64"]').boundingBox())!;
    await page.mouse.move(row.x + 40, row.y + row.height / 2); await page.mouse.down();
    await page.mouse.move(row.x + 100, row.y + row.height / 2 + 45, { steps: 6 });
    await expect(page.locator('.project-dashboard-anchor[data-dragging]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.project-dashboard-anchor[data-dragging]')).toHaveCount(0);
    expect((await library.boundingBox())!).toEqual(before);
    await page.mouse.move(row.x + 140, row.y + row.height / 2 + 60, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await positions(page, ['project'])).toEqual([project]);
    expect((await library.boundingBox())!).toEqual(before);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.3');
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /./);
  });
});

test('by default a dashboard has no PR or ticket lines; Settings turns them on live and Needs you off keeps its count', async ({}, testInfo) => {
  await launch(async page => {
    const library = board(page), small = board(page, 'small');
    await expect(library).toHaveAttribute('data-mode', 'full');
    await expect(library.locator('h4[data-section="needs"]')).toHaveText('Needs me · 4');
    await expect(library.locator('h4[data-section="working"]')).toHaveText('Working · 2');
    await expect(library.locator('.dashboard-pipeline, .dashboard-tally')).toHaveCount(0);
    await expect(small.locator('.dashboard-summary')).toHaveCount(0);
    await expect(small.locator('.dashboard-counts')).toHaveText('1 working2 items');
    // A PR row under Needs you still previews without the PR line.
    await library.locator('.dashboard-row[data-row="pr-62"]').hover();
    await expect(page.locator('.dashboard-preview[data-preview="pr-62"]')).toBeVisible();
    await page.mouse.move(8, 700);
    await page.screenshot({ path: testInfo.outputPath('dashboard-default-sections.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    const sections = page.getByRole('group', { name: 'Dashboard sections' });
    for (const [name, checked] of [['Needs me', true], ['Working', true], ['To-dos', true], ['Plots', true], ['Pull requests', false], ['Tickets', false]] as const) {
      if (checked) await expect(sections.getByRole('checkbox', { name, exact: true })).toBeChecked(); else await expect(sections.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
    }
    await sections.scrollIntoViewIfNeeded();
    await page.getByRole('dialog', { name: 'Settings' }).screenshot({ path: testInfo.outputPath('settings-dashboard-sections.png') });
    await sections.getByRole('checkbox', { name: 'Pull requests', exact: true }).check();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(library.locator('.dashboard-pipeline h4')).toHaveText('PRs · 10');
    await expect(library.locator('.dashboard-tally')).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.mapDashboards.sections).toEqual({ ...DEFAULT_DASHBOARD_SECTIONS, pipelines: true });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    await sections.getByRole('checkbox', { name: 'Needs me', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(library.locator('h4[data-section="needs"]')).toHaveCount(0);
    await expect(library.locator('header small')).toHaveText(/^2 asking · 2 my turn · active [34]m ago · 26 items$/);
  }, undefined, defaultSections);
});

test('with every section off a dashboard is its header alone', async ({}, testInfo) => {
  await launch(async page => {
    const library = board(page);
    await expect(library).toHaveAttribute('data-mode', 'full');
    await expect(library.locator('header small')).toHaveText(/^2 asking · 2 my turn · active [34]m ago · 26 items$/);
    await expect(library.locator('h4, ul, .dashboard-block, .dashboard-summary')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('dashboard-header-only.png') });
  }, undefined, store => { const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { ...settings.value.mapDashboards, sections: { needsYou: false, working: false, todos: false, plots: false, pipelines: false, tallies: false } } } }); });
});
