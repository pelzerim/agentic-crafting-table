import { openDiagnosticSessions } from './session-navigation.ts';
import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { test, openTerminal } from './visual-fixture.ts';

test('Sessions and MCP share archive, stop and removal without changing map items or recordings', async ({ visual: { app, page } }) => {
  await openTerminal(page);
  const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const initial = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  const directory = await app.evaluate(({ app }) => app.getPath('userData'));
  const client = new Client({ name: 'session-management-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const parse = (result: any) => JSON.parse(result.content[0].text);
    await page.getByRole('button', { name: 'Back to project' }).click();
    await openDiagnosticSessions(page);
    await expect(page.locator(`[data-session-id="${id}"]`)).toBeVisible();
    await expect(page.locator('.session-manager')).toHaveScreenshot('settings-diagnostic-sessions.png', { mask: [page.locator('.session-manager .settings-list-meta')] });
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    await expect(page.locator('.session-manager')).toHaveCount(0);
    await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
    await expect(page.locator('.session-manager')).toBeVisible();
    const row = page.locator(`[data-session-id="${id}"]`);
    await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    const rejected = await client.callTool({ name: 'workspace_manage_session', arguments: { sessionId: id, action: 'remove' } });
    expect(parse(rejected).error.code).toBe('SESSION_RUNNING');
    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(parse(await client.callTool({ name: 'workspace_runtime_sessions', arguments: { view: 'active' } }))).toEqual([]);
    const archived = parse(await client.callTool({ name: 'workspace_runtime_sessions', arguments: { view: 'archived' } }));
    expect(archived[0].pid).toBe(initial.pid); expect(archived[0].state).toBe('running');
    await page.reload(); await openDiagnosticSessions(page);
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Archived sessions' }).click();
    await expect(row.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await row.getByRole('button', { name: 'Restore', exact: true }).click(); await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Current sessions' }).click(); await expect(row).toContainText('running');
    await client.callTool({ name: 'workspace_manage_session', arguments: { sessionId: id, action: 'archive' } });
    await expect(row).toHaveCount(0); await page.getByRole('button', { name: 'Archived sessions' }).click();
    await client.callTool({ name: 'workspace_stop_session', arguments: { sessionId: id } });
    await expect(row).toContainText('exited');
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Current sessions' }).click(); await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Ended sessions' }).click();
    await expect(row).toContainText('exited');
    expect(parse(await client.callTool({ name: 'workspace_manage_session', arguments: { sessionId: id, action: 'remove' } })).error.code).toBe('SESSION_NOT_ARCHIVED');
    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    // Archive holds archived sessions in its own Sessions tab.
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.mouse.click(100, 650, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Open archive', exact: true }).click();
    await page.getByRole('form', { name: 'Archive', exact: true }).getByRole('button', { name: 'Archived sessions' }).click();
    await expect(page.getByRole('button', { name: 'Archived sessions' })).toHaveAttribute('aria-pressed', 'true');
    await row.getByRole('button', { name: 'Delete entry', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Keep', exact: true })).toBeFocused(); await page.keyboard.press('Escape');
    await expect(row.getByRole('button', { name: 'Delete entry', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Delete entry', exact: true }).click(); await row.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(row).toHaveCount(0);
    await page.reload();
    expect(await page.evaluate(() => window.craftingTable.sessionsList('all'))).toEqual([]);
    const history = await page.evaluate(async id => {
      let after = 0, text = '';
      for (;;) {
        const page = await window.craftingTable.sessionRead(id, after, true);
        text += page.chunks.map(chunk => chunk.data).join(''); after = page.lastSequence;
        if (!page.hasMore) return { text, session: page.session };
      }
    }, id);
    expect(history.text).toContain('Last terminal row'); expect(history.session.removedAt).toBeTruthy();
    const graph = await page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
    expect(graph.nodes.some(node => node.id === initial.nodeId)).toBe(true);
    expect(graph.resources.some(resource => resource.data.sessionId === id)).toBe(true);
  } finally { await client.close(); }
});
