import { expect } from '@playwright/test';
import { choose } from './combobox.ts';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async payload => {
    const commands = JSON.parse(payload) as WorkspaceCommand[];
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands });
  }, JSON.stringify(commands));
}
async function setup(page: Page) {
  await apply(page, [
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check billing flows', data: {}, projectId: 'billing', position: { x: 650, y: 600 } },
    { type: 'todo.save', todo: { id: 'check', title: 'Review implementation', completed: false, nodeIds: [] } },
  ]);
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  await expect(page.getByRole('form', { name: 'To-dos', exact: true })).toHaveAttribute('data-open', 'true');
}

test('to-dos have only task text, empty or checked icons, and readable editable done rows', async ({ visual: { page } }) => {
  await page.mouse.dblclick(100, 650);
  const form = page.getByRole('form', { name: 'New item', exact: true });
  await form.getByRole('button', { name: 'To-do', exact: true }).click();
  await expect(form.getByLabel('Notes', { exact: true })).toHaveCount(0);
  await expect(form.locator('textarea')).toHaveCount(0);
  await form.getByLabel('Title', { exact: true }).fill('Prepare release');
  await form.getByRole('button', { name: 'Add to-do', exact: true }).click();
  const task = page.getByRole('article', { name: 'Prepare release', exact: true });
  await expect(task).toBeVisible();
  const created = await read(page), node = created.nodes.find(node => node.title === 'Prepare release')!;
  expect(created.resources.find(resource => resource.id === node.resourceId)?.data).toEqual({});
  await expect(task.locator('.item-glyph')).toHaveAttribute('data-icon', 'square');
  // A historical payload must remain readable by the app without reviving Notes.
  await apply(page, [
    { type: 'item.update', id: node.id, data: { notes: 'Keep historical data' } },
    { type: 'link.save', link: { id: 'task-agent', sourceId: node.id, targetId: 'agent', kind: 'context', label: '' } },
    { type: 'todo.save', todo: { id: 'reference', title: 'Track release', completed: false, nodeIds: [node.id] } },
  ]);
  await task.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Item settings…' }).click();
  const settings = page.getByRole('form', { name: 'Item settings' });
  await expect(settings.getByLabel('Notes', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save changes' }).click();
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).click();
  const attachment = overlay.getByRole('button', { name: 'Show Prepare release on map', exact: true });
  await expect(attachment.locator('.item-icon')).toHaveAttribute('data-icon', 'square');
  const openSize = (await task.boundingBox())!;
  await overlay.getByRole('checkbox', { name: 'Complete Prepare release', exact: true }).check();
  await page.mouse.move(1180, 650);
  await expect(task).toHaveAttribute('data-completed', 'true');
  // Done to-dos keep their size and connections.
  const doneSize = (await task.boundingBox())!;
  expect([doneSize.width, doneSize.height]).toEqual([openSize.width, openSize.height]);
  await expect(task.getByRole('button', { name: 'Edit Prepare release', exact: true })).toBeVisible();
  await expect(task.locator('.item-glyph')).toHaveAttribute('data-icon', 'square-check');
  await expect(attachment.locator('.item-icon')).toHaveAttribute('data-icon', 'square-check');
  await expect(page.locator('.react-flow__edge[data-id="task-agent"]')).toBeVisible();
  await expect(task).toHaveScreenshot('todo-completed-text.png');
  await task.hover(); await expect(task).toHaveAttribute('data-preview', 'false');
  await task.getByRole('button', { name: 'Edit Prepare release', exact: true }).click();
  await task.getByRole('textbox', { name: 'Edit title' }).fill('Release prepared');
  await task.getByRole('textbox', { name: 'Edit title' }).press('Enter');
  await page.reload();
  const restored = page.getByRole('article', { name: 'Release prepared', exact: true });
  await expect(restored.getByRole('button', { name: 'Edit Release prepared', exact: true })).toBeVisible();
  await expect(restored).toHaveAttribute('data-completed', 'true');
  expect((await read(page)).resources.find(resource => resource.id === node.resourceId)?.data).toEqual({ notes: 'Keep historical data' });
  await restored.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Reopen', exact: true }).click();
  await expect(restored.locator('.item-glyph')).toHaveAttribute('data-icon', 'square');
  await expect(restored).toHaveAttribute('data-completed', 'false');
});

test('the to-do card checkbox toggles done both ways without selecting, opening or dragging the item', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check billing flows', data: {}, projectId: 'billing', position: { x: 650, y: 600 } }]);
  const task = page.getByRole('article', { name: 'Check billing flows', exact: true }), map = page.locator('.map-area');
  const box = task.getByRole('checkbox', { name: 'Mark done', exact: true });
  await expect(box).toHaveAttribute('aria-checked', 'false');
  await expect(box).toHaveClass(/nodrag/);
  const target = (await box.boundingBox())!;
  const zoom = Number(await map.getAttribute('data-zoom'));
  expect(Math.min(target.width, target.height) / zoom).toBeGreaterThanOrEqual(24);
  const position = async () => (await read(page)).nodes.find(node => node.id === 'task')!.position;
  const before = await position();
  await box.click();
  await expect(task).toHaveAttribute('data-completed', 'true');
  await expect.poll(async () => Boolean((await read(page)).nodes.find(node => node.id === 'task')?.completedAt)).toBe(true);
  const undo = task.getByRole('checkbox', { name: 'Mark not done', exact: true });
  await expect(undo).toHaveAttribute('aria-checked', 'true');
  await expect(task.locator('.item-glyph')).toHaveAttribute('data-icon', 'square-check');
  await expect(task).not.toHaveAttribute('data-selected', 'true');
  await expect(map).toHaveAttribute('data-focus', '');
  await expect(task.getByRole('textbox', { name: 'Edit title' })).toHaveCount(0);
  expect(await position()).toEqual(before);
  // A press that wanders off the box must not drag the card.
  const at = (await undo.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2); await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 40, { steps: 5 }); await page.mouse.up();
  expect(await position()).toEqual(before);
  await undo.click();
  await expect(task).toHaveAttribute('data-completed', 'false');
  await expect.poll(async () => Boolean((await read(page)).nodes.find(node => node.id === 'task')?.completedAt)).toBe(false);
  await box.focus(); await page.keyboard.press('Space');
  await expect(task).toHaveAttribute('data-completed', 'true');
  await expect(undo).toBeFocused();
  await page.keyboard.press('Space');
  await expect(task).toHaveAttribute('data-completed', 'false');
  await expect(map).toHaveAttribute('data-focus', '');
  await expect(task).not.toHaveAttribute('data-selected', 'true');
});

test('to-do overlay drags map attachments, shares completion/grouping, and keeps drafts through collapse and reload', async ({ visual: { page } }) => {
  await setup(page);
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true }), row = overlay.locator('[data-todo-id="check"]');
  const before = await read(page), source = page.getByRole('article', { name: 'Claude · implementation', exact: true });
  const box = (await source.boundingBox())!, destination = (await row.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 35); await page.mouse.down();
  await page.mouse.move(destination.x + 100, destination.y + 16, { steps: 18 });
  await expect(row).toHaveAttribute('data-drop-target', 'true');
  await expect(overlay).toHaveAttribute('data-open', 'true'); await page.mouse.up();
  await expect.poll(async () => (await read(page)).todos[0].nodeIds).toEqual(['agent']);
  expect((await read(page)).nodes).toEqual(before.nodes);
  // The attachment puts the checklist row in its project, shown as the project chip on the row.
  await expect(overlay.locator('[data-todo-id="check"] .todo-project')).toHaveText('Billing redesign');
  await overlay.getByRole('checkbox', { name: 'Complete Check billing flows' }).click();
  await expect(page.getByRole('article', { name: 'Check billing flows', exact: true })).toHaveAttribute('data-completed', 'true');
  expect((await read(page)).todos.length).toBe(1);
  // Keep the pointer inside: the production overlay intentionally collapses
  // 240 ms after leaving, including during a slow screenshot comparison.
  const links = overlay.getByRole('button', { name: 'Show Claude · implementation on map' });
  await expect(links.locator('.brand-claude')).toHaveCount(1);
  await links.hover(); await expect(links).toHaveAttribute('title', 'Claude · implementation · Billing redesign');
  await expect(overlay.getByRole('tooltip')).toHaveCount(0);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await expect(page).toHaveScreenshot('todo-overlay.png');
  // The ticked map to-do folded into Done; its project leaves with the map membership.
  await overlay.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
  await expect(overlay.locator('[data-todo-id="map:task"] .todo-project')).toHaveText('Billing redesign');
  await apply(page, [{ type: 'node.attach', id: 'task', projectId: null }]);
  await expect(overlay.locator('[data-todo-id="map:task"]')).toBeVisible(); await expect(overlay.locator('[data-todo-id="map:task"] .todo-project')).toHaveCount(0);
  await apply(page, [{ type: 'node.archive', id: 'task' }]); await expect(overlay.locator('[data-todo-id="map:task"]')).toHaveCount(0);
  await apply(page, [{ type: 'node.restore', id: 'task' }]); await expect(overlay.locator('[data-todo-id="map:task"]')).toBeVisible();
  // The to-do tool is pinned to its rail slot; it no longer moves.
  await expect(overlay.getByRole('button', { name: 'Move to-dos' })).toHaveCount(0);
  const pinned = (await overlay.boundingBox())!; expect([pinned.x, pinned.y]).toEqual([16, 164]);
  const input = overlay.getByRole('textbox', { name: 'New to-do' }); await input.pressSequentially('Keep this draft');
  await page.mouse.move(1180, 710); await page.waitForTimeout(350);
  await expect(overlay).toHaveAttribute('data-open', 'true'); // Active keyboard editing cannot auto-collapse.
  await page.mouse.click(1180, 710); await expect(overlay).toHaveAttribute('data-open', 'false');
  expect((await overlay.boundingBox())!.width).toBe(44);
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.viewRead()).todoOverlay?.draft)).toBe('Keep this draft');
  await page.reload(); await expect(overlay).toHaveAttribute('data-open', 'false');
  expect((await overlay.boundingBox())!.x).toBeCloseTo(pinned.x, 0); // Still in its slot after reload.
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).focus(); await page.keyboard.press('Enter');
  await expect(input).toHaveValue('Keep this draft');
  await overlay.getByRole('button', { name: 'Add to-do', exact: true }).click();
  await expect.poll(async () => (await read(page)).todos.some(todo => todo.title === 'Keep this draft')).toBe(true);
  await overlay.getByRole('button', { name: 'Close to-do list', exact: true }).click(); await expect(overlay).toHaveAttribute('data-open', 'false');
});

test('keyboard attachment uses map links and supports removing an attachment without deleting either item', async ({ visual: { page } }) => {
  await setup(page); await page.mouse.click(1180, 710);
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  await expect(overlay).toHaveAttribute('data-open', 'false');
  await page.keyboard.press('t');
  await expect(overlay).toHaveAttribute('data-open', 'true');
  await overlay.getByRole('button', { name: 'Attach map item to to-do' }).focus(); await page.keyboard.press('Enter');
  await expect(overlay.getByRole('combobox', { name: 'Item to attach' })).toBeFocused();
  await expect(overlay.locator('.rail-panel-sheet')).toHaveScreenshot('todo-attach-picker.png');
  await choose(overlay, 'Item to attach', 'agent');
  await expect(overlay.locator('.todo-attach-target').first()).toBeFocused();
  await overlay.getByRole('button', { name: 'Attach to Check billing flows', exact: true }).click();
  await expect.poll(async () => (await read(page)).links.some(link => link.sourceId === 'agent' && link.targetId === 'task')).toBe(true);
  await overlay.getByRole('button', { name: 'Detach Claude · implementation', exact: true }).click();
  await expect.poll(async () => (await read(page)).links.some(link => link.sourceId === 'agent' && link.targetId === 'task')).toBe(false);
  expect((await read(page)).nodes.some(node => node.id === 'agent')).toBe(true);
});

test('long to-do lists retain scroll from their pinned rail slot', async ({ visual: { page } }) => {
  await apply(page, Array.from({ length: 28 }, (_, index) => ({ type: 'todo.save' as const, todo: { id: `row-${index}`, title: `Follow up ${index}`, completed: false, nodeIds: [] } })));
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).focus(); await page.keyboard.press('Enter');
  expect((await overlay.boundingBox())!.x).toBe(16);
  const list = overlay.locator('.todo-list'); await list.hover(); await page.mouse.wheel(0, 500);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  const top = await list.evaluate(element => element.scrollTop);
  await overlay.getByRole('button', { name: 'Close to-do list', exact: true }).click(); await expect(overlay).toHaveAttribute('data-open', 'false');
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover(); await expect(overlay).toHaveAttribute('data-open', 'true');
  expect(await list.evaluate(element => element.scrollTop)).toBe(top);
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.viewRead()).todoOverlay?.scrollTop)).toBe(top);
  await page.reload(); await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover(); await expect(overlay).toHaveAttribute('data-open', 'true');
  expect(await list.evaluate(element => element.scrollTop)).toBe(top);
  const row = overlay.locator('[data-todo-id="row-20"]');
  await row.getByRole('checkbox').click();
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'row-20')?.completed).toBe(true);
});


test('to-do titles edit in place, preserve state, cancel or retain invalid drafts and survive reload', async ({ visual: { page } }) => {
  await setup(page);
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  const before = await read(page), node = before.nodes.find(node => node.id === 'task')!;
  const task = page.locator('[data-item-id="task"]');
  await task.getByRole('button', { name: 'Edit Check billing flows', exact: true }).click();
  const mapInput = task.getByRole('textbox', { name: 'Edit title', exact: true });
  await expect(mapInput).toBeFocused(); await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await mapInput.fill('Verify billing changes');
  await expect(task.locator('.connect-handle')).toBeHidden();
  await expect(task).toHaveScreenshot('todo-map-edit.png');
  await mapInput.press('Enter');
  await expect(task).toHaveAttribute('aria-label', 'Verify billing changes');
  // An edit is a touch: the to-do's age starts over (TODO-12).
  expect((await read(page)).nodes.find(item => item.id === 'task')).toEqual({ ...node, title: 'Verify billing changes', todoTouchedAt: expect.any(String) });
  expect((await read(page)).links).toEqual(before.links);
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  const row = overlay.locator('[data-todo-id="map:task"]');
  await row.getByRole('button', { name: 'Edit Verify billing changes', exact: true }).click();
  const editor = row.getByRole('textbox', { name: 'Edit title', exact: true });
  await editor.fill(''); await editor.press('Enter'); await expect(row.getByRole('alert')).toContainText('1–500');
  await page.mouse.move(1180, 710); await page.waitForTimeout(350);
  await expect(overlay).toHaveAttribute('data-open', 'true'); await expect(editor).toHaveValue('');
  await expect(overlay.locator('.rail-panel-sheet')).toHaveScreenshot('todo-inline-edit.png');
  await editor.fill('Cancelled draft'); await editor.press('Escape');
  await expect(overlay).toHaveAttribute('data-open', 'true'); await expect(row).toContainText('Verify billing changes');
  await row.getByRole('button', { name: 'Edit Verify billing changes', exact: true }).focus(); await page.keyboard.press('Enter');
  await editor.fill('Saved on blur'); await overlay.getByRole('textbox', { name: 'New to-do' }).click();
  await expect(task).toHaveAttribute('aria-label', 'Saved on blur');
  const checklist = overlay.locator('[data-todo-id="check"]');
  // A ticked row folds into Done; its title stays editable there.
  await checklist.getByRole('checkbox').click();
  await overlay.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
  await checklist.getByRole('button', { name: 'Edit Review implementation', exact: true }).click();
  await checklist.getByRole('textbox', { name: 'Edit title' }).fill('Review tests'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).todos[0].title).toBe('Review tests');
  expect((await read(page)).todos[0]).toEqual({ ...before.todos[0], title: 'Review tests', completed: true, doneAt: expect.any(String), touchedAt: expect.any(String) });
  // A drag begun on the title moves the item without entering its editor.
  const title = task.getByRole('button', { name: 'Edit Saved on blur', exact: true }), bounds = (await title.boundingBox())!;
  await page.mouse.move(bounds.x + 10, bounds.y + 6); await page.mouse.down(); await page.mouse.move(bounds.x + 80, bounds.y + 66, { steps: 10 }); await page.mouse.up();
  await expect(mapInput).toHaveCount(0); await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await expect.poll(async () => (await read(page)).nodes.find(item => item.id === 'task')!.position).not.toEqual(node.position);
  await page.reload(); await expect(task).toHaveAttribute('aria-label', 'Saved on blur');
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  await overlay.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
  await expect(overlay.locator('[data-todo-id="check"]')).toContainText('Review tests');
});

test('external title changes retain the inline draft and require resolving the conflict', async ({ visual: { page } }) => {
  await setup(page);
  const task = page.locator('[data-item-id="task"]');
  await task.getByRole('button', { name: 'Edit Check billing flows', exact: true }).click();
  const input = task.getByRole('textbox', { name: 'Edit title' }); await input.fill('Local draft');
  await apply(page, [{ type: 'node.update', id: 'task', title: 'Changed by an agent' }]);
  await expect(task).toHaveAttribute('aria-label', 'Changed by an agent');
  await input.press('Enter'); await expect(input).toHaveValue('Local draft'); await expect(task.getByRole('alert')).toContainText('changed elsewhere');
  expect((await read(page)).nodes.find(node => node.id === 'task')!.title).toBe('Changed by an agent');
  await input.press('Escape'); await expect(task.getByRole('button', { name: 'Edit Changed by an agent' })).toBeVisible();
});

test('agent, PR and shell attachment marks match their map identities', async ({ visual: { page } }) => {
  await apply(page, [
    { type: 'item.add', id: 'shell', resourceId: 'shell-r', pluginId: 'terminal.session', title: 'Shell', data: { cwd: '/tmp', sessionId: 'fixture-shell', workspaceId: 'fixture', shell: '/bin/sh' }, projectId: 'billing', position: { x: 850, y: 620 } },
    { type: 'todo.save', todo: { id: 'linked', title: 'Check related work', completed: false, nodeIds: ['agent', 'pr', 'shell'] } },
  ]);
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  const attachments = page.getByRole('button', { name: 'Links for Check related work' }).locator('svg');
  for (const [index, id] of ['agent', 'pr', 'shell'].entries()) {
    const mapIcon = page.locator(`[data-item-id="${id}"] .item-glyph`);
    expect(await attachments.nth(index).innerHTML()).toBe(await mapIcon.innerHTML());
    expect(await attachments.nth(index).evaluate(el => getComputedStyle(el).color)).toBe(await mapIcon.evaluate(el => getComputedStyle(el).color));
  }
  await expect(page.getByRole('form', { name: 'To-dos' }).locator('.rail-panel-sheet')).toHaveScreenshot('todo-provider-attachments.png');
});

test('one to-do link reveals the map directly while multiple links widen a separate reference area', async ({ visual: { page, app } }) => {
  await apply(page, [
    { type: 'item.add', id: 'web', resourceId: 'web-r', pluginId: 'web.link', title: 'Release guide', data: { url: 'https://example.test/release' }, position: { x: 900, y: 600 } },
    { type: 'todo.save', todo: { id: 'single', title: 'Read the release guide', completed: false, nodeIds: ['web'] } },
    { type: 'todo.save', todo: { id: 'multiple', title: 'Check related work', completed: false, nodeIds: ['agent', 'pr', 'brief'] } },
  ]);
  await app.evaluate(({ shell }) => { (globalThis as any).openedBrowser = false; shell.openExternal = async () => { (globalThis as any).openedBrowser = true; }; });
  const before = await read(page), overlay = page.getByRole('form', { name: 'To-dos' });
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  await overlay.getByRole('button', { name: 'Show Release guide on map', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1');
  expect(await app.evaluate(() => (globalThis as any).openedBrowser)).toBe(false);
  await expect(overlay).toHaveAttribute('data-references', 'false');
  const map = (await page.locator('.map-area').boundingBox())!, web = (await page.locator('[data-item-id="web"]').boundingBox())!;
  expect(web.x + web.width / 2).toBeCloseTo(map.x + map.width / 2, 0);
  const row = overlay.locator('[data-todo-id="multiple"]'), initial = (await row.boundingBox())!;
  const sheet = overlay.locator('.rail-panel-sheet'), width = (await sheet.boundingBox())!.width;
  await row.getByRole('button', { name: 'Links for Check related work' }).click();
  const references = overlay.getByRole('region', { name: 'Linked items for Check related work' });
  await expect(references).toBeVisible();
  expect((await sheet.boundingBox())!.width).toBe(width + 260);
  expect((await row.boundingBox())!.height).toBe(initial.height);
  await expect(row.locator('.todo-reference-list')).toHaveCount(0);
  expect((await references.boundingBox())!.x).toBeGreaterThanOrEqual((await row.boundingBox())!.x + (await row.boundingBox())!.width);
  await expect(sheet).toHaveScreenshot('todo-linked-items.png');
  await references.getByRole('button', { name: 'Plan switcher · Billing redesign', exact: true }).click();
  await expect(overlay).toHaveAttribute('data-references', 'false');
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  expect((await sheet.boundingBox())!.width).toBe(width);
  expect(await read(page)).toEqual(before);
  await overlay.getByRole('button', { name: 'Detach Release guide', exact: true }).click();
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'single')?.nodeIds).toEqual([]);
  expect((await read(page)).nodes.some(node => node.id === 'web')).toBe(true);
});

test('checklist to-dos archive and restore before deletion is available', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'todo.save', todo: { id: 'archive-task', title: 'Check the rollout', completed: false, nodeIds: ['agent'] } }]);
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  const openTodo = async () => {
    await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
    await expect(overlay).toHaveAttribute('data-open', 'true');
  };
  const openArchive = async () => {
    await expect(page.locator('[data-item-id="agent"]')).toBeVisible();
    await page.mouse.click(100, 650, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Open archive', exact: true }).click();
  };
  await openTodo();
  await expect(overlay.getByRole('heading', { name: 'To-do', exact: true })).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'To-do', exact: true })).toHaveCount(0);
  const row = overlay.locator('[data-todo-id="archive-task"]'), cluster = row.locator('.todo-row-actions');
  await row.hover();
  await expect(cluster.getByRole('button')).toHaveCount(2);
  await expect(cluster.getByRole('button', { name: 'Archive Check the rollout', exact: true })).toHaveAttribute('title', 'Archive to-do');
  await expect(cluster.getByRole('button', { name: 'Archive Check the rollout', exact: true })).toHaveText('');
  await expect(cluster.getByRole('button', { name: 'Detach Claude · implementation', exact: true })).toHaveAttribute('title', 'Detach item');
  await expect(row).toHaveScreenshot('todo-row-actions.png');
  await expect(overlay.getByRole('button', { name: /^Remove |^Delete / })).toHaveCount(0);
  await overlay.getByRole('button', { name: 'Archive Check the rollout', exact: true }).click();
  await expect(overlay.getByRole('button', { name: 'Archive Check the rollout', exact: true })).toHaveCount(0);
  const archived = (await read(page)).todos.find(todo => todo.id === 'archive-task')!;
  expect(archived.archivedAt).toBeTruthy(); expect(archived.nodeIds).toEqual(['agent']);
  await page.reload(); await openArchive();
  const archive = page.getByRole('form', { name: 'Archive', exact: true }), todoTab = archive.getByRole('button', { name: 'Archived to-dos', exact: true });
  // Archive is one home with a tab per kind; each tab counts its entries.
  await expect(archive.getByRole('button', { name: 'Archived items', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(todoTab).toContainText('1');
  await todoTab.click(); await expect(todoTab).toHaveAttribute('aria-pressed', 'true');
  await archive.getByRole('button', { name: 'Restore Check the rollout', exact: true }).click();
  expect((await read(page)).todos.find(todo => todo.id === 'archive-task')!.archivedAt).toBeUndefined();
  await archive.getByRole('button', { name: 'Close archive' }).click(); await openTodo();
  await overlay.getByRole('button', { name: 'Archive Check the rollout', exact: true }).click();
  await openArchive(); await todoTab.click(); await archive.getByRole('button', { name: 'More actions for Check the rollout', exact: true }).click();
  await archive.getByRole('menuitem', { name: 'Delete Check the rollout', exact: true }).click();
  const confirm = archive.getByRole('group', { name: 'Delete permanently', exact: true });
  await expect(confirm).toContainText('Delete Check the rollout permanently?');
  await expect(confirm.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
  expect((await read(page)).todos.some(todo => todo.id === 'archive-task')).toBe(true);
  await confirm.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect.poll(async () => (await read(page)).todos.some(todo => todo.id === 'archive-task')).toBe(false);
  expect((await read(page)).nodes.some(node => node.id === 'agent')).toBe(true);
});

test('to-do overlay resizes, remembers bounds, collapses to its icon and cancels an unfinished resize', async ({ visual: { page } }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click();
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true }), grip = overlay.getByRole('button', { name: 'Resize to-do list' }), sheet = overlay.locator('.rail-panel-sheet');
  const before = (await sheet.boundingBox())!, handle = (await grip.boundingBox())!;
  await page.mouse.move(handle.x + 8, handle.y + 8); await page.mouse.down(); await page.mouse.move(handle.x + 108, handle.y + 108, { steps: 5 }); await page.mouse.up();
  await expect(sheet).toHaveCSS('width', `${before.width + 100}px`); await expect(sheet).toHaveCSS('height', `${before.height + 100}px`);
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead())).todoOverlay?.width).toBe(before.width + 100);
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead())).todoOverlay?.height).toBe(before.height + 100);
  await page.reload(); await page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click();
  await expect(sheet).toHaveCSS('width', `${before.width + 100}px`); await expect(sheet).toHaveCSS('height', `${before.height + 100}px`);
  await overlay.getByRole('button', { name: 'Close to-do list', exact: true }).click(); await page.mouse.move(900, 600);
  await expect(sheet).toBeHidden();
  await overlay.getByRole('button', { name: 'Keep to-dos open', exact: true }).hover();
  await expect(sheet).toHaveCSS('width', `${before.width + 100}px`);
  const next = (await grip.boundingBox())!;
  await page.mouse.move(next.x + 8, next.y + 8); await page.mouse.down(); await page.mouse.move(next.x + 58, next.y + 58, { steps: 3 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(sheet).toHaveCSS('width', `${before.width + 100}px`);
  await grip.focus(); await page.keyboard.press('ArrowRight'); await expect(sheet).toHaveCSS('width', `${before.width + 110}px`);
  await expect(sheet).toHaveScreenshot('todo-resized.png');
  await page.keyboard.press('Home'); await expect(sheet).toHaveCSS('width', '330px');
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead())).todoOverlay?.width).toBeUndefined();
  await page.reload(); await expect(sheet).toHaveCSS('width', '330px');
});

test('a Linear ticket in the list shows Linear\'s own title with its identifier chip; a saved generated label is not shown', async ({ visual: { page } }) => {
  const original = 'BIL-128 · Make plan changes predictable';
  const state = await read(page), ticket = state.nodes.find(n => state.resources.some(r => r.id === n.resourceId && r.pluginId === 'linear.ticket'))!;
  await apply(page, [{ type: 'node.update', id: ticket.id, title: original }, { type: 'node.todo', id: ticket.id, enabled: true }, { type: 'node.todo.label', id: ticket.id, sourceTitle: original, title: 'Shorter generated label' }]);
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true }), row = overlay.locator(`[data-todo-id="map:${ticket.id}"]`);
  await expect(row.locator('.todo-row-title')).toHaveText('Make plan changes predictable'); await expect(row.locator('.todo-ticket')).toHaveText('BIL-128');
  await expect(page.locator(`[data-item-id="${ticket.id}"]`)).toHaveAttribute('aria-label', original);
  await page.reload(); await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  await expect(row.locator('.todo-row-title')).toHaveText('Make plan changes predictable');
  expect((await read(page)).nodes.find(node => node.id === ticket.id)?.todoLabel?.title).toBe('Shorter generated label');
});

test('an empty to-do list says how to add one; the add button lights up for a draft and the close button hides the list', async ({ visual: { page } }) => {
  const overlay = page.getByRole('form', { name: 'To-dos', exact: true });
  await page.keyboard.press('t'); await expect(overlay).toHaveAttribute('data-open', 'true');
  const empty = overlay.locator('.todo-empty');
  await expect(empty).toContainText('Nothing here yet'); await expect(empty).toContainText('Type below, or drag an item onto a to-do.');
  const add = overlay.getByRole('button', { name: 'Add to-do', exact: true });
  await expect(add).toBeDisabled();
  await expect(overlay.locator('.rail-panel-sheet')).toHaveScreenshot('todo-empty.png');
  await overlay.getByRole('textbox', { name: 'New to-do' }).fill('Ship billing copy');
  await expect(add).toBeEnabled(); await expect(add).toHaveCSS('background-color', await page.evaluate(() => {
    const probe = document.createElement('i'); probe.style.color = 'var(--act-accent)'; document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  }));
  await overlay.getByRole('button', { name: 'Close to-do list', exact: true }).click();
  await expect(overlay).toHaveAttribute('data-open', 'false');
});
