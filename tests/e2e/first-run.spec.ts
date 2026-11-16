import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

test('the first-run guide opens automatically, stays with the task and can be hidden', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-first-run-'));
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:agent-installation');
      ipcMain.handle('app:agent-installation', () => [{ id: 'claude', name: 'Claude', installed: false }, { id: 'codex', name: 'Codex', installed: false }]);
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1280, 800);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const card = page.getByRole('region', { name: 'Get started' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Choose a project');
    await page.screenshot({ path: 'test-results/pr/first-run-empty.png' });
    const apply = (commands: WorkspaceCommand[]) => page.evaluate(async encoded => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: JSON.parse(encoded) });
    }, JSON.stringify(commands));
    await apply([{ type: 'project.create', id: 'billing', title: 'Billing redesign', summary: '', position: { x: 300, y: 300 } }]);
    await expect(card.getByLabel('Guide project', { exact: true })).toHaveValue('billing');
    await expect(card.getByRole('button', { name: 'Choose project folder' })).toBeVisible();
    await apply([{ type: 'node.update', id: 'billing', workingDirectory: directory }]);
    await card.getByLabel('First task', { exact: true }).fill('Explain the retry behavior and suggest one improvement.');
    await card.getByRole('button', { name: 'Save task on map' }).click();
    await expect(card).toContainText('Task saved');
    await expect(card).toBeVisible();
    await page.reload();
    await expect(card).toContainText('Task saved');
    await expect(card).toContainText('Claude: CLI not found');
    await expect(card.getByRole('button', { name: 'Review and start session' })).toBeDisabled();
    await page.screenshot({ path: 'test-results/pr/first-run-task.png' });
    await card.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.locator('[data-project-label="billing"]')).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: 'Open first session guide' }).click();
    await expect(card).toContainText('Task saved');
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:agent-installation');
      ipcMain.handle('app:agent-installation', () => [{ id: 'claude', name: 'Claude', installed: true }, { id: 'codex', name: 'Codex', installed: false }]);
    });
    await card.getByRole('button', { name: 'Check again' }).click();
    await expect(card.getByRole('button', { name: 'Review and start session' })).toBeEnabled();
  } finally { await exitWithoutShutdown(app); }
});


test('the guide links a task to a scripted agent and opens its first session', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-guided-agent-'));
  const bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` } });
  let sessionId: string | undefined;
  try {
    const page = await app.firstWindow();
    await resize(app, page, 1280, 800);
    const card = page.getByRole('region', { name: 'Get started' });
    await card.getByRole('button', { name: 'Create your first project', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Fixture repository');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(card).toContainText('Claude: CLI found');
    await expect(card.getByRole('button', { name: 'Review and start session' })).toBeDisabled();
    await card.getByLabel('First task', { exact: true }).fill('Explain the retry behavior before making changes.');
    await card.getByRole('button', { name: 'Save task on map' }).click();
    await card.getByRole('button', { name: 'Review and start session' }).click();
    await expect(card).toBeHidden();
    await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue(repo);
    await page.getByLabel('Title', { exact: true }).fill('Guided agent');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Open my first session' })).toBeVisible({ timeout: 20_000 });
    const { state } = await page.evaluate(() => window.craftingTable.workspaceRead());
    const agent = state.nodes.find(node => node.title === 'Guided agent')!;
    const task = state.nodes.find(node => state.resources.some(resource => resource.id === node.resourceId && resource.pluginId === 'workspace.note'))!;
    expect(state.links).toContainEqual(expect.objectContaining({ sourceId: task.id, targetId: agent.id, kind: 'context' }));
    sessionId = String(state.resources.find(resource => resource.id === agent.resourceId)!.data.sessionId);
    await expect.poll(async () => {
      const saved = await readFile(join(repo, 'fixture-opening-context.json'), 'utf8').catch(() => '');
      return Boolean(saved && JSON.parse(saved).context.hierarchy.entries.some((entry: { nodeId: string }) => entry.nodeId === task.id));
    }).toBe(true);
    await page.screenshot({ path: 'test-results/pr/first-run-ready.png' });
    await card.getByRole('button', { name: 'Open my first session' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.xterm-accessibility')).toContainText('What next (scripted fixture)');
  } finally {
    if (sessionId) await (await app.firstWindow()).evaluate(id => window.craftingTable.sessionStop(id), sessionId);
    await exitWithoutShutdown(app);
  }
});


test('hiding the guide in a pristine workspace stays hidden after reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-first-run-dismiss-'));
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.getByRole('region', { name: 'Get started' });
    await card.getByRole('button', { name: 'Hide', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Guide me through my first session' })).toBeVisible();
    await expect(card).toHaveCount(0);
    // A dismissal of the old checklist also survives migration without the new key.
    await page.evaluate(() => { localStorage.removeItem('craft.firstRun.active'); localStorage.setItem('craft.firstRun.hidden', '1'); });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Guide me through my first session' })).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally { await exitWithoutShutdown(app); }
});

test('an existing workspace with no guide preference does not open onboarding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-first-run-existing-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(state => stateSchema.parse({ ...state, revision: 1, nodes: [{ id: 'existing', title: 'Existing project', position: { x: 300, y: 300 } }] }));
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.getByRole('region', { name: 'Get started' });
    await expect(page.locator('[data-project-label="existing"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('craft.firstRun.active'))).toBe('0');
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-project-label="existing"]')).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally { await exitWithoutShutdown(app); }
});
