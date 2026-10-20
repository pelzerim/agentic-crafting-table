import { expect } from '@playwright/test';
import { join, resolve } from 'node:path';
import { test } from './visual-fixture.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

test('sending terminals and agents to Undermap stops their sessions and keeps their history', async ({ visual: { app, page } }) => {
  const directory = await app.evaluate(({ app }) => app.getPath('userData'));
  await page.evaluate(() => window.craftingTable.sessionsList('all'));
  const runtime = await connectSupervisor(join(directory, 'runtime'));
  const apply = async (commands: WorkspaceCommand[]) => page.evaluate(async payload => {
    const commands = JSON.parse(payload) as WorkspaceCommand[], { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands });
  }, JSON.stringify(commands));
  const read = (id: string) => page.evaluate(id => window.craftingTable.sessionRead(id, 0, true), id);
  try {
    // Plain agents without stop-on-archive stop too: Undermap always ends the process.
    for (const provider of ['claude', 'codex']) {
      const id = `under-${provider}`;
      await apply([{ type: 'item.add', id, resourceId: id + '-r', pluginId: 'agent.session', title: id, projectId: 'billing', position: { x: 650, y: 650 }, data: { sessionId: id, provider } }]);
      await runtime.call('sessions.launch', { sessionId: id, requestId: id, nodeId: id, workspaceId: 'fixture', executable: process.execPath, args: [resolve('tests/fixtures/scripted-agent.mjs')], cwd: directory, cols: 80, rows: 24 });
      await expect.poll(async () => (await read(id)).chunks.map(chunk => chunk.data).join('')).toContain('READY:');
      await apply([{ type: 'nodes.action', ids: ['agent', id], action: 'below' }]);
      await expect.poll(async () => (await read(id)).session.state, { timeout: 2_500 }).toBe('exited');
      const stopped = await read(id);
      expect(stopped.session.stopRequestedAt).toBeTruthy(); expect(stopped.chunks.map(chunk => chunk.data).join('')).toContain('READY:');
      await apply([{ type: 'nodes.action', ids: ['agent', id], action: 'surface' }]);
      await page.waitForTimeout(1_500);
      expect((await read(id)).session.state).toBe('exited'); // Returning never relaunches on its own.
    }
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision,
        pluginId: 'terminal.session', title: 'Undermap terminal', projectId: 'billing', position: { x: 700, y: 700 }, data: { cwd: '/tmp' } });
    });
    await page.getByRole('article', { name: 'Undermap terminal', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const sessionId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo BEFORE_UNDERMAP_$((6*7))\n');
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('BEFORE_UNDERMAP_42');
    await page.keyboard.press('Escape');
    // Sending the project below stops every session inside it.
    await apply([{ type: 'node.below', id: 'billing' }]);
    await expect.poll(async () => (await read(sessionId)).session.state, { timeout: 2_500 }).toBe('exited');
    expect((await read(sessionId)).chunks.map(chunk => chunk.data).join('')).toContain('BEFORE_UNDERMAP_42');
  } finally { runtime.close(); }
});
