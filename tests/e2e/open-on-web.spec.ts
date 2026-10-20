import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

type Providers = Parameters<typeof startWorkspaceService>[3];

async function launch(providers: Providers, item: { pluginId: string; title: string; data: Record<string, unknown>; todo?: boolean }, run: (page: Page, browser: () => Promise<string[]>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-open-on-web-'));
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 300, y: 300 }, workingDirectory: '/tmp' },
    { type: 'item.add', id: 'item', resourceId: 'item-r', projectId: 'project', position: { x: 300, y: 160 }, pluginId: item.pluginId, title: item.title, data: item.data },
    ...item.todo ? [{ type: 'node.todo', id: 'item', enabled: true }] : [],
  ] } as never);
  const app: ElectronApplication = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await app.evaluate(({ shell, app, webContents }) => {
      const record = (globalThis as any).browserEvents = [] as string[];
      shell.openExternal = async (url: string) => { record.push(url); };
      for (const contents of webContents.getAllWebContents()) {
        contents.on('did-create-window', (_window, details) => record.push(`window ${details.url}`));
        contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) record.push(`navigate ${details.url}`); });
      }
      app.on('browser-window-created', () => record.push('window created'));
    });
    await run(page, () => app.evaluate(() => (globalThis as any).browserEvents.slice() as string[]));
  } finally {
    await exitWithoutShutdown(app); await service.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const PR_URL = 'https://github.com/fixture/billing/pull/42', COMMENT_URL = `${PR_URL}#issuecomment-5`;

test('every way out of a pull request opens its https URL in the browser and nothing in the app', async () => {
  await launch(githubFixture(), { pluginId: 'github.pull-request', title: 'Plan switcher', data: { owner: 'fixture', repo: 'billing', number: 42 } }, async (page, browser) => {
    const expected: string[] = [];
    const opens = async (action: () => Promise<void>, url: string) => { await action(); expected.push(url); await expect.poll(browser).toEqual(expected); };
    const card = page.locator('[data-item-id="item"]');
    await opens(async () => { await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Open on GitHub', exact: true }).click(); }, PR_URL);
    await card.click();
    const header = page.locator('.view-header').getByRole('link', { name: 'Open in GitHub', exact: true });
    await expect(header).toHaveAttribute('href', PR_URL);
    await opens(() => header.click(), PR_URL);
    await opens(() => header.click({ modifiers: ['Meta'] }), PR_URL);
    await opens(() => header.click({ modifiers: ['Shift'] }), PR_URL);
    await opens(() => header.click({ button: 'middle' }), PR_URL);
    const author = page.locator('.pr-comment-meta a').first();
    await expect(author).toHaveAttribute('href', COMMENT_URL);
    await opens(() => author.click(), COMMENT_URL);
    await opens(() => author.click({ button: 'middle' }), COMMENT_URL);
    await page.evaluate(url => { window.open(url, '_blank', 'noopener'); }, PR_URL);
    expected.push(PR_URL); await expect.poll(browser).toEqual(expected);
    await page.evaluate(() => { window.open('about:blank'); window.open('javascript:alert(1)'); window.open('file:///etc/passwd'); });
    await page.waitForTimeout(300);
    expect(await browser()).toEqual(expected);
  });
});

test('a middle click on an item card opens its web page and opens nothing in the app', async () => {
  await launch(githubFixture(), { pluginId: 'github.pull-request', title: 'Plan switcher', data: { owner: 'fixture', repo: 'billing', number: 42 } }, async (page, browser) => {
    await page.locator('[data-item-id="item"]').click({ button: 'middle' });
    await expect.poll(browser).toEqual([PR_URL]);
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /.+/);
  });
});

test('a middle click on a to-do row opens the web page of its item', async () => {
  await launch({}, { pluginId: 'linear.ticket', title: 'BIL-128 · Make plan changes predictable', data: { workspaceKey: 'acme', issueId: 'BIL-128' }, todo: true }, async (page, browser) => {
    await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
    await page.getByRole('form', { name: 'To-dos', exact: true }).locator('[data-todo-id="map:item"]').click({ button: 'middle' });
    await expect.poll(browser).toEqual(['https://linear.app/acme/issue/BIL-128']);
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /.+/);
  });
});

test('the rollout header opens the run on GitHub, by click and by middle-click', async () => {
  await launch(rolloutFixture(), { pluginId: 'github.rollout', title: 'Rollout', data: { owner: 'fixture', repo: 'web', runId: 101 } }, async (page, browser) => {
    const run = 'https://github.com/fixture/web/actions/runs/101';
    await page.locator('[data-item-id="item"]').click();
    const header = page.locator('.view-header').getByRole('link', { name: 'Open in GitHub', exact: true });
    await expect(header).toHaveAttribute('href', run);
    await header.click(); await expect.poll(browser).toEqual([run]);
    await header.click({ button: 'middle' }); await expect.poll(browser).toEqual([run, run]);
  });
});
