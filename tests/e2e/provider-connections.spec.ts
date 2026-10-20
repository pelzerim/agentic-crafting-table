import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('provider connections use native account metadata and retain bindings through switching, disconnect and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-github-settings-')), bin = join(directory, 'bin');
  await mkdir(bin); await writeFile(join(bin, 'gh'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/github-cli.mjs')).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, PATH: `${bin}:${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Connected project'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const graph = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const connections = async () => (await page.evaluate(() => window.craftingTable.settingsRead())).value.connections;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const github = page.locator('[data-provider=github]');
    await github.getByRole('button', { name: 'How to connect', exact: true }).click();
    await expect(github.locator('.settings-code').first()).toContainText('gh auth login');
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(page.getByRole('option', { name: 'fixture-developer', exact: true })).toBeAttached();
    await expect(page.getByRole('option', { name: 'fixture-expired · sign-in required' })).toHaveJSProperty('disabled', true);
    // Choosing an account applies immediately; the Settings draft stays clean.
    await page.getByLabel('GitHub account', { exact: true }).selectOption('fixture-developer', { timeout: 5000 });
    await expect.poll(async () => (await connections())[0]?.account).toBe('fixture-developer');
    await expect(github).toContainText('Connected'); await expect(page.getByText('No unsaved changes')).toBeVisible();
    const first = (await connections())[0];
    await github.getByRole('button', { name: 'More GitHub actions', exact: true }).click(); await page.getByRole('button', { name: 'Change account', exact: true }).click();
    await expect(page.getByRole('option', { name: 'fixture-reviewer', exact: true })).toBeAttached();
    await page.getByLabel('GitHub account', { exact: true }).selectOption('fixture-reviewer', { timeout: 5000 });
    await expect.poll(async () => (await connections()).find(connection => connection.isDefault)?.account).toBe('fixture-reviewer');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    const saved = await connections();
    expect(saved).toHaveLength(2); expect(saved.find(connection => connection.id === first.id)?.enabled).toBe(true); expect(saved.find(connection => connection.isDefault)?.account).toBe('fixture-reviewer');
    await app.close(); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await expect(page.getByRole('article', { name: 'Connected project' })).toBeVisible();
    expect(await connections()).toEqual(saved);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'More GitHub actions', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect GitHub', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeFocused(); await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible(); expect(await connections()).toEqual(saved);
    await page.getByRole('button', { name: 'More GitHub actions', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect GitHub', exact: true }).click();
    await page.getByRole('group', { name: 'Disconnect GitHub' }).getByRole('button', { name: 'Disconnect GitHub', exact: true }).click();
    await expect.poll(async () => (await connections()).every(connection => !connection.enabled && !connection.isDefault)).toBe(true);
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(page.getByRole('option', { name: 'fixture-developer', exact: true })).toBeAttached();
    await page.getByLabel('GitHub account', { exact: true }).selectOption('fixture-developer', { timeout: 5000 });
    await expect.poll(async () => (await connections()).find(connection => connection.isDefault)?.id).toBe(first.id);
    await page.getByRole('button', { name: 'Save settings' }).click(); await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(graph);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
