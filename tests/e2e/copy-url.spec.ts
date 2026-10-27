import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const PR_URL = 'https://github.com/example/billing/pull/48', BOOKMARK_URL = 'https://example.com/spec?a=1#intro';
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Context actions', exact: true });
const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());

/** The pasteboard is the person's own: put their text back unless something else replaced ours meanwhile. */
async function withClipboard(app: ElectronApplication, ours: string[], run: () => Promise<void>) {
  const before = await clipboardText(app);
  await app.evaluate(({ clipboard }) => clipboard.writeText('copy-url fixture'));
  try { await run(); }
  finally { await app.evaluate(async ({ clipboard }, { before, ours }) => { if (ours.includes(await clipboard.readText())) await clipboard.writeText(before); }, { before, ours: [...ours, 'copy-url fixture'] }); }
}

async function seed(page: Page) {
  await page.evaluate(async url => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'bookmark', resourceId: 'bookmark-resource', pluginId: 'web.bookmark', title: 'Billing spec', data: { url }, projectId: 'billing', position: { x: 300, y: 520 } },
      { type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'workspace.note', title: 'Scratch note', data: { text: 'Remember the spec' }, projectId: 'billing', position: { x: 300, y: 640 } },
    ] as never });
  }, BOOKMARK_URL);
  await expect(card(page, 'Billing spec')).toBeVisible();
}

test('Copy URL sits right after "Open on …", copies the item URL and neither opens nor acknowledges anything', async ({ visual: { app, page } }) => {
  await seed(page);
  await app.evaluate(({ shell }) => { const opened = (globalThis as any).openedUrls = [] as string[]; shell.openExternal = async url => { opened.push(url); }; });
  await withClipboard(app, [PR_URL, BOOKMARK_URL], async () => {
    const before = await read(page);
    await card(page, 'Plan switcher').click({ button: 'right' });
    const labels = await menu(page).getByRole('menuitem').allTextContents();
    expect(labels.slice(labels.indexOf('Open on GitHub'), labels.indexOf('Open on GitHub') + 3)).toEqual(['Open on GitHub', 'Copy URL', 'Settings']);
    const entry = menu(page).getByRole('menuitem', { name: 'Copy URL', exact: true });
    await expect(entry).not.toHaveAttribute('data-remote'); await expect(entry.locator('.item-icon')).toHaveCount(1);
    await entry.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => clipboardText(app)).toBe(PR_URL);
    await expect(page.getByRole('status').filter({ hasText: 'URL copied' })).toBeVisible();
    await card(page, 'Billing spec').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Connect to…', 'Open in browser', 'Copy URL', 'Settings', 'Move to project', 'Move to plot', 'Mark done', 'Send to Undermap']);
    await menu(page).getByRole('menuitem', { name: 'Copy URL', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect.poll(() => clipboardText(app)).toBe(BOOKMARK_URL);
    await expect(page.getByRole('menu')).toHaveCount(0);
    const after = await read(page);
    expect(after).toEqual(before);
    expect(after.nodes.find(node => node.id === 'pr')?.attention).toBe('review');
    await expect(page.locator('[data-expanded-item-id]')).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).openedUrls)).toEqual([]);
  });
});

test('items without a web page have no Copy URL; a selection copies every URL, one per line', async ({ visual: { app, page } }) => {
  await seed(page);
  const note = page.locator('[data-item-id="note"]');
  await note.click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: /Copy URL/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await card(page, 'Claude · implementation').click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: /Copy URL/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await withClipboard(app, [`${PR_URL}\n${BOOKMARK_URL}`], async () => {
    await card(page, 'Plan switcher').click({ modifiers: ['Shift'] }); await card(page, 'Billing spec').click({ modifiers: ['Shift'] });
    await card(page, 'Billing spec').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Copy URLs', 'Move to project', 'Move to plot', 'Mark done', 'Send selection to Undermap']);
    await menu(page).getByRole('menuitem', { name: 'Copy URLs', exact: true }).click();
    await expect.poll(() => clipboardText(app)).toBe(`${PR_URL}\n${BOOKMARK_URL}`);
    await expect(page.getByRole('status').filter({ hasText: '2 URLs copied' })).toBeVisible();
    await page.keyboard.press('Escape');
    await note.click({ modifiers: ['Shift'] });
    await note.click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Move to project', exact: true })).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: /Copy URL/ })).toHaveCount(0);
  });
});

test('the clipboard bridge accepts only http(s) URLs, alone or as a short list', async ({ visual: { app, page } }) => {
  await withClipboard(app, ['https://example.com/a%20b\nhttp://localhost:3000/'], async () => {
    for (const input of ['javascript:alert(1)', 'file:///etc/passwd', ['https://example.com/', 'javascript:alert(1)'], [], Array(201).fill('https://example.com/')])
      expect(await page.evaluate(async input => { try { await window.craftingTable.copyUrl(input as never); return 'copied'; } catch { return 'refused'; } }, input), JSON.stringify(input).slice(0, 60)).toBe('refused');
    expect(await clipboardText(app)).toBe('copy-url fixture');
    await page.evaluate(() => window.craftingTable.copyUrl(['https://example.com/a b', 'http://localhost:3000']));
    expect(await clipboardText(app)).toBe('https://example.com/a%20b\nhttp://localhost:3000/');
  });
});

test('the app\'s own pages may write text to the clipboard, but never read it', async ({ visual: { app, page } }) => {
  const report = '## Notes\n- shipped the "inbox"';
  await withClipboard(app, [report], async () => {
    await page.bringToFront(); await page.locator('body').click({ position: { x: 5, y: 5 } });
    expect(await page.evaluate(async text => { try { await navigator.clipboard.writeText(text); return 'copied'; } catch (error) { return (error as Error).message; } }, report)).toBe('copied');
    expect(await clipboardText(app)).toBe(report);
    expect(await page.evaluate(async () => { try { await navigator.clipboard.readText(); return 'read'; } catch { return 'refused'; } })).toBe('refused');
  });
});
