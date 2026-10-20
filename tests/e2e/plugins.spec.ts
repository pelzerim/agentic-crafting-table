import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samplePluginRepository, sampleManifest } from '../fixtures/plugin-repo.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import type { PluginDefinitionsModule } from '../../packages/plugin-sdk/host.ts';

const openPlugins = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Plugins', exact: true }).click();
  return page.getByRole('region', { name: 'Plugins' });
};
/** Approving or changing a plugin restarts the workspace service and reloads the window. */
const reloadsAfter = async (page: Page, action: () => Promise<void>) => {
  const reloaded = page.waitForEvent('load', { timeout: 30_000 });
  await action(); await reloaded;
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 20_000 });
};
/** Runs a journey against an app whose services this test owns, then stops them. */
async function withApp(work: (page: Page, app: ElectronApplication, data: string, sources: string) => Promise<void>, seed?: (data: string, sources: string) => Promise<Record<string, string> | void>) {
  const data = await mkdtemp(join(tmpdir(), 'craft-plugins-')), sources = await mkdtemp(join(tmpdir(), 'craft-plugin-sources-'));
  const env = await seed?.(data, sources);
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ...env, ACT_TEST_DATA_DIR: data } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible({ timeout: 20_000 });
    await work(page, app, data, sources);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(data), () => connectSupervisor(join(data, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) {
        try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; }
        finally { client.close(); }
      }
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await rm(sources, { recursive: true, force: true });
  }
}
const cardResource = async (page: Page) => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(resource => resource.pluginId === 'sample.card');

test('a git plugin installs with consent, adds its item type, survives removal as a placeholder, reinstalls, refuses a tampered release and asks again to update', async () => {
  test.setTimeout(180_000);
  await withApp(async (page, _app, data, sources) => {
    const repository = await samplePluginRepository(sources), first = execFileSync('git', ['rev-parse', 'v1.0.0'], { cwd: repository.work, encoding: 'utf8' }).trim();
    let plugins = await openPlugins(page);
    await expect(plugins.getByText('No plugins installed')).toBeVisible();
    await expect(plugins.getByRole('list', { name: 'Built-in plugins' })).toContainText('workspace.note');

    await plugins.getByLabel('Repository URL').fill(repository.url);
    await plugins.getByLabel('Tag, branch or commit').fill('v1.0.0');
    await plugins.getByRole('button', { name: 'Fetch', exact: true }).click();
    let review = plugins.getByRole('group', { name: 'Review Sample cards' });
    await expect(review).toContainText(first);
    await expect(review).toContainText('Item type sample.card');
    await expect(review).toContainText('Service code (runs with the app’s full access)');
    await expect(review).toContainText('Plugins are trusted code.');
    expect((await page.evaluate(() => window.craftingTable.pluginsInstalled())).installed).toEqual([]);
    await reloadsAfter(page, () => review.getByRole('button', { name: `Trust and install ${first.slice(0, 12)}`, exact: true }).click());
    await expect(page.locator('link[data-plugin="sample"]')).toHaveCount(1);

    await page.mouse.dblclick(640, 420);
    const form = page.getByRole('form', { name: 'New item' });
    await form.getByRole('button', { name: 'All', exact: true }).click();
    await form.getByRole('button', { name: 'Sample card', exact: true }).click();
    await form.getByLabel('Title', { exact: true }).fill('Git card');
    await form.getByLabel('Text', { exact: true }).fill('Hello from git');
    await form.getByRole('button', { name: 'Add sample card', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(async () => (await cardResource(page))?.data).toEqual({ text: 'Hello from git' });
    const card = page.getByRole('article', { name: 'Git card', exact: true });
    await card.click();
    await expect(page.locator('.sample-card-text')).toHaveText('Sample says: Hello from git');
    await page.keyboard.press('Escape');

    plugins = await openPlugins(page);
    const row = plugins.locator('[data-plugin-id="sample"]');
    await expect(row).toContainText('Running'); await expect(row).toContainText(`sample · 1.0.0 · ${first.slice(0, 12)}`);
    await row.getByRole('button', { name: 'Remove…', exact: true }).click();
    await reloadsAfter(page, () => row.getByRole('button', { name: 'Remove plugin', exact: true }).click());
    await card.click();
    await expect(page.locator('.resource-detail')).toContainText('Sample cards was removed. Its items are kept');
    expect((await cardResource(page))?.data).toEqual({ text: 'Hello from git' });
    await page.keyboard.press('Escape');

    plugins = await openPlugins(page);
    await expect(row).toContainText('Removed');
    await row.getByRole('button', { name: 'Reinstall…', exact: true }).click();
    review = plugins.getByRole('group', { name: 'Review Sample cards' });
    await reloadsAfter(page, () => review.getByRole('button', { name: `Trust and install ${first.slice(0, 12)}`, exact: true }).click());
    await card.click();
    await expect(page.locator('.sample-card-text')).toHaveText('Sample says: Hello from git');
    await page.keyboard.press('Escape');

    await repository.release('v1.0.1', { 'dist/renderer.mjs': 'export default { activate() { globalThis.tampered = true; } };\n' }, { pack: false });
    plugins = await openPlugins(page);
    await plugins.getByLabel('Repository URL').fill(repository.url);
    await plugins.getByLabel('Tag, branch or commit').fill('v1.0.1');
    await plugins.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(plugins.getByRole('status').filter({ hasText: 'changed: dist/renderer.mjs' })).toBeVisible();
    await expect(plugins.getByRole('group', { name: 'Review Sample cards' })).toHaveCount(0);

    const second = await repository.release('v1.1.0', { 'act-plugin.json': sampleManifest('1.1.0'), 'dist/renderer.mjs': readFileSync(join(import.meta.dirname, '../fixtures/plugins/sample/dist/renderer.mjs'), 'utf8') });
    await plugins.getByLabel('Tag, branch or commit').fill('v1.1.0');
    await plugins.getByRole('button', { name: 'Fetch', exact: true }).click();
    review = plugins.getByRole('group', { name: 'Review Sample cards' });
    await expect(review).toContainText(`Replaces1.0.0 · ${first.slice(0, 12)}`);
    await expect(review).toContainText('Same contributions; its code changed.');
    await reloadsAfter(page, () => review.getByRole('button', { name: `Trust and update to ${second.slice(0, 12)}`, exact: true }).click());
    plugins = await openPlugins(page);
    await expect(row).toContainText(`sample · 1.1.0 · ${second.slice(0, 12)}`); await expect(row).toContainText('Running');
    await expect(row.getByRole('button', { name: 'Roll back…', exact: true })).toBeVisible();
    const installed = await page.evaluate(() => window.craftingTable.pluginsInstalled());
    expect(installed.installed.map(plugin => [plugin.id, plugin.commit, plugin.previous.map(release => release.commit)])).toEqual([['sample', second, [first]]]);

    writeFileSync(join(data, 'plugins/store/sample', second, 'dist/renderer.mjs'), 'export default { activate() { globalThis.altered = true; } };\n');
    await plugins.getByRole('button', { name: /^Advanced settings/ }).click();
    await reloadsAfter(page, () => plugins.getByRole('button', { name: 'Reload plugins', exact: true }).click());
    plugins = await openPlugins(page);
    await expect(row).toContainText('Failed'); await expect(row).toContainText('changed: dist/renderer.mjs');
    expect(await page.evaluate(() => (globalThis as { altered?: boolean }).altered)).toBeUndefined();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await card.click();
    await expect(page.locator('.resource-detail')).toContainText('Sample cards could not load and is turned off. Its items are kept.');
  });
});

test('an act:// install link opens the prefilled review; an invalid link is refused visibly; nothing installs until the person approves', async () => {
  test.setTimeout(120_000);
  const remote = 'https://plugins.example.test/acme/sample-pack.git';
  let repository!: Awaited<ReturnType<typeof samplePluginRepository>>;
  /** Simulates the operating system handing the app a link, as macOS does through open-url. */
  const openLink = (app: ElectronApplication, link: string) => app.evaluate(({ app: electronApp }, url) => { electronApp.emit('open-url', { preventDefault() {} }, url); }, link);
  await withApp(async (page, app) => {
    const plugins = page.getByRole('region', { name: 'Plugins' });
    await openLink(app, `act://plugins/remove?source=${encodeURIComponent(remote)}`);
    await expect(plugins.getByRole('alert')).toHaveText('The install link was not used. Only plugins/install links are supported.');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await openLink(app, `act://plugins/install?source=${encodeURIComponent(repository.url)}&ref=v1.0.0`);
    await expect(plugins.getByRole('alert')).toContainText('An install link needs an https://, ssh:// or git@host:path repository.');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();

    const first = execFileSync('git', ['rev-parse', 'v1.0.0'], { cwd: repository.work, encoding: 'utf8' }).trim();
    await openLink(app, `act://plugins/install?source=${encodeURIComponent(remote)}&ref=v1.0.0`);
    await expect(plugins.getByLabel('Repository URL')).toHaveValue(remote);
    await expect(plugins.getByLabel('Tag, branch or commit')).toHaveValue('v1.0.0');
    const review = plugins.getByRole('group', { name: 'Review Sample cards' });
    await expect(review).toContainText(first);
    await expect(review).toContainText(`${remote} @ v1.0.0`);
    await expect(review).toContainText('Plugins are trusted code.');
    await expect(plugins.getByRole('alert')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await page.evaluate(() => window.craftingTable.pluginsInstalled())).installed).toEqual([]);
    await reloadsAfter(page, () => review.getByRole('button', { name: `Trust and install ${first.slice(0, 12)}`, exact: true }).click());
    const installed = await page.evaluate(() => window.craftingTable.pluginsInstalled());
    expect(installed.installed.map(plugin => [plugin.id, plugin.commit, plugin.source])).toEqual([['sample', first, { kind: 'git', url: remote, ref: 'v1.0.0' }]]);
  }, async (_data, sources) => {
    repository = await samplePluginRepository(sources);
    // The link names an https remote; git reads it from the local fixture repository instead.
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${repository.url}.insteadOf`, GIT_CONFIG_VALUE_0: remote };
  });
});

test('items of a type the app no longer bundles stay placeholders and return unchanged when a package that owns its id is installed', async () => {
  test.setTimeout(120_000);
  const box = { id: 'box', resourceId: 'box-resource', pluginId: 'legacy.box', title: 'Build box', data: { boxId: 'b-17' } };
  await withApp(async (page, _app, _data, sources) => {
    const saved = async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(resource => resource.pluginId === 'legacy.box');
    const before = await saved();
    expect(before?.data).toEqual(box.data);
    const article = page.getByRole('article', { name: box.title, exact: true });
    await article.click();
    await expect(page.locator('.resource-detail')).toContainText('Plugin is not installed');
    await page.keyboard.press('Escape');

    const repository = await samplePluginRepository(sources, 'relocated'), commit = execFileSync('git', ['rev-parse', 'v1.0.0'], { cwd: repository.work, encoding: 'utf8' }).trim();
    const plugins = await openPlugins(page);
    await plugins.getByLabel('Repository URL').fill(repository.url);
    await plugins.getByLabel('Tag, branch or commit').fill('v1.0.0');
    await plugins.getByRole('button', { name: 'Fetch', exact: true }).click();
    const review = plugins.getByRole('group', { name: 'Review Relocated items' });
    await expect(review).toContainText('Item type legacy.box');
    await reloadsAfter(page, () => review.getByRole('button', { name: `Trust and install ${commit.slice(0, 12)}`, exact: true }).click());
    await article.click();
    await expect(page.locator('.legacy-box-text')).toHaveText('Box b-17');
    expect(await saved()).toEqual(before);
  }, async data => {
    const relocated: PluginDefinitionsModule = (await import(join(import.meta.dirname, '../fixtures/plugins/relocated/dist/definitions.mjs'))).default;
    const service = await startWorkspaceService(data, createResourcePluginRegistry(relocated.definitions));
    try {
      await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', ...box, position: { x: 640, y: 360 } }] });
    } finally { await service.close(); }
  });
});


test('a development folder loads in place after approval and reloads with rebuilt code', async () => {
  test.setTimeout(120_000);
  await withApp(async (page, app, _data, sources) => {
    const folder = join(sources, 'dev-sample');
    cpSync(join(import.meta.dirname, '../fixtures/plugins/sample'), folder, { recursive: true });
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, folder);
    let plugins = await openPlugins(page);
    await plugins.getByRole('button', { name: /^Advanced settings/ }).click();
    await plugins.getByRole('button', { name: 'Load from folder…', exact: true }).click();
    const review = plugins.getByRole('group', { name: 'Review Sample cards' });
    await expect(review).toContainText('Development'); await expect(review).toContainText(folder);
    await reloadsAfter(page, () => review.getByRole('button', { name: 'Trust and load from folder', exact: true }).click());
    plugins = await openPlugins(page);
    const row = plugins.locator('[data-plugin-id="sample"]');
    await expect(row).toContainText('Running'); await expect(row).toContainText('Development'); await expect(row).toContainText('development build');
    await expect(row.getByRole('button', { name: 'Check for update', exact: true })).toHaveCount(0);
    writeFileSync(join(folder, 'dist/renderer.css'), '.sample-card-text { color: var(--act-accent); }\n');
    await plugins.getByRole('button', { name: /^Advanced settings/ }).click();
    await reloadsAfter(page, () => plugins.getByRole('button', { name: 'Reload plugins', exact: true }).click());
    expect(await page.evaluate(async () => (await (await fetch(document.querySelector<HTMLLinkElement>('link[data-plugin="sample"]')!.href)).text()))).toContain('--act-accent');
  });
});
