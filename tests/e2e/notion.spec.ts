import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { notionProviders, notionPageId, notionComment } from '../fixtures/notion.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

test('Notion URL-only creation shows paginated title and nested content safely, refreshes and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-notion-view-')), providers = notionProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  const launch = () => electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0); await page.getByLabel('Item URL').fill(`https://www.notion.so/billing-${notionPageId}`); await page.getByRole('button', { name: 'Attach page', exact: true }).click();
    await expect(page.getByRole('form', { name: 'New item' })).toHaveCount(0);
    await page.getByRole('article', { name: 'Billing experience', exact: true }).click();
    const detail = page.locator('.notion-detail'), frame = page.locator('.item-view:visible'); await expect(detail).toContainText('Keep the current cycle'); await expect(detail).toContainText('<script>window.notionInjected=true</script>'); expect(await page.evaluate(() => 'notionInjected' in window)).toBe(false);
    const toggle = detail.locator('details.notion-block[data-block-type=toggle]'); await expect(toggle.locator('summary')).toHaveText('Plan requirements');
    const todo = toggle.locator('.notion-children [data-block-type=to_do] input[type=checkbox]'); await expect(todo).toBeDisabled(); await expect(todo).not.toBeChecked(); await toggle.locator('summary').click(); await expect(todo).toBeVisible(); await expect(toggle.locator('.notion-children')).toHaveCSS('padding-left', '18px');
    await expect(detail).not.toContainText('[ ]');
    await expect(frame.locator('.view-freshness')).toHaveAttribute('datetime', /^\d{4}-.*Z$/); await expect(frame.locator('.view-meta')).toHaveText(/^Page · edited /);
    await expect(frame.getByRole('link', { name: 'Open in Notion', exact: true })).toHaveAttribute('href', `https://www.notion.so/${notionPageId}`);
    await expect(frame).toHaveScreenshot('notion-page-detail.png', { mask: [frame.locator('.view-freshness'), frame.locator('.view-meta')] });
    const paragraphs = ['Changes should be understandable before a customer confirms a new plan. Preserve the current billing cycle and show the date when each change takes effect. '.repeat(3), 'The preview needs to explain credits, the next invoice, and any delayed changes. Include the same information in the confirmation message. '.repeat(3)];
    const rich = (plain_text: string) => ({ type: 'text', plain_text, text: { content: plain_text } });
    providers.responses[`/v1/blocks/${notionPageId}/children?page_size=100`].results.push(...paragraphs.map((text, index) => ({ object: 'block', id: String(index + 7).repeat(32), type: 'paragraph', has_children: false, paragraph: { rich_text: [rich(text)] } })), { object: 'block', id: '9'.repeat(32), type: 'code', has_children: false, code: { rich_text: [rich('const changedPlans = [' + Array.from({ length: 18 }, (_, i) => `"plan-${i}"`).join(', ') + '];')] } });
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(detail.locator('[data-block-type=code]')).toBeVisible();
    const widths = await detail.evaluate(element => { const prose = element.querySelector('[data-block-type=paragraph]')!, code = element.querySelector('[data-block-type=code] pre')!; return { prose: prose.clientWidth, code: code.clientWidth, content: code.scrollWidth }; });
    expect(widths.code).toBeGreaterThan(widths.prose); expect(widths.content).toBeGreaterThan(widths.code);
    await expect(frame).toHaveScreenshot('notion-long-document.png', { mask: [frame.locator('.view-freshness'), frame.locator('.view-meta')] });
    await resize(app, page, 900, 640);
    await expect(page.locator('.resource-detail:visible')).toHaveScreenshot('notion-long-document-narrow.png');
    await resize(app, page, 1280, 800);
    providers.responses[`/v1/pages/${notionPageId}/properties/title?page_size=100`].results[0].title.plain_text = 'Updated billing ';
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(detail.locator('.provider-read-title')).toHaveText('Updated billing experience');
    const before = await service.control.read();
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); app = await launch(); page = await app.firstWindow();
    // Restored native bounds may be clamped to the host display work area. Use
    // the same content viewport for document captures before and after restart.
    await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('article', { name: 'Updated billing experience', exact: true }).click(); await expect(page.locator('.notion-detail')).toContainText('Keep the current cycle'); expect((await service.control.read()).resources).toEqual(before.resources);
    providers.before(() => { throw new Error('Notion page access removed'); });
    await page.locator('.item-view:visible').getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.locator('.notion-detail')).toContainText('Notion page access removed'); await expect(page.locator('.item-view:visible .view-freshness')).toHaveText(/^Saved copy · \d\d:\d\d$/); await expect(page.locator('.notion-detail .view-stale-banner')).toHaveText(/^Couldn’t refresh from Notion\. .*Notion page access removed.*You’re reading the copy saved at \d\d:\d\d\.$/); await expect(page.locator('.notion-detail')).toContainText('Keep the current cycle');
    await expect(page.locator('.item-view:visible')).toHaveScreenshot('notion-saved-copy.png', { mask: [page.locator('.item-view:visible .view-freshness'), page.locator('.item-view:visible .view-meta'), page.locator('.view-stale-banner')] });
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('new Notion comments show an unread badge until the page link is opened; Needs me stays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-notion-comments-')), providers = notionProviders();
  providers.comments[notionPageId] = [notionComment('a', '2026-09-26T11:00:00.000Z')];
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  const client = await connectWorkspace(directory);
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
    const opened = () => app.evaluate(() => (globalThis as any).openedUrls as string[]);
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await page.getByLabel('Item URL').fill(`https://app.notion.com/p/acme/Billing-experience-${notionPageId}`); await page.getByRole('button', { name: 'Attach page', exact: true }).click();
    const card = page.getByRole('article', { name: 'Billing experience', exact: true }), badge = card.locator('[data-indicator="comments"]');
    await expect(card).toBeVisible(); await expect(badge).toHaveCount(0);
    const nodeId = (await service.control.read()).nodes.find(node => node.resourceId)!.id;
    providers.comments[notionPageId].push(notionComment('b', new Date().toISOString()), notionComment('c', new Date().toISOString()));
    await client.call('runtime.run', { nodeId, action: 'resource.read', arguments: { refresh: true } });
    await expect(badge).toHaveAttribute('aria-label', '2 unread comments');
    await expect(card).toHaveScreenshot('notion-unread-comments-card.png');
    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toContainText(/Billing experience.*2 new comments/);
    await page.keyboard.press('Escape');
    await card.click();
    const frame = page.locator('.item-view:visible');
    await expect(frame.locator('.view-chip')).toHaveText('2 unread comments');
    await frame.getByRole('link', { name: 'Open in Notion', exact: true }).click();
    await expect.poll(opened).toEqual([`https://www.notion.so/${notionPageId}`]);
    await expect(frame.locator('.view-chip')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(badge).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    expect((await service.control.read()).nodes.find(node => node.id === nodeId)?.attentionSources?.['notion.comments']).toBe('comment');
    await card.click(); await page.getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    providers.comments[notionPageId].push(notionComment('d', new Date(Date.now() + 60_000).toISOString()));
    await client.call('runtime.run', { nodeId, action: 'resource.read', arguments: { refresh: true } });
    await expect(badge).toHaveAttribute('aria-label', '1 unread comment');
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Open on Notion', exact: true }).click();
    await expect(badge).toHaveCount(0);
  } finally { client.close(); await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

const launchArgs = ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs];
/** A workspace as it was saved before app.notion.com links were recognised: the page is a web link titled “Notion”, connected to a note. */
async function bookmarkWorkspace(directory: string, providers: ReturnType<typeof notionProviders>) {
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'billing', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'link', resourceId: 'link-r', pluginId: 'web.link', title: 'Notion', data: { url: `https://app.notion.com/p/acme/Billing-experience-${notionPageId}` }, projectId: 'billing', position: { x: 40, y: 140 } },
    { type: 'item.add', id: 'todo', resourceId: 'todo-r', pluginId: 'workspace.todo', title: 'Review the spec', data: {}, projectId: 'billing', position: { x: 340, y: 140 } },
    { type: 'link.save', link: { id: 'spec', sourceId: 'todo', targetId: 'link', kind: 'reference', label: '' } },
  ] });
  await service.close();
}

test('a web link to a Notion page becomes a Notion page item on the next start: page title, kept connection, comment cue and Needs me', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-notion-upgrade-')), providers = notionProviders();
  providers.comments[notionPageId] = [notionComment('a', '2026-09-26T11:00:00.000Z')];
  await bookmarkWorkspace(directory, providers);
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const app = await electron.launch({ args: launchArgs, env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  const client = await connectWorkspace(directory);
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    const card = page.getByRole('article', { name: 'Billing experience', exact: true }), badge = card.locator('.item-indicators [data-indicator="comments"]');
    await expect(card).toBeVisible();
    await expect(page.getByRole('article', { name: 'Notion', exact: true })).toHaveCount(0);
    const state = await service.control.read(), node = state.nodes.find(candidate => candidate.id === 'link')!;
    expect(state.resources.find(resource => resource.id === 'link-r')).toMatchObject({ pluginId: 'notion.page', connectionId: 'notion-fixture', data: { pageId: notionPageId }, title: 'Billing experience' });
    expect(node).toMatchObject({ resourceId: 'link-r', projectId: 'billing', title: 'Billing experience' });
    expect(state.links).toEqual([{ id: 'spec', sourceId: 'todo', targetId: 'link', kind: 'reference', label: '' }]);
    await expect(page.locator('.react-flow__edge[data-id="spec"]')).toHaveCount(1);
    await expect(badge).toHaveCount(0); expect(node.attentionSources).toBeUndefined();
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toHaveCount(0);
    providers.comments[notionPageId].push(notionComment('b', new Date().toISOString()));
    await client.call('runtime.run', { nodeId: 'link', action: 'resource.read', arguments: { refresh: true } });
    await expect(badge).toHaveAttribute('aria-label', '1 unread comment'); await expect(badge).toHaveAttribute('data-tone', 'blue');
    await expect(badge.locator('svg')).toHaveCount(1); await expect(badge).toHaveText('1');    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toContainText(/Billing experience.*New comment/);
    await page.keyboard.press('Escape');
    await card.click({ button: 'right' });
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Open', 'Connect to…', 'Open on Notion', 'Copy URL', 'Settings', 'Move to project', 'Mark done', 'Send to Undermap']);
  } finally { client.close(); await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Convert to Notion page in the item menu upgrades a web link the start could not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-notion-convert-')), providers = notionProviders();
  await bookmarkWorkspace(directory, providers);
  providers.before(() => { throw new Error('Notion page access removed'); });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const app = await electron.launch({ args: launchArgs, env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    const link = page.getByRole('article', { name: 'Notion', exact: true });
    await expect(link).toBeVisible();
    await expect.poll(() => providers.calls.length).toBeGreaterThan(0);
    expect((await service.control.read()).resources.find(resource => resource.id === 'link-r')?.pluginId).toBe('web.link');
    providers.before(undefined);
    await link.click({ button: 'right' });
    const convert = page.getByRole('menuitem', { name: 'Convert to Notion page', exact: true });
    await expect(convert).toBeVisible();
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Open', 'Connect to…', 'Open in browser', 'Copy URL', 'Convert to Notion page', 'Settings', 'Move to project', 'Mark done', 'Send to Undermap']);
    await convert.click();
    await expect(page.getByRole('article', { name: 'Billing experience', exact: true })).toBeVisible();
    const state = await service.control.read();
    expect(state.resources.find(resource => resource.id === 'link-r')).toMatchObject({ pluginId: 'notion.page', title: 'Billing experience' });
    expect(state.links.map(connection => connection.id)).toEqual(['spec']);
    await page.getByRole('article', { name: 'Billing experience', exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Open on Notion', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Convert to/ })).toHaveCount(0);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
