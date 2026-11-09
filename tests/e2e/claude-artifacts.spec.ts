import { readFileSync } from 'node:fs';
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
      // Google's sign-in popup: it sets its cookie, tries a popup of its own and answers its opener.
      if (url.hostname === 'accounts.google.com') return html(`<script>document.cookie = 'google=1; Secure; Path=/';
        window.open('https://example.com/from-sign-in');
        window.opener.postMessage('signed in:' + typeof window.craftingTable + typeof require, '*');</script>`);
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
  const clipboardWrite = () => inGuest(app, "navigator.permissions.query({ name: 'clipboard-write' }).then(status => status.state)");
  expect(await clipboardWrite()).toBe('granted');
  await region.getByRole('button', { name: 'Open in browser', exact: true }).click();
  await expect.poll(opened).toEqual([URL, URL]);

  // Sign-in through an identity provider leaves claude.ai and comes back inside the item, in the artifact session only.
  const address = region.getByLabel('Page address');
  await expect(address).toBeHidden();
  await inGuest(app, "location.href = 'https://idp.example.com/authorize'");
  await expect(address).toHaveText('idp.example.com');
  await expect(address).toBeVisible();
  expect(await clipboardWrite()).toBe('denied');
  await inGuest(app, "location.replace('https://claude.ai/auth/callback')");
  await expect.poll(served).toEqual(expect.arrayContaining(['idp.example.com/authorize', 'claude.ai/auth/callback', 'claude.ai/auth/done']));
  await expect.poll(async () => (await guest(app))?.url).toBe(URL);
  await expect.poll(() => cookies(app, 'persist:claude-artifacts')).toEqual(['claude.ai:sessionKey', 'idp.example.com:idp']);
  expect(await cookies(app)).toEqual([]);
  expect(await opened()).toEqual([URL, URL]);
  await expect(address).toBeHidden();

  // Google sign-in opens in an app window in the artifact session, answers the item's page and closes; a popup it opens
  // goes to the browser. Any other popup goes to the browser, and the item keeps the artifact.
  const userAgent = await inGuest(app, 'navigator.userAgent');
  expect(userAgent).not.toContain('Electron/'); expect(userAgent).toMatch(/\(KHTML, like Gecko\) Chrome\/\S+ Safari\//);
  await inGuest(app, "addEventListener('message', event => { document.title = event.data; }); window.signInWindow = window.open('https://accounts.google.com/o/oauth2/v2/auth'); undefined");
  await expect.poll(() => inGuest(app, 'document.title')).toBe('signed in:undefinedundefined');
  // The window's title is its page's host, not the page's own title.
  await expect.poll(() => app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows()
    .filter(window => window.webContents.session === session.fromPartition('persist:claude-artifacts')).map(window => window.getTitle()))).toEqual(['accounts.google.com']);
  await inGuest(app, 'window.signInWindow.close()');
  await expect.poll(() => cookies(app, 'persist:claude-artifacts')).toEqual(['accounts.google.com:google', 'claude.ai:sessionKey', 'idp.example.com:idp']);
  expect(await cookies(app)).toEqual([]);
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/from-sign-in']);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await inGuest(app, "window.open('https://example.com/popup')");
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/from-sign-in', 'https://example.com/popup']);
  expect((await guest(app))?.url).toBe(URL);
  expect(page.url()).not.toContain('claude.ai');

  // A plain http page and a download go to the browser, and the item keeps the artifact.
  await inGuest(app, "location.href = 'http://example.com/'");
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/from-sign-in', 'https://example.com/popup', 'http://example.com/']);
  await inGuest(app, "Object.assign(document.createElement('a'), { href: 'https://claude.ai/files/notes.txt', download: 'notes.txt' }).click()");
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/from-sign-in', 'https://example.com/popup', 'http://example.com/', 'https://claude.ai/files/notes.txt']);
  expect((await guest(app))?.url).toBe(URL);
  // A file the page makes itself is saved in the app; the test picks the path so no save dialog shows.
  const saved = test.info().outputPath('export.txt');
  await app.evaluate(({ session }, saved) => {
    const outcomes: string[] = (globalThis as any).downloadOutcomes = [];
    session.fromPartition('persist:claude-artifacts').on('will-download', (_event, item) => {
      item.setSavePath(saved); item.once('done', (_done, state) => outcomes.push(`${item.getURL().split(':')[0]}:${state}`));
    });
  }, saved);
  await inGuest(app, "Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['exported'])), download: 'export.txt' }).click()");
  await expect.poll(() => app.evaluate(() => (globalThis as any).downloadOutcomes.slice())).toEqual(['blob:completed']);
  expect(readFileSync(saved, 'utf8')).toBe('exported');
  // A page the embedder loads is held to the same rule as one the page navigates to.
  await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find(item => item.getType() === 'webview')!.loadURL('http://example.com/embedder').catch(() => {}); });
  await expect.poll(opened).toEqual([URL, URL, 'https://example.com/from-sign-in', 'https://example.com/popup', 'http://example.com/', 'https://claude.ai/files/notes.txt', 'http://example.com/embedder']);
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
