import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

test('Auto deploy: armed from the PR view after a confirmation, its status line follows the service, Stop ends it, and the map menu offers it', async () => {
  test.setTimeout(90_000);
  const providers = githubFixture();
  providers.mergeSettings = { ...providers.mergeSettings, review: 'APPROVED', rollup: 'PENDING' };
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-auto-deploy-')), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.locator('[data-item-id="pr"]'), frame = page.locator('[data-expanded-item-id=pr]'), actions = prActions(page, frame);
    await card.click();
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open');
    const status = frame.locator('.pr-auto-deploy-status');
    await expect(status).toBeHidden();

    await actions.pick('Auto deploy');
    const menu = page.getByRole('menu', { name: 'Auto deploy', exact: true });
    await expect(menu.locator('.resource-choice-prompt')).toHaveText('Deploy #42 automatically?');
    await menu.getByRole('menuitem', { name: 'Start auto deploy', exact: true }).click();
    const confirm = menu.getByRole('group', { name: 'Start auto deploy' });
    await expect(confirm).toContainText('Auto deploy #42 “Make billing plan changes predictable”?');
    await expect(confirm).toContainText('Rebases it onto main when needed, has an agent fix blocking Claude review findings and failing CI, merges it into main once ready');
    await expect(confirm).toContainText('approves the next one only after a pass. Any doubt halts.');
    expect(providers.merges).toHaveLength(0);
    await confirm.getByRole('menuitem', { name: 'Start auto deploy', exact: true }).click();

    await expect(status).toBeVisible();
    await expect(status.locator('.pr-auto-deploy-text')).toHaveText('Auto deploy · waiting for checks');
    await expect(status).toHaveAttribute('data-state', 'armed');
    await expect(status.locator('.pr-auto-deploy-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(frame.getByRole('list', { name: 'Auto deploy actions' })).toBeVisible();
    await actions.open();
    await expect(actions.item('Auto deploy · on')).toBeVisible();
    await page.keyboard.press('Escape');

    await status.getByRole('button', { name: 'Stop auto deploy', exact: true }).click();
    await expect(status).toBeHidden();
    const record = await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'github.rollout.autoDeploy' as 'agent.resume', nodeId: 'pr', arguments: { operation: 'status' } })) as { state: string };
    expect(record.state).toBe('stopped');

    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Auto deploy', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Auto deploy', exact: true });
    await expect(submenu.getByRole('menuitem', { name: 'Start auto deploy', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(providers.merges).toHaveLength(0); expect(providers.titles).toHaveLength(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Auto deploy on a draft: the confirm says it marks it ready, one ready write goes to GitHub, and the action list shows it', async () => {
  test.setTimeout(90_000);
  const providers = githubFixture();
  providers.pull = { ...providers.pull, draft: true };
  providers.mergeSettings = { ...providers.mergeSettings, review: 'APPROVED', rollup: 'PENDING' };
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-auto-deploy-draft-')), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), frame = page.locator('[data-expanded-item-id=pr]'), actions = prActions(page, frame);
    await page.locator('[data-item-id="pr"]').click();
    await actions.pick('Auto deploy');
    const menu = page.getByRole('menu', { name: 'Auto deploy', exact: true });
    await menu.getByRole('menuitem', { name: 'Start auto deploy', exact: true }).click();
    const confirm = menu.getByRole('group', { name: 'Start auto deploy' });
    await expect(confirm).toContainText('Marks it ready for review, rebases it onto main when needed');
    await confirm.getByRole('menuitem', { name: 'Start auto deploy', exact: true }).click();

    const status = frame.locator('.pr-auto-deploy-status');
    await expect(status.locator('.pr-auto-deploy-text')).toHaveText('Auto deploy · waiting for checks', { timeout: 20_000 });
    expect(providers.drafts.map(entry => entry.draft)).toEqual([false]);
    await status.getByRole('button', { name: '2 actions of auto deploy', exact: true }).click();
    await expect(frame.locator('.pr-auto-deploy-actions .pr-auto-deploy-action-text')).toHaveText(['Armed by you', 'Marked ready for review']);
    expect(providers.merges).toHaveLength(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
