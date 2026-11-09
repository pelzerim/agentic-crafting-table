import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubIssueFixture } from '../fixtures/github-issue.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { githubIssueConnector } from '../../src/resource-plugins/items/github-issue/connector.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

test('a GitHub issue URL makes an issue card; Change state closes it on GitHub and the open issue shows its description and comments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-github-issue-view-')), github = githubIssueFixture();
  const providers = Object.assign(github, { host(registry: ResourcePluginRegistry) { const host = new ResourcePluginHost(registry); host.register('github.issue', githubIssueConnector(() => github.client)); return host; } });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Web'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Web');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await page.getByLabel('Item URL').fill('https://github.com/fixture/web/issues/7'); await page.getByRole('button', { name: 'Attach issue', exact: true }).click();
    const card = page.getByRole('article', { name: 'Search ignores accents', exact: true });
    await expect(card).toBeVisible(); await expect(card.getByText('Open', { exact: true })).toBeVisible(); await expect(card).toContainText('#7');

    await card.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Linked pull requests', exact: true })).toBeVisible();
    const trigger = page.getByRole('menuitem', { name: 'Change state', exact: true }), menu = page.getByRole('menu', { name: 'Change state', exact: true });
    await trigger.hover(); await expect(menu.getByRole('menuitemradio')).toHaveText(['Open', 'Close as completed', 'Close as not planned']);
    await expect(menu.getByRole('menuitemradio', { name: 'Open', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(github.writes).toEqual([]);
    await menu.getByRole('menuitemradio', { name: 'Close as not planned', exact: true }).click();
    await expect(card.getByText('Not planned', { exact: true })).toBeVisible();
    expect(github.writes).toEqual(['closed:not_planned']);

    await card.click();
    const detail = page.locator('.github-issue-detail'), frame = page.locator('.item-view:visible');
    await expect(detail.locator('.github-issue-description strong')).toHaveText('café');
    await expect(detail).toContainText('<script>window.providerScriptExecuted=true</script>');
    expect(await page.evaluate(() => 'providerScriptExecuted' in window)).toBe(false);
    await expect(detail.getByRole('list', { name: 'Labels' })).toHaveText('bug');
    await expect(detail.getByRole('article', { name: 'Comment from fixture-reviewer' })).toContainText('Reproduced with');
    await expect(frame.getByRole('button', { name: 'Change status: Not planned' })).toBeVisible();
    await expect(frame.locator('.view-meta')).toHaveText(/^#7 · opened by fixture-reporter · updated /);
    if (process.env.ACT_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.ACT_SCREENSHOT_DIR, 'github-issue-view.png') });
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
