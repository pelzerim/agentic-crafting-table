import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('real terminal output receives a bounded native summary; labels and budgets survive service restart', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-summary-ui-')), bin = join(directory, 'bin'), log = join(directory, 'summary-requests.jsonl');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-summary.mjs')).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, ACT_SUMMARY_FIXTURE_LOG: log, PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/sh' };
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Summary project');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Summary project');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Billing tests');
    await page.getByLabel('Working directory', { exact: true }).fill(directory);
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    const card = page.getByRole('article', { name: 'Billing tests' }); await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type("printf 'Running billing tests\\npassword=FAKE_PRIVATE_CREDENTIAL\\n'\n");
    await expect(page.locator('.xterm-accessibility')).toContainText('Running billing tests');
    await page.getByRole('button', { name: 'Back to project' }).click();
    const readNode = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.title === 'Billing tests')!);
    const before = await readNode();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'AI features', exact: true }).click();
    await expect(page.getByLabel('Summarize agent and terminal activity', { exact: true })).not.toBeChecked();
    await page.getByLabel('Summarize agent and terminal activity', { exact: true }).check();
    await expect(page.getByLabel('Summary model', { exact: true })).toHaveValue('haiku');
    await page.getByLabel('Summary requests per hour').fill('1');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(card).toContainText('Running billing regression tests', { timeout: 25_000 });
    const after = await readNode(); expect(after.activity).toBe(before.activity); expect(after.attention).toBe(before.attention);
    const entries = () => readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(() => []);
    expect(await entries()).toHaveLength(1); expect((await entries())[0].evidence.recentOutput).toContain('[redacted credential]');
    const workspace = await connectWorkspace(directory), hello = await workspace.call<{ pid: number }>('hello'); workspace.close(); process.kill(hello.pid, 'SIGKILL');
    await expect.poll(async () => {
      const client = await connectWorkspace(directory).catch(() => undefined);
      if (!client) return false;
      try { return (await client.call<{ pid: number }>('hello')).pid !== hello.pid; } finally { client.close(); }
    }).toBe(true);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => window.craftingTable.workspaceRead());
    await card.click();
    await expect(page.locator('.map-card.expanded')).toBeVisible();
    await expect(card).not.toHaveClass(/expanded/);
    await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toBeEnabled();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.type("printf 'More billing tests after restart\\n'\n");
    await expect(page.locator('.xterm-accessibility')).toContainText('More billing tests after restart');
    await page.getByRole('button', { name: 'Back to project' }).click();
    // Wait beyond the summary debounce without making paid calls.
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.settingsRead())).value.summaries.requestsPerHour).toBe(1);
    await page.waitForTimeout(6000);
    expect(await entries()).toHaveLength(1); await expect(card).toContainText('Running billing regression tests');
    await card.click(); expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.state).toBe('running');
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await expect.poll(async () => (await readNode()).activity).toBe('complete');
  } finally {
    for (const name of ['summary-requests.jsonl.errors', 'service.log', 'runtime/service.log']) {
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
