import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { test, resize } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { STANDUP_ENABLED } from '../../packages/core/standup.ts';

/** The rail's Actions slot is away while the standup report is disabled. */
const ACTIONS = STANDUP_ENABLED ? ['Table actions'] : [];

async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'rail-fixture' }, commands }); }, JSON.stringify(commands));
}
const acknowledgeAll = (page: Page) => page.evaluate(async () => {
  const { state } = await window.craftingTable.workspaceRead();
  for (const node of state.nodes.filter(node => node.attention !== 'none')) await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: (await window.craftingTable.workspaceRead()).state.revision, actor: { kind: 'user', id: 'desktop' }, commands: [{ type: 'node.update', id: node.id, attention: 'none' }] });
});
const needsMe = (page: Page, count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Needs me', exact: true });
const slot = (page: Page, name: string) => page.locator(`.tool-rail-slot[data-slot=${name}]`);
const box = async (locator: Locator) => (await locator.boundingBox())!;
const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

test('the rail is the one origin of every menu: Needs me, To-dos, Reminders, GitHub inbox, Undermap, then Settings', async ({ visual: { page } }) => {
  const rail = await box(page.locator('.tool-rail'));
  const buttons = await page.locator('.rail-panel-toggle,.below-portal').evaluateAll(elements => elements
    .map(element => ({ name: element.getAttribute('aria-label')!, ...element.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number } }))
    .sort((a, b) => a.y - b.y));
  expect(buttons.map(button => button.name)).toEqual(['Needs me: 2', 'Keep to-dos open', 'Reminders', 'GitHub inbox', 'Go to Undermap', ...ACTIONS, 'Settings']);
  for (const button of buttons) {
    expect([button.x, button.width, button.height]).toEqual([16, 44, 44]);
    expect(button.y).toBeGreaterThan(rail.y); expect(button.y + button.height).toBeLessThan(rail.y + rail.height);
  }
  // Actions and Settings sit apart from the tools, below the divider.
  const first = buttons.length - 1 - ACTIONS.length;
  expect(buttons[first]!.y - buttons[first - 1]!.y).toBeGreaterThan(buttons[first - 1]!.y - buttons[first - 2]!.y);
  // Top right holds no control any more: only the silent connection status.
  await expect(page.locator('.map-actions')).toHaveCount(0);
  await expect(page.locator('.map-status').getByRole('button')).toHaveCount(0);
  await expect(page.locator('.map-status').getByRole('status')).toHaveAccessibleName('Desktop connected');
  expect((await box(page.getByRole('button', { name: 'Settings', exact: true }))).x).toBeLessThan(100);

  // Keyboard: Tab walks the rail top to bottom; each slot names itself with its key.
  await needsMe(page, 2).focus();
  await expect(page.locator('.tool-rail-tip[data-slot=attention]')).toBeVisible(); await expect(page.locator('.tool-rail-tip[data-slot=attention]')).toHaveText('Needs me1 N');
  await expect(needsMe(page, 2)).toHaveAttribute('aria-keyshortcuts', '1 N');
  for (const name of ['Keep to-dos open', 'Reminders', /^GitHub inbox/, 'Go to Undermap', ...ACTIONS, 'Settings']) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
  }
  await expect(page.locator('.tool-rail-tip[data-slot=settings]')).toBeVisible(); await expect(page.locator('.tool-rail-tip[data-slot=settings]')).toHaveText('Settings7 ,');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-keyshortcuts', '7 ,');
  await page.mouse.move(1180, 710); await page.evaluate(() => (document.activeElement as HTMLElement).blur());

  // The amber slot counts what waits, with the to-do slot's badge pattern; only the Needs me badge is amber.
  const badge = page.locator('.needs-me-count');
  await expect(badge).toHaveText('2'); await expect(needsMe(page, 2)).toHaveClass(/needs-me-button/);
  const look = (locator: Locator) => locator.evaluate(element => { const style = getComputedStyle(element); return [style.color, style.backgroundColor, style.fontSize, style.fontWeight, style.height]; });
  // The to-do badge counts tickets waiting in From Linear, never Next; one marked Not for me no longer counts.
  await apply(page, [{ type: 'todo.save', todo: { id: 'next-one', title: 'Next up', completed: false, nodeIds: [] } }]);
  await expect(page.getByRole('button', { name: 'Keep to-dos open', exact: true })).toBeVisible();
  await expect(page.locator('.todo-triage-count')).toHaveCount(0);
  const waiting = (id: string, number: number) => ({ type: 'todo.save' as const, todo: { id, title: `Waiting ${number}`, completed: false, nodeIds: [], horizon: 'inbox' as const,
    triage: { source: 'linear', key: `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`, label: `APP-${number}`, status: 'Todo', item: { pluginId: 'linear.ticket', title: `RUN-${number} · Waiting`, data: {} } } } });
  await apply(page, [waiting('waiting-1', 1), waiting('waiting-2', 2)]);
  await expect(page.locator('.todo-triage-count')).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Keep to-dos open: 2 in the inbox', exact: true })).toBeVisible();
  await apply(page, [{ type: 'todo.dismiss', id: 'waiting-2', dismissed: true }]);
  await expect(page.locator('.todo-triage-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Keep to-dos open: 1 in the inbox', exact: true })).toBeVisible();
  expect((await look(badge)).slice(2)).toEqual((await look(page.locator('.todo-triage-count'))).slice(2));
  expect((await look(badge))[1]).not.toBe((await look(page.locator('.todo-triage-count')))[1]);
  await expect(page.locator('.tool-rail')).toHaveScreenshot('rail-needs-me.png');
});

test('Needs me opens from the rail like the other sheets: rest to peek, click or N to keep, one sheet at a time', async ({ visual: { page } }) => {
  const rail = await box(page.locator('.tool-rail')), toggle = needsMe(page, 2);
  await toggle.hover();
  await expect(sheet(page)).toBeVisible();
  await expect(slot(page, 'attention')).toHaveAttribute('data-active', 'true'); await expect(slot(page, 'attention')).not.toHaveAttribute('data-pinned');
  // A peek leaves focus alone and ends when the pointer leaves.
  await expect(sheet(page).locator(':focus')).toHaveCount(0);
  await page.mouse.move(1180, 710); await expect(sheet(page)).toHaveCount(0);

  await toggle.click();
  await expect(slot(page, 'attention')).toHaveAttribute('data-pinned', 'true'); await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(sheet(page).getByRole('button', { name: 'Open Claude · implementation', exact: true })).toBeFocused();
  const opened = await box(sheet(page));
  expect([opened.x, opened.y]).toEqual([rail.x + rail.width + 8, rail.y]);
  await page.mouse.move(1180, 710); await page.waitForTimeout(350);
  await expect(sheet(page)).toBeVisible();
  await page.screenshot({ path: 'test-results/rail-needs-me-open.png' });

  // The sheet resizes like the others and remembers its size.
  const grip = sheet(page).getByRole('button', { name: 'Resize needs me', exact: true });
  await grip.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await box(sheet(page))).width).toBe(opened.width + 10);
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.viewRead()).attentionPanel?.width)).toBe(opened.width + 10);

  // One sheet at a time: another tool takes over, and N brings Needs me back.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('2');
  await expect(sheet(page)).toHaveCount(0); await expect(page.locator('.todo-overlay')).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('1');
  await expect(sheet(page)).toBeVisible(); await expect(page.locator('.todo-overlay')).toHaveAttribute('data-open', 'false');
  await page.keyboard.press('2');
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(sheet(page)).toBeVisible(); await expect(page.locator('.todo-overlay')).toHaveAttribute('data-open', 'false');
  // Hovering another tool peeks over the kept sheet, which returns afterwards.
  await page.getByRole('button', { name: /^GitHub inbox/ }).hover();
  await expect(page.getByRole('dialog', { name: 'GitHub inbox', exact: true })).toBeVisible(); await expect(sheet(page)).toHaveCount(0);
  await page.mouse.move(1180, 710);
  await expect(sheet(page)).toBeVisible(); await expect(page.getByRole('dialog', { name: 'GitHub inbox', exact: true })).toHaveCount(0);

  // Escape closes it from anywhere outside a text field; so does its slot, and a right click on the map.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  const zoom = await page.locator('.map-area').getAttribute('data-zoom');
  await page.keyboard.press('Escape'); await expect(sheet(page)).toHaveCount(0);
  // That Escape belonged to the sheet: the map did not step back as well.
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', zoom!);
  await toggle.click(); await expect(sheet(page)).toBeVisible();
  await toggle.click(); await expect(sheet(page)).toHaveCount(0); await expect(slot(page, 'attention')).not.toHaveAttribute('data-pinned');
  await toggle.click(); await expect(sheet(page)).toBeVisible();
  await page.mouse.click(640, 720, { button: 'right' });
  await expect(sheet(page)).toHaveCount(0); await expect(page.getByRole('menu', { name: 'Context actions' })).toHaveCount(0);
  await page.mouse.click(640, 720, { button: 'right' });
  await expect(page.getByRole('menu', { name: 'Context actions' })).toBeVisible();
});

test('at zero the Needs me slot stays in place, plain, and still opens the list', async ({ visual: { page } }) => {
  const before = await box(needsMe(page, 2));
  await acknowledgeAll(page);
  const quiet = page.getByRole('button', { name: 'Needs me', exact: true });
  await expect(quiet).toBeVisible(); await expect(quiet).toHaveClass(/needs-me-quiet/);
  await expect(page.getByRole('button', { name: /^Needs me:/ })).toHaveCount(0); await expect(page.locator('.needs-me-count')).toHaveCount(0);
  expect(await box(quiet)).toEqual(before);
  const look = (locator: Locator) => locator.evaluate(element => { const style = getComputedStyle(element); return [style.color, style.backgroundColor, style.borderTopWidth]; });
  expect(await look(quiet)).toEqual(await look(page.getByRole('button', { name: 'Settings', exact: true })));
  await page.mouse.move(1180, 710);
  await expect(page.locator('.tool-rail')).toHaveScreenshot('rail-needs-me-zero.png');
  await quiet.click();
  await expect(sheet(page)).toContainText('Nothing needs me.');
  await expect(sheet(page).getByRole('button', { name: 'Close needs me', exact: true })).toBeFocused();
});

test('Settings opens from the rail, shows its slot open and returns focus there', async ({ visual: { page } }) => {
  const settings = page.getByRole('button', { name: 'Settings', exact: true }), dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.click();
  await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(slot(page, 'settings')).toHaveAttribute('data-active', 'true'); await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(settings).toBeFocused(); await expect(slot(page, 'settings')).not.toHaveAttribute('data-active');
  await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
});

test('Needs me stays reachable while an item is open, and the rail clears the zoom bar, Atlas and frame bar at narrow widths', async ({ visual: { app, page } }) => {
  for (const width of [1280, 1100, 900]) {
    await resize(app, page, width, 800);
    const rail = await box(page.locator('.tool-rail'));
    for (const chrome of ['.map-locator', '.zoom-markers']) expect(apart(rail, await box(page.locator(chrome))), `${chrome} at ${width}`).toBe(true);
    expect(rail.y + rail.height).toBeLessThan(800 - 20);
    await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
    const bar = page.locator('.expanded .card-heading');
    await expect(bar).toBeVisible();
    await expect.poll(async () => apart(rail, await box(bar)), { message: `frame bar at ${width}` }).toBe(true);
    await needsMe(page, 2).click();
    await expect(sheet(page)).toBeVisible();
    await page.screenshot({ path: `test-results/rail-item-open-${width}.png` });
    await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
    await page.screenshot({ path: `test-results/rail-item-${width}.png` });
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('.expanded')).toHaveCount(0);
  }
});

test('hovering a rail slot names it at once, and the name goes away when its sheet opens', async ({ visual: { page } }) => {
  const tip = page.locator('.tool-rail-tip[data-slot=reminders]'), shown = () => tip.evaluate(element => getComputedStyle(element).visibility);
  const target = await box(page.getByRole('button', { name: 'Reminders', exact: true }));
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.waitForTimeout(120);
  expect(await shown()).toBe('visible');
  await expect(page.getByRole('dialog', { name: 'Reminders', exact: true })).toBeVisible();
  await expect.poll(shown).toBe('hidden');
});
