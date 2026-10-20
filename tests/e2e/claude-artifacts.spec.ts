import { test } from './visual-fixture.ts';
import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000042', URL = `https://claude.ai/code/artifact/${ID}`;
const read = async (page: Page) => (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
async function recordBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
  return () => app.evaluate(() => (globalThis as any).openedUrls.slice() as string[]);
}
async function paste(page: Page, app: ElectronApplication, text: string, point: { x: number; y: number }) {
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
  await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y);
  await page.keyboard.press('Meta+v');
}

test('a pasted claude.ai artifact link becomes one card that opens in the browser, never in the app', async ({ visual: { page, app } }) => {
  const opened = await recordBrowser(app);
  const form = page.getByRole('form', { name: 'New item' });
  await paste(page, app, URL, { x: 470, y: 650 });
  await expect(form.getByLabel('Item URL')).toHaveValue(URL);
  await expect(form.locator('.detected-item')).toHaveText('Claude artifact');
  await form.getByRole('button', { name: 'Add Claude artifact', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect.poll(async () => (await read(page)).resources.filter(resource => resource.pluginId === 'claude.artifact').length).toBe(1);
  const state = await read(page), resource = state.resources.find(resource => resource.pluginId === 'claude.artifact')!;
  expect(resource.data).toEqual({ url: URL, artifactId: ID }); expect(resource.schemaVersion).toBe(2);
  const card = page.getByRole('article', { name: 'Claude artifact · 00000000' });
  await expect(card).toBeVisible();

  // The same artifact, spelled differently, joins the existing item.
  await paste(page, app, `${URL}?utm_source=share#top`, { x: 200, y: 720 });
  await expect(form.locator('.detected-item')).toHaveText('Claude artifact');
  await form.getByRole('button', { name: 'Add Claude artifact', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect.poll(async () => (await read(page)).nodes.filter(item => item.resourceId === resource.id).length).toBe(1);
  expect((await read(page)).resources.filter(resource => resource.pluginId === 'claude.artifact')).toHaveLength(1);

  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open on claude.ai', exact: true }).click();
  await expect.poll(opened).toEqual([URL]);
  await card.click();
  const panel = page.getByRole('region', { name: 'Claude artifact · 00000000' }).locator('.claude-artifact-view');
  await expect(panel.getByRole('heading', { name: 'Claude artifact · 00000000' })).toBeVisible();
  await expect(panel.getByRole('link', { name: URL })).toHaveAttribute('href', URL);
  await page.screenshot({ path: 'test-results/claude-artifact-panel.png' });
  await panel.getByRole('button', { name: 'Open in browser', exact: true }).click();
  await expect.poll(opened).toEqual([URL, URL]);
  await panel.getByRole('link', { name: URL }).click();
  await expect.poll(opened).toEqual([URL, URL, URL]);
  expect(page.url()).not.toContain('claude.ai');
  expect(page.frames().some(frame => frame.url().includes('claude.ai'))).toBe(false);
});

test('a lookalike host is not offered as a Claude artifact', async ({ visual: { page, app } }) => {
  const form = page.getByRole('form', { name: 'New item' });
  await paste(page, app, `https://claude.ai.example.com/code/artifact/${ID}`, { x: 470, y: 650 });
  await expect(form.locator('.detected-item')).toHaveText('Web link');
});
