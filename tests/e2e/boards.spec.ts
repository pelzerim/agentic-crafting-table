import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Boards' });
const tab = (page: Page, name: string) => tabs(page).getByRole('tab').filter({ has: page.locator('.board-tab-name').getByText(name, { exact: true }) });
const project = (page: Page) => page.locator('.react-flow__node[data-id="billing"]');
const zoom = (page: Page) => page.locator('.map-area').getAttribute('data-zoom');
const apply = (page: Page, commands: unknown[]) => page.evaluate(async commands => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
}, commands);

test('a board made from the ground menu brings the tabs; a project moved there shows only there, each board keeps its camera, and ⌘1 switches back', async ({ visual: { page } }) => {
  await expect(tabs(page)).toHaveCount(0);
  const mainZoom = await zoom(page);
  expect(mainZoom).not.toBe('1');

  await page.mouse.click(100, 650, { button: 'right' });
  await page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'New board…' }).click();
  const name = page.getByRole('textbox', { name: 'Board name' });
  await expect(name).toHaveValue('Board 2');
  await name.fill('Side projects'); await name.press('Enter');
  await expect(tabs(page).locator('.board-tab-name')).toHaveText(['Main', 'Side projects']);
  await expect(tab(page, 'Side projects')).toHaveAttribute('aria-selected', 'true');
  await expect(project(page)).toHaveCount(0);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await expect.poll(() => zoom(page)).toBe('1');
  // The zoom slider keeps the keyboard while focused, as every input does.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('ControlOrMeta+1');
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect(project(page)).toBeVisible();
  await expect.poll(() => zoom(page), 'Main keeps its own camera').toBe(mainZoom);

  await page.getByRole('button', { name: 'Project options: Billing redesign' }).click();
  await page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'Move to board', exact: true }).click();
  await page.getByRole('menu', { name: 'Move to board' }).getByRole('menuitemradio', { name: 'Side projects', exact: true }).click();
  await expect(project(page)).toHaveCount(0);
  const state = await read(page), side = state.boards.find(board => board.name === 'Side projects')!;
  expect(state.nodes.filter(node => node.id === 'billing' || node.projectId === 'billing').every(node => node.board === side.id)).toBe(true);
  await expect(tab(page, 'Side projects').locator('.board-tab-count')).toHaveText('2');

  await tab(page, 'Side projects').click();
  await expect(project(page)).toBeVisible();
  await expect.poll(() => zoom(page), 'Side projects keeps its own camera').toBe('1');

  await page.keyboard.press('ControlOrMeta+1');
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect(project(page)).toHaveCount(0);
});

test('deleting the board on screen opens the first board at its own camera, and undo brings the deleted board back on screen', async ({ visual: { page } }) => {
  const mainZoom = await zoom(page);
  await apply(page, [{ type: 'board.save', board: { id: 'second', name: 'Second' } }, { type: 'board.save', board: { id: 'third', name: 'Third' } }]);
  await tab(page, 'Second').click();
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await expect.poll(() => zoom(page)).toBe('1');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await tab(page, 'Second').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Board actions' }).getByRole('menuitem', { name: 'Delete board' }).click();
  await expect(tabs(page).locator('.board-tab-name')).toHaveText(['Main', 'Third']);
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => zoom(page), 'Main opens at its own camera').toBe(mainZoom);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(tab(page, 'Second')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+1');
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => zoom(page), 'Main kept its camera').toBe(mainZoom);
});

test('showing a hidden item that sits on another board switches to that board', async ({ visual: { page } }) => {
  const note = (id: string, extra: object) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, ...extra });
  await apply(page, [{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'project.create', id: 'other', title: 'Other', board: 'side', position: { x: 0, y: 0 } }]);
  await apply(page, [note('helper', { projectId: 'other', position: { x: 200, y: 200 }, hidden: { label: 'helper note' } }), note('anchor', { board: 'main', position: { x: 300, y: 900 } })]);
  await apply(page, [{ type: 'link.save', link: { id: 'anchor-helper', sourceId: 'anchor', targetId: 'helper', kind: 'reference' } }]);
  await page.locator('.react-flow__node[data-id="anchor"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'Show helper note' }).click();
  await expect(tab(page, 'Side')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.react-flow__node[data-id="helper"]')).toBeVisible();
});

test('a board switch asks the open view first: a conflicting notes draft keeps the person on this board', async ({ visual: { page, app } }) => {
  await app.evaluate(({ session }) => {
    session.fromPartition('youtube-embeds').protocol.handle('https', () => new Response('<!doctype html><title>Fixture</title><video></video>', { headers: { 'content-type': 'text/html' } }));
  });
  const source = 'https://www.youtube.com/watch?v=eeeeeeeeeee', notesTo = (notes: string) => ({ type: 'item.update', id: 'clip', data: { source, notes } });
  await apply(page, [{ type: 'board.save', board: { id: 'side', name: 'Side' } }, { type: 'item.add', id: 'clip', resourceId: 'clip-r', pluginId: 'workspace.video', title: 'clip', data: { source, notes: 'First' }, projectId: 'billing', position: { x: 650, y: 620 } }]);
  await page.locator('.map-card[data-item-id="clip"]').click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
  await expect(notes).toHaveValue('First');
  await page.evaluate(async command => {
    const area = document.querySelector<HTMLTextAreaElement>('.video-notes-text')!;
    area.value += ' and mine'; area.dispatchEvent(new Event('input'));
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [command as never] });
  }, notesTo('Newer elsewhere'));
  await expect(page.locator('.video-notes .pr-comment-feedback')).toHaveText(/saved notes changed elsewhere/);
  await tab(page, 'Side').click();
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true');
  await expect(notes).toHaveValue('First and mine');
});
