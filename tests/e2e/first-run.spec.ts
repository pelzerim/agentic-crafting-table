import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

test('a first run shows one instruction and a three-step checklist that collapses steps as they are done', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-first-run-'));
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1280, 800);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const card = page.getByRole('region', { name: 'Get started' }), step = (name: string) => card.getByRole('listitem').filter({ hasText: name });
    await expect(page.getByText('Double-click anywhere to add an item · right-click for more')).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveCount(3);
    await expect(step('Create a project')).toHaveAttribute('data-done', 'false');
    await expect(step('Connect GitHub or Linear').getByRole('button', { name: 'Connect…' })).toBeVisible();
    await expect(card).toContainText('0 of 3 done');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('first-run-empty.png');
    const apply = (commands: WorkspaceCommand[]) => page.evaluate(async encoded => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: JSON.parse(encoded) });
    }, JSON.stringify(commands));
    await apply([{ type: 'project.create', id: 'billing', title: 'Billing redesign', summary: '', position: { x: 300, y: 300 } }]);
    await expect(step('Create a project')).toHaveAttribute('data-done', 'true');
    await expect(step('Create a project')).toContainText('Billing redesign');
    await expect(step('Create a project').getByRole('button')).toHaveCount(0);
    await expect(card).toContainText('1 of 3 done');
    await expect(card).toHaveScreenshot('first-run-docked.png');
    await step('Connect GitHub or Linear').getByRole('button', { name: 'Connect…' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await card.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.locator('[data-project-label="billing"]')).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally { await exitWithoutShutdown(app); }
});
