import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test as visualTest } from './visual-fixture.ts';
import type { GitHubClient, InboxPull } from '../../packages/provider-runtime/github.ts';

const pull = (repo: string, number: number, title: string, reasons: InboxPull['reasons'], extra: Partial<InboxPull> = {}): InboxPull => {
  const [owner, name] = repo.split('/');
  return { key: `${owner}/${name}/pull/${number}`, owner, repo: name, number, title, url: `https://github.com/${repo}/pull/${number}`, author: 'teammate', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), draft: false, comments: 3, reasons, ...extra };
};

test('the GitHub inbox opens from its rail slot, filters by reason and shows a pull request on the map', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-inbox-')), github = githubFixture();
  const items = [pull('fixture/billing', 42, 'Make billing plan changes predictable', ['review', 'assigned']), pull('fixture/api', 7, 'Rate limit exports', ['authored'], { draft: true }), pull('fixture/web', 3, 'Fix the pricing page', ['mentioned'])];
  const inboxClient = () => ({ async inbox() { return items; } }) as unknown as GitHubClient;
  const service = await startWorkspaceService(directory, undefined, undefined, { ...github, assignments: [], inboxClient });
  const settings = service.store.readSettings();
  service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, connections: github.accounts } }, service.control.registry);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const toggle = page.getByRole('button', { name: /^GitHub inbox/ });
    // Your own pull request is not news: it stays out of the Inbox tab and the badge, and shows under Yours.
    await expect(toggle).toHaveAccessibleName('GitHub inbox: 2 new, 1 review requested', { timeout: 8_000 });
    await expect(page.locator('.github-inbox-toggle .github-inbox-count')).toHaveText('2');
    await toggle.hover();
    const panel = page.getByRole('dialog', { name: 'GitHub inbox' });
    await expect(panel.locator('.github-inbox-list li')).toHaveCount(2);
    await expect(panel.locator('li[data-key="fixture/api/pull/7"]')).toHaveCount(0);
    await expect(panel.getByRole('tab')).toHaveText(['Inbox 2', 'Needs review 1', 'Assigned 1', 'Yours 1', 'Mentioned 1']);
    await expect(panel.getByRole('tab', { name: /^Inbox/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.tool-rail-slot[data-slot=inbox]')).toHaveAttribute('data-active', 'true');
    await page.screenshot({ path: 'test-results/github-inbox.png' });
    await panel.getByRole('tab', { name: /^Yours/ }).click();
    const own = panel.locator('li[data-key="fixture/api/pull/7"]');
    await expect(own).toBeVisible(); await expect(own).not.toHaveAttribute('data-seen', 'true');
    await expect(own.getByRole('button', { name: /seen$|Back to inbox/ })).toHaveCount(0);
    await panel.getByRole('tab', { name: /Needs review/ }).click();
    await expect(panel.locator('.github-inbox-list li')).toHaveCount(1);
    const row = panel.locator('li[data-key="fixture/billing/pull/42"]');
    await expect(row).toContainText('Review requested'); await expect(row).toContainText('Assigned');
    await row.getByRole('button', { name: 'Show on map', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Open on map', exact: true })).toBeVisible();
    const state = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const resource = state.resources.find(record => record.pluginId === 'github.pull-request' && record.data.number === 42)!;
    expect(resource.connectionId).toBe('github-fixture');
    await expect(page.locator(`[data-item-id="${state.nodes.find(node => node.resourceId === resource.id)!.id}"]`)).toBeVisible();
    // Hover-open closes when the pointer leaves; a click keeps it open until clicked again or Escape.
    await page.mouse.move(900, 700); await expect(panel).toHaveCount(0);
    await toggle.click(); await page.mouse.move(900, 700); await page.waitForTimeout(400); await expect(panel).toBeVisible();
    await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
    // Both tools open beside the rail, never over it; the inbox keeps the size it was given.
    const rail = (await page.locator('.tool-rail').boundingBox())!;
    await toggle.click(); await expect.poll(async () => (await panel.boundingBox())!.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    const grip = panel.getByRole('button', { name: 'Resize github inbox' }), handle = (await grip.boundingBox())!, width = Math.round((await panel.boundingBox())!.width);
    await page.mouse.move(handle.x + 8, handle.y + 8); await page.mouse.down(); await page.mouse.move(handle.x + 88, handle.y + 48, { steps: 4 }); await page.mouse.up();
    await expect(panel).toHaveCSS('width', `${width + 80}px`);
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead())).inboxPanel?.width).toBe(width + 80);
    await page.keyboard.press('Escape'); await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.getByRole('button', { name: /^GitHub inbox/ }).click(); await expect(panel).toHaveCSS('width', `${width + 80}px`);
    await expect.poll(async () => (await panel.boundingBox())!.x).toBe(rail.x + rail.width + 8);
    await page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click();
    await expect.poll(async () => (await page.locator('.todo-overlay .rail-panel-sheet').boundingBox())!.x).toBe(rail.x + rail.width + 8);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rail tools share one open sheet and one open indicator; hidden pull requests stay hidden and the list stays cached', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-inbox-')), github = githubFixture();
  let calls = 0;
  const items = [pull('fixture/billing', 42, 'Make billing plan changes predictable', ['review']), pull('fixture/api', 7, 'Rate limit exports', ['mentioned'])];
  const inboxClient = () => ({ async inbox() { calls++; return items; } }) as unknown as GitHubClient;
  const service = await startWorkspaceService(directory, undefined, undefined, { ...github, assignments: [], inboxClient });
  const settings = service.store.readSettings();
  service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, connections: github.accounts } }, service.control.registry);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const inbox = page.getByRole('dialog', { name: 'GitHub inbox' }), todos = page.locator('.todo-overlay'), active = page.locator('.tool-rail-slot[data-active]');
    const inboxToggle = page.locator('.github-inbox-toggle'), todoToggle = page.locator('.todo-toggle');
    await todoToggle.click(); await expect(todos).toHaveAttribute('data-open', 'true');
    await expect(active).toHaveCount(1); await expect(active).toHaveAttribute('data-slot', 'todos');
    // Pinning the inbox unpins and closes the to-dos.
    await inboxToggle.click(); await expect(inbox).toBeVisible(); await expect(todos).toHaveAttribute('data-open', 'false');
    await expect(todoToggle).toHaveAccessibleName('Keep to-dos open');
    await expect(active).toHaveCount(1); await expect(active).toHaveAttribute('data-slot', 'inbox');
    // Hovering the to-dos peeks over the pinned inbox, which returns when the pointer leaves.
    await todoToggle.hover(); await expect(todos).toHaveAttribute('data-open', 'true'); await expect(inbox).toHaveCount(0);
    await expect(active).toHaveAttribute('data-slot', 'todos');
    await page.mouse.move(900, 700); await expect(todos).toHaveAttribute('data-open', 'false'); await expect(inbox).toBeVisible();
    // Hiding a pull request removes it now and for good.
    await inbox.locator('li[data-key="fixture/api/pull/7"]').getByRole('button', { name: 'Hide fixture/api #7 from the inbox' }).click();
    await expect(inbox.locator('.github-inbox-list li')).toHaveCount(1);
    // Travelling to Undermap closes every sheet; the Undermap slot shows it is open.
    await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
    await expect(inbox).toHaveCount(0); await expect(todos).toHaveAttribute('data-open', 'false');
    await expect(active).toHaveCount(1); await expect(active).toHaveAttribute('data-slot', 'undermap');
    await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
    const before = calls;
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.locator('.github-inbox-toggle').click();
    await expect(inbox.locator('.github-inbox-list li')).toHaveCount(1);
    await expect(inbox.locator('li[data-key="fixture/billing/pull/42"]')).toBeVisible();
    expect(calls).toBe(before); // The saved list shows at once, without another GitHub read.
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the inbox body shows loading rows, a failed read as an alert with Retry, and refreshes from an icon', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-inbox-')), github = githubFixture();
  let release: (() => void) | undefined, mode: 'hang' | 'fail' | 'ok' = 'hang', reads = 0;
  const items = [pull('fixture/billing', 42, 'Make billing plan changes predictable', ['review'])];
  const inboxClient = () => ({ async inbox() {
    reads++;
    if (mode === 'hang') await new Promise<void>(resolve => { release = resolve; });
    if (mode === 'fail') throw Object.assign(new Error('GitHub returned 502 Bad Gateway'), { retryAt: 0 });
    return items;
  } }) as unknown as GitHubClient;
  const service = await startWorkspaceService(directory, undefined, undefined, { ...github, assignments: [], inboxClient });
  const settings = service.store.readSettings();
  service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, connections: github.accounts } }, service.control.registry);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.locator('.github-inbox-toggle').click();
    const panel = page.getByRole('dialog', { name: 'GitHub inbox' });
    await expect(panel.locator('.github-inbox-skeleton li')).toHaveCount(3);
    await expect(panel.getByRole('status')).toHaveText('Loading pull requests…');
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    mode = 'fail'; release?.();
    const alert = panel.getByRole('alert');
    await expect(alert).toContainText("Couldn't refresh · GitHub returned 502 Bad Gateway");
    const before = reads; await alert.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(before); await expect(alert).toBeVisible();
    // A background refresh may also clear the alert once GitHub answers again.
    mode = 'ok';
    await expect(async () => {
      if (await alert.count()) await alert.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 1_000 });
      await expect(alert).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(panel.locator('.github-inbox-list li')).toHaveCount(1);
    const refresh = panel.getByRole('button', { name: 'Refresh GitHub inbox', exact: true });
    await expect(refresh).toHaveText(''); await expect(refresh).toHaveAttribute('title', /^Updated just now/);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Seen moves a pull request out of the Inbox tab into the reason tabs until it has new activity', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-inbox-seen-')), github = githubFixture();
  const items = [pull('fixture/billing', 42, 'Make billing plan changes predictable', ['review', 'assigned']), pull('fixture/api', 7, 'Rate limit exports', ['mentioned'], { draft: true }), pull('fixture/web', 3, 'Fix the pricing page', ['mentioned']),
    pull('fixture/web', 9, 'Tidy the footer', ['authored', 'mentioned'])];
  const inboxClient = () => ({ async inbox() { return items; } }) as unknown as GitHubClient;
  const service = await startWorkspaceService(directory, undefined, undefined, { ...github, assignments: [], inboxClient });
  const settings = service.store.readSettings();
  service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, connections: github.accounts } }, service.control.registry);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const toggle = page.locator('.github-inbox-toggle'), badge = toggle.locator('.github-inbox-count'), panel = page.getByRole('dialog', { name: 'GitHub inbox' });
    const rows = panel.locator('.github-inbox-list li'), tab = (name: string) => panel.getByRole('tab', { name: new RegExp(`^${name}`) });
    await expect(badge).toHaveText('3', { timeout: 8_000 });
    await toggle.click();
    await expect(rows).toHaveCount(3);
    await expect(rows.first().getByRole('button', { name: 'Back to inbox' })).toHaveCount(0);
    await page.waitForTimeout(400); await page.screenshot({ path: '.local/github-inbox-seen/inbox-tab.png' });

    await panel.locator('li[data-key="fixture/api/pull/7"]').getByRole('button', { name: 'Mark fixture/api #7 seen' }).click();
    await expect(rows).toHaveCount(2); await expect(tab('Inbox')).toHaveText('Inbox 2');
    await expect(badge).toHaveText('2'); await expect(toggle).toHaveAccessibleName('Close GitHub inbox');

    await tab('Mentioned').click();
    const seenRow = panel.locator('li[data-key="fixture/api/pull/7"]');
    await expect(seenRow).toHaveAttribute('data-seen', 'true');
    await expect(seenRow.getByRole('button', { name: /seen$/ })).toHaveCount(0);
    await expect(seenRow.getByRole('button', { name: 'Hide fixture/api #7 from the inbox' })).toBeVisible();
    await expect(seenRow.getByRole('button', { name: 'Back to inbox', exact: true })).toBeVisible();
    await page.screenshot({ path: '.local/github-inbox-seen/seen-row-mentioned-tab.png' });

    await tab('Inbox').click();
    await panel.locator('li[data-key="fixture/billing/pull/42"]').getByRole('button', { name: /seen$/ }).click();
    // A middle click anywhere on a row opens the pull request on GitHub and marks it seen.
    await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
    await panel.locator('li[data-key="fixture/web/pull/3"] small').first().click({ button: 'middle' });
    await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrls.slice() as string[])).toEqual(['https://github.com/fixture/web/pull/3']);
    await expect(rows).toHaveCount(0); await expect(panel.locator('.github-inbox-empty')).toHaveText('Nothing new');
    await expect(badge).toHaveCount(0);
    await page.screenshot({ path: '.local/github-inbox-seen/inbox-empty.png' });
    await page.keyboard.press('Escape'); await expect(toggle).toHaveAccessibleName('GitHub inbox');

    // Seen survives a reload; Back to inbox returns a row at once.
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await toggle.click(); await expect(panel.locator('.github-inbox-empty')).toHaveText('Nothing new');
    await tab('Needs review').click();
    await panel.locator('li[data-key="fixture/billing/pull/42"]').getByRole('button', { name: 'Back to inbox', exact: true }).click();
    await expect(panel.locator('li[data-key="fixture/billing/pull/42"]')).not.toHaveAttribute('data-seen', 'true');
    await tab('Inbox').click(); await expect(rows).toHaveCount(1);
    await expect(toggle).toHaveAccessibleName('Close GitHub inbox');
    await expect(badge).toHaveText('1');

    // New activity on GitHub brings a seen pull request back.
    items[1] = { ...items[1], updatedAt: new Date().toISOString() };
    await panel.getByRole('button', { name: 'Refresh GitHub inbox', exact: true }).click();
    await expect(rows).toHaveCount(2); await expect(panel.locator('li[data-key="fixture/api/pull/7"]')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(toggle).toHaveAccessibleName('GitHub inbox: 2 new, 1 review requested');
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

visualTest('without a GitHub account the inbox offers Open Connections, which opens Settings on Connections', async ({ visual: { page } }) => {
  await page.locator('.github-inbox-toggle').click();
  const panel = page.getByRole('dialog', { name: 'GitHub inbox' });
  await expect(panel).toContainText('Connect GitHub to see pull requests that involve you.');
  await expect(panel.getByRole('tablist')).toHaveCount(0);
  await expect(panel).toHaveScreenshot('github-inbox-not-connected.png');
  await panel.getByRole('button', { name: 'Open Connections', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible(); await expect(settings.getByRole('treeitem', { name: 'Connections', exact: true })).toHaveAttribute('aria-selected', 'true');
});
