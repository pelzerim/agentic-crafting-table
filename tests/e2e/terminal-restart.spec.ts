import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { test, openTerminal } from './visual-fixture.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';

test('a stopped Terminal starts a new shell and retries preserve the original restart across service loss', async ({ visual: { app, page } }) => {
  await openTerminal(page);
  const oldId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const first = (await page.evaluate(id => window.craftingTable.sessionRead(id), oldId)).session;
  const directory = await app.evaluate(({ app }) => app.getPath('userData'));
  const client = new Client({ name: 'terminal-restart-test', version: '1' });
  const parse = (result: any) => JSON.parse(result.content[0].text);
  const requestId = '00000000-0000-4000-8000-000000000011';
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const start = (id = requestId) => client.callTool({ name: 'workspace_run', arguments: { action: 'terminal.start', nodeId: first.nodeId, arguments: { requestId: id } } });
    await expect(page.getByRole('button', { name: 'New shell', exact: true })).toBeDisabled();
    const attachId = '00000000-0000-4000-8000-000000000012';
    expect(parse(await start(attachId)).session.id).toBe(oldId);
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New shell', exact: true })).toBeEnabled();
    expect(parse(await start(attachId)).session.state, 'retrying an old attach must not start new work').toBe('exited');
    await page.getByRole('button', { name: 'New shell', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const nextId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
    expect(nextId).not.toBe(oldId);
    const next = (await page.evaluate(id => window.craftingTable.sessionRead(id), nextId)).session;
    expect(next.cwd).toBe(first.cwd); expect(next.predecessorId).toBe(oldId); expect(next.pid).not.toBe(first.pid);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id, 0, true), oldId)).chunks.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New shell', exact: true })).toBeEnabled();
    const [a, b] = await Promise.all([start(), start()]);
    expect(parse(a).session.pid).toBe(parse(b).session.pid);
    expect(parse(a).session.id).toBe(requestId);
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-id', requestId);
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New shell', exact: true })).toBeEnabled();
    expect(parse(await start()).session.state).toBe('exited');
    const workspace = await connectWorkspace(directory); const hello = await workspace.call<{ pid: number }>('hello'); workspace.close();
    process.kill(hello.pid, 'SIGKILL');
    await expect.poll(async () => { const connection = await connectWorkspace(directory).catch(() => undefined); if (!connection) return false; try { return (await connection.call<{ pid: number }>('hello')).pid !== hello.pid; } finally { connection.close(); } }).toBe(true);
    const replay = parse(await start()); expect(replay.session.id).toBe(requestId); expect(replay.session.state).toBe('exited');
    expect(replay.session.pid).toBe(parse(a).session.pid);
    // No resumed process is silently launched for an already completed request.
    expect((await page.evaluate(() => window.craftingTable.sessionsList('all'))).filter(session => session.state === 'running')).toHaveLength(0);
  } finally { await client.close(); }
});
