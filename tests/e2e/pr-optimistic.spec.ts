import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { enableShowShip, githubFixture, pullFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

const base = pullFixture.title, evidence = join(process.cwd(), '.local', 'optimistic-github');
async function start(prefix: string, providers = githubFixture()) {
  const directory = await mkdtemp(join(tmpdir(), prefix)), service = await startWorkspaceService(directory, undefined, undefined, providers);
  enableShowShip(service.store);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  return { providers, service, app, page: await app.firstWindow(), close: async () => { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
/** GitHub takes as long as the test likes to answer a write. */
function slow(providers: ReturnType<typeof githubFixture>) {
  let answer!: () => void; const answered = new Promise<void>(resolve => { answer = resolve; });
  providers.holdWrites(() => answered);
  return answer;
}
const shot = async (page: Page, name: string) => { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name) }); };
const parts = (page: Page) => {
  const view = page.locator('[data-expanded-item-id="pr"].expanded'), card = page.locator('[data-item-id="pr"]');
  return { view, card, chip: view.locator('.view-header .view-chip'), notice: view.locator('.pr-error'), state: page.locator('[data-item-id="pr"] [data-indicator="review-state"]').first(), pending: page.locator('[data-item-id="pr"] [data-indicator="pending"]').first() };
};

test('a slow merge shows Merged · confirming at once on the view and the card, then confirmed', async () => {
  const { providers, page, close } = await start('craft-pr-optimistic-merge-');
  try {
    const answer = slow(providers), { view, chip, state, pending } = parts(page);
    await page.locator('[data-item-id="pr"]').click();
    await expect(chip).toHaveText('Open', { timeout: 20_000 });
    await prActions(page, view).pick('Merge');
    await expect(page.getByRole('menu', { name: 'Merge pull request', exact: true })).toHaveCount(0);
    await expect(chip).toHaveText('Merged · confirming'); await expect(chip).toHaveAttribute('data-pending', '');
    await expect(state).toHaveAttribute('aria-label', 'Merged'); await expect(pending).toHaveAttribute('aria-label', 'Confirming');
    await expect(view.locator('.pr-merge')).toBeDisabled();
    expect(providers.merges).toHaveLength(0);
    await shot(page, 'merge-confirming-view-and-card.png');
    answer();
    await expect(chip).toHaveText('Merged', { timeout: 20_000 }); await expect(chip).not.toHaveAttribute('data-pending', '');
    await expect(pending).toHaveCount(0); await expect(state).toHaveAttribute('aria-label', 'Merged');
    expect(providers.merges).toHaveLength(1);
  } finally { await close(); }
});

test('a declined merge shows Merged briefly, then goes back with the reason and a notification', async () => {
  const { providers, page, close } = await start('craft-pr-optimistic-declined-');
  try {
    providers.mergeSettings = { ...providers.mergeSettings, status: 'DIRTY' };
    const answer = slow(providers), { view, chip, notice, state, pending } = parts(page);
    await page.locator('[data-item-id="pr"]').click();
    await expect(chip).toHaveText('Open', { timeout: 20_000 });
    await prActions(page, view).pick('Merge');
    await expect(chip).toHaveText('Merged · confirming'); await expect(state).toHaveAttribute('aria-label', 'Merged');
    answer();
    await expect(chip).toHaveText('Open', { timeout: 20_000 }); await expect(state).toHaveAttribute('aria-label', 'Open'); await expect(pending).toHaveCount(0);
    await expect(notice).toHaveText('Merge of #42 didn’t go through: GitHub declined the merge: Pull Request is not mergeable');
    const toast = page.getByRole('alert').filter({ hasText: 'Merge of #42 didn’t go through' });
    await expect(toast).toBeVisible();
    await expect(view.locator('.pr-merge')).toBeEnabled();
    await shot(page, 'merge-declined-reverted-notice.png');
    expect(providers.merges).toHaveLength(1);
  } finally { await close(); }
});

test('Show/Ship retitles at once and a declined retitle goes back with its reason', async () => {
  const { providers, page, close } = await start('craft-pr-optimistic-show-ship-');
  try {
    const { view, chip, notice } = parts(page), heading = page.locator('.expanded .card-heading .card-label strong');
    await page.locator('[data-item-id="pr"]').click();
    await expect(chip).toHaveText('Open', { timeout: 20_000 });
    const menu = page.getByRole('menu', { name: 'Show or ship', exact: true });
    let answer = slow(providers);
    await prActions(page, view).pick(/^(Show\/Ship|Show|Ship)$/); await menu.getByRole('menuitem', { name: '[ship]', exact: true }).click();
    await expect(heading).toHaveText(`[ship] ${base}`); await expect(view.locator('.pr-show-ship')).toHaveText('Ship');
    await expect(chip).toHaveText('Open · confirming');
    expect(providers.titles).toHaveLength(0);
    answer();
    await expect(chip).toHaveText('Open', { timeout: 20_000 }); await expect(heading).toHaveText(`[ship] ${base}`);
    answer = slow(providers);
    providers.replyToTitle(() => ({ status: 422, body: { message: 'Validation Failed' }, headers: new Headers() }));
    await prActions(page, view).pick(/^(Show\/Ship|Show|Ship)$/); await menu.getByRole('menuitemradio', { name: '[show]', exact: true }).click();
    await expect(heading).toHaveText(`[show] ${base}`);
    answer();
    await expect(heading).toHaveText(`[ship] ${base}`, { timeout: 20_000 });
    await expect(notice).toHaveText('Retitle of #42 didn’t go through: GitHub declined the new title.');
    expect(providers.titles).toEqual([`[ship] ${base}`, `[show] ${base}`]);
  } finally { await close(); }
});

test('closing shows Closed at once and a refused close reopens with its reason', async () => {
  const { providers, page, close } = await start('craft-pr-optimistic-close-');
  try {
    const { view, chip, notice, state } = parts(page);
    await page.locator('[data-item-id="pr"]').click();
    await expect(chip).toHaveText('Open', { timeout: 20_000 });
    let answer = slow(providers);
    await prActions(page, view).pick('Close…');
    let confirm = page.getByRole('menu', { name: 'Close…', exact: true }).getByRole('group', { name: 'Close pull request…', exact: true });
    await confirm.getByRole('menuitem', { name: 'Close pull request', exact: true }).click();
    await expect(chip).toHaveText('Closed · confirming'); await expect(state).toHaveAttribute('aria-label', 'Closed');
    await expect(view.locator('.pr-close-toggle')).toHaveText('Reopen');
    answer();
    await expect(chip).toHaveText('Closed', { timeout: 20_000 });
    await prActions(page, view).pick('Reopen');
    await page.getByRole('menu', { name: 'Reopen', exact: true }).getByRole('menuitem', { name: 'Reopen pull request', exact: true }).click();
    await expect(chip).toHaveText('Open', { timeout: 20_000 });
    answer = slow(providers);
    providers.replyToState(() => ({ status: 422, headers: new Headers(), body: { message: 'Validation Failed' } }));
    await prActions(page, view).pick('Close…');
    confirm = page.getByRole('menu', { name: 'Close…', exact: true }).getByRole('group', { name: 'Close pull request…', exact: true });
    await confirm.getByRole('menuitem', { name: 'Close pull request', exact: true }).click();
    await expect(chip).toHaveText('Closed · confirming');
    answer();
    await expect(chip).toHaveText('Open', { timeout: 20_000 }); await expect(state).toHaveAttribute('aria-label', 'Open');
    await expect(notice).toHaveText(/^Closing #42 didn’t go through: GitHub declined/);
    expect(providers.states).toEqual(['closed', 'open', 'closed']);
  } finally { await close(); }
});

test('a merge from the map’s right-click menu with the view closed shows at once and notifies when GitHub declines', async () => {
  const { providers, page, close } = await start('craft-pr-optimistic-menu-');
  try {
    providers.mergeSettings = { ...providers.mergeSettings, status: 'DIRTY' };
    const answer = slow(providers), { card, state, pending } = parts(page);
    await expect(state).toHaveAttribute('aria-label', 'Open');
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover();
    await page.getByRole('menu', { name: 'Merge…', exact: true }).getByRole('menuitem', { name: 'Squash and merge', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Merged'); await expect(pending).toHaveAttribute('aria-label', 'Confirming');
    await expect(page.getByRole('status').filter({ hasText: 'Merged · confirming' })).toBeVisible();
    await shot(page, 'menu-merge-confirming-card.png');
    answer();
    await expect(state).toHaveAttribute('aria-label', 'Open', { timeout: 20_000 }); await expect(pending).toHaveCount(0);
    const toast = page.getByRole('alert').filter({ hasText: 'Merge of #42 didn’t go through' });
    await expect(toast).toBeVisible();
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await shot(page, 'menu-merge-declined-notification.png');
    await toast.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('[data-expanded-item-id="pr"].expanded .pr-error')).toHaveText('Merge of #42 didn’t go through: GitHub declined the merge: Pull Request is not mergeable', { timeout: 20_000 });
    expect(providers.merges).toHaveLength(1);
  } finally { await close(); }
});
