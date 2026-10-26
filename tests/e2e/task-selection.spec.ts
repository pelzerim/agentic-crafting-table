import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async payload => { const commands = JSON.parse(payload) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands }); }, JSON.stringify(commands));
}
const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
async function center(page: Page, id: string) { const box = await card(page, id).boundingBox(); expect(box).toBeTruthy(); return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }; }

test('Linear keeps its identity as a local task, with reorderable rows, and ticks in the list only', async ({ visual: { page } }) => {
  await card(page, 'ticket').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Turn into todo', exact: true }).click();
  await apply(page, [
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check rollout', data: {}, projectId: 'billing', position: { x: 600, y: 700 } },
    { type: 'project.create', id: 'next', title: 'Next project', position: { x: 1800, y: 0 }, summary: '' },
    { type: 'todo.save', todo: { id: 'check', title: 'Another task', completed: false, nodeIds: ['next'] } },
  ]);
  await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  const list = page.getByRole('form', { name: 'To-dos', exact: true }), rows = () => list.getByRole('region', { name: 'Next', exact: true }).locator('[data-todo-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-todo-id')));
  const row = list.locator('[data-todo-id="map:ticket"]');
  await expect(row).toContainText('Plan changes'); await expect(row.locator('.todo-ticket')).toHaveText('BIL-128');
  expect((await read(page)).resources.find(r => r.id === 'ticket-resource')?.pluginId ?? (await read(page)).resources.find(r => r.pluginId === 'linear.ticket')?.pluginId).toBe('linear.ticket');
  await expect.poll(rows).toEqual(['check', 'map:ticket', 'map:task']);
  await list.getByRole('button', { name: 'Reorder Check rollout', exact: true }).dragTo(row);
  await expect.poll(rows).toEqual(['check', 'map:task', 'map:ticket']);
  await expect(page).toHaveScreenshot('ordered-linear-tasks.png');
  await page.reload(); await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  await expect.poll(rows).toEqual(['check', 'map:task', 'map:ticket']);
  await list.getByRole('button', { name: 'Reorder Check rollout', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await expect.poll(rows).toEqual(['check', 'map:ticket', 'map:task']);
  // Ticking the ticket in the list is the list's own: it folds into Done and Linear's item is not marked done.
  await row.getByRole('checkbox').click();
  await expect.poll(async () => Boolean((await read(page)).nodes.find(n => n.id === 'ticket')?.todoDoneAt)).toBe(true);
  expect((await read(page)).nodes.find(n => n.id === 'ticket')?.completedAt).toBeUndefined();
  await list.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
  await expect(list.locator('[data-todo-id="map:ticket"] input')).toBeChecked();
  await list.getByRole('button', { name: /Show BIL-128.*on map/ }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  // A right click with the kept to-do sheet open only closes the sheet; the next one opens the item's menu.
  await card(page, 'ticket').click({ button: 'right' }); await expect(page.getByRole('button', { name: /^Keep to-dos open/ })).toBeVisible();
  await card(page, 'ticket').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from to-dos', exact: true }).click();
  await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  await expect(row).toHaveCount(0); expect((await read(page)).nodes.some(n => n.id === 'ticket')).toBe(true);
});

test('Shift selection moves a group atomically, preserves membership and offers shared actions', async ({ visual: { page } }) => {
  const before = await read(page);
  for (const id of ['agent', 'pr']) { const point = await center(page, id); await page.keyboard.down('Shift'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Shift'); }
  await expect(page.locator('.map-selection rect[data-selected-id]')).toHaveCount(2);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await expect(page).toHaveScreenshot('map-multiple-selection.png');
  const from = await center(page, 'agent'); await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 95, from.y + 70, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await read(page)).revision).toBe(before.revision + 1);
  const after = await read(page), a0 = before.nodes.find(n => n.id === 'agent')!, a1 = after.nodes.find(n => n.id === 'agent')!, p0 = before.nodes.find(n => n.id === 'pr')!, p1 = after.nodes.find(n => n.id === 'pr')!;
  expect(a1.position.x - a0.position.x).toBeCloseTo(p1.position.x - p0.position.x, 5); expect(a1.position.y - a0.position.y).toBeCloseTo(p1.position.y - p0.position.y, 5);
  expect(a1.projectId).toBe(a0.projectId); expect(p1.projectId).toBe(p0.projectId); expect(after.links).toEqual(before.links);
  await card(page, 'pr').click({ button: 'right' });
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Move to project', 'Mark done', 'Send selection to Undermap']);
  await page.getByRole('menuitem', { name: 'Mark done', exact: true }).click();
  await expect.poll(async () => (await read(page)).nodes.filter(n => ['agent', 'pr'].includes(n.id) && n.completedAt).length).toBe(2);
  await page.keyboard.press('Escape'); await expect(page.locator('.map-selection rect[data-selected-id]')).toHaveCount(0);
});

test('Shift-drag marquee selects only intersecting items and ordinary background click clears it', async ({ visual: { page } }) => {
  const box = await card(page, 'pr').boundingBox();
  await page.keyboard.down('Shift'); await page.mouse.move(box!.x - 12, box!.y - 12); await page.mouse.down(); await page.mouse.move(box!.x + box!.width + 12, box!.y + box!.height + 12, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(page.locator('.map-selection [data-selected-id="pr"]')).toHaveCount(1);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  // A new Shift-drag starts a new selection instead of adding to the previous one.
  const agent = (await card(page, 'agent').boundingBox())!;
  await page.keyboard.down('Shift'); await page.mouse.move(agent.x - 12, agent.y - 12); await page.mouse.down(); await page.mouse.move(agent.x + agent.width + 12, agent.y + agent.height + 12, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(page.locator('.map-selection [data-selected-id="agent"]')).toHaveCount(1);
  await expect(page.locator('.map-selection [data-selected-id="pr"]')).toHaveCount(0);
  await page.mouse.click(1200, 520); await expect(page.locator('.map-selection rect[data-selected-id]')).toHaveCount(0);
});

test('to-do drag previews rows without saving until drop, and cancels cleanly', async ({ visual: { page } }) => {
  await apply(page, [
    { type: 'todo.save', todo: { id: 'first', title: 'First task', completed: false, nodeIds: ['billing'] } },
    { type: 'todo.save', todo: { id: 'second', title: 'Second task', completed: false, nodeIds: ['billing'] } },
    { type: 'project.create', id: 'next', title: 'Next project', position: { x: 1800, y: 0 }, summary: '' },
    { type: 'todo.save', todo: { id: 'third', title: 'Third task', completed: false, nodeIds: ['next'] } },
  ]);
  await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  const list = page.getByRole('form', { name: 'To-dos', exact: true });
  const rows = () => list.locator('[data-todo-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-todo-id')));
  const before = await read(page);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  // The browser sends dragend to the element the drag began on, wherever the row is drawn by then.
  const grip = (await list.getByRole('button', { name: 'Reorder Second task', exact: true }).elementHandle())!;
  const first = list.locator('[data-todo-id="first"]');
  const box = (await first.boundingBox())!;
  await grip.dispatchEvent('dragstart', { dataTransfer: transfer });
  await first.dispatchEvent('dragover', { dataTransfer: transfer, clientY: box.y + box.height / 2 });
  await expect.poll(rows).toEqual(['second', 'first', 'third']);
  expect((await read(page)).revision).toBe(before.revision);
  // Repeated events at the same coordinates must not oscillate after DOM movement.
  await list.locator('[data-todo-id="second"]').dispatchEvent('dragover', { dataTransfer: transfer, clientY: box.y + box.height / 2 });
  await expect.poll(rows).toEqual(['second', 'first', 'third']);
  await grip.dispatchEvent('dragend', { dataTransfer: transfer });
  await expect.poll(rows).toEqual(['first', 'second', 'third']);
  expect((await read(page)).revision).toBe(before.revision);
  await grip.dispatchEvent('dragstart', { dataTransfer: transfer });
  const third = list.locator('[data-todo-id="third"]');
  await third.dispatchEvent('dragover', { dataTransfer: transfer, clientY: (await third.boundingBox())!.y });
  await expect.poll(rows).toEqual(['first', 'second', 'third']);
  await first.dispatchEvent('dragover', { dataTransfer: transfer, clientY: box.y + box.height / 2 });
  await list.locator('[data-todo-id="second"]').dispatchEvent('drop', { dataTransfer: transfer });
  await expect.poll(async () => (await read(page)).todos.find(t => t.id === 'second')?.todoOrder).toBe(0);
  await page.reload();
  await expect.poll(rows).toEqual(['second', 'first', 'third']);
});

test('dragging list tasks onto the map creates once and subsequently moves the same item', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'todo.save', todo: { id: 'map-drop', title: 'Drag onto table', completed: false, nodeIds: [] } }]);
  await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  const list = page.getByRole('form', { name: 'To-dos', exact: true });
  const grip = list.getByRole('button', { name: 'Reorder Drag onto table', exact: true });
  const map = page.locator('.map-area');
  await grip.dragTo(map, { targetPosition: { x: 1100, y: 500 } });
  await expect.poll(async () => (await read(page)).nodes.filter(n => n.title === 'Drag onto table').length).toBe(1);
  let state = await read(page);
  const node = state.nodes.find(n => n.title === 'Drag onto table')!;
  expect(state.todos.some(t => t.id === 'map-drop')).toBe(false);
  await expect(list.locator(`[data-todo-id="map:${node.id}"]`)).toHaveCount(1);
  await grip.dragTo(map, { targetPosition: { x: 1150, y: 700 } });
  await expect.poll(async () => (await read(page)).nodes.find(n => n.id === node.id)?.position).not.toEqual(node.position);
  state = await read(page);
  expect(state.nodes.filter(n => n.title === 'Drag onto table')).toHaveLength(1);
  expect(state.nodes.find(n => n.id === node.id)?.resourceId).toBe(node.resourceId);
  await page.reload();
  await expect(list.locator(`[data-todo-id="map:${node.id}"]`)).toHaveCount(1);
});

/** Map coordinates under a screen point, from the flow viewport transform. */
const toWorld = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform), area = document.querySelector('.react-flow')!.getBoundingClientRect();
  return { x: (x - area.left - matrix.e) / matrix.a, y: (y - area.top - matrix.f) / matrix.a };
}, point);
const near = (a: { x: number; y: number }, b: { x: number; y: number }, within = 40) => Math.hypot(a.x - b.x, a.y - b.y) <= within;
async function dragRow(page: Page, title: string, to: { x: number; y: number }, during?: () => Promise<void>) {
  const grip = page.getByRole('form', { name: 'To-dos', exact: true }).getByRole('button', { name: `Reorder ${title}`, exact: true }), box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await during?.();
  await page.mouse.up();
}

test('a list task dragged onto the map shows a ghost and becomes a map task at the drop point', async ({ visual: { page } }, testInfo) => {
  await apply(page, [{ type: 'todo.save', todo: { id: 'ghosted', title: 'Place me here', completed: false, nodeIds: [] } }]);
  await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  const drop = { x: 1150, y: 420 };
  await dragRow(page, 'Place me here', drop, async () => {
    await expect(page.locator('.todo-drop-ghost')).toContainText('Place me here');
    await expect(page.locator('.attachment-preview')).toHaveText('Place on the map');
    await page.screenshot({ path: testInfo.outputPath('todo-drop-ghost.png') });
  });
  await expect.poll(async () => (await read(page)).nodes.filter(n => n.title === 'Place me here').length).toBe(1);
  const state = await read(page), node = state.nodes.find(n => n.title === 'Place me here')!;
  expect(near(node.position, await toWorld(page, drop))).toBe(true);
  expect(node.projectId).toBeUndefined(); expect(state.todos.some(t => t.id === 'ghosted')).toBe(false);
  await expect(page.locator('.todo-drop-ghost')).toHaveCount(0);
});

test('dragging a map task row moves that item where it is dropped, keeping or transferring its project as a map drag would', async ({ visual: { page } }, testInfo) => {
  await apply(page, [{ type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Move me', data: {}, projectId: 'billing', position: { x: 600, y: 700 } }]);
  const side = await toWorld(page, { x: 1170, y: 250 });
  await apply(page, [
    { type: 'project.create', id: 'side', title: 'Side project', position: { x: side.x, y: side.y - 160 }, summary: '' },
    { type: 'item.add', id: 'anchor', resourceId: 'anchor-r', pluginId: 'workspace.todo', title: 'Side anchor', data: {}, projectId: 'side', position: side },
  ]);
  await page.getByRole('button', { name: 'Keep to-dos open' }).click();
  const list = page.getByRole('form', { name: 'To-dos', exact: true }), resourceId = (await read(page)).nodes.find(n => n.id === 'task')!.resourceId;
  const inside = { x: 470, y: 520 };
  await dragRow(page, 'Move me', inside, async () => {
    // The item itself follows the pointer, placed as a map drag places it.
    await expect(page.locator('[data-item-id="task"]')).toHaveAttribute('data-dragging', 'true');
    const box = (await card(page, 'task').boundingBox())!;
    expect(near({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, inside, 60)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('todo-drag-move.png') });
  });
  await expect.poll(async () => near((await read(page)).nodes.find(n => n.id === 'task')!.position, await toWorld(page, inside))).toBe(true);
  expect((await read(page)).nodes.find(n => n.id === 'task')?.projectId).toBe('billing');
  // Empty space keeps the project, as dragging the item there on the map would.
  const outside = { x: 210, y: 690 };
  await dragRow(page, 'Move me', outside);
  await expect.poll(async () => near((await read(page)).nodes.find(n => n.id === 'task')!.position, await toWorld(page, outside))).toBe(true);
  expect((await read(page)).nodes.find(n => n.id === 'task')?.projectId).toBe('billing');
  // Inside another project's neighbourhood it transfers.
  const into = { x: 1170, y: 400 };
  await dragRow(page, 'Move me', into, async () => { await expect(page.locator('.attachment-preview')).toHaveText('Move to Side project'); });
  await expect.poll(async () => (await read(page)).nodes.find(n => n.id === 'task')?.projectId).toBe('side');
  const state = await read(page);
  expect(state.nodes.filter(n => n.title === 'Move me')).toHaveLength(1);
  expect(state.nodes.find(n => n.id === 'task')?.resourceId).toBe(resourceId);
  await expect(list.locator('[data-todo-id="map:task"]')).toHaveCount(1);
  await expect(page.locator('[data-item-id="task"]')).toHaveAttribute('data-dragging', 'false');
});

test('a drop for an item that went to Undermap is refused with the Undermap message and changes nothing', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'item.add', id: 'sunk', resourceId: 'sunk-r', pluginId: 'workspace.todo', title: 'Sunk task', data: {}, projectId: 'billing', position: { x: 600, y: 700 } }, { type: 'node.below', id: 'sunk' }]);
  const before = await read(page);
  // A stale row: the item went to Undermap while its row was being dragged.
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.setData('application/x-crafting-todo-map', 'map:sunk');
    const area = document.querySelector('.map-area')!, rect = area.getBoundingClientRect();
    area.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.x + 900, clientY: rect.y + 400 }));
  });
  await expect(page.getByText('This item is in Undermap. Bring it back to show it here.')).toBeVisible();
  const after = await read(page);
  expect(after.revision).toBe(before.revision);
  expect(after.nodes.find(n => n.id === 'sunk')).toEqual(before.nodes.find(n => n.id === 'sunk'));
});
