import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { enableShowShip, githubFixture, pullFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

const base = pullFixture.title;
async function start(prefix: string, providers = githubFixture(), showShip = true) {
  const directory = await mkdtemp(join(tmpdir(), prefix)), service = await startWorkspaceService(directory, undefined, undefined, providers);
  if (showShip) enableShowShip(service.store);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  return { providers, service, app, page: await app.firstWindow(), close: async () => { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('right-click Show/Ship > [ship] tags the GitHub title and the card follows', async () => {
  const { providers, page, close } = await start('craft-pr-show-ship-menu-');
  try {
    const card = page.locator('[data-item-id="pr"]');
    await expect(page.getByRole('article', { name: base, exact: true })).toBeVisible();
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show/Ship', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Show/Ship', exact: true });
    await expect(submenu.getByRole('menuitem', { name: `Retitle #42 “${base}” on GitHub?`, exact: true })).toBeDisabled();
    await expect(submenu.getByRole('menuitem')).toHaveText([/Retitle #42/, '[show]', '[ship]']);
    await expect(submenu.getByRole('menuitem', { name: '[ship]', exact: true })).toHaveAttribute('title', `Becomes “[ship] ${base}”`);
    await submenu.getByRole('menuitem', { name: '[ship]', exact: true }).click();
    await expect(page.getByRole('article', { name: `[ship] ${base}`, exact: true })).toBeVisible({ timeout: 20_000 });
    expect(providers.titles).toEqual([`[ship] ${base}`]);
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Show/Ship', exact: true }).hover();
    await expect(submenu.getByRole('menuitemradio', { name: '[ship]', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(submenu.getByRole('menuitemradio', { name: '[ship]', exact: true })).toBeDisabled();
    await expect(submenu.getByRole('menuitemradio')).toHaveText(['[show]', '[ship]', 'Remove tag']);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    expect(providers.titles).toHaveLength(1);
  } finally { await close(); }
});

test('the PR view button switches the tag in place, removes it, reports a GitHub decline and stays clickable for closed PRs', async () => {
  const providers = githubFixture(); providers.pull = { ...providers.pull, title: `${base} [Ship]` };
  const { page, close } = await start('craft-pr-show-ship-view-', providers);
  try {
    await page.locator('[data-item-id="pr"]').click();
    const button = page.locator('.pr-show-ship'), menu = page.getByRole('menu', { name: 'Show or ship', exact: true });
    await expect(button).toBeEnabled(); await expect(button).toHaveText('Ship');
    await prActions(page).pick(/^(Show\/Ship|Show|Ship)$/);
    await expect(menu.locator('.resource-choice-prompt')).toHaveText(`Retitle #42 “${base} [Ship]” on GitHub?`);
    await expect(menu.getByRole('menuitemradio', { name: '[ship]', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: '[show]', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(prActions(page).button).toBeFocused();
    expect(providers.titles).toHaveLength(0);
    await prActions(page).pick(/^(Show\/Ship|Show|Ship)$/); await menu.getByRole('menuitemradio', { name: '[show]', exact: true }).click();
    await expect(page.locator('.expanded .card-heading .card-label strong')).toHaveText(`[show] ${base}`, { timeout: 20_000 });
    await expect(button).toHaveText('Show');
    await expect(page.getByRole('article', { name: `[show] ${base}`, exact: true })).toHaveCount(1);
    await prActions(page).pick(/^(Show\/Ship|Show|Ship)$/); await menu.getByRole('menuitemradio', { name: 'Remove tag', exact: true }).click();
    await expect(page.locator('.expanded .card-heading .card-label strong')).toHaveText(base, { timeout: 20_000 });
    await expect(button).toHaveText('Show/Ship');
    expect(providers.titles).toEqual([`[show] ${base}`, base]);
    await prActions(page).pick(/^(Show\/Ship|Show|Ship)$/); await expect(menu.getByRole('menuitem')).toHaveText([`[show]Becomes “[show] ${base}”`, `[ship]Becomes “[ship] ${base}”`, 'Cancel']);
    providers.replyToTitle(() => ({ status: 422, body: { message: 'Validation Failed' }, headers: new Headers() }));
    await menu.getByRole('menuitem', { name: '[show]', exact: true }).click();
    await expect(page.locator('.pr-error')).toHaveText('Retitle of #42 didn’t go through: GitHub declined the new title.', { timeout: 20_000 });
    expect(providers.titles).toEqual([`[show] ${base}`, base, `[show] ${base}`]);
    providers.replyToTitle(undefined); providers.pull = { ...providers.pull, title: `[ship] Renamed elsewhere`, state: 'closed' };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(button).toHaveText('Ship'); await expect(button).toBeEnabled(); await expect(button).toHaveAttribute('title', 'Closed — GitHub may decline');
    await prActions(page).pick(/^(Show\/Ship|Show|Ship)$/);
    await expect(menu.locator('.resource-choice-prompt')).toHaveText('Retitle #42 “[ship] Renamed elsewhere” on GitHub? GitHub reports it is closed.');
    await menu.getByRole('menuitemradio', { name: '[show]', exact: true }).click();
    await expect(page.locator('.expanded .card-heading .card-label strong')).toHaveText('[show] Renamed elsewhere', { timeout: 20_000 });
  } finally { await close(); }
});

test('Show/Ship is off in a new workspace until it is switched on in the pull request settings', async () => {
  const { providers, page, close } = await start('craft-pr-show-ship-optin-', githubFixture(), false);
  try {
    const card = page.locator('[data-item-id="pr"]');
    await expect(page.getByRole('article', { name: base, exact: true })).toBeVisible();
    await card.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Merge…', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Show/Ship', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await card.click();
    await prActions(page).open(); await expect(prActions(page).item('Merge')).toBeVisible();
    await expect(prActions(page).item('Show/Ship')).toHaveCount(0); await page.keyboard.press('Escape');
    await card.click({ button: 'right' }); await expect(page.locator('.map-card.expanded')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('treeitem', { name: 'Items' }).click();
    await settings.getByRole('treeitem', { name: 'GitHub pull request' }).click();
    const toggle = settings.getByRole('switch', { name: 'Show/Ship' });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings).toHaveCount(0);
    await card.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Show/Ship', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await card.click();
    await prActions(page).open(); await expect(prActions(page).item('Show/Ship')).toBeVisible(); await page.keyboard.press('Escape');
    expect(providers.titles).toHaveLength(0);
  } finally { await close(); }
});
