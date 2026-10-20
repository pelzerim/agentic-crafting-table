import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('Stop session asks before ending a working agent turn and sits apart from other controls', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-stop-confirm-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Agent project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Scripted Claude');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Scripted Claude' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');
    const stop = page.getByRole('button', { name: 'Stop session', exact: true });
    await expect(page.locator('.terminal-status > button').last()).toHaveText('Stop session');
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead(), node = state.nodes.find(node => node.title === 'Scripted Claude')!;
      await window.craftingTable.workspaceApply({ commandId: 'working-fixture', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.update', id: node.id, activity: 'working' }] });
    });
    await stop.click();
    const confirm = page.getByRole('group', { name: 'Stop', exact: true });
    await expect(confirm).toContainText('Stop Claude? The current turn is lost.');
    await expect(confirm.getByRole('button', { name: 'Keep running', exact: true })).toBeFocused();
    await expect(page.locator('.terminal-stop-confirm')).toHaveScreenshot('terminal-stop-confirm.png');
    await page.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await stop.click(); await confirm.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await expect(confirm).toHaveCount(0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
