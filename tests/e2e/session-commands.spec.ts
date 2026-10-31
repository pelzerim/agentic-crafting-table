import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openProjectPicker } from './project-picker.ts';

async function withApp(run: (app: ElectronApplication, directory: string, repo: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-session-commands-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  for (const [name, fixture] of [['claude', 'native-agent'], ['codex', 'native-codex']]) await writeFile(join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve(`tests/fixtures/${fixture}.mjs`)).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), CODEX_FIXTURE_HOME: repo, PATH: `${bin}:${process.env.PATH}` } });
  try { await run(app, directory, repo); }
  finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
async function createProject(page: Page, repo: string) {
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Agent project');
  await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
  await page.getByLabel('Project working directory', { exact: true }).fill(repo);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await openProjectPicker(page, 'Agent project');
  await page.getByRole('button', { name: 'Agent session', exact: true }).click();
}

test('/clear in an open agent opens a new session beside it and moves the view there, and the old item keeps its conversation', async () => {
  test.setTimeout(60_000);
  await withApp(async (app, directory, repo) => {
    const page = await app.firstWindow(), nativeConfig = join(directory, 'claude-history');
    await createProject(page, repo);
    await page.getByLabel('Title', { exact: true }).fill('Claude session');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Claude session' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');

    const agents = () => page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      return state.nodes.filter(node => node.resourceId).map(node => ({ id: node.id, title: node.title, x: node.position.x, projectId: node.projectId, ...state.resources.find(resource => resource.id === node.resourceId)!.data }));
    }) as Promise<{ id: string; title: string; x: number; projectId?: string; sessionId: string; nativeSessionId: string; cwd: string }[]>;
    const [source] = await agents();
    const folder = join(nativeConfig, 'projects', realpathSync(repo).replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${source.nativeSessionId}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: source.nativeSessionId, cwd: realpathSync(repo), isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Saved work' } }) + '\n');

    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('clear-command\n');

    await expect(page.getByRole('region', { name: 'New session', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('region', { name: 'Claude session', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'New session', exact: true }).locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect.poll(async () => (await agents()).find(agent => agent.id === source.id)?.sessionId, { timeout: 15_000 }).not.toBe(source.sessionId);
    const [kept, opened] = await agents();
    expect(kept.nativeSessionId).toBe(source.nativeSessionId);
    expect(opened.nativeSessionId).not.toBe(source.nativeSessionId);
    expect(opened.projectId).toBe(source.projectId);
    expect(opened.cwd).toBe(source.cwd);
    const supervisor = await connectSupervisor(join(directory, 'runtime'));
    const sessions = await supervisor.call<{ id: string; state: string }[]>('sessions.list'); supervisor.close();
    expect(sessions.filter(session => session.state === 'running').map(session => session.id).sort()).toEqual([kept.sessionId, opened.sessionId].sort());
  });
});

test('/new in an open Codex agent moves the view to a new session', async () => {
  test.setTimeout(60_000);
  await withApp(async (app, directory, repo) => {
    const page = await app.firstWindow();
    await createProject(page, repo);
    await page.getByRole('radio', { name: 'Codex', exact: true }).check();
    await page.getByLabel('Title', { exact: true }).fill('Codex session');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await page.getByRole('article', { name: 'Codex session', exact: true }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_READY:');
    const session = () => page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      return state.resources.filter(resource => resource.pluginId === 'agent.session').map(resource => ({ sessionId: String(resource.data.sessionId), nativeSessionId: String(resource.data.nativeSessionId) }));
    });
    const [source] = await session();

    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('new-command\n');

    const opened = page.getByRole('region', { name: 'New session', exact: true });
    await expect(opened).toBeVisible({ timeout: 15_000 });
    await expect(opened.locator('.xterm-accessibility')).toContainText('NATIVE_READY:');
    const after = await session();
    expect(after).toHaveLength(2);
    expect(after[0].nativeSessionId, 'the item the command was typed in keeps its conversation').toBe(source.nativeSessionId);
    expect(after[1].nativeSessionId).not.toBe(source.nativeSessionId);
    const supervisor = await connectSupervisor(join(directory, 'runtime'));
    const running = (await supervisor.call<{ id: string; state: string }[]>('sessions.list')).filter(record => record.state === 'running').map(record => record.id); supervisor.close();
    expect(running).toContain(after[1].sessionId);
  });
});
