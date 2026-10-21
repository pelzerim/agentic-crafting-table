import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { linearProviders } from '../fixtures/linear.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { linearMarkdown, wideLinearMarkdown } from '../fixtures/linear-markdown.ts';

test('Linear URL-only creation shows a compact titled ticket, safe description, rename refresh and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-view-')), providers = linearProviders();
  providers.data.issue.description = linearMarkdown;
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  const launch = () => electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0); await page.getByLabel('Item URL').fill('https://linear.app/fixture/issue/BIL-128/old-title'); await page.getByRole('button', { name: 'Attach ticket', exact: true }).click();
    await expect(page.getByRole('form', { name: 'New item' })).toHaveCount(0);
    const card = page.getByRole('article', { name: 'BIL-128 · Make plan changes predictable', exact: true });
    await expect(card).toBeVisible();
    const textFit = await card.locator('.card-label strong').evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(textFit.height).toBe(30); expect(textFit.scrollHeight).toBeLessThanOrEqual(textFit.height); expect(textFit.scrollWidth).toBeLessThanOrEqual(textFit.width);
    await expect(card).toHaveScreenshot('linear-ticket-card.png'); await card.click();
    const detail = page.locator('.linear-detail'), frame = page.locator('.item-view:visible'); await expect(detail).toContainText('Keep the current billing cycle'); await expect(detail).toContainText('<script>window.linearInjected=true</script>'); expect(await page.evaluate(() => 'linearInjected' in window)).toBe(false);
    const markdown = detail.locator('.markdown-content');
    await expect(markdown.getByRole('heading', { name: 'Billing behavior' })).toBeVisible();
    await expect(markdown.locator('strong')).toHaveText('effective dates'); await expect(markdown.locator('em')).toHaveText('credits'); await expect(markdown.locator('del')).toHaveText('old estimates');
    await expect(markdown.locator('ol > li')).toHaveCount(2); await expect(markdown.locator('ol ul > li')).toHaveCount(2);
    await expect(markdown.getByRole('checkbox')).toHaveCount(2);
    await expect(markdown.getByRole('checkbox').first()).toBeChecked(); await expect(markdown.getByRole('checkbox').last()).not.toBeChecked();
    for (const checkbox of await markdown.getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
    await expect(markdown.locator('blockquote')).toContainText('Explain the date before saving.');
    await expect(markdown.getByRole('columnheader')).toHaveText(['Change', 'Effective date']);
    await expect(markdown.locator('pre code')).toContainText('preserveCredits: true');
    await expect(markdown.locator('script,img,iframe,svg,style,[onerror],[onclick]')).toHaveCount(0);
    await expect(markdown.getByRole('link', { name: 'Unsafe link', exact: true })).toHaveCount(0);
    await expect(markdown.getByRole('link', { name: 'Local file', exact: true })).toHaveCount(0);
    await expect(markdown.getByRole('link', { name: 'Credential URL', exact: true })).toHaveCount(0);
    await expect(markdown.getByRole('link', { name: 'Image: Billing screenshot' })).toHaveAttribute('href', 'https://images.example.test/billing.png');
    await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
    const mapUrl = page.url(); await markdown.getByRole('link', { name: 'Implementation guide', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrls)).toEqual(['https://example.test/billing?view=changes#preview']); expect(page.url()).toBe(mapUrl);
    await expect(frame.locator('.view-freshness')).toHaveAttribute('datetime', /^\d{4}-.*Z$/); await expect(frame.locator('.view-freshness')).toHaveText('Read just now');
    await expect(frame.locator('.view-meta')).toHaveText(/^BIL-128 · updated /); await expect(frame.getByRole('link', { name: 'Open in Linear', exact: true })).toHaveAttribute('href', /^https:\/\/linear\.app\/fixture\/issue\//);
    await expect(detail.locator('.provider-read-title')).toHaveText('BIL-128 · Make plan changes predictable'); await expect(detail.locator('.provider-read-title')).toBeHidden();
    const scrollView = page.locator('.resource-detail:visible');
    await scrollView.evaluate(element => { element.scrollTop = 0; }); await page.mouse.move(4, 4);
    await expect(frame).toHaveScreenshot('linear-ticket-detail.png', { mask: [frame.locator('.view-freshness'), frame.locator('.view-meta')] });
    await scrollView.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(scrollView).toHaveScreenshot('linear-markdown-content.png');
    providers.data.issue.description = wideLinearMarkdown;
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(markdown.locator('h1')).toHaveText('Wide content');
    await resize(app, page, 900, 640);
    const widths = await markdown.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, code: element.querySelector('pre')!.clientWidth, codeScroll: element.querySelector('pre')!.scrollWidth, table: element.querySelector('table')!.clientWidth, tableScroll: element.querySelector('table')!.scrollWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.width + 1); expect(widths.codeScroll).toBeGreaterThan(widths.code); expect(widths.tableScroll).toBeGreaterThan(widths.table);
    await expect(page.locator('.resource-detail:visible')).toHaveScreenshot('linear-markdown-narrow.png');
    // Empty content clears the old render. No checkbox or rendered content writes back.
    providers.data.issue.description = '  \n '; await frame.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(detail.locator('.view-empty')).toContainText('This issue has no description.'); await expect(detail.locator('table,pre,input')).toHaveCount(0);
    await resize(app, page, 1280, 800); providers.data.issue.description = linearMarkdown;
    providers.data.issue.previousIdentifiers.push('BIL-128'); providers.data.issue.identifier = 'PAY-7'; providers.data.issue.url = 'https://linear.app/fixture/issue/PAY-7/updated'; providers.data.issue.state.name = 'Done'; providers.data.issue.state.type = 'completed';
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(detail.locator('.provider-read-title')).toHaveText('PAY-7 · Make plan changes predictable'); await expect(frame.locator('.view-chip')).toHaveText('Done'); await expect(frame.locator('.view-meta')).toContainText('PAY-7');
    const before = await service.control.read();
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); app = await launch(); page = await app.firstWindow();
    await page.getByRole('article', { name: 'PAY-7 · Make plan changes predictable', exact: true }).click(); await expect(page.locator('.linear-detail')).toContainText('Keep the current billing cycle'); expect((await service.control.read()).resources).toEqual(before.resources);
    await expect(page.locator('.linear-detail .markdown-content strong')).toHaveText('effective dates');
    providers.data.viewer.id = '99999999-9999-4999-8999-999999999999';
    await page.locator('.item-view:visible').getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.locator('.linear-detail')).toContainText('The Linear credential belongs to another account'); await expect(page.locator('.linear-detail')).toContainText('Keep the current billing cycle');
    await expect(page.locator('.linear-detail .markdown-content strong')).toHaveText('effective dates');
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Linear workflow menus show custom states and explicitly sync map/detail with stale and permission errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-workflow-')), providers = linearProviders();
  providers.states[2].name = 'Ready for QA';
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'BIL-128 · Make plan changes predictable', position: { x: 600, y: 340 }, data: { issueId: providers.data.issue.id } },
  ] });
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.craftingTable.runtimeRun({ nodeId: 'ticket', action: 'resource.read', arguments: { refresh: true } }));
    const card = page.getByRole('article', { name: 'BIL-128 · Make plan changes predictable', exact: true });
    await expect(card.getByText('In Progress', { exact: true })).toBeVisible();
    const assertSeparated = async () => {
      const title = await card.locator('.card-label strong').boundingBox(), status = await card.locator('.indicator-labels').boundingBox(), bounds = await card.boundingBox();
      expect(title!.y + title!.height + 1).toBeLessThan(status!.y);
      expect(status!.y + status!.height).toBeLessThan(bounds!.y + bounds!.height);
    };
    await assertSeparated();
    const setHeight = async (height: number) => page.evaluate(async height => {
      const snapshot = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: snapshot.state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.resize', id: 'ticket', dimensions: { width: 240, height } }] });
    }, height);
    await setHeight(48);
    await expect(card).toHaveAttribute('data-tight-title', 'true'); await assertSeparated();
    await setHeight(64); await expect(card).not.toHaveAttribute('data-tight-title', 'true'); await assertSeparated();
    await card.click({ button: 'right' });
    const trigger = page.getByRole('menuitem', { name: 'Change status', exact: true }), menu = page.getByRole('menu', { name: 'Change status', exact: true });
    await trigger.hover(); await expect(menu.getByRole('menuitemradio')).toHaveText(['Todo', 'In Progress', 'Ready for QA', 'Done']);
    await expect(menu.getByRole('menuitemradio', { name: 'In Progress', exact: true })).toBeDisabled();
    await expect(menu.getByRole('menuitemradio', { name: 'In Progress', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(providers.writes).toHaveLength(0);
    await page.mouse.move(4, 4); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await expect(page).toHaveScreenshot('linear-status-map-menu.png');
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
    // Keyboard entry waits for asynchronously loaded provider choices.
    await card.click({ button: 'right' }); await trigger.focus(); await page.keyboard.press('ArrowRight');
    await expect(menu.getByRole('menuitemradio', { name: 'Todo', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('menuitemradio', { name: 'Ready for QA', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(menu).toHaveCount(0);
    await expect(card.getByText('Ready for QA', { exact: true })).toBeVisible(); expect(providers.writes).toHaveLength(1);
    await expect(page.locator('.resource-detail:visible')).toHaveCount(0);
    await page.mouse.move(4, 4); await card.evaluate(element => (element as HTMLElement).blur());
    await expect(card).toHaveScreenshot('linear-status-ready-card.png');
    await card.click();
    const detail = page.locator('.linear-detail'), frame = page.locator('.item-view:visible'), status = frame.getByRole('button', { name: 'Change status: Ready for QA', exact: true });
    await status.click(); await expect(menu.getByRole('menuitemradio', { name: 'Ready for QA', exact: true })).toBeDisabled();
    await expect(frame).toHaveScreenshot('linear-status-detail-menu.png', { mask: [frame.locator('.view-freshness'), frame.locator('.view-meta')] });
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(status).toBeFocused(); expect(providers.writes).toHaveLength(1);
    await status.click(); await expect(menu.getByRole('menuitemradio', { name: 'Done', exact: true })).toBeVisible();
    // A remote edit while the menu is open must not be overwritten with a stale choice.
    providers.data.issue.updatedAt = '2026-09-28T12:00:00.000Z';
    await menu.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
    await expect(detail.getByRole('status')).toContainText('The issue changed in Linear'); expect(providers.writes).toHaveLength(1);
    await expect(status).toBeEnabled();
    const write = providers.transport.updateState!;
    providers.transport.updateState = async () => { throw new Error('Linear credentials lack permission to update this issue.'); };
    await status.click(); await menu.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
    await expect(detail.getByRole('status')).toContainText('lack permission'); expect(providers.writes).toHaveLength(1);
    await expect(status).toBeEnabled(); providers.transport.updateState = write;
    await status.click(); await menu.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Change status: Done', exact: true })).toHaveAttribute('data-tone', 'green');
    expect(providers.writes).toHaveLength(2);
    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect(card.getByText('Done', { exact: true })).toBeVisible(); await expect(card).toHaveAttribute('data-completed', 'true');
    await page.reload(); await expect(card.getByText('Done', { exact: true })).toBeVisible();
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Linear Done and the to-do checkbox mirror each other, restore the earlier status and keep the ticket fully visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-done-')), providers = linearProviders();
  const [, inProgress, , done] = providers.states;
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'BIL-128 · Make plan changes predictable', position: { x: 600, y: 340 }, data: { issueId: providers.data.issue.id } },
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Tell billing', position: { x: 980, y: 420 }, data: {} },
    { type: 'link.save', link: { id: 'ticket-task', sourceId: 'ticket', targetId: 'task', kind: 'reference', label: '' } },
    { type: 'node.todo', id: 'ticket', enabled: true },
  ] });
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    const refresh = () => page.evaluate(() => window.craftingTable.runtimeRun({ nodeId: 'ticket', action: 'resource.read', arguments: { refresh: true } }));
    await refresh();
    const card = page.getByRole('article', { name: 'BIL-128 · Make plan changes predictable', exact: true }), link = page.locator('.react-flow__edge[data-id="ticket-task"]');
    await expect(card.getByText('In Progress', { exact: true })).toBeVisible(); await expect(card).toHaveAttribute('data-completed', 'false');
    await page.mouse.move(4, 4);
    const openSize = (await card.boundingBox())!;
    const assertFullyVisible = async () => {
      const size = (await card.boundingBox())!;
      expect([size.width, size.height].map(Math.round)).toEqual([openSize.width, openSize.height].map(Math.round));
      expect(await card.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
      await expect(card.locator('.indicator-labels')).toBeVisible(); await expect(link).toBeVisible();
    };
    providers.data.issue.state = { id: done.id, name: done.name, type: done.type }; await refresh();
    await expect(card).toHaveAttribute('data-completed', 'true'); await assertFullyVisible();
    await expect(card.locator('.card-label strong')).toHaveCSS('text-decoration-line', 'line-through');
    expect(providers.writes).toHaveLength(0);
    // In the to-do list the row ticked itself and folded into Done; it reopens only on the map (TODO-06, TODO-12).
    await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).click();
    const overlay = page.getByRole('form', { name: 'To-dos', exact: true }), checkbox = overlay.getByRole('checkbox', { name: /^Complete Make plan changes predictable/ });
    await overlay.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
    await expect(checkbox).toBeChecked(); await expect(checkbox).toBeDisabled();
    // The card's Reopen and Mark done still mirror to Linear.
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Reopen', exact: true }).click();
    await expect(card).toHaveAttribute('data-completed', 'false'); await expect(card.getByText('In Progress', { exact: true })).toBeVisible();
    expect(providers.writes.map(write => write.stateId)).toEqual([inProgress.id]);
    // Ticking in the list is the list's own and never writes Linear.
    await page.getByRole('button', { name: /^Keep to-dos open/ }).click();
    await expect(checkbox).not.toBeChecked(); await checkbox.click();
    await expect(overlay.getByRole('region', { name: 'Done', exact: true }).locator('.todo-group-count')).toHaveText('1');
    await expect(card).toHaveAttribute('data-completed', 'false'); expect(providers.writes).toHaveLength(1);
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Mark done', exact: true }).click();
    await expect(card.getByText('Done', { exact: true })).toBeVisible(); await expect(card).toHaveAttribute('data-completed', 'true');
    expect(providers.writes.map(write => write.stateId)).toEqual([inProgress.id, done.id]);
    await page.mouse.move(4, 4); await assertFullyVisible();
    // Linear moved on before Reopen; the re-read sees an open state and does not write.
    providers.data.issue.state = { id: providers.states[2].id, name: providers.states[2].name, type: providers.states[2].type };
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Reopen', exact: true }).click();
    await expect(card).toHaveAttribute('data-completed', 'false');
    expect(providers.writes).toHaveLength(2);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a ticket offers Linked pull requests → Add to the map; it says so when Linear lists none and tries each one it lists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-pulls-')), providers = linearProviders();
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await page.getByLabel('Item URL').fill('https://linear.app/fixture/issue/BIL-128'); await page.getByRole('button', { name: 'Attach ticket', exact: true }).click();
    const card = page.getByRole('article', { name: 'BIL-128 · Make plan changes predictable', exact: true });
    await expect(card).toBeVisible();
    const add = async () => {
      await card.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Linked pull requests', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Add to the map', exact: true }).click();
    };
    await add();
    await expect(page.getByRole('alert').filter({ hasText: 'Linear lists no pull requests on BIL-128' })).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    // Linear now lists one: the table attaches it as a pull request, which this fixture's host cannot load.
    Object.assign(providers.data.issue, { attachments: { nodes: [{ url: 'https://github.com/fixture/billing/pull/42' }] } });
    const expire = () => { const db = new DatabaseSync(service.store.file); db.exec('UPDATE resource_cache SET checked_at=0'); db.close(); };
    await expect.poll(async () => { expire(); await service.resources.poll(); return ((await service.resources.cached((await service.control.read()).nodes.find(node => node.title.startsWith('BIL-128'))!.id))?.detail as any)?.pulls; }).toEqual([{ owner: 'fixture', repo: 'billing', number: 42 }]);
    await add();
    await expect(page.getByRole('alert').filter({ hasText: /Provider attachment is unavailable for this item type/ })).toBeVisible();
  } finally {
    await exitWithoutShutdown(app); await service.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
