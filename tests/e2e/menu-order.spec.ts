import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';

const PR = 'github.pull-request';
const PR_ENTRIES = ['Open', 'Connect to…', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', 'Open on GitHub', 'Copy URL', 'Settings', 'Move to project', 'Move to plot', 'Remove from plot', 'Mark done / Reopen', 'Send to Undermap'];
const PR_IDS = ['open', 'connect', '---', 'plugin:review', 'plugin:reviewLoop', 'plugin:architecture', 'plugin:merge', 'plugin:autoDeploy', 'plugin:state', 'plugin:showShip', '---', 'open-web', 'copy-url', 'edit', '---', 'send-project', 'move-plot', 'plot-unpin', 'complete', 'below'];
const PR_MENU = ['Open', 'Connect to…', '---', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', '---', 'Open on GitHub', 'Copy URL', 'Settings', '---', 'Move to project', 'Move to plot', 'Mark done', 'Send to Undermap'];
const NOTION_MENU = ['Open', 'Connect to…', '---', 'Open on Notion', 'Copy URL', 'Settings', '---', 'Move to project', 'Move to plot', 'Mark done', 'Send to Undermap'];
const NOTHING_SAVED = { order: {}, layout: {}, hidden: {} };
const without = (list: string[], ...remove: string[]) => list.filter(entry => !remove.includes(entry));

const menu = (page: Page) => page.getByRole('menu', { name: 'Context actions', exact: true });
const section = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: 'Right-click menus', exact: true });
const labels = (page: Page) => section(page).getByRole('listitem').locator('.menu-order-label');
const ids = (page: Page) => section(page).getByRole('listitem').evaluateAll(rows => rows.map(row => row.getAttribute('data-menu-entry')));
const row = (page: Page, id: string) => section(page).locator(`[data-menu-entry="${id}"]`);
const grip = (page: Page, label: string) => section(page).getByRole('button', { name: `Reorder ${label}`, exact: true });
const shown = (page: Page, label: string) => section(page).getByRole('checkbox', { name: `Show ${label} in the menu`, exact: true });
const reset = (page: Page) => section(page).getByRole('button', { name: 'Reset this menu', exact: true });
const typeSelect = (page: Page) => section(page).getByLabel('Item type', { exact: true });
const savedMenus = (page: Page) => page.evaluate(async () => (await window.craftingTable.settingsRead()).value.menus);
async function openMenus(page: Page, type = PR) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('treeitem', { name: 'Items', exact: true }).click();
  await typeSelect(page).selectOption(type);
  await section(page).getByRole('list').evaluate(list => list.scrollIntoView({ block: 'start' }));
}
const save = async (page: Page) => { await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0); };
/** The open menu's rows top to bottom, a separator as `---`. */
async function itemMenu(page: Page, title: string) {
  await page.getByRole('article', { name: title, exact: true }).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  const drawn = await menu(page).locator('[role=menuitem],[role=separator]').evaluateAll(rows => rows.map(entry => entry.getAttribute('role') === 'separator' ? '---' : entry.textContent ?? ''));
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  return drawn;
}
/** Drags the grip at `from` (a locator of one grip) onto the row holding `onto`. */
async function drag(page: Page, from: ReturnType<typeof grip>, onto: ReturnType<typeof row>, release = true) {
  const start = (await from.boundingBox())!, x = start.x + start.width / 2;
  await page.mouse.move(x, start.y + start.height / 2); await page.mouse.down();
  const target = (await onto.boundingBox())!;
  await page.mouse.move(x, target.y + target.height / 2, { steps: 8 });
  if (release) await page.mouse.up();
}

test('Settings → Items reorders one item type’s menu by keyboard; other types stay as they were and Reset restores', async ({ visual: { page } }) => {
  expect(await itemMenu(page, 'Plan switcher')).toEqual(PR_MENU);
  await openMenus(page);
  const types = await typeSelect(page).locator('option').allTextContents();
  expect(types).toEqual([...types].sort((a, b) => a.localeCompare(b)));
  for (const name of ['Bookmark', 'Claude artifact', 'GitHub pull request', 'Linear ticket', 'Note', 'Notion page', 'Terminal', 'Web link']) expect(types).toContain(name);
  await expect(labels(page)).toHaveText(PR_ENTRIES);
  expect(await ids(page)).toEqual(PR_IDS);
  await expect(reset(page)).toBeDisabled();
  await expect(section(page).getByRole('button', { name: /^Move .* (earlier|later)$/ })).toHaveCount(0);
  await expect(section(page).getByRole('button', { name: /^[↑↓]$/ })).toHaveCount(0);
  await grip(page, 'Copy URL').focus();
  for (let step = 0; step < 12; step++) { await page.keyboard.press('ArrowUp'); await expect(grip(page, 'Copy URL')).toBeFocused(); }
  const moved = ['copy-url', ...without(PR_IDS, 'copy-url')];
  expect(await ids(page)).toEqual(moved);
  await page.keyboard.press('ArrowUp');
  expect(await ids(page)).toEqual(moved);
  await expect(section(page).getByRole('status')).toHaveText('Copy URL is 1 of 20');
  await expect(reset(page)).toBeEnabled();
  await expect(typeSelect(page).locator('option:checked')).toHaveText('GitHub pull request · custom menu');
  await expect(page.locator('#settings-entry-Items .settings-tree-marker')).toHaveAttribute('data-marker', 'dirty');
  await typeSelect(page).selectOption('notion.page');
  await expect(labels(page)).toHaveText(['Open', 'Connect to…', 'Open on Notion', 'Copy URL', 'Settings', 'Move to project', 'Move to plot', 'Remove from plot', 'Mark done / Reopen', 'Send to Undermap']);
  await expect(reset(page)).toBeDisabled();
  await save(page);
  expect(await savedMenus(page)).toEqual({ ...NOTHING_SAVED, layout: { [PR]: moved } });
  const menuMoved = ['Copy URL', ...without(PR_MENU, 'Copy URL')];
  expect(await itemMenu(page, 'Plan switcher')).toEqual(menuMoved);
  expect(await itemMenu(page, 'Billing experience')).toEqual(NOTION_MENU);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Mark done', exact: true }).click();
  expect(await itemMenu(page, 'Plan switcher')).toEqual(menuMoved.map(label => label === 'Mark done' ? 'Reopen' : label));
  await openMenus(page);
  expect(await ids(page)).toEqual(moved);
  await reset(page).click();
  expect(await ids(page)).toEqual(PR_IDS); await expect(reset(page)).toBeDisabled();
  await save(page);
  expect(await savedMenus(page)).toEqual(NOTHING_SAVED);
  expect(await itemMenu(page, 'Plan switcher')).toEqual(PR_MENU.map(label => label === 'Mark done' ? 'Reopen' : label));
});

test('dragging an entry by its grip reorders the menu; dragging it back saves nothing', async ({ visual: { page } }) => {
  await openMenus(page);
  await drag(page, grip(page, 'Copy URL'), row(page, 'plugin:review'), false);
  await expect(row(page, 'copy-url')).toHaveAttribute('data-dragging', 'true');
  expect(await ids(page)).toEqual(['open', 'connect', '---', 'copy-url', ...without(PR_IDS, 'open', 'connect', 'copy-url').slice(1)]);
  const box = (await grip(page, 'Copy URL').boundingBox())!, x = box.x + box.width / 2;
  await page.mouse.move(x, (await row(page, 'open').boundingBox())!.y - 30, { steps: 8 });
  await page.mouse.up();
  await expect(row(page, 'copy-url')).not.toHaveAttribute('data-dragging');
  const moved = ['copy-url', ...without(PR_IDS, 'copy-url')];
  expect(await ids(page)).toEqual(moved);
  await page.mouse.move(x, (await row(page, 'plugin:merge').boundingBox())!.y + 10, { steps: 4 });
  expect(await ids(page)).toEqual(moved);
  await save(page);
  expect(await itemMenu(page, 'Plan switcher')).toEqual(['Copy URL', ...without(PR_MENU, 'Copy URL')]);
  await openMenus(page);
  await drag(page, grip(page, 'Copy URL'), row(page, 'open-web'));
  expect(await ids(page)).toEqual(PR_IDS);
  await expect(reset(page)).toBeDisabled();
  await expect(page.locator('#settings-entry-Items .settings-tree-marker')).toHaveAttribute('data-marker', 'dirty');
  await save(page);
  expect(await savedMenus(page)).toEqual(NOTHING_SAVED);
});

test('a list taller than the page scrolls while a row is dragged at its edge', async ({ visual: { page } }) => {
  await openMenus(page);
  await section(page).evaluate(element => element.scrollIntoView({ block: 'start' }));
  const last = row(page, 'below'), scroller = page.getByRole('dialog', { name: 'Settings' }).locator('.settings-content');
  const edges = await scroller.evaluate(element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; });
  expect((await last.boundingBox())!.y, 'the last row starts below the page').toBeGreaterThan(edges.bottom);
  const start = (await grip(page, 'Open').boundingBox())!, x = start.x + start.width / 2;
  await page.mouse.move(x, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(x, edges.bottom - 12, { steps: 6 });
  await expect.poll(() => ids(page)).toEqual([...PR_IDS.slice(1), 'open']);
  await expect(row(page, 'open')).toBeInViewport();
  await page.mouse.move(x, edges.top + 12, { steps: 6 });
  await expect.poll(() => ids(page)).toEqual(PR_IDS);
  await page.mouse.up();
  await expect(reset(page)).toBeDisabled();
});

test('a separator is a row: it drags between two entries, is removed with × and added after the row last used', async ({ visual: { page } }) => {
  await openMenus(page);
  await expect(row(page, '---')).toHaveCount(3);
  await expect(section(page).getByRole('button', { name: 'Remove separator', exact: true })).toHaveCount(3);
  // The line between Connect and the provider actions moves down one, between Trigger review and Review loop.
  await drag(page, grip(page, 'Separator').first(), row(page, 'plugin:review'));
  const dragged = ['open', 'connect', 'plugin:review', '---', ...PR_IDS.slice(4)];
  expect(await ids(page)).toEqual(dragged);
  await save(page);
  expect(await savedMenus(page)).toEqual({ ...NOTHING_SAVED, layout: { [PR]: dragged } });
  expect(await itemMenu(page, 'Plan switcher')).toEqual(['Open', 'Connect to…', 'Trigger review', '---', ...PR_MENU.slice(4)]);
  expect(await itemMenu(page, 'Billing experience')).toEqual(NOTION_MENU);

  await openMenus(page);
  await row(page, '---').first().getByRole('button', { name: 'Remove separator', exact: true }).click();
  const removed = without(dragged.slice(0, 4), '---').concat(dragged.slice(4));
  expect(await ids(page)).toEqual(removed);
  await expect(section(page).getByRole('status')).toHaveText('Separator removed');
  await grip(page, 'Copy URL').focus();
  await section(page).getByRole('button', { name: 'Add separator', exact: true }).click();
  const at = removed.indexOf('copy-url') + 1, added = [...removed.slice(0, at), '---', ...removed.slice(at)];
  expect(await ids(page)).toEqual(added);
  await expect(grip(page, 'Separator').nth(1)).toBeFocused();
  await expect(section(page).getByRole('status')).toHaveText(`Separator added, ${at + 1} of 20`);
  // Two lines in a row and one at the very end are rows here, and one line or none in the menu.
  await page.keyboard.press('ArrowDown');
  expect(await ids(page)).toEqual([...removed.slice(0, at), 'edit', '---', '---', ...removed.slice(at + 2)]);
  await typeSelect(page).selectOption('notion.page');
  await section(page).getByRole('button', { name: 'Add separator', exact: true }).click();
  expect((await ids(page)).slice(-2)).toEqual(['below', '---']);
  await expect(typeSelect(page).locator('option:checked')).toHaveText('Notion page · custom menu');
  await save(page);
  expect(await itemMenu(page, 'Plan switcher')).toEqual(['Open', 'Connect to…', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', '---', 'Open on GitHub', 'Copy URL', 'Settings', '---', 'Move to project', 'Move to plot', 'Mark done', 'Send to Undermap']);
  expect(await itemMenu(page, 'Billing experience')).toEqual(NOTION_MENU);
});

test('an entry can be hidden from one item type’s menu and shown again; the last one cannot be hidden', async ({ visual: { page } }) => {
  await openMenus(page);
  await expect(shown(page, 'Send to Undermap')).toBeChecked();
  await shown(page, 'Send to Undermap').uncheck();
  await shown(page, 'Trigger review').uncheck();
  await expect(row(page, 'below')).toHaveAttribute('data-hidden', 'true');
  expect(await ids(page)).toEqual(PR_IDS);
  await expect(section(page).getByRole('status')).toHaveText('Trigger review is hidden from the menu');
  await expect(typeSelect(page).locator('option:checked')).toHaveText('GitHub pull request · custom menu');
  // Away from the list's edges, where a held row scrolls the list.
  await row(page, 'open-web').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await drag(page, grip(page, 'Separator').nth(1), row(page, 'copy-url'));
  const layout = [...PR_IDS.slice(0, 10), 'open-web', 'copy-url', '---', ...PR_IDS.slice(13)];
  expect(await ids(page)).toEqual(layout);
  await section(page).locator('.menu-order-add').evaluate(element => element.scrollIntoView({ block: 'end' }));
  await capture(page, 'settings-menu-order.png');
  await save(page);
  expect(await savedMenus(page)).toEqual({ ...NOTHING_SAVED, layout: { [PR]: layout }, hidden: { [PR]: ['below', 'plugin:review'] } });
  expect(await itemMenu(page, 'Plan switcher')).toEqual(['Open', 'Connect to…', '---', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', 'Open on GitHub', 'Copy URL', '---', 'Settings', '---', 'Move to project', 'Move to plot', 'Mark done']);
  expect(await itemMenu(page, 'Billing experience')).toEqual(NOTION_MENU);

  await openMenus(page);
  await expect(shown(page, 'Send to Undermap')).not.toBeChecked();
  await shown(page, 'Send to Undermap').check();
  await expect(row(page, 'below')).not.toHaveAttribute('data-hidden');
  await save(page);
  expect(await savedMenus(page)).toEqual({ ...NOTHING_SAVED, layout: { [PR]: layout }, hidden: { [PR]: ['plugin:review'] } });
  expect((await itemMenu(page, 'Plan switcher')).slice(-2)).toEqual(['Mark done', 'Send to Undermap']);

  await openMenus(page);
  await reset(page).click();
  expect(await ids(page)).toEqual(PR_IDS);
  await expect(shown(page, 'Trigger review')).toBeChecked();
  await expect(section(page).getByRole('checkbox', { checked: false })).toHaveCount(0);
  await expect(reset(page)).toBeDisabled();
  await typeSelect(page).selectOption('workspace.note');
  const entries = await labels(page).allTextContents();
  for (const label of entries.slice(1)) await shown(page, label).uncheck();
  await expect(section(page).getByRole('alert')).toHaveCount(0);
  await shown(page, entries[0]!).click();
  await expect(shown(page, entries[0]!)).toBeChecked();
  await expect(section(page).getByRole('alert')).toHaveText('At least one entry stays in the menu. Show another entry first.');
  await shown(page, entries[1]!).check();
  await expect(section(page).getByRole('alert')).toHaveCount(0);
  await reset(page).click();
  await expect(section(page).getByRole('checkbox', { checked: false })).toHaveCount(0);
  await save(page);
  expect(await savedMenus(page)).toEqual(NOTHING_SAVED);
  expect(await itemMenu(page, 'Plan switcher')).toEqual(PR_MENU);
});

test('hiding an entry leaves the selection menu and Undermap as they were', async ({ visual: { page } }) => {
  await page.evaluate(async type => {
    const settings = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, menus: { order: {}, layout: {}, hidden: { [type]: ['below', 'complete', 'copy-url', 'send-project', 'edit'] } } } });
  }, PR);
  await expect.poll(() => itemMenu(page, 'Plan switcher')).toEqual([...without(PR_MENU.slice(0, 12), 'Copy URL'), '---', 'Move to plot']);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('article', { name: 'Billing experience', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('article', { name: 'Billing experience', exact: true }).click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Copy URLs', 'Move to project', 'Move to plot', 'Mark done', 'Send selection to Undermap']);
  await menu(page).getByRole('menuitem', { name: 'Send selection to Undermap', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  expect(await itemMenu(page, 'Plan switcher')).toEqual(['Bring back to map', 'Open on GitHub', 'Copy URL', 'Item settings…', '---', 'Archive']);
});

test('an order saved before separators were rows draws the same menu and becomes a layout when it is next changed', async ({ visual: { page } }) => {
  const order = ['copy-url', 'open', 'connect', 'plugin:review', 'plugin:architecture', 'plugin:merge', 'plugin:state', 'plugin:showShip', 'open-web', 'edit', 'send-project', 'complete', 'below'];
  await page.evaluate(async ([type, saved]) => {
    const settings = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, menus: { order: { [type as string]: saved as string[] }, layout: {}, hidden: {} } } });
  }, [PR, order] as const);
  const drawn = ['Copy URL', '---', 'Open', 'Connect to…', '---', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', '---', 'Open on GitHub', 'Settings', '---', 'Move to project', 'Move to plot', 'Mark done', 'Send to Undermap'];
  await expect.poll(() => itemMenu(page, 'Plan switcher')).toEqual(drawn);
  await openMenus(page);
  const converted = ['copy-url', '---', 'open', 'connect', '---', 'plugin:review', 'plugin:reviewLoop', 'plugin:architecture', 'plugin:merge', 'plugin:autoDeploy', 'plugin:state', 'plugin:showShip', '---', 'open-web', 'edit', '---', 'send-project', 'move-plot', 'plot-unpin', 'complete', 'below'];
  expect(await ids(page)).toEqual(converted);
  await expect(typeSelect(page).locator('option:checked')).toHaveText('GitHub pull request · custom menu');
  await expect(page.locator('#settings-entry-Items .settings-tree-marker[data-marker=dirty]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await savedMenus(page)).order).toEqual({ [PR]: order });
  await openMenus(page);
  await row(page, '---').first().getByRole('button', { name: 'Remove separator', exact: true }).click();
  await save(page);
  expect(await savedMenus(page)).toEqual({ ...NOTHING_SAVED, layout: { [PR]: converted.filter((_, index) => index !== 1) } });
  expect(await itemMenu(page, 'Plan switcher')).toEqual(drawn.filter((_, index) => index !== 1));
});
