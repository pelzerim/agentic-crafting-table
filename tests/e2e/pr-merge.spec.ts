import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

async function start(prefix: string, providers = githubFixture()) {
  const directory = await mkdtemp(join(tmpdir(), prefix)), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  return { providers, service, app, page: await app.firstWindow(), close: async () => { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('right-click Merge > method merges the confirmed head without opening the PR', async () => {
  const { providers, page, close } = await start('craft-pr-merge-menu-');
  try {
    const card = page.locator('[data-item-id="pr"]'), state = card.locator('[data-indicator="review-state"]');
    await expect(state).toHaveAttribute('aria-label', 'Open');
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Merge…', exact: true });
    await expect(submenu.getByRole('menuitem', { name: 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?', exact: true })).toBeDisabled();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /Merge #42/, 'Squash and merge', 'Create a merge commit', 'Rebase and merge']);
    expect(providers.merges).toHaveLength(0);
    await expect(submenu).toHaveScreenshot('context-menu-merge-confirm.png');
    // The submenu's question is the confirmation: picking a method answers it.
    await submenu.getByRole('menuitem', { name: 'Squash and merge', exact: true }).click();
    await expect(submenu.getByRole('group')).toHaveCount(0);
    await expect(state).toHaveAttribute('aria-label', 'Merged', { timeout: 20_000 });
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), method: 'SQUASH' }]);
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover();
    await expect(submenu.getByRole('menuitem', { name: 'This pull request is already merged.', exact: true })).toBeDisabled();
    expect(providers.merges).toHaveLength(1);
  } finally { await close(); }
});

test('the Merge menu shows the saved methods at once, updates them from GitHub, and an outdated pick fails and is read live next time', async () => {
  const { providers, page, close } = await start('craft-pr-merge-cached-');
  /** Holds every GitHub read until the returned function is called. */
  const hold = () => { let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); providers.delay(() => held); return () => { providers.delay(undefined); release(); }; };
  try {
    const card = page.locator('[data-item-id="pr"]'), submenu = page.getByRole('menu', { name: 'Merge…', exact: true });
    const openMerge = async () => { await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover(); };
    await expect(card.locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Open');
    await openMerge();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /Merge #42/, 'Squash and merge', 'Create a merge commit', 'Rebase and merge']);
    await page.keyboard.press('Escape');

    providers.mergeSettings = { ...providers.mergeSettings, squash: false };
    let release = hold();
    await openMerge();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /Merge #42/, 'Squash and merge', 'Create a merge commit', 'Rebase and merge']);
    release();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /Merge #42/, 'Create a merge commit', 'Rebase and merge'], { timeout: 20_000 });
    await page.keyboard.press('Escape');

    providers.mergeSettings = { ...providers.mergeSettings, rebase: false };
    release = hold();
    await openMerge();
    await submenu.getByRole('menuitem', { name: 'Rebase and merge', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Merge of #42 didn’t go through' })).toBeVisible({ timeout: 20_000 });
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), method: 'REBASE' }]);
    release();

    release = hold();
    await openMerge();
    await expect(submenu.getByRole('menuitem', { name: 'Checking merge options…', exact: true })).toBeVisible();
    release();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /Merge #42/, 'Create a merge commit'], { timeout: 20_000 });
  } finally { await close(); }
});

test('the full PR view merges with one click using the default method, and adds to a merge queue', async () => {
  const { providers, page, close } = await start('craft-pr-merge-view-');
  try {
    providers.mergeSettings = { ...providers.mergeSettings, status: 'UNSTABLE' };
    await page.locator('[data-item-id="pr"]').click();
    const merge = page.locator('.pr-merge'), menu = page.getByRole('menu', { name: 'Merge pull request', exact: true });
    await expect(merge).toBeEnabled(); await expect(merge).toHaveAttribute('data-irreversible', '');
    await prActions(page).pick('Merge');
    await expect.poll(() => providers.merges.length, { timeout: 20_000 }).toBe(1);
    await expect(menu.getByRole('menuitem')).toHaveCount(0);
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), method: 'SQUASH' }]);
    await expect(page.locator('.view-header .view-chip')).toHaveText('Merged', { timeout: 20_000 });
  } finally { await close(); }
  const queued = await start('craft-pr-merge-queue-');
  try {
    queued.providers.mergeSettings = { ...queued.providers.mergeSettings, status: 'CLEAN', queueEnabled: true };
    await queued.page.locator('[data-item-id="pr"]').click();
    await expect(queued.page.locator('.pr-merge')).toBeEnabled();
    await prActions(queued.page).pick('Merge');
    await expect(queued.page.locator('.view-header .view-meta')).toContainText('In merge queue', { timeout: 20_000 });
    await expect(queued.page.locator('.pr-merge')).toHaveAttribute('title', 'Already in the merge queue — GitHub may decline');
    expect(queued.providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), method: 'QUEUE' }]);
  } finally { await queued.close(); }
});

test('a merge GitHub declines shows its reason in the PR view and stays there through a background read', async () => {
  const { providers, page, close } = await start('craft-pr-merge-declined-');
  try {
    providers.mergeSettings = { ...providers.mergeSettings, status: 'DIRTY' };
    await page.locator('[data-item-id="pr"]').click();
    const merge = page.locator('.pr-merge'), notice = page.locator('.pr-detail > .pr-error');
    await expect(merge).toBeEnabled();
    await prActions(page).pick('Merge');
    await expect(notice).toHaveText('Merge of #42 didn’t go through: GitHub declined the merge: Pull Request is not mergeable', { timeout: 20_000 });
    await expect(notice).toBeVisible();
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), method: 'SQUASH' }]);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 16_000)));
    await expect(notice).toHaveText('Merge of #42 didn’t go through: GitHub declined the merge: Pull Request is not mergeable');
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open');
    await expect(merge).toBeEnabled();
  } finally { await close(); }
});

test('Merge stays clickable for a draft and for a saved copy GitHub could not refresh, and GitHub decides', async () => {
  const providers = githubFixture(); providers.pull = { ...providers.pull, draft: true };
  const { page, close } = await start('craft-pr-merge-draft-', providers);
  try {
    await page.locator('[data-item-id="pr"]').click();
    const merge = page.locator('.pr-merge'), menu = page.getByRole('menu', { name: 'Merge pull request', exact: true }), notice = page.locator('.pr-detail > .pr-error');
    await expect(page.locator('.view-header .view-chip')).toHaveText('Draft', { timeout: 20_000 });
    await expect(merge).toBeEnabled(); await expect(merge).toHaveAttribute('title', 'Draft — GitHub may decline');
    providers.fail(500); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.view-header .view-freshness')).toHaveText(/^Saved copy · /, { timeout: 20_000 });
    await expect(merge).toBeEnabled();
    await prActions(page).pick('Merge');
    await expect(menu.getByRole('alert')).toContainText(/.+/);
    const reason = await menu.getByRole('alert').textContent();
    await expect(notice).toHaveText(reason!);
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    providers.fail(200);
    await prActions(page).pick('Merge');
    await expect(notice).toHaveText('Merge of #42 didn’t go through: GitHub declined the merge: Pull Request is not mergeable', { timeout: 20_000 });
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), method: 'SQUASH' }]);
  } finally { await close(); }
});
