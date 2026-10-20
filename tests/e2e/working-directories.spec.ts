import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openProjectPicker } from './project-picker.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launch = (directory: string, env: Record<string, string> = {}) => electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', ...env } });
const stubFolderDialog = (app: ElectronApplication, path: string) => app.evaluate(({ dialog }, path) => {
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
}, path);

test('the global default working directory is validated, chosen with the folder dialog, saved and cleared', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-default-directory-'));
  const chosen = join(directory, 'code'); await mkdir(chosen);
  let app = await launch(directory);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const openItems = async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
    };
    await openItems();
    const field = page.getByLabel('Default working directory', { exact: true });
    await expect(field).toHaveValue('');
    await field.fill(join(directory, 'missing'));
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('alert')).toContainText('must be an existing folder');
    await stubFolderDialog(app, chosen);
    await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
    await expect(field).toHaveValue(chosen);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.defaultWorkingDirectory).toBe(chosen);

    await app.close(); app = await launch(directory); page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await openItems();
    await expect(page.getByLabel('Default working directory', { exact: true })).toHaveValue(chosen);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.getByLabel('Default working directory', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.defaultWorkingDirectory).toBe('');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('new terminals and agents start from the global default and offer recent folders', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-recent-folders-'));
  const global = join(directory, 'global'), other = join(directory, 'other'), bin = join(directory, 'bin');
  for (const folder of [global, other, bin]) await mkdir(folder);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const app = await launch(directory, { CLAUDE_CONFIG_DIR: join(directory, 'claude-config'), PATH: `${bin}:${process.env.PATH}` });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async global => { const current = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, defaultWorkingDirectory: global } }); }, global);
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Folderless project');
    await expect(page.getByLabel('Project working directory', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();

    const field = page.getByLabel('Working directory', { exact: true });
    const startTerminal = async (title: string) => {
      await openProjectPicker(page, 'Folderless project');
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      await page.getByLabel('Title', { exact: true }).fill(title);
      await expect(field).toHaveValue(global);
    };
    await startTerminal('Typed folder');
    await field.fill(other);
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Typed folder' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.craftingTable.recentDirectories())).toEqual([await realpath(other)]);

    await startTerminal('Picked folder');
    await field.click();
    const suggestions = page.getByRole('listbox', { name: 'Working directory suggestions' });
    await expect(suggestions.getByRole('group', { name: 'Global default' }).getByRole('option')).toHaveText([global]);
    await expect(suggestions.getByRole('group', { name: 'Recent' }).getByRole('option')).toHaveText([await realpath(other)]);
    await suggestions.getByRole('option', { name: await realpath(other) }).click();
    await expect(field).toHaveValue(await realpath(other));
    await expect(suggestions).toHaveCount(0);
    await page.mouse.move(0, 0);
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await field.press('Enter');
    await expect(field).toHaveValue(await realpath(other));
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Picked folder' })).toBeVisible();

    await openProjectPicker(page, 'Folderless project');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveAttribute('placeholder', 'Terminal · global');
    await expect(page.getByText('Name (optional)')).toBeVisible();
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Terminal · global' })).toBeVisible();

    await openProjectPicker(page, 'Folderless project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Default folder agent');
    await expect(field).toHaveValue(global);
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Default folder agent' })).toBeVisible();
    const cwd = async (title: string) => { const { state } = await page.evaluate(() => window.craftingTable.workspaceRead()); const node = state.nodes.find(node => node.title === title); return state.resources.find(resource => resource.id === node?.resourceId)?.data.cwd; };
    expect(await cwd('Picked folder')).toBe(await realpath(other));
    expect(await cwd('Default folder agent')).toBe(await realpath(global));
    await expect.poll(() => page.evaluate(() => window.craftingTable.recentDirectories())).toEqual([await realpath(global), await realpath(other)]);

    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead(), projectId = state.nodes.find(node => !node.resourceId)!.id;
      await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision,
        pluginId: 'terminal.session', title: 'No folder given', projectId, position: { x: 2400, y: 1600 }, data: {} });
    });
    expect(await cwd('No folder given')).toBe(await realpath(global));
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('long folders stay readable: suggestions and the field keep the folder name visible', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-long-folders-'));
  const folder = join(directory, 'a-rather-long-parent-directory-name', 'another-quite-long-nested-directory', 'workspace-checkouts', 'billing-reports');
  await mkdir(folder, { recursive: true });
  const app = await launch(directory);
  try {
    const page = await app.firstWindow();
    await page.evaluate(async folder => { const current = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, defaultWorkingDirectory: folder } }); }, folder);
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Long folders');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Long folders');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const field = page.getByLabel('Working directory', { exact: true });
    await expect(field).toHaveValue(folder);
    const tailShown = () => field.evaluate((input: HTMLInputElement) => input.scrollWidth > input.clientWidth && input.scrollLeft + input.clientWidth >= input.scrollWidth - 1);
    await expect.poll(tailShown).toBe(true);
    await field.click();
    const suggestions = page.getByRole('listbox', { name: 'Working directory suggestions' });
    const option = suggestions.getByRole('option');
    await expect(option).toHaveText([folder]);
    await expect(option).toHaveAttribute('title', folder);
    const name = option.locator('.act-directory-name');
    await expect(name).toHaveText('billing-reports');
    expect(await name.evaluate(element => { const box = element.getBoundingClientRect(), row = element.closest('[role=option]')!.getBoundingClientRect(); return element.scrollWidth <= element.clientWidth && box.left >= row.left && box.right <= row.right; })).toBe(true);
    const list = (await suggestions.boundingBox())!;
    expect(list.width).toBeGreaterThanOrEqual(420);
    expect(list.x).toBeGreaterThanOrEqual(0);
    expect(list.x + list.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await option.click();
    await field.blur();
    await expect.poll(tailShown).toBe(true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
