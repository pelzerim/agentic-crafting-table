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
import { plotProject } from '../fixtures/plot-project.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
/** The world point at the centre of the map area. */
async function centre(page: Page) {
  const view = await camera(page), area = (await page.locator('.map-area').boundingBox())!;
  return { x: (area.width / 2 - view.x) / view.zoom, y: (area.height / 2 - view.y) / view.zoom, zoom: view.zoom };
}
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'column-fixture' }, commands }); }, JSON.stringify(commands));
}
const turnSummaries = (store: SqliteStore, on: boolean) => { const current = store.readSettings(); store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, projectSummaries: on } } }); };
const needsMe = (page: Page, count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });

/** Six projects on the Map and one muted: three need me, agents work in three, one was active recently, two are quiet. */
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
  item('parser', 'infra', 'fix(backend): flag private-location agents below 8.12.0 as outdated so the version parse never trips on a missing build number', 450, 1200, { attention: 'review', activityAt: ago(9) });
  item('notes', 'recent', 'Release notes', 1720, 1200, { activityAt: ago(30) });
  item('guide', 'docs', 'Style guide', 3320, 0, { activityAt: ago(3 * 1440) });
  item('old', 'archive', 'Old ticket', 3320, 1200, {});
  item('question', 'night', 'Night agent', 4920, 0, { attention: 'input', activityAt: ago(2) }, true);
  return stateSchema.parse({ version: 1, revision: 0, nodes, resources, links: [], todos: [], view: {} });
}

async function launch(run: (page: Page) => Promise<void>, options: { mapCorner?: MapCorner; prepare?(store: SqliteStore): void; state?: () => ReturnType<typeof workspace> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-project-column-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => (options.state ?? workspace)()); await store.writeView('desktop', { camera: { x: 200, y: 120, zoom: .4 } });
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
    const column = page.getByRole('group', { name: /^Projects: 6, 4 waiting on me\./ });
    await expect(column).toBeVisible();
    await expect(page.locator('.map-locator.atlas')).toHaveCount(0);
    expect(await column.locator('[data-project-icon]').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-project-icon')))).toEqual(['billing', 'runner', 'infra', 'recent', 'docs', 'archive']);
    // A badge only where something waits on me: the top tier and its count; working agents earn none.
    expect(await column.locator('[data-project-icon]').evaluateAll(icons => icons.map(icon => [icon.getAttribute('data-mark'), icon.querySelector('.project-icon-mark')?.textContent ?? '']))).toEqual([['asking', '1'], ['turn', '1'], ['turn', '1'], ['idle', ''], ['idle', ''], ['idle', '']]);
    // Each icon carries a tag on the project colour; quiet projects dim.
    expect(await column.locator('.project-icon-tag').allTextContents()).toEqual(['BIL', 'ER', 'INF', 'REC', 'DOC', 'ARC']);
    expect(await column.locator('[data-project-icon][data-quiet]').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-project-icon')))).toEqual(['docs', 'archive']);
    await expect(column.locator('[data-project-icon][data-new]')).toHaveCount(0);
    expect((await column.boundingBox())!.width).toBe(44);
    // The zoom bar sits in the bottom-left corner, right of the rail, clear of the column.
    const bar = (await page.locator('.zoom-markers').boundingBox())!, corner = (await column.boundingBox())!, area = (await page.locator('.map-area').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(70); expect(bar.x + bar.width).toBeLessThan(corner.x);
    expect(area.y + area.height - (bar.y + bar.height)).toBeLessThan(40);
    // Hovering an icon names the project and lists what waits on me there.
    await column.locator('[data-project-icon="billing"]').hover();
    const tip = page.getByRole('tooltip');
    await expect(tip.locator('strong')).toHaveText('Billing');
    await expect(tip.locator('.project-column-tip-row')).toHaveText(['Webhook agent — Waiting for your input', 'PR 812 refunds — Ready for your review']);
    await expect(tip.locator('.project-column-tip-next')).toHaveCount(0);
    await expect(tip.locator('.project-column-tip-meta')).toHaveText('1 working');
    await column.locator('[data-project-icon="recent"]').hover();
    await expect(tip.locator('.project-column-tip-meta')).toHaveText('Nothing open');
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

test('unfolded, each project says what waits on me, once: its Needs me rows and what else is open; a row centres its item without opening it', async () => {
  await launch(async page => {
    await expect(needsMe(page, 4)).toBeVisible();
    await page.keyboard.press('m');
    const panel = page.getByRole('region', { name: 'Projects', exact: true });
    await expect(panel).toBeVisible();
    // Nothing in the panel runs past its edge: long rows end in an ellipsis.
    const overflow = await page.locator('.project-column-panel').evaluate(panel => [panel, ...panel.querySelectorAll('.project-column-row, .project-column-entry, .project-column-meta')].filter(element => element.scrollWidth > element.clientWidth + 1).length);
    expect(overflow).toBe(0);
    await expect(panel).toBeVisible();
    await expect(page.locator('.map-locator.project-column')).toBeHidden();
    await expect(page.locator('.zoom-markers')).toBeHidden();
    expect(await panel.locator('[data-project-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-project-row')))).toEqual(['billing', 'runner', 'infra', 'recent']);
    const billing = panel.locator('[data-project-row="billing"]');
    // Without written lines there is no Next or Status: the rows are the facts, nothing restates them.
    await expect(billing.locator('.project-column-next, .project-column-status, .project-column-pen')).toHaveCount(0);
    expect(await billing.locator('[data-need-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-need-row')))).toEqual(['ask', 'refund']);
    await expect(billing.getByText('Refund fixer')).toHaveCount(0);
    await expect(billing.locator('.project-column-meta')).toHaveText('1 working');
    await expect(billing.locator('[data-plot-header]')).toHaveCount(0);
    const infra = panel.locator('[data-project-row="infra"]');
    await expect(infra.locator('.project-column-meta')).toHaveText('1 working');
    await expect(panel.locator('[data-project-row="recent"] .project-column-meta')).toHaveCount(0);
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
    await expect(needsMe(page, 4)).toBeVisible();
    await expect(panel).toBeVisible();
    // The panel stays beside Needs me, and beside an item opened from it; Esc closes Needs me first.
    const sheet = page.getByRole('dialog', { name: 'Needs me', exact: true });
    await page.keyboard.press('n');
    await expect(sheet).toBeVisible();
    await expect(panel).toBeVisible();
    await sheet.getByRole('button', { name: 'Open Webhook agent', exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'ask');
    await expect(panel).toBeVisible();
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await page.keyboard.press('n');
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(panel).toBeVisible();
    // From inside the panel, Esc folds the panel and leaves Needs me open.
    await page.keyboard.press('n'); await expect(sheet).toBeVisible();
    await panel.getByRole('checkbox', { name: 'Needs me' }).focus();
    await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0);
    await page.keyboard.press('m'); await expect(panel).toBeVisible();
    await page.mouse.move(4, 4);
    await expect(panel).toHaveScreenshot('project-column-open.png', { mask: [panel.locator('small'), panel.locator('.project-column-status')] });
  });
});

test('the panel resizes from its corner, folds rows, filters by Needs me and type, stays open beside an open item and, pinned, beside Needs me', async () => {
  await launch(async page => {
    const panel = page.getByRole('region', { name: 'Projects', exact: true }), area = page.locator('.map-area');
    await page.keyboard.press('m');
    await expect(panel).toBeVisible();
    // A click on the corner without a drag saves no size; a drag grows the panel up and left; the size and folds survive a reload.
    await panel.getByRole('button', { name: 'Resize the projects panel' }).click();
    expect((await page.evaluate(() => window.craftingTable.viewRead()))?.projectsPanel?.height).toBeUndefined();
    const before = (await panel.boundingBox())!, grip = (await panel.getByRole('button', { name: 'Resize the projects panel' }).boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 100, grip.y + grip.height / 2 - 60, { steps: 4 }); await page.mouse.up();
    const after = (await panel.boundingBox())!;
    expect(Math.round(after.width - before.width)).toBe(100); expect(Math.round(after.x + after.width)).toBe(Math.round(before.x + before.width));
    const billing = panel.locator('[data-project-row="billing"]');
    await billing.getByRole('button', { name: 'Fold Billing' }).click();
    await expect(billing.getByRole('button', { name: 'Unfold Billing' })).toHaveAttribute('aria-expanded', 'false');
    await expect(billing.locator('[data-need-row]')).toHaveCount(0);
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.keyboard.press('m');
    expect(Math.round((await panel.boundingBox())!.width)).toBe(Math.round(after.width));
    await expect(billing.locator('[data-need-row]')).toHaveCount(0);
    await billing.getByRole('button', { name: 'Unfold Billing' }).click();
    // Unticked, Needs me lists every item, what waits on me first; a type chip hides its items.
    await panel.getByRole('checkbox', { name: 'Needs me' }).uncheck();
    expect(await billing.locator('[data-item-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-item-row')))).toEqual(['refund', 'ask', 'fixer']);
    await expect(billing.getByRole('button', { name: 'Refund fixer: Working. Open' })).toBeVisible();
    await panel.getByRole('button', { name: 'Tickets', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Tickets', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(await billing.locator('[data-item-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-item-row')))).toEqual(['ask', 'fixer']);
    // An item row opens its item; the panel stays; another item row closes it and opens that one; M folds and unfolds it meanwhile.
    await billing.getByRole('button', { name: 'Webhook agent: Asking me. Open' }).click();
    await expect(area).toHaveAttribute('data-focus', 'ask');
    await expect(panel).toBeVisible();
    await panel.locator('[data-item-row="budget"] button').click();
    await expect(area).toHaveAttribute('data-focus', 'budget');
    await expect(panel).toBeVisible();
    // With Needs me ticked, a Needs me row also opens its item in place of the open one.
    await panel.getByRole('checkbox', { name: 'Needs me' }).check(); await panel.getByRole('button', { name: 'Tickets', exact: true }).click();
    await billing.locator('[data-need="refund"]').click();
    await expect(area).toHaveAttribute('data-focus', 'refund');
    await panel.getByRole('button', { name: 'Keep the projects panel open' }).focus(); await page.keyboard.press('m');
    await expect(panel).toHaveCount(0); await expect(area).toHaveAttribute('data-focus', 'refund');
    await page.keyboard.press('m');
    await expect(panel).toBeVisible();
    // Pinned, Needs me and Esc leave it open and clickable; M folds it and unpins.
    await panel.getByRole('button', { name: 'Keep the projects panel open' }).click();
    await expect(panel.getByRole('button', { name: 'Keep the projects panel open' })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press('Escape');
    await expect(area).toHaveAttribute('data-focus', '');
    await page.keyboard.press('n');
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toBeVisible();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Fold Edge runtime' }).click();
    await expect(panel.getByRole('button', { name: 'Unfold Edge runtime' })).toBeVisible();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(panel).toBeVisible();
    await page.keyboard.press('m');
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('m');
    await expect(panel.getByRole('button', { name: 'Keep the projects panel open' })).toHaveAttribute('aria-pressed', 'false');
  });
});

test('a saved width wider than the window is capped, so the panel and its corner grip stay inside the window', async () => {
  await launch(async page => {
    await page.setViewportSize({ width: 760, height: 800 });
    await page.keyboard.press('m');
    const panel = page.getByRole('region', { name: 'Projects', exact: true }), grip = (await panel.getByRole('button', { name: 'Resize the projects panel' }).boundingBox())!;
    expect(grip.x).toBeGreaterThanOrEqual(0); expect((await panel.boundingBox())!.width).toBeLessThan(760);
  }, { prepare: store => store.writeView('desktop', { camera: { x: 200, y: 120, zoom: .4 }, projectsPanel: { width: 900 } }) });
});

test('written Next and Status lines appear under the rows, marked as written by the summary model; off, they leave', async () => {
  const seed = (store: SqliteStore, on: boolean) => {
    turnSummaries(store, on);
    // Attempted now, so the helper waits ten minutes before it would ask again.
    store.reserveProjectSummary('billing', 'seeded', store.readSettings().value.summaries, Date.now(), 0);
    store.finishProjectSummary('billing', 'seeded', `{"next":"Answer the Webhook agent about retries.","status":"Refund PR waits on your review; the webhook agent asks about retries."}`, 'haiku');
  };
  await launch(async page => {
    const panel = page.getByRole('region', { name: 'Projects', exact: true });
    await page.keyboard.press('m');
    const billing = panel.locator('[data-project-row="billing"]');
    await expect(billing.locator('.project-column-next')).toHaveText('Answer the Webhook agent about retries. (written by the summary model)');
    await expect(billing.locator('.project-column-status')).toHaveText('Refund PR waits on your review; the webhook agent asks about retries. (written by the summary model)');
    await expect(billing.locator('.project-column-status')).toHaveAttribute('title', 'Written by the summary model');
    await expect(billing.locator('.project-column-pen')).toHaveCount(1);
    expect(await billing.locator('[data-need-row], .project-column-next, .project-column-status, .project-column-meta').evaluateAll(parts => parts.map(part => part.className.replace('project-column-', '')))).toEqual(['entry', 'entry', 'next', 'status', 'meta']);
    const runner = panel.locator('[data-project-row="runner"]');
    await expect(runner.locator('.project-column-next, .project-column-status, .project-column-pen')).toHaveCount(0);
  }, { prepare: store => seed(store, true) });
  await launch(async page => {
    const panel = page.getByRole('region', { name: 'Projects', exact: true });
    await page.keyboard.press('m');
    const billing = panel.locator('[data-project-row="billing"]');
    await expect(billing.locator('[data-need-row]')).toHaveCount(2);
    await expect(billing.locator('.project-column-next, .project-column-status, .project-column-pen')).toHaveCount(0);
  }, { prepare: store => seed(store, false) });
});

test('a new Needs me row edges its icon in copper until the column is unfolded', async () => {
  await launch(async page => {
    const column = page.getByRole('group', { name: /^Projects: 6/ }), runner = column.locator('[data-project-icon="runner"]');
    await expect(column).toBeVisible();
    await expect(column.locator('[data-project-icon][data-new]')).toHaveCount(0);
    await apply(page, [{ type: 'node.update', id: 'budget', attention: 'input', attentionNote: 'Agent asked a question' }]);
    await expect(runner).toHaveAttribute('data-new', '');
    await expect(column.locator('[data-project-icon][data-new]')).toHaveCount(1);
    const copper = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--act-copper)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    expect(await runner.evaluate(element => getComputedStyle(element, '::before').backgroundColor)).toBe(copper);
    await page.keyboard.press('m');
    await expect(page.getByRole('region', { name: 'Projects', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(runner).toBeVisible();
    await expect(runner).not.toHaveAttribute('data-new', '');
  });
});

test('Seen, the one action a row reveals on hover, acknowledges it as the Needs me sheet does', async () => {
  await launch(async page => {
    await expect(needsMe(page, 4)).toBeVisible();
    await page.keyboard.press('m');
    const panel = page.getByRole('region', { name: 'Projects', exact: true }), billing = panel.locator('[data-project-row="billing"]');
    const row = billing.locator('[data-need-row="refund"]'), seen = row.locator('.project-column-seen');
    expect(await seen.evaluate(button => getComputedStyle(button).visibility)).toBe('hidden');
    await row.hover();
    expect(await seen.evaluate(button => getComputedStyle(button).visibility)).toBe('visible');
    await expect(row.getByRole('button')).toHaveCount(2);
    await row.getByRole('button', { name: 'Mark PR 812 refunds seen' }).click();
    // A review request still waits on the person after Seen: the row stays, dimmed, without a Seen action, and leaves the counts.
    await expect(billing.locator('[data-need-row="refund"]')).toHaveAttribute('data-seen', 'true');
    await expect(billing.locator('[data-need-row="refund"]').getByRole('button', { name: /Mark .* seen/ })).toHaveCount(0);
    await expect(needsMe(page, 3)).toBeVisible();
  });
});

test('a project whose Needs me rows span two plots groups them by plot; a plot header flies there; with rows in one plot there is no header', async () => {
  const asked = (ids: string[]) => () => {
    const state = plotProject();
    return { ...state, nodes: state.nodes.map(node => ids.includes(node.id) ? { ...node, attention: 'input' as const, attentionAt: new Date(Date.now() - 2 * 60_000).toISOString() } : node) };
  };
  await launch(async page => {
    await page.keyboard.press('m');
    const panel = page.getByRole('region', { name: 'Projects', exact: true }), row = panel.locator('[data-project-row="photos"]');
    await expect(row.locator('[data-plot-header]')).toHaveCount(2);
    expect(await row.locator('[data-plot-header], .project-column-loose').evaluateAll(heads => heads.map(head => head.getAttribute('aria-label') ?? head.textContent))).toEqual(['Plot Thumbnail: 1 asking, 1 working. Fly there', 'Plot Billing: 1 my turn, 1 working. Fly there', 'Loose']);
    await expect(row.locator('[data-plot-header]')).toHaveText(['Thumbnail', 'Billing']);
    expect(await row.locator('[data-need-row]').evaluateAll(rows => rows.map(entry => entry.getAttribute('data-need-row')))).toEqual(['thumb-agent', 'billing-pr', 'changelog']);
    await expect(row.locator('.project-column-meta')).toHaveText('2 working');
    await row.getByRole('button', { name: /^Plot Billing: / }).click();
    await expect.poll(async () => { const point = await centre(page); return point.x > 850 && point.x < 1250 && point.y > 150 && point.y < 360; }).toBe(true);
  }, { state: asked(['thumb-agent', 'changelog']) });
  await launch(async page => {
    await page.keyboard.press('m');
    const row = page.getByRole('region', { name: 'Projects', exact: true }).locator('[data-project-row="photos"]');
    await expect(row.locator('[data-need-row]')).toHaveCount(1);
    await expect(row.locator('[data-plot-header], .project-column-loose')).toHaveCount(0);
  }, { state: plotProject });
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
