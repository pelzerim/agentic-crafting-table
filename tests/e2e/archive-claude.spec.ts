import { openDiagnosticSessions } from './session-navigation.ts';
import { expect } from '@playwright/test';
import { join, resolve } from 'node:path';
import { test } from './visual-fixture.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

test('archiving Claude from the map, Sessions or its project stops the PTY and preserves history', async ({ visual: { app, page } }) => {
  const directory = await app.evaluate(({ app }) => app.getPath('userData'));
  await page.evaluate(() => window.craftingTable.sessionsList('all'));
  const runtime = await connectSupervisor(join(directory, 'runtime'));
  const apply = async (commands: WorkspaceCommand[]) => page.evaluate(async payload => {
    const commands = JSON.parse(payload) as WorkspaceCommand[], { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands });
  }, JSON.stringify(commands));
  try {
    for (const route of ['map', 'sessions', 'project']) {
      const id = `archive-${route}`;
      await apply([{ type: 'item.add', id, resourceId: id + '-r', pluginId: 'agent.session', title: id, projectId: 'billing', position: { x: 650, y: 650 }, data: { sessionId: id, provider: 'claude' } }]);
      await runtime.call('sessions.launch', { sessionId: id, requestId: id, nodeId: id, workspaceId: 'fixture', executable: process.execPath, args: [resolve('tests/fixtures/scripted-agent.mjs')], cwd: directory, cols: 80, rows: 24, ...(route !== 'map' ? { stopOnArchive: true } : {}) });
      await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).chunks.map(chunk => chunk.data).join('')).toContain('READY:');
      if (route === 'sessions') {
        await openDiagnosticSessions(page);
        await page.locator(`[data-session-id="${id}"]`).getByRole('button', { name: 'Archive', exact: true }).click();
      } else {
        if (route === 'map') {
          for (const selected of ['agent', id]) {
            const rect = await page.locator(`.react-flow__node[data-id="${selected}"]`).boundingBox();
            await page.keyboard.down('Shift'); await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2); await page.keyboard.up('Shift');
          }
        }
        await page.locator(`.react-flow__node[data-id="${route === 'project' ? 'billing' : id}"]`).click({ button: 'right' });
        await page.getByRole('menuitem', { name: route === 'project' ? 'Send project to Undermap' : 'Send selection to Undermap', exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(node => node.id === (route === 'project' ? 'billing' : id))?.belowAt).toBeTruthy();
        await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.state).toBe('exited'); // Undermap stops it before any archive.
        await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
        await page.locator(`.react-flow__node[data-id="${route === 'project' ? 'billing' : id}"]`).click({ button: 'right' });
        await page.getByRole('menuitem', { name: route === 'project' ? 'Archive project' : 'Archive', exact: true }).click();
        await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
      }
      await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.state).toBe('exited');
      const stopped = await page.evaluate(id => window.craftingTable.sessionRead(id, 0, true), id);
      expect(stopped.session.stopRequestedAt).toBeTruthy(); expect(stopped.chunks.map(chunk => chunk.data).join('')).toContain('READY:');
      if (route === 'sessions') {
        await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
        await page.locator(`[data-session-id="${id}"]`).getByRole('button', { name: 'Restore', exact: true }).click();
        await page.getByRole('button', { name: 'Close settings' }).click();
      } else await apply([{ type: 'node.restore', id: route === 'project' ? 'billing' : id }, ...(route === 'project' ? ['billing'] : ['agent', id]).map(target => ({ type: 'node.surface' as const, id: target }))]);
      expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.state).toBe('exited');
    }
    await page.reload();
    const sessions = await page.evaluate(() => window.craftingTable.sessionsList('all'));
    expect(sessions.every(session => session.state === 'exited')).toBe(true);
  } finally { runtime.close(); }
});
