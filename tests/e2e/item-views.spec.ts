import { expect } from '@playwright/test';
import { test, capture, resize, openTerminal } from './visual-fixture.ts';
import { showAdvanced } from './settings-helpers.ts';

async function addItems(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'view-fixtures', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'workspace.note', title: 'Migration decision', data: { text: Array.from({ length: 40 }, (_, i) => `Decision ${i + 1}: preserve existing sessions.`).join('\n') }, projectId: 'billing', position: { x: 530, y: 650 } },
      { type: 'item.add', id: 'todo', resourceId: 'todo-resource', pluginId: 'workspace.todo', title: 'Check migration', data: {}, projectId: 'billing', position: { x: 950, y: 620 } },
      { type: 'link.save', link: { id: 'todo-agent', sourceId: 'todo', targetId: 'agent', kind: 'context', label: '' } },
    ] });
  });
}

test('per-type settings keep independent drafts and sizes across save, cancel, reset and reload', async ({ visual: { page } }) => {
  const settings = async () => { await page.getByRole('button', { name: 'Settings', exact: true }).click(); };
  const select = async (name: string) => {
    await page.getByRole('treeitem', { name, exact: true }).click(); await showAdvanced(page);
    return page.getByRole('group', { name: `${name} settings` });
  };
  await settings(); await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
  const claude = await select('Claude'); await expect(claude.getByLabel('Remote Control', { exact: true })).toBeVisible();
  await claude.getByLabel('Width', { exact: true }).fill('1000'); await claude.getByLabel('Height', { exact: true }).fill('580');
  const codex = await select('Codex'); await expect(codex.getByLabel('Remote Control')).toHaveCount(0);
  await codex.getByLabel('Width', { exact: true }).fill('900'); await codex.getByLabel('Height', { exact: true }).fill('500');
  const todo = await select('To-do'); await expect(todo.getByLabel('Width', { exact: true })).toHaveCount(0);
  const note = await select('Note'); await expect(note.getByLabel('Width', { exact: true })).toHaveCount(0);
  await capture(page, 'settings-item-note.png');
  await page.getByRole('button', { name: 'Save settings' }).click(); await page.reload();
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.settingsRead())).value.itemViews).toEqual({ 'agent.session:claude': { width: 1000, height: 580 }, 'agent.session:codex': { width: 900, height: 500 } });
  await settings(); await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
  await (await select('Codex')).getByLabel('Width', { exact: true }).fill('700');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  const agent = page.locator('[data-expanded-item-id="agent"].expanded'); await expect(agent).toBeVisible();
  expect((await agent.boundingBox())!.width).toBeCloseTo(1000, 0); expect((await agent.boundingBox())!.height).toBeCloseTo(580, 0);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await settings(); await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
  const restored = await select('Codex'); await expect(restored.getByLabel('Width', { exact: true })).toHaveValue('900');
  await restored.getByRole('button', { name: 'Reset view size' }).click(); await expect(restored.getByLabel('Width', { exact: true })).not.toHaveValue('900');
  await page.getByRole('button', { name: 'Save settings' }).click();
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.itemViews['agent.session:codex']).toBeUndefined();
});

test('connected to-dos return from an expanded agent to inline editing and never mount detail', async ({ visual: { page } }) => {
  await addItems(page);
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  await page.getByRole('button', { name: 'Open connected item: Check migration', exact: true }).click();
  await expect(page.locator('.map-card.expanded')).toHaveCount(0);
  const todo = page.locator('[data-item-id="todo"]');
  await expect(todo.getByRole('textbox')).toBeVisible();
  await todo.getByRole('textbox').fill('Check resumed sessions'); await page.keyboard.press('Enter');
  await expect(todo).toContainText('Check resumed sessions');
  await expect(todo.locator('.card-detail')).toHaveCount(0);
  await todo.click(); await page.keyboard.press('Escape');
  await expect(todo.locator('.card-detail')).toHaveCount(0);
});


test('the entire expanded terminal menu bar moves the view except interactive controls', async ({ visual: { page } }) => {
  await openTerminal(page);
  const view = page.getByRole('region', { name: 'Development terminal', exact: true });
  const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
  const sessionId = (await surface.getAttribute('data-terminal-id'))!;
  const originalSession = await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId);
  const positions = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.map(({ id, position }) => ({ id, position })));
  const beforePositions = await positions();
  for (const part of ['.terminal-state', '.terminal-directory', '.terminal-status']) {
    const target = view.locator(part), rect = (await target.boundingBox())!, before = (await view.boundingBox())!;
    const point = part === '.terminal-status'
      ? await target.evaluate(el => { const state = el.querySelector('.terminal-state')!.getBoundingClientRect(); return { x: state.right + 3, y: state.y + state.height / 2 }; })
      : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    expect(await target.evaluate(el => getComputedStyle(el).cursor)).toBe('grab');
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x - 8, point.y + 8, { steps: 5 }); await page.mouse.up();
    const after = (await view.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x - 8, 0); expect(after.y).toBeCloseTo(before.y + 8, 0);
  }
  expect(await positions()).toEqual(beforePositions);
  await expect(surface).toHaveAttribute('data-mount-id', mount!);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(originalSession.session.pid);
  const beforeButton = (await view.boundingBox())!, stop = view.getByRole('button', { name: 'Stop session', exact: true }), button = (await stop.boundingBox())!;
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2); await page.mouse.down();
  await page.mouse.move(button.x + button.width / 2, button.y + button.height + 35, { steps: 5 }); await page.mouse.up();
  expect(await view.boundingBox()).toEqual(beforeButton);
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await stop.click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
  expect(await view.boundingBox()).toEqual(beforeButton);
  await view.getByRole('button', { name: 'Back to project' }).click(); await expect(view).toBeHidden();
});

test('with an item open the board pans and zooms around it; the item stays put and open, Back leaves the camera there, and wheel over the item never moves the map', async ({ visual: { page } }) => {
  const camera = () => page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  const area = page.locator('.map-area'), view = page.locator('[data-item-view="agent"]');
  await expect(area).toHaveAttribute('data-focus', 'agent');
  const placed = (await view.boundingBox())!, start = await camera();
  await page.mouse.move(placed.x + placed.width / 2, placed.y + placed.height / 2); await page.mouse.wheel(0, 400);
  expect(await camera()).toEqual(start);
  const below = { x: placed.x + placed.width / 2, y: placed.y + placed.height + 25 };
  await page.mouse.move(below.x, below.y); await page.mouse.down(); await page.mouse.move(below.x - 200, below.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await camera()).x - start.x)).toBe(-200);
  await page.mouse.move(below.x, below.y); await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await camera()).zoom).toBeGreaterThan(start.zoom);
  // The zoom keys move the board too, but not while the keyboard is inside the item.
  const wheeled = (await camera()).zoom;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press('-');
  await expect.poll(async () => (await camera()).zoom).toBeLessThan(wheeled);
  const keyed = (await camera()).zoom;
  await view.getByRole('button', { name: 'Back to project', exact: true }).focus(); await page.keyboard.press('0'); await page.waitForTimeout(300);
  expect((await camera()).zoom).toBe(keyed);
  await expect(area).toHaveAttribute('data-focus', 'agent');
  expect(await view.boundingBox()).toEqual(placed);
  await expect(page.locator('[data-selected-id]')).toHaveCount(0);
  const panned = await camera();
  // Saved while the item is still open, so a reload keeps it.
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead()))?.camera?.zoom).toBeCloseTo(panned.zoom, 2);
  await view.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(area).toHaveAttribute('data-focus', '');
  expect(await camera()).toEqual(panned);
  await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
  await expect.poll(camera).toEqual(panned);
});
