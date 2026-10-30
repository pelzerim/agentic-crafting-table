import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openProjectPicker } from './project-picker.ts';

test('clicking the title of an open agent view edits it in place; Enter saves the new name and Escape keeps the old one', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-title-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` };
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Agent project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Claude session');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Claude session' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');

    const view = page.getByRole('region', { name: 'Claude session', exact: true });
    await view.getByRole('button', { name: 'Edit Claude session' }).click();
    const input = view.getByRole('textbox', { name: 'Edit title' });
    await expect(input).toBeFocused();
    await input.fill('Scratch name'); await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(view.getByRole('button', { name: 'Edit Claude session' })).toBeVisible();

    await view.getByRole('button', { name: 'Edit Claude session' }).click();
    await input.fill('Fix cart rounding'); await input.press('Enter');
    const renamed = page.getByRole('region', { name: 'Fix cart rounding', exact: true });
    await expect(renamed.getByRole('button', { name: 'Edit Fix cart rounding' })).toBeVisible();
    // The terminal keeps running and keeps the keyboard after the rename.
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');

    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect(page.getByRole('article', { name: 'Fix cart rounding' })).toBeVisible();
    const node = await page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.title === 'Fix cart rounding'));
    // A typed name is the person's: automatic agent titles never replace it.
    expect(node).toBeDefined(); expect(node!.generatedTitle).toBeUndefined();
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
