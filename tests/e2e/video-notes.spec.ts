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

  // Quitting right after typing waits for the save the debounce would have made later.
  await notes.press('End'); await notes.pressSequentially('!');
  const agreed = await app.evaluate(({ ipcMain, BrowserWindow }) => new Promise<unknown>(resolve => {
    const listener = (_event: unknown, message: { id?: number; answer?: unknown }) => { if (message?.id === 4242 && typeof message.answer === 'boolean') { ipcMain.off('app:before-quit-answer', listener); resolve(message.answer); } };
    ipcMain.on('app:before-quit-answer', listener);
    BrowserWindow.getAllWindows()[0].webContents.send('app:before-quit', { id: 4242 });
  }));
  expect(agreed).toBe(true);
  expect(await saved()).toBe('The intro drags\n[00:00] !');

  // The service accepts the panel's fingerprint of the draft; this agent has no live session, so nothing is pending.
  await apply(page, [
    { type: 'item.create', id: 'listener', projectId: 'billing', position: { x: 900, y: 620 }, resource: { id: 'listener-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Listener', data: { sessionId: 'no-such-session', provider: 'claude' } } },
    { type: 'node.update', id: 'listener', activity: 'idle' },
    { type: 'link.save', link: { id: 'clip-listener', sourceId: 'clip', targetId: 'listener', kind: 'context' } },
  ]);
  const feedback = page.locator('.video-notes .pr-comment-feedback');
  await page.getByRole('button', { name: 'Send to agent ▸', exact: true }).click();
  await expect(feedback).not.toHaveText(/^(Sending…)?$/);
  await expect(feedback).not.toHaveText(/notes changed/);
  expect(await page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.resources.find(resource => resource.id === 'clip-r')?.data.notesPending)).toBeUndefined();
});

test('an open notes panel follows notes saved elsewhere, and a draft typed meanwhile saves over them', async ({ visual: { page } }) => {
  const source = 'https://www.youtube.com/watch?v=ddddddddddd', notesTo = (notes: string) => ({ type: 'item.update', id: 'clip', data: { source, notes } });
  await apply(page, [{ type: 'item.add', id: 'clip', resourceId: 'clip-r', pluginId: 'workspace.video', title: 'clip', data: { source, notes: 'First' }, projectId: 'billing', position: { x: 650, y: 620 } }]);
  await page.locator('.map-card[data-item-id="clip"]').click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
  const saved = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.resources.find(resource => resource.id === 'clip-r')?.data.notes);
  await expect(notes).toHaveValue('First');
  await apply(page, [notesTo('From another window')]);
  await expect(notes).toHaveValue('From another window');

  // Notes saved elsewhere while the person types: the latest edit wins, with no conflict to resolve.
  await page.evaluate(async command => {
    const area = document.querySelector<HTMLTextAreaElement>('.video-notes-text')!;
    area.value += ' and mine'; area.dispatchEvent(new Event('input'));
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [command as never] });
  }, notesTo('Newer elsewhere'));
  await expect.poll(saved).toBe('From another window and mine');
  await expect(notes).toHaveValue('From another window and mine');
  await expect(page.locator('.video-notes .pr-comment-feedback')).not.toHaveText(/elsewhere|could not be saved/);
  await expect(page.getByRole('button', { name: 'Keep my draft' })).toHaveCount(0);
});
