import { openDiagnosticSessions } from './session-navigation.ts';
import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { test, openTerminal, resize } from './visual-fixture.ts';

test('recording cleanup requires confirmation, preserves native identity, and updates open terminal output through UI and MCP', async ({ visual: { app, page } }) => {
  await openTerminal(page);
  const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const initial = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  const directory = await app.evaluate(({ app }) => app.getPath('userData'));
  const client = new Client({ name: 'recording-test', version: '1' });
  const parse = (result: any) => JSON.parse(result.content[0].text);
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    expect((await client.callTool({ name: 'workspace_delete_recording', arguments: { sessionId: id } })).isError).toBe(true);
    expect(parse(await client.callTool({ name: 'workspace_delete_recording', arguments: { sessionId: id, confirmation: 'delete-recording' } })).error.code).toBe('SESSION_RUNNING');
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await page.getByRole('button', { name: 'Back to project' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Terminal recordings' })).toContainText('Recording database');
    await expect(page.getByRole('button', { name: 'Delete recording', exact: true })).toHaveCount(0);
    expect(parse(await client.callTool({ name: 'workspace_delete_recording', arguments: { sessionId: id, confirmation: 'delete-recording' } })).error.code).toBe('SESSION_NOT_ARCHIVED');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await openDiagnosticSessions(page);
    await page.getByRole('button', { name: 'Ended sessions' }).click();
    await page.locator(`[data-session-id="${id}"]`).getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.mouse.click(100, 650, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Open archive', exact: true }).click();
    await page.getByRole('form', { name: 'Archive', exact: true }).getByRole('button', { name: 'Archived session recordings', exact: true }).click();
    const row = page.locator(`[data-recording-id="${id}"]`);
    await expect(row).toContainText('Development terminal');
    await row.getByRole('button', { name: 'Delete recording', exact: true }).click();
    await row.getByRole('button', { name: 'Keep recording', exact: true }).click();
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id, 0, true), id)).chunks.length).toBeGreaterThan(0);
    await row.getByRole('button', { name: 'Delete recording', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await expect(row).toContainText('Recording deleted');
    await expect(row.getByRole('button', { name: 'Delete recording', exact: true })).toHaveCount(0);
    const storage = parse(await client.callTool({ name: 'workspace_recordings', arguments: {} }));
    expect(storage.recordings.find((entry: any) => entry.id === id).deletedAt).toBeTruthy();
    const deleted = parse(await client.callTool({ name: 'workspace_delete_recording', arguments: { sessionId: id, confirmation: 'delete-recording' } }));
    expect(deleted.session.pid).toBe(initial.pid); expect(deleted.cleanupPending).toBe(false);
    await resize(app, page, 900, 640);
    await row.scrollIntoViewIfNeeded();
    const metadata = row.locator('small').first();
    await expect(metadata).toContainText(`exited ·`);
    await expect(metadata).toContainText(id.slice(0, 8));
    // The native runtime uses a real timestamp and a random session identity.
    // Mask the full metadata line so their varying glyph widths cannot change
    // the mask itself. This style is scoped to screenshot capture only.
    await expect(row).toHaveScreenshot('recording-deleted.png', {
      mask: [metadata], stylePath: resolve('tests/fixtures/recording-screenshot.css'),
    });
    await page.getByRole('button', { name: 'Close archive' }).click();
    await page.getByRole('article', { name: 'Development terminal' }).click();
    await expect(page.locator('.terminal-status')).toContainText('Recording deleted');
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-id', id);
    await expect(page.getByRole('button', { name: 'New shell', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
    await expect(page.locator('.xterm-accessibility-tree')).not.toContainText('Last terminal row');
    await page.reload();
    const persisted = await page.evaluate(id => window.craftingTable.sessionRead(id, 0, true), id);
    expect(persisted.chunks).toEqual([]); expect(persisted.session.recordingDeletedAt).toBe(deleted.session.recordingDeletedAt);
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.some(node => node.id === initial.nodeId)).toBe(true);
    await resize(app, page, 1280, 800);
    await page.evaluate(async () => {
      const state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.resourceCreate({ requestId: '00000000-0000-4000-8000-000000000019', nodeId: '00000000-0000-4000-8000-000000000018', resourceId: '00000000-0000-4000-8000-000000000017', expectedRevision: state.revision, pluginId: 'terminal.session', title: 'MCP cleanup terminal', projectId: 'billing', position: { x: 950, y: 750 }, data: { cwd: '/tmp' } });
    });
    await page.getByRole('article', { name: 'MCP cleanup terminal' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const nextId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!; expect(nextId).not.toBe(id);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type("printf 'MCP_RECORDING_OUTPUT\\n'\n");
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('MCP_RECORDING_OUTPUT');
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await expect(page.locator('.terminal-content .xterm-accessibility-tree')).toContainText('MCP_RECORDING_OUTPUT');
    await client.callTool({ name: 'workspace_manage_session', arguments: { sessionId: nextId, action: 'archive' } });
    const remoteDelete = parse(await client.callTool({ name: 'workspace_delete_recording', arguments: { sessionId: nextId, confirmation: 'delete-recording' } }));
    expect(remoteDelete.session.recordingDeletedAt).toBeTruthy();
    await expect(page.locator('.terminal-recording')).toHaveCount(0);
    await expect(page.locator('.terminal-status')).toContainText('Recording deleted');
    await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
    await expect(page.locator('.xterm-accessibility-tree')).not.toContainText('MCP_RECORDING_OUTPUT');
  } finally { await client.close(); }
});
