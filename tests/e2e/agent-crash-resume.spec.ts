import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openProjectPicker } from './project-picker.ts';
import { expectStopSession } from './agent-session.ts';

async function sizeBy(page: Page, handle: Locator, dx: number, dy: number) {
  const grip = (await handle.boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}
/** The grid xterm shows locally, independent of the process's PTY size. */
const localGrid = (page: Page) => page.locator('.terminal-surface').evaluate(element => {
  const screen = element.querySelector('.xterm-screen')!.getBoundingClientRect(), style = getComputedStyle(element.querySelector('.xterm')!);
  const context = document.createElement('canvas').getContext('2d')!; context.font = `${style.fontSize} ${style.fontFamily}`;
  return { cols: Math.round(screen.width / context.measureText('W').width), rows: element.querySelectorAll('.xterm-accessibility-tree > div').length };
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sessionOf = (page: Page, nodeId: string) => page.evaluate(async id => {
  const { state } = await window.craftingTable.workspaceRead(), node = state.nodes.find(node => node.id === id);
  return String(state.resources.find(resource => resource.id === node?.resourceId)?.data.sessionId);
}, nodeId);

test('after a crash, Resume in a lost agent view attaches the new process and sizes its terminal', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-crash-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Agent project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Crashed Claude');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Crashed Claude' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');
    const nodeId = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(node => node.title === 'Crashed Claude')!.id;
    const lostId = await sessionOf(page, nodeId);
    const child = (await page.evaluate(id => window.craftingTable.sessionRead(id), lostId)).session.pid!;

    // A machine crash ends the desktop, workspace service, supervisor and agent together without a close checkpoint.
    const workspace = await connectWorkspace(directory), service = (await workspace.call<{ pid: number }>('hello')).pid; workspace.close();
    const runtime = await connectSupervisor(join(directory, 'runtime')), supervisor = (await runtime.call<{ pid: number }>('hello')).pid; runtime.close();
    await exitWithoutShutdown(app);
    for (const pid of [supervisor, service, child]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await expect.poll(() => [supervisor, service, child].some(alive)).toBe(false);

    app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('article', { name: 'Crashed Claude' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'lost');
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');
    const handle = page.getByRole('button', { name: 'Resize view: Crashed Claude' });
    const initial = await localGrid(page);
    await sizeBy(page, handle, -240, -180);
    await expect.poll(async () => (await localGrid(page)).rows).toBeLessThan(initial.rows);
    // The replayed recording has no process to redraw it, but xterm still fills a larger view.
    await sizeBy(page, handle, 240, 180);
    await expect.poll(() => localGrid(page)).toEqual(initial);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(() => sessionOf(page, nodeId)).not.toBe(lostId);
    await expect(page.locator('.terminal-error')).toHaveCount(0);
    const resumedId = await sessionOf(page, nodeId);
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-id', resumedId);
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_RESUMED:');
    await expectStopSession(page, true);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    const pty = async () => { const { cols, rows } = (await page.evaluate(id => window.craftingTable.sessionRead(id), resumedId)).session; return { cols, rows }; };
    // The new process starts at a default size; attaching must size it to the open view.
    await expect.poll(async () => (await pty()).rows).toBe(initial.rows);
    const attached = await pty();
    await sizeBy(page, handle, -240, -180);
    await expect.poll(async () => (await pty()).rows).toBeLessThan(attached.rows);
    expect((await pty()).cols).toBeLessThan(attached.cols);
    await sizeBy(page, handle, 240, 180);
    await expect.poll(pty).toEqual(attached);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
