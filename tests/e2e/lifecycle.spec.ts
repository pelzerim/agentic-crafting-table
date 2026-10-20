import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

async function answerClose(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = (async (options: any) => { (globalThis as any).closeDialog = options; return { response, checkboxChecked: false }; }) as any;
  }, response);
}

for (const warnBeforeClosing of [true, false]) test(`close can be cancelled, then stops managed work and restores sessions (warning ${warnBeforeClosing ? 'on' : 'off'})`, async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-close-reopen-')), bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).waitFor();
    const projectId = randomUUID();
    await page.evaluate(async projectId => {
      const state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: projectId, title: 'Persistent project', summary: 'BILLING_BRIEF', position: { x: 300, y: 200 } }] });
    }, projectId);
    const nodes: Record<string, { nodeId: string; sessionId: string; cwd: string; nativeId: string }> = {};
    for (const name of ['working', 'waiting', 'stopped', 'terminal']) {
      const cwd = join(directory, name); await mkdir(cwd);
      const nodeId = randomUUID(), requestId = randomUUID();
      await page.evaluate(async input => {
        const state = (await window.craftingTable.workspaceRead()).state;
        await window.craftingTable.resourceCreate({ requestId: input.requestId, nodeId: input.nodeId, resourceId: crypto.randomUUID(), expectedRevision: state.revision, projectId: input.projectId, title: input.name, position: { x: 600, y: 200 }, pluginId: input.name === 'terminal' ? 'terminal.session' : 'agent.session', data: input.name === 'terminal' ? { cwd: input.cwd } : { cwd: input.cwd, provider: 'claude', model: 'opus' } });
      }, { name, cwd, nodeId, requestId, projectId });
      nodes[name] = { nodeId, sessionId: requestId, nativeId: requestId, cwd };
      if (name !== 'terminal') await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), requestId)).chunks.map(chunk => chunk.data).join('')).toContain('NATIVE_IDLE:');
    }
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), nodes.terminal.sessionId)).chunks.map(chunk => chunk.data).join('')).toContain('$');
    await page.evaluate(async nodes => {
      await window.craftingTable.sessionInput(nodes.working.sessionId, 'work\r');
      await window.craftingTable.sessionInput(nodes.waiting.sessionId, 'wait-for-input\r');
      await window.craftingTable.sessionStop(nodes.stopped.sessionId);
      await window.craftingTable.sessionInput(nodes.terminal.sessionId, "sleep 1000 & jobs -p > child.pid; wait\r");
    }, nodes);
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(node => node.id === nodes.working.nodeId)?.activity).toBe('working');
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(node => node.id === nodes.waiting.nodeId)?.attention).toBe('input');
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), nodes.stopped.sessionId)).session.state).toBe('exited');
    await expect.poll(() => readFile(join(nodes.terminal.cwd, 'child.pid'), 'utf8').then(value => value.trim()).catch(() => '')).toMatch(/^\d+$/);
    const childPid = Number(await readFile(join(nodes.terminal.cwd, 'child.pid'), 'utf8'));
    await page.evaluate(async nodes => {
      await window.craftingTable.sessionManage(nodes.terminal.sessionId, 'archive');
      await window.craftingTable.sessionManage(nodes.stopped.sessionId, 'archive');
      await window.craftingTable.sessionManage(nodes.stopped.sessionId, 'remove');
    }, nodes);
    const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const layout = before.nodes.map(({ id, resourceId, projectId, position }) => ({ id, resourceId, projectId, position }));
    await page.evaluate(async () => {
      const settings = await window.craftingTable.settingsRead();
      await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, warnBeforeClosing: true } });
    });
    await answerClose(app, 1);
    // macOS hides the window on close; Quit is the path that stops sessions there.
    if (process.platform === 'darwin') await app.evaluate(({ app }) => { app.quit(); });
    else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(() => (globalThis as any).closeDialog?.message)).toBe('Closing will stop ongoing sessions.');
    expect(await app.evaluate(() => (globalThis as any).closeDialog.defaultId)).toBe(1);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), nodes.working.sessionId)).session.state).toBe('running');
    expect((await page.evaluate(() => window.craftingTable.recoveryStatus())).phase).toBe('open');
    const windowBounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workArea;
      window.setBounds({ x: area.x + 25, y: area.y + 35, width: 1050, height: 700 });
      return window.getBounds();
    });
    if (!warnBeforeClosing) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('treeitem', { name: 'General', exact: true }).click();
      await expect(settings.getByLabel('Warn before closing with active sessions')).toBeChecked();
      await settings.getByLabel('Warn before closing with active sessions').uncheck();
      await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
    }
    // Cancel any unexpected confirmation when disabled: shutdown must still finish.
    await answerClose(app, warnBeforeClosing ? 0 : 1);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => { app.quit(); });
    await closed;
    await expect.poll(() => { try { process.kill(childPid, 0); return true; } catch { return false; } }).toBe(false);
    app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.warnBeforeClosing).toBe(warnBeforeClosing);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(windowBounds);
    await expect(page.getByRole('article', { name: 'Persistent project' })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.recoveryStatus())).entries.filter(entry => entry.state === 'restored').length).toBe(2);
    await expect(page.getByText('2 sessions restored', { exact: true })).toBeVisible();
    const after = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    expect(after.nodes.map(({ id, resourceId, projectId, position }) => ({ id, resourceId, projectId, position }))).toEqual(layout);
    for (const name of ['working', 'waiting']) {
      const node = after.nodes.find(node => node.id === nodes[name].nodeId)!;
      const resource = after.resources.find(resource => resource.id === node.resourceId)!;
      expect(resource.data.sessionId).not.toBe(nodes[name].sessionId);
      expect(resource.data.cwd).toContain(name);
      const resumed = (await page.evaluate(id => window.craftingTable.sessionRead(id), String(resource.data.sessionId))).session;
      expect(resumed.predecessorId).toBe(nodes[name].sessionId);
      expect(Boolean(resumed.archivedAt)).toBe(false);
      if (name !== 'terminal') {
        expect(resource.data.nativeSessionId).toBe(nodes[name].nativeId);
        await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), String(resource.data.sessionId))).chunks.map(chunk => chunk.data).join('')).toContain('NATIVE_RESUMED:');
      }
    }
    await expect.poll(() => readFile(join(nodes.working.cwd, 'fixture-continued.txt'), 'utf8').catch(() => '')).toBe(nodes.working.nativeId);
    expect(await readFile(join(nodes.waiting.cwd, 'fixture-continued.txt'), 'utf8').catch(() => '')).toBe('');
    const terminal = after.resources.find(resource => resource.id === after.nodes.find(node => node.id === nodes.terminal.nodeId)?.resourceId)!;
    expect(terminal.data.sessionId).toBe(nodes.terminal.sessionId);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), nodes.terminal.sessionId)).session.state).toBe('exited');
    const stopped = after.resources.find(resource => resource.id === after.nodes.find(node => node.id === nodes.stopped.nodeId)?.resourceId)!;
    expect(stopped.data.sessionId).toBe(nodes.stopped.sessionId);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), nodes.working.sessionId)).chunks.map(chunk => chunk.data).join('')).toContain('WORK_STARTED');
    await page.screenshot({ path: 'test-results/restored-workspace.png' });
    await page.evaluate(() => window.craftingTable.retryRecovery());
    expect((await page.evaluate(() => window.craftingTable.sessionsList('all'))).filter(session => session.state === 'running')).toHaveLength(2);
    expect((await page.evaluate(() => window.craftingTable.sessionsList())).filter(session => session.state === 'running')).toHaveLength(2);
    expect((await page.evaluate(() => window.craftingTable.sessionsList('all'))).some(session => session.id === nodes.stopped.sessionId)).toBe(false);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing the window on macOS hides it while sessions keep running; Dock activate reveals the same window', async () => {
  test.skip(process.platform !== 'darwin', 'Hide-on-close is macOS behaviour');
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-close-hide-'));
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh' };
  const app = await electron.launch({ args: ['.'], env });
  let quit = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).waitFor();
    const projectId = randomUUID(), sessionId = randomUUID(), cwd = join(directory, 'ticker');
    await mkdir(cwd);
    await page.evaluate(async input => {
      let state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: input.projectId, title: 'Hidden project', summary: 'Hidden', position: { x: 300, y: 200 } }] });
      state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.resourceCreate({ requestId: input.sessionId, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision, projectId: input.projectId, title: 'Ticker', position: { x: 600, y: 200 }, pluginId: 'terminal.session', data: { cwd: input.cwd } });
    }, { projectId, sessionId, cwd });
    const output = async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('');
    const ticks = async () => (await output()).split('TICK').length - 1;
    await expect.poll(output).toContain('$');
    await page.evaluate(id => window.craftingTable.sessionInput(id, 'while :; do echo TICK; sleep 0.2; done\r'), sessionId);
    await expect.poll(ticks).toBeGreaterThan(3);
    // Warning enabled: hiding never asks, because nothing stops.
    await page.evaluate(async () => {
      const settings = await window.craftingTable.settingsRead();
      await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, warnBeforeClosing: true } });
      (window as unknown as { hiddenMarker: string }).hiddenMarker = 'same-document';
    });
    await answerClose(app, 1);
    const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(() => (globalThis as any).actWindowPresence?.state)).toBe('hidden');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, destroyed: window.isDestroyed() })))).toEqual([{ id: windowId, destroyed: false }]);
    expect(await app.evaluate(() => (globalThis as any).closeDialog)).toBeUndefined();
    expect(app.process().exitCode).toBeNull();
    expect((await page.evaluate(() => window.craftingTable.recoveryStatus())).phase).toBe('open');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.state).toBe('running');
    const hiddenTicks = await ticks();
    await expect.poll(ticks).toBeGreaterThan(hiddenTicks + 3);
    await app.evaluate(({ app }) => { app.emit('activate', {}, false); });
    await expect.poll(() => app.evaluate(() => (globalThis as any).actWindowPresence?.state)).toBe('shown');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id))).toEqual([windowId]);
    expect(await page.evaluate(() => (window as unknown as { hiddenMarker: string }).hiddenMarker)).toBe('same-document');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.state).toBe('running');
    // The Window menu reopens it as well.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(() => (globalThis as any).actWindowPresence?.state)).toBe('hidden');
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('show-main-window')!.click(); });
    await expect.poll(() => app.evaluate(() => (globalThis as any).actWindowPresence?.state)).toBe('shown');
    // Quit still uses the orderly close path with its optional warning.
    await app.evaluate(({ app }) => { app.quit(); });
    await expect.poll(() => app.evaluate(() => (globalThis as any).closeDialog?.message)).toBe('Closing will stop ongoing sessions.');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.state).toBe('running');
    const shellPid = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid!;
    expect(shellPid).toBeGreaterThan(0);
    await answerClose(app, 0);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => { app.quit(); });
    await closed; quit = true;
    await expect.poll(() => { try { process.kill(shellPid, 0); return true; } catch { return false; } }).toBe(false);
  } finally {
    if (!quit) await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
