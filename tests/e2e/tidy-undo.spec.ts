import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { test, openTerminal } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const apply = (page: Page, commands: WorkspaceCommand[]) => page.evaluate(async (commands: unknown[]) => {
  for (let attempt = 0; ; attempt++) {
    const { state } = await window.craftingTable.workspaceRead();
    try { await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never }); return; }
    catch (error) { if (attempt >= 4 || !String((error as Error).message).includes('Revision conflict')) throw error; }
  }
}, commands as unknown[]);
const positions = async (page: Page) => Object.fromEntries((await read(page)).nodes.filter(node => node.resourceId).map(node => [node.id, node.position]));
const at = async (page: Page, id: string) => (await read(page)).nodes.find(node => node.id === id)!.position;
const shot = async (page: Page, name: string) => { await mkdir('test-results/pr', { recursive: true }); await page.screenshot({ path: `test-results/pr/${name}.png` }); };

test('Tidy previews on the map, applies as one step, and ⌘Z puts every item back', async ({ visual: { page } }) => {
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toBeVisible();
  const before = await positions(page);
  await shot(page, 'tidy-before');
  await page.mouse.click(100, 650, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Tidy…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tidy' });
  await expect(dialog.getByRole('checkbox', { name: /Line up items/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Archive finished work/ })).not.toBeChecked();
  await shot(page, 'tidy-dialog');
  await expect(page.locator('.map-tidy-ghosts [data-tidy-ghost]').first()).toBeVisible();
  await shot(page, 'tidy-preview');
  expect(await positions(page), 'the preview moves nothing').toEqual(before);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(page.locator('.map-tidy-ghosts')).toHaveCount(0);
  expect(await positions(page), 'Esc changes nothing').toEqual(before);

  await page.mouse.click(100, 650, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Tidy…', exact: true }).click();
  await expect(page.locator('.map-tidy-ghosts [data-tidy-ghost]').first()).toBeVisible();
  // A change after the preview: Apply is refused and nothing half applies.
  await apply(page, [{ type: 'node.move', id: 'brief', position: { x: 1300, y: 700 } }]);
  const moved = await positions(page);
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The map changed since this preview');
  expect(await positions(page)).toEqual(moved);
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => positions(page)).not.toEqual(moved);
  const tidied = await positions(page);
  await expect(page.locator('.map-item-highlights')).toBeVisible();
  await shot(page, 'tidy-after');

  // The notice's Undo is the same step as ⌘Z.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Undid tidy', { exact: true })).toBeVisible();
  await expect.poll(() => positions(page)).toEqual(moved);
  await shot(page, 'tidy-undo-notice');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => positions(page)).toEqual(tidied);
});

test('⌘Z does nothing while typing in a note or a terminal, and undoes the map once it has focus', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [{ type: 'item.add', id: 'api', resourceId: 'api-resource', pluginId: 'workspace.note', data: { text: 'API compatibility\nKeep stable' }, projectId: 'billing', position: { x: 380, y: 520 } }]);
  const card = page.getByRole('article', { name: 'Plan switcher', exact: true }), start = await at(page, 'pr');
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 172, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => at(page, 'pr')).not.toEqual(start);
  const dropped = await at(page, 'pr');

  const tile = page.locator('[data-item-id="api"]'), editor = tile.getByRole('textbox', { name: 'Note text' });
  const note = (await tile.boundingBox())!;
  await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
  await expect(editor).toBeFocused();
  await page.keyboard.type('!'); await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(400);
  expect(await at(page, 'pr'), 'typing keeps ⌘Z').toEqual(dropped);
  await page.keyboard.press('Escape');

  await openTerminal(page);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(400);
  expect(await at(page, 'pr'), 'the terminal keeps ⌘Z').toEqual(dropped);
  await page.locator('.item-view:not([hidden]) .item-close').click();
  await expect(page.locator('.item-view:not([hidden])')).toHaveCount(0);

  await page.mouse.click(100, 650);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByText(/^Undid move/)).toBeVisible();
  await expect.poll(() => at(page, 'pr')).toEqual(start);
});
