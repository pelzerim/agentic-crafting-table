import { test } from './visual-fixture.ts';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const apply = (page: Page, commands: unknown[]) => page.evaluate(async commands => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
}, commands);

test('a video plays on after its item closes only when asked, and only one video at a time', async ({ visual: { page, app } }) => {
  await app.evaluate(({ session }) => {
    session.fromPartition('youtube-embeds').protocol.handle('https', () => new Response('<!doctype html><title>Fixture</title><p>Fixture video</p>', { headers: { 'content-type': 'text/html' } }));
  });
  const video = (id: string, x: number) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.video', title: id, data: { source: `https://www.youtube.com/watch?v=${id}` }, projectId: 'billing', position: { x, y: 620 } });
  await apply(page, [video('aaaaaaaaaaa', 650), video('bbbbbbbbbbb', 900)]);
  const pages = page.locator('webview[data-site="youtube"]'), shown = () => pages.evaluateAll(views => views.map(view => view.getAttribute('src')!.match(/embed\/(\w+)/)![1]));
  const open = async (id: string) => { await page.locator(`.map-card[data-item-id="${id}"]`).click(); await expect(page.getByRole('region', { name: id })).toBeVisible(); };
  const back = () => page.getByRole('button', { name: 'Back to project', exact: true }).click();

  await open('aaaaaaaaaaa'); await back();
  await expect(pages).toHaveCount(0);
  await open('aaaaaaaaaaa');
  await page.getByRole('button', { name: 'Play in background', exact: true }).click();
  await back();
  await expect.poll(shown).toEqual(['aaaaaaaaaaa']);
  await open('bbbbbbbbbbb'); await back();
  await expect.poll(shown).toEqual(['aaaaaaaaaaa']);
  // A second background video stops the first, so at most one hidden player holds memory.
  await open('bbbbbbbbbbb');
  await page.getByRole('button', { name: 'Play in background', exact: true }).click();
  await back();
  await expect.poll(shown).toEqual(['bbbbbbbbbbb']);
});
