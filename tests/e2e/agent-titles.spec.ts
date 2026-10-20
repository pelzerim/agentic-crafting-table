import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openProjectPicker } from './project-picker.ts';

test('a working agent is named from its activity; a user rename sticks until Auto-name from activity', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-title-')), bin = join(directory, 'bin'), repo = join(directory, 'repo'), log = join(directory, 'title-requests.jsonl');
  await mkdir(bin); await mkdir(repo);
  // One executable plays both the scripted agent and the tool-free title helper.
  const fixture = (name: string) => JSON.stringify(pathToFileURL(resolve('tests/fixtures', name)).href);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nawait import(process.argv.includes('--max-turns') ? ${fixture('native-summary.mjs')} : ${fixture('native-agent.mjs')});\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, ACT_SUMMARY_FIXTURE_LOG: log, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` };
  const entries = () => readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(() => []);
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Photos');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'AI features', exact: true }).click();
    await expect(page.getByLabel('Auto-title agents', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await openProjectPicker(page, 'Photos');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Claude session' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('Investigate the thumbnail refresh loop\n');
    await expect(page.locator('.xterm-accessibility')).toContainText('RECEIVED:Investigate the thumbnail refresh loop');
    await page.getByRole('button', { name: 'Back to project' }).click();
    const card = page.getByRole('article', { name: 'Fix thumbnail refresh loop' });
    await expect(card).toBeVisible({ timeout: 25_000 });
    const [first] = await entries();
    expect(first.model).toBe('haiku'); expect(first.evidence.currentTitle).toBeNull(); expect(first.evidence.directory).toBe('repo');
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Item settings…' }).click();
    await page.getByLabel('Title', { exact: true }).fill('My thumbnail work');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const renamed = page.getByRole('article', { name: 'My thumbnail work' }); await expect(renamed).toBeVisible();
    await renamed.click(); await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('Now fix the retry delay\n');
    await expect(page.locator('.xterm-accessibility')).toContainText('RECEIVED:Now fix the retry delay');
    await page.getByRole('button', { name: 'Back to project' }).click();
    await page.waitForTimeout(5000);
    await expect(renamed).toBeVisible(); expect(await entries()).toHaveLength(1);
    await renamed.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Auto-name from activity' }).click();
    await expect(page.getByRole('article', { name: 'Fix thumbnail refresh loop' })).toBeVisible({ timeout: 15_000 });
    const requests = await entries(); expect(requests).toHaveLength(2); expect(requests[1].evidence.currentTitle).toBe('My thumbnail work');
  } finally {
    for (const name of ['title-requests.jsonl.errors', 'service.log', 'runtime/service.log']) {
      const output = await readFile(join(directory, name), 'utf8').catch(() => undefined);
      if (output) await testInfo.attach(name.replaceAll('/', '-'), { body: output.slice(-65536), contentType: 'text/plain' });
    }
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
