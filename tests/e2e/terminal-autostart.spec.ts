import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('opening a terminal whose shell ended starts a fresh shell without replaying the old output', async ({ visual: { page } }) => {
  const nodeId = await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead(), nodeId = crypto.randomUUID();
    await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId, resourceId: crypto.randomUUID(), expectedRevision: state.revision,
      pluginId: 'terminal.session', title: 'Scratch shell', projectId: 'billing', position: { x: 700, y: 700 }, data: { cwd: '/tmp' } });
    return nodeId;
  });
  const item = page.getByRole('article', { name: 'Scratch shell', exact: true }), terminal = page.locator('.native-terminal'), surface = page.locator('.terminal-surface');
  await item.click();
  await expect(terminal).toHaveAttribute('data-session-state', 'running');
  const first = (await surface.getAttribute('data-terminal-id'))!;
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo OLD_$((20+22))\n');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('OLD_42');
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  await expect(terminal).toHaveAttribute('data-session-state', 'exited');
  // Stopping inside the open view keeps it stopped; only opening it again starts a shell.
  await page.waitForTimeout(800); await expect(terminal).toHaveAttribute('data-session-state', 'exited');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await item.click();
  await expect(terminal).toHaveAttribute('data-session-state', 'running');
  await expect.poll(async () => surface.getAttribute('data-terminal-id')).not.toBe(first);
  await expect(page.locator('.xterm-accessibility-tree')).not.toContainText('OLD_42');
  const node = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  expect(node.resources.find(resource => resource.id === node.nodes.find(candidate => candidate.id === nodeId)!.resourceId)!.data.sessionId).not.toBe(first);
});
