import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { todoContext } from '../../src/graph/todos.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async payload => {
    const commands = JSON.parse(payload) as WorkspaceCommand[];
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands });
  }, JSON.stringify(commands));
}
const handover = 'Why: the plan switcher double-charges on downgrade.\n\nNext: rerun the backfill, then <b>check</b> https://example.com/runbook';
const openList = async (page: Page) => {
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  await expect(overlay).toHaveAttribute('data-open', 'true');
  return overlay;
};

test('a to-do\'s context stays hidden behind a glyph, opens under the row, and is edited and cleared in place', async ({ visual: { page } }) => {
  await apply(page, [
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check billing flows', data: {}, projectId: 'billing', position: { x: 650, y: 600 } },
    { type: 'todo.save', todo: { id: 'plain', title: 'Review implementation', completed: false, nodeIds: [] } },
    { type: 'todo.save', todo: { id: 'handover', title: 'Hand over billing', completed: false, nodeIds: [], context: handover } },
  ]);
  let overlay = await openList(page);
  const plain = overlay.locator('[data-todo-id="plain"]'), row = overlay.locator('[data-todo-id="handover"]');
  await expect(plain.locator('.todo-context-glyph')).toHaveCount(0);
  const glyph = row.getByRole('button', { name: 'Show context for Hand over billing', exact: true });
  await expect(glyph).toHaveAttribute('title', /^Has context · written by you \S+.*$/);
  await expect(glyph).toHaveAttribute('aria-expanded', 'false');
  await expect(glyph.locator('svg')).toHaveAttribute('data-glyph', 'message');
  await expect(overlay).not.toContainText('double-charges');
  expect((await row.boundingBox())!.height).toBe((await plain.boundingBox())!.height);

  await glyph.focus(); await page.keyboard.press('Enter');
  const panel = overlay.getByRole('group', { name: 'Context for Hand over billing', exact: true });
  await expect(panel.locator('.todo-context-text')).toHaveText(handover);
  await expect(panel.locator('b')).toHaveCount(0);
  await expect(panel.locator('.todo-context-meta')).toHaveText(/^written by you · \S+.*$/);
  await expect(row.getByRole('button', { name: 'Hide context for Hand over billing', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual((await row.boundingBox())!.y + (await row.boundingBox())!.height - 1);
  expect(await panel.locator('.todo-context-text').evaluate(element => [getComputedStyle(element).whiteSpace, getComputedStyle(element).userSelect, getComputedStyle(element).overflowY])).toEqual(['pre-wrap', 'text', 'auto']);

  // Editing keeps the list open; Escape cancels the draft and nothing else.
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = panel.getByRole('textbox', { name: 'Context for Hand over billing', exact: true });
  await expect(editor).toBeFocused(); await expect(editor).toHaveValue(handover);
  await editor.fill('Draft that is thrown away');
  await page.mouse.move(1180, 710); await page.waitForTimeout(350);
  await expect(overlay).toHaveAttribute('data-open', 'true'); await expect(editor).toHaveValue('Draft that is thrown away');
  await editor.press('Escape');
  await expect(overlay).toHaveAttribute('data-open', 'true'); await expect(editor).toHaveCount(0);
  await expect(panel.locator('.todo-context-text')).toHaveText(handover);
  expect(todoContext(await read(page), 'handover')!.text).toBe(handover);

  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.fill('Backfill done on staging.\nProduction is next.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('.todo-context-text')).toHaveText('Backfill done on staging.\nProduction is next.');
  await expect.poll(async () => todoContext(await read(page), 'handover')?.text).toBe('Backfill done on staging.\nProduction is next.');
  expect(todoContext(await read(page), 'handover')!.by).toEqual({ kind: 'user', id: 'desktop' });

  // The text is not on the map, and survives a reload.
  await expect(page.locator('.map-area')).not.toContainText('Backfill done');
  await page.reload();
  overlay = await openList(page);
  await expect(overlay).not.toContainText('Backfill done');
  await overlay.locator('[data-todo-id="handover"]').getByRole('button', { name: 'Show context for Hand over billing', exact: true }).click();
  await expect(overlay.getByRole('group', { name: 'Context for Hand over billing', exact: true }).locator('.todo-context-text')).toHaveText('Backfill done on staging.\nProduction is next.');

  // The row menu adds context to a to-do that has none, also for a to-do on the map.
  await overlay.locator('[data-todo-id="plain"]').click({ button: 'right', position: { x: 60, y: 10 } });
  await expect(page.getByRole('menuitem', { name: 'Show context', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Clear context', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Add context…', exact: true }).click();
  const added = overlay.getByRole('textbox', { name: 'Context for Review implementation', exact: true });
  await expect(added).toBeFocused(); await added.fill('Start with the reducer tests.'); await added.press('ControlOrMeta+Enter');
  await expect(overlay.locator('[data-todo-id="plain"] .todo-context-glyph')).toBeVisible();
  await expect.poll(async () => todoContext(await read(page), 'plain')?.text).toBe('Start with the reducer tests.');
  await overlay.locator('[data-todo-id="map:task"]').click({ button: 'right', position: { x: 60, y: 10 } });
  await page.getByRole('menuitem', { name: 'Add context…', exact: true }).click();
  const mapped = overlay.getByRole('textbox', { name: 'Context for Check billing flows', exact: true });
  await mapped.fill('Only staging so far.'); await overlay.getByRole('group', { name: 'Context for Check billing flows', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'task')?.todoContext).toBe('Only staging so far.');
  await expect(page.locator('[data-item-id="task"]')).not.toContainText('Only staging');

  // Clearing asks once, in place.
  await overlay.locator('[data-todo-id="handover"]').click({ button: 'right', position: { x: 60, y: 10 } });
  await expect(page.getByRole('menuitem', { name: 'Add context…', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Clear context', exact: true }).click();
  const confirm = overlay.getByRole('group', { name: 'Context for Hand over billing', exact: true });
  await expect(confirm).toContainText('Clear this context?');
  await confirm.getByRole('button', { name: 'Keep', exact: true }).click();
  expect(todoContext(await read(page), 'handover')?.text).toBe('Backfill done on staging.\nProduction is next.');
  await confirm.getByRole('button', { name: 'Clear', exact: true }).click();
  await confirm.getByRole('button', { name: 'Clear context', exact: true }).click();
  await expect(overlay.locator('[data-todo-id="handover"] .todo-context-glyph')).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  await expect.poll(async () => todoContext(await read(page), 'handover')).toBeUndefined();
  expect((await read(page)).todos.find(todo => todo.id === 'handover')).toEqual({ id: 'handover', title: 'Hand over billing', completed: false, nodeIds: [], horizon: 'next', todoOrder: expect.any(Number), touchedAt: expect.any(String) });
});
