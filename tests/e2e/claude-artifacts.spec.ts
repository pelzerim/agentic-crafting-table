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

/** Serves every https page of the artifact session from the test, so the guest never reaches the network. A fixture
 * identity provider sets its cookie; continuing to claude.ai's callback signs in and redirects back. */
async function serveArtifactPages(app: ElectronApplication) {
  await app.evaluate(({ session }, artifact) => {
    const served: string[] = (globalThis as any).servedPages = [];
    const html = (body: string) => new Response(`<!doctype html><title>Fixture</title>${body}`, { headers: { 'content-type': 'text/html' } });
    session.fromPartition('persist:claude-artifacts').protocol.handle('https', request => {
      const url = new globalThis.URL(request.url); served.push(url.hostname + url.pathname);
      if (url.hostname === 'idp.example.com') return html(`<script>document.cookie = 'idp=1; Secure; Path=/';</script>`);
      if (url.pathname === '/auth/callback') return html(`<script>document.cookie = 'sessionKey=fixture; Secure; Path=/'; location.replace('https://claude.ai/auth/done');</script>`);
      if (url.pathname === '/auth/done') return new Response(null, { status: 302, headers: { location: artifact } });
      return html('<p>Fixture artifact</p>');
    });
  }, URL);
  return () => app.evaluate(() => (globalThis as any).servedPages.slice() as string[]);
}
const cookies = (app: ElectronApplication, partition?: string) => app.evaluate(async ({ session }, partition) =>
  (await (partition ? session.fromPartition(partition) : session.defaultSession).cookies.get({})).map(cookie => `${cookie.domain}:${cookie.name}`).sort(), partition);
const guests = (app: ElectronApplication) => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => item.getType() === 'webview')
  .map(item => {
    const { contextIsolation, webSecurity, webviewTag, allowRunningInsecureContent, experimentalFeatures } = (item as any).getLastWebPreferences() ?? {};
    return { url: item.getURL(), contextIsolation, webSecurity, webviewTag, allowRunningInsecureContent, experimentalFeatures };
  }));
const guest = (app: ElectronApplication) => app.evaluate(({ webContents, session }) => {
  const contents = webContents.getAllWebContents().find(item => item.getType() === 'webview');
  return contents && { url: contents.getURL(), ownSession: contents.session === session.fromPartition('persist:claude-artifacts') && contents.session !== session.defaultSession };
});
const inGuest = (app: ElectronApplication, script: string) => app.evaluate(({ webContents }, script) => webContents.getAllWebContents().find(item => item.getType() === 'webview')!.executeJavaScript(script, true), script);

test('a pasted claude.ai artifact link becomes one card whose page opens inside the item, signed in inside the item', async ({ visual: { page, app } }) => {
  const opened = await recordBrowser(app);
  const served = await serveArtifactPages(app);
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
  const region = page.getByRole('region', { name: 'Claude artifact · 00000000' });
  const webview = region.locator('webview[data-site="claude"]');
  await expect(webview).toHaveAttribute('src', URL);
  await expect(webview).toHaveAttribute('partition', 'persist:claude-artifacts');
  await expect.poll(() => guest(app)).toEqual({ url: URL, ownSession: true });
  await expect.poll(() => inGuest(app, 'document.body.textContent')).toBe('Fixture artifact');
  expect(await inGuest(app, 'typeof window.craftingTable + typeof require')).toBe('undefinedundefined');
  await region.getByRole('button', { name: 'Open in browser', exact: true }).click();
  await expect.poll(opened).toEqual([URL, URL]);

  // Sign-in through an identity provider leaves claude.ai and comes back inside the item, in the artifact session only.
  const address = region.getByLabel('Page address');
  await expect(address).toBeHidden();
  await inGuest(app, "location.href = 'https://idp.example.com/authorize'");
  await expect(address).toHaveText('idp.example.com');
  await expect(address).toBeVisible();
  await inGuest(app, "location.replace('https://claude.ai/auth/callback')");
  await expect.poll(served).toEqual(expect.arrayContaining(['idp.example.com/authorize', 'claude.ai/auth/callback', 'claude.ai/auth/done']));
  await expect.poll(async () => (await guest(app))?.url).toBe(URL);
  await expect.poll(() => cookies(app, 'persist:claude-artifacts')).toEqual(['claude.ai:sessionKey', 'idp.example.com:idp']);
  expect(await cookies(app)).toEqual([]);
  expect(await opened()).toEqual([URL, URL]);
  await expect(address).toBeHidden();

  // A popup goes to the browser and the item keeps the artifact.
  await inGuest(app, "window.open('https://example.com/popup')");
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/popup']);
  expect((await guest(app))?.url).toBe(URL);
  expect(page.url()).not.toContain('claude.ai');

  // A plain http page and a download go to the browser, and the item keeps the artifact.
  await inGuest(app, "location.href = 'http://example.com/'");
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/popup', 'http://example.com/']);
  await inGuest(app, "Object.assign(document.createElement('a'), { href: 'https://claude.ai/files/notes.txt', download: 'notes.txt' }).click()");
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/popup', 'http://example.com/', 'https://claude.ai/files/notes.txt']);
  expect((await guest(app))?.url).toBe(URL);

  // Closing the view removes the page; opening it again loads it again.
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(page.locator('webview')).toHaveCount(0);
  await expect.poll(() => guest(app)).toBeUndefined();
  await card.click();
  await expect.poll(() => guest(app)).toEqual({ url: URL, ownSession: true });
});

test('a lookalike host is not offered as a Claude artifact', async ({ visual: { page, app } }) => {
  const form = page.getByRole('form', { name: 'New item' });
  await paste(page, app, `https://claude.ai.example.com/code/artifact/${ID}`, { x: 470, y: 650 });
  await expect(form.locator('.detected-item')).toHaveText('Web link');
});

test('the app attaches a web page only in a registered site, on a page it allows, with its own preferences', async ({ visual: { page, app } }) => {
  await serveArtifactPages(app);
  await page.evaluate(artifact => {
    const add = (attributes: Record<string, string>) => {
      const view = document.createElement('webview');
      for (const [name, value] of Object.entries(attributes)) view.setAttribute(name, value);
      document.body.append(view);
    };
    add({ src: artifact });
    add({ partition: 'persist:claude-artifacts', src: 'https://example.com/' });
    add({ partition: 'persist:claude-artifacts', src: artifact, webpreferences: 'contextIsolation=no, webSecurity=no, webviewTag=yes, allowRunningInsecureContent=yes, experimentalFeatures=yes' });
  }, URL);
  // Only the third attaches, and with the fixed preferences whatever it asked for.
  await expect.poll(() => inGuest(app, 'document.body.textContent').catch(() => '')).toBe('Fixture artifact');
  expect(await guests(app)).toEqual([{ url: URL, contextIsolation: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false }]);
});
