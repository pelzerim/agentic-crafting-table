import { test } from './visual-fixture.ts';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const apply = (page: Page, commands: unknown[]) => page.evaluate(async commands => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
}, commands);

test('notes on a video start hidden, keep what was typed across closing the item, and Add time stamps the player time', async ({ visual: { page, app } }) => {
  await app.evaluate(({ session }) => {
    session.fromPartition('youtube-embeds').protocol.handle('https', () => new Response('<!doctype html><title>Fixture</title><video></video>', { headers: { 'content-type': 'text/html' } }));
  });
  await apply(page, [{ type: 'item.add', id: 'clip', resourceId: 'clip-r', pluginId: 'workspace.video', title: 'clip', data: { source: 'https://www.youtube.com/watch?v=ccccccccccc' }, projectId: 'billing', position: { x: 650, y: 620 } }]);
  const open = async () => { await page.locator('.map-card[data-item-id="clip"]').click(); await expect(page.getByRole('region', { name: 'clip' })).toBeVisible(); };
  const back = () => page.getByRole('button', { name: 'Back to project', exact: true }).click();
  const notes = page.getByRole('textbox', { name: 'Notes', exact: true }), toggle = page.getByRole('button', { name: 'Notes', exact: true });
  const saved = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.resources.find(resource => resource.id === 'clip-r')?.data.notes);

  await open();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(notes).toBeHidden();
  await toggle.click();
  await notes.fill('The intro drags');
  await expect.poll(saved).toBe('The intro drags');
  await back(); await open();
  await expect(notes).toBeVisible();
  await expect(notes).toHaveValue('The intro drags');
  await notes.press('End'); await notes.press('Enter');
  await expect(page.locator('webview[data-site="youtube"]')).toHaveCount(1);
  await expect(async () => {
    await page.getByRole('button', { name: 'Add time', exact: true }).click();
    await expect(notes).toHaveValue('The intro drags\n[00:00] ');
  }).toPass();
  await expect(page.getByRole('button', { name: '[00:00]' })).toBeVisible();
  await expect.poll(saved).toBe('The intro drags\n[00:00] ');

  // A send whose answer never came reuses its request after the item reopens, so the agent never gets the notes twice.
  await apply(page, [
    { type: 'item.create', id: 'listener', projectId: 'billing', position: { x: 900, y: 620 }, resource: { id: 'listener-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Listener', data: { sessionId: 'no-such-session', provider: 'claude' } } },
    { type: 'node.update', id: 'listener', activity: 'idle' },
    { type: 'link.save', link: { id: 'clip-listener', sourceId: 'clip', targetId: 'listener', kind: 'context' } },
  ]);
  const send = page.getByRole('button', { name: 'Send to agent ▸', exact: true });
  const pending = () => page.evaluate(async () => ((await window.craftingTable.workspaceRead()).state.resources.find(resource => resource.id === 'clip-r')?.data.notesPending as { requestId?: string } | undefined)?.requestId);
  await send.click();
  await expect.poll(pending).toMatch(/^[0-9a-f-]{36}$/);
  const first = await pending();
  await expect(send).toBeEnabled();
  await back(); await open();
  await send.click();
  await expect(page.locator('.video-notes .pr-comment-feedback')).not.toHaveText(/Sending/);
  expect(await pending()).toBe(first);
});
