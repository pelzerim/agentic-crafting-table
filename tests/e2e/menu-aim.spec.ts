import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';

test('a submenu stays open while the pointer crosses other rows on its way there, and another row takes over once the pointer stops on it', async () => {
  test.setTimeout(60_000);
  const providers = githubFixture();
  const directory = await mkdtemp(join(tmpdir(), 'craft-menu-aim-')), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.locator('[data-item-id="pr"]');
    await card.click({ button: 'right' });
    const row = page.getByRole('menuitem', { name: 'Auto deploy', exact: true });
    await row.hover();
    const submenu = page.getByRole('menu', { name: 'Auto deploy', exact: true });
    const target = submenu.getByRole('menuitem', { name: 'Start auto deploy', exact: true });
    await expect(target).toBeVisible();
    const from = (await row.boundingBox())!, to = (await submenu.boundingBox())!;
    const left = to.x < from.x, start = { x: left ? from.x + from.width - 12 : from.x + 12, y: from.y + from.height / 2 };
    const end = { x: left ? to.x + to.width - 16 : to.x + 16, y: to.y + to.height - 6 };
    expect(end.y - start.y, 'the way down to it crosses the rows below').toBeGreaterThan(from.height);
    await page.mouse.move(start.x, start.y);
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await expect(submenu).toBeVisible();
    await target.click();
    await expect(submenu.getByRole('group', { name: 'Start auto deploy' })).toBeVisible();

    const menu = page.getByRole('menu', { name: 'Context actions' });
    for (let tries = 0; tries < 3 && await menu.isVisible(); tries++) await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await card.click({ button: 'right' });
    await row.hover();
    await expect(target).toBeVisible();
    const state = page.getByRole('menuitem', { name: 'Change state', exact: true });
    await state.hover();
    await expect(page.getByRole('menu', { name: 'Change state', exact: true })).toBeVisible();
    await expect(submenu).toBeHidden();
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
