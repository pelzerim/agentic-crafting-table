import { openDiagnosticSessions } from './session-navigation.ts';
import { openProjectPicker } from './project-picker.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { SessionSnapshot } from '../../packages/session-runtime/protocol.ts';

test('native terminal survives zoom, window and workspace restart; deleting its node does not stop it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-desktop-terminal-'));
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh' } });
  const mcp = new Client({ name: 'terminal-directory-check', version: '1' });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Terminal project');
    await page.getByLabel('Project working directory', { exact: true }).fill(directory);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Terminal project');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Development shell');
    await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue(directory);
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    const card = page.getByRole('article', { name: 'Development shell' });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
    const sessionId = (await surface.getAttribute('data-terminal-id'))!;
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await expect(page.locator('.map-locator')).not.toBeVisible();
    await expect(page.getByRole('slider', { name: 'Map zoom' })).not.toBeVisible();
    const fontSize = () => page.locator('.xterm-accessibility-tree').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    const originalFont = await fontSize();
    const zoomFactor = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: '+', modifiers: ['control'] }));
    await expect.poll(fontSize).toBe(originalFont + 1);
    await page.keyboard.press('Control+0');
    await expect.poll(fontSize).toBe(originalFont);
    await page.keyboard.press('Control++');
    await expect.poll(fontSize).toBe(originalFont + 1);
    await page.keyboard.press('Control+-');
    await expect.poll(fontSize).toBe(originalFont);
    await page.keyboard.press('Meta++');
    await expect.poll(fontSize).toBe(originalFont + 1);
    await page.keyboard.press('Meta+0');
    await expect.poll(fontSize).toBe(13);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(zoomFactor);
    for (const size of [[900, 600], [1280, 860]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), size);
      await expect.poll(() => page.locator('.terminal-surface').evaluate(element => {
        const screen = element.querySelector('.xterm-screen')!.getBoundingClientRect(), outer = element.getBoundingClientRect();
        return screen.bottom <= outer.bottom - 7 && screen.right <= outer.right - 7;
      })).toBe(true);
    }

    await page.keyboard.type("printf 'from-real-shell' > proof.txt\n");
    await expect.poll(() => readFile(join(directory, 'proof.txt'), 'utf8').catch(() => '')).toBe('from-real-shell');
    const runtime = await connectSupervisor(join(directory, 'runtime'));
    const session = await runtime.call<SessionSnapshot>('sessions.read', { sessionId }); runtime.close();
    expect(session.session.pid).toBeGreaterThan(0);
    const exit = page.getByRole('button', { name: 'Back to project' });
    await expect(exit).toHaveText('');
    await expect(exit.locator('svg')).toBeVisible();
    // Compare the controls in one renderer frame after the bubble's motion;
    // separate IPC reads can sample different points of the same transform.
    const view = page.getByRole('region', { name: 'Development shell', exact: true });
    await expect.poll(() => view.evaluate(element => element.getAnimations().filter(animation => animation.id === 'bubble-expansion').length)).toBe(0);
    const controls = await view.evaluate(element => {
      const close = element.querySelector('.item-close')!.getBoundingClientRect();
      const stop = [...element.querySelectorAll('button')].find(button => button.textContent === 'Stop session')!.getBoundingClientRect();
      return { closeHeight: close.height, stopHeight: stop.height, closeY: close.y, stopY: stop.y };
    });
    expect(controls.closeHeight).toBe(controls.stopHeight);
    expect(controls.closeY).toBe(controls.stopY);
    // Right-click the actual native terminal: return to the map without its menu or a new item.
    await surface.click({ button: 'right' });
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'New item' })).toHaveCount(0);
    await card.click();
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(session.session.pid);
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
    // Secondary click outside the content has the same navigation behavior.
    await page.locator('.rail-settings').click({ button: 'right' });
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await card.click();
    await exit.click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await card.click();
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
    await page.screenshot({ path: 'test-results/native-terminal.png' });
    await exitWithoutShutdown(app);
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh' } });
    page = await app.firstWindow();
    await page.getByRole('article', { name: 'Development shell' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const current = await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId);
    expect(current.session.pid).toBe(session.session.pid);
    expect(current.chunks.map(chunk => chunk.data).join('')).toContain('from-real-shell');
    const workspace = await connectWorkspace(directory);
    const hello = await workspace.call<{ pid: number }>('hello'); workspace.close(); process.kill(hello.pid, 'SIGKILL');
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'after-service-restart' > proof.txt\n");
    await expect.poll(() => readFile(join(directory, 'proof.txt'), 'utf8')).toBe('after-service-restart');
    await page.evaluate(async id => {
      const state = (await window.craftingTable.workspaceRead()).state;
      const resource = state.resources.find(resource => resource.data.sessionId === id)!;
      const node = state.nodes.find(node => node.resourceId === resource.id)!;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'desktop' }, commands: [{ type: 'node.archive', id: node.id }, { type: 'node.delete', id: node.id }] });
    }, sessionId);
    await expect(page.getByRole('article', { name: 'Development shell' })).toHaveCount(0);
    await openDiagnosticSessions(page);
    const row = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(row.getByText('Session · not on the map')).toBeVisible();
    await expect(row).toContainText('running');
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Ended sessions' }).click();
    await expect(row).toContainText('exited');
    // Production MCP may omit cwd; the service resolves and freezes the same
    // project default used by the creation form, including after a restart.
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp-bridge.cjs')], env: { ...process.env as Record<string, string>, ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const call = async (name: string, input: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: input }); expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const state = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const project = state.nodes.find(node => !node.resourceId)!;
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: state.revision, pluginId: 'terminal.session', title: 'MCP shell', projectId: project.id, position: { x: 1000, y: 600 }, data: {} };
    const inherited = await call('workspace_create_item', request);
    expect(inherited.session.cwd).toBe(await realpath(directory));
    await call('workspace_stop_session', { sessionId: inherited.session.id });
    await page.evaluate(async id => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.update', id, workingDirectory: '' }] });
    }, project.id);
    const replay = await call('workspace_create_item', request);
    expect(replay.session.id).toBe(inherited.session.id); expect(replay.session.cwd).toBe(inherited.session.cwd);
  } finally {
    await mcp.close();
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
