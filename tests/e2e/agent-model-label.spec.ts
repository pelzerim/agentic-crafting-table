import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openProjectPicker } from './project-picker.ts';

/** AGENT-04b: the expanded agent view's header names the model and effort the session runs on now. */
async function launch(provider: 'claude' | 'codex') {
  const directory = await mkdtemp(join(tmpdir(), `craft-model-label-${provider}-`)), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  const fixture = provider === 'claude' ? 'native-agent.mjs' : 'native-codex.mjs';
  await writeFile(join(bin, provider), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve(`tests/fixtures/${fixture}`)).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), CODEX_FIXTURE_HOME: repo, PATH: `${bin}:${process.env.PATH}` };
  const app = await electron.launch({ args: ['.'], env }), page = await app.firstWindow();
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Agent project');
  await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
  await page.getByLabel('Project working directory', { exact: true }).fill(repo);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await openProjectPicker(page, 'Agent project');
  await page.getByRole('button', { name: 'Agent session', exact: true }).click();
  if (provider === 'codex') { await page.getByRole('radio', { name: 'Codex', exact: true }).check(); await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-6-astra'); }
  await page.getByLabel('Title', { exact: true }).fill('Billing agent');
  await page.getByRole('button', { name: provider === 'claude' ? 'Start Claude' : 'Start Codex', exact: true }).click();
  await page.getByRole('article', { name: 'Billing agent' }).click();
  await expect(page.locator('.xterm-accessibility')).toContainText(provider === 'claude' ? 'NATIVE_IDLE:' : 'NATIVE_READY:');
  const sessionId = String((await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(resource => resource.pluginId === 'agent.session')!.data.sessionId);
  return { app, page, directory, type: (line: string) => page.evaluate(([id, text]) => window.craftingTable.sessionInput(id, text), [sessionId, `${line}\r`] as const) };
}

async function close(app: ElectronApplication, directory: string) {
  await exitWithoutShutdown(app);
  for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
    const client = await connect().catch(() => undefined);
    if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
  }
  await rm(directory, { recursive: true, force: true });
}

const header = (page: Page) => page.getByRole('region', { name: 'Billing agent', exact: true }).locator('.terminal-status');

test('a Claude view names the model `/model` switched to and the effort its next turn reports', async () => {
  test.setTimeout(60_000);
  const { app, page, directory, type } = await launch('claude');
  try {
    const label = page.locator('.terminal-launch');
    await expect(label).toHaveText('claude · opus');
    await type('effort-turn:high');
    await expect(label).toHaveText('claude · opus high');
    await type('model-command:claude-fable-5-2');
    await expect(page.locator('.xterm-accessibility')).toContainText('MODEL_SWITCHED');
    await page.waitForTimeout(500);
    await header(page).screenshot({ path: 'test-results/pr/agent-model-label-claude.png' });
    await expect(label).toHaveText('claude · fable 5.2 high');
    await expect(label).toHaveAttribute('title', 'Provider, model and effort this session runs on now');
    await type('effort-turn:low');
    await expect(label).toHaveText('claude · fable 5.2 low');
  } finally { await close(app, directory); }
});

test("a Codex view names the model and effort the terminal's `/model` picked, without a turn", async () => {
  test.setTimeout(60_000);
  const { app, page, directory, type } = await launch('codex');
  try {
    const label = page.locator('.terminal-launch');
    await expect(label).toHaveText('codex · gpt-6-astra high');
    await type('model-command:gpt-6.2-sol:medium');
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_INPUT:model-command');
    await page.waitForTimeout(3000); // One settings read: the TUI's `/model` sends no notice.
    await header(page).screenshot({ path: 'test-results/pr/agent-model-label-codex.png' });
    await expect(label).toHaveText('codex · gpt-6.2-sol medium');
  } finally { await close(app, directory); }
});
