import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

/** A pull request GitHub cannot merge yet (blocked) in a repository that allows auto-merge. */
async function start(prefix: string) {
  const providers = githubFixture(); providers.mergeSettings = { ...providers.mergeSettings, status: 'BLOCKED', autoMergeAllowed: true };
  const directory = await mkdtemp(join(tmpdir(), prefix)), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  return { providers, page: await app.firstWindow(), close: async () => { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
const head = 'a'.repeat(40);

test('right-click Merge on a blocked pull request turns on merge when ready, the card shows it, and Merge then cancels it', async () => {
  const { providers, page, close } = await start('craft-pr-merge-when-ready-');
  try {
    const card = page.locator('[data-item-id="pr"]'), state = card.locator('[data-indicator="review-state"]'), submenu = page.getByRole('menu', { name: 'Merge…', exact: true });
    const openMerge = async () => { await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover(); };
    await expect(state).toHaveAttribute('aria-label', 'Open');
    await openMerge();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa when ready? Required reviews or checks are not satisfied.',
      'Squash and merge when ready', 'Create a merge commit when ready', 'Rebase and merge when ready']);
    await submenu.getByRole('menuitem', { name: 'Squash and merge when ready', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Merge when ready (squash)', { timeout: 20_000 });
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH', whenReady: true }]);

    await openMerge();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', 'Merge when ready is on: GitHub will squash and merge #42 “Make billing plan changes predictable” into main once it can. Required reviews or checks are not satisfied.',
      'Cancel merge when ready'], { timeout: 20_000 });
    await submenu.getByRole('menuitem', { name: 'Cancel merge when ready', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Open', { timeout: 20_000 });
    expect(providers.mergeCancels).toEqual(['PR_kwDOfixture42']);
    expect(providers.merges).toHaveLength(1);
  } finally { await close(); }
});

test('a merge when ready GitHub refuses because the pull request became mergeable says so, and the menu then offers to merge it at once', async () => {
  const { providers, page, close } = await start('craft-pr-merge-when-ready-clean-');
  try {
    const card = page.locator('[data-item-id="pr"]'), submenu = page.getByRole('menu', { name: 'Merge…', exact: true });
    const openMerge = async () => { await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover(); };
    await openMerge();
    await expect(submenu.getByRole('menuitem', { name: 'Squash and merge when ready', exact: true })).toBeVisible();
    providers.mergeSettings = { ...providers.mergeSettings, status: 'CLEAN' };
    await submenu.getByRole('menuitem', { name: 'Squash and merge when ready', exact: true }).click();
    const toast = page.getByRole('alert').filter({ hasText: 'Merge when ready for #42 didn’t go through' });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Open', { timeout: 20_000 });
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH', whenReady: true }]);
    await toast.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('.pr-detail > .pr-error')).toHaveText('Merge when ready for #42 didn’t go through: GitHub declined merge when ready because the pull request can be merged now. Open Merge again to merge it.', { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await openMerge();
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /^Merge #42 .* at aaaaaaa\?$/, 'Squash and merge', 'Create a merge commit', 'Rebase and merge'], { timeout: 20_000 });
  } finally { await close(); }
});

test('the full PR view turns on merge when ready in one click with the default method and names it on the meta line', async () => {
  const { providers, page, close } = await start('craft-pr-merge-when-ready-view-');
  try {
    await page.locator('[data-item-id="pr"]').click();
    await expect(page.locator('.pr-merge')).toBeEnabled();
    await prActions(page).pick('Merge');
    await expect(page.locator('.view-header .view-meta')).toContainText('Merge when ready (squash)', { timeout: 20_000 });
    expect(providers.merges).toEqual([{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH', whenReady: true }]);
    await expect(page.locator('.pr-merge')).toHaveAttribute('title', 'Merge when ready is on');
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open');
  } finally { await close(); }
});
