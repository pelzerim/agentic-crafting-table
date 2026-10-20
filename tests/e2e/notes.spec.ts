import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';
import type { ElectronApplication } from '@playwright/test';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';

test.use({ titleFixture: true });

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  const actor = { kind: 'user', id: 'note-fixture' };
  await page.evaluate(async input => {
    const { commands, actor } = JSON.parse(input);
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor, commands });
  }, JSON.stringify({ commands, actor }));
}
/** The desktop always applies as the person; an agent writes through the service like MCP does. */
async function applyAsAgent(app: ElectronApplication, page: Page, commands: WorkspaceCommand[]) {
  const client = await connectWorkspace(await app.evaluate(() => process.env.ACT_TEST_DATA_DIR!));
  try {
    const { state } = await page.evaluate(() => window.craftingTable.workspaceRead());
    await client.call('apply', { commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'agent', id: 'agent' }, commands });
  } finally { client.close(); }
}
const note = (id: string, text: string, position: { x: number; y: number }, extra: Record<string, string> = {}): WorkspaceCommand =>
  ({ type: 'item.add', id, resourceId: `${id}-resource`, pluginId: 'workspace.note', data: { text, ...extra }, projectId: 'billing', position });

test('a note is a paper tile whose text is its face; long notes fade and expand in place', async ({ visual: { page } }) => {
  const rollout = ['Rollout checklist', ...Array.from({ length: 19 }, (_, index) => `- [ ] Step ${index + 1}`)].join('\n');
  await apply(page, [
    note('api', 'API compatibility\nKeep /v1/plans stable.\nAsk Alex about invoices', { x: 640, y: 600 }),
    note('order', 'Migration order\n1. Backfill plan_tier\n2. Dual-write', { x: 880, y: 620 }, { paper: 'sky' }),
    note('rollout', rollout, { x: 1120, y: 700 }),
    { type: 'item.add', id: 'todo', resourceId: 'todo-resource', pluginId: 'workspace.todo', title: 'Review the migration', data: {}, projectId: 'billing', position: { x: 1150, y: 450 } },
  ]);
  const api = page.locator('[data-item-id="api"]'), order = page.locator('[data-item-id="order"]'), long = page.locator('[data-item-id="rollout"]');
  await expect(api).toHaveAttribute('data-paper', 'mint'); await expect(order).toHaveAttribute('data-paper', 'sky');
  await expect(page.getByRole('article', { name: /^Note: / })).toHaveCount(3);
  await expect(api.locator('.paper-face')).toContainText('Keep /v1/plans stable.');
  await expect(api.locator('.paper-first')).toHaveText('API compatibility');
  expect(Number(await api.locator('.paper-first').evaluate(element => getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600);
  await expect(api).toHaveCSS('width', '160px'); await expect(api).toHaveCSS('height', '128px');
  expect(await api.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(await page.locator('[data-item-id="todo"]').evaluate(element => getComputedStyle(element).backgroundColor));
  await expect(api.getByRole('button', { name: /lines/ })).toHaveCount(0);
  const more = long.getByRole('button', { name: '+ 6 lines', exact: true });
  await expect(more).toBeVisible(); await expect(long.locator('.paper-face')).toHaveAttribute('data-faded', 'true');
  const resting = (await long.boundingBox())!;
  await capture(page, 'note-sticky-tiles.png');
  await more.click();
  await expect(long.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect((await long.boundingBox())!.height).toBeGreaterThan(resting.height + 60);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
});

/** The viewport point just before a character of the tile's face. */
async function pointBefore(page: Page, id: string, phrase: string) {
  return page.locator(`[data-item-id="${id}"] .paper-face`).evaluate((face, phrase) => {
    const walker = face.ownerDocument.createTreeWalker(face, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent!.indexOf(phrase);
      if (index < 0) continue;
      const range = face.ownerDocument.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`No ${phrase} on the tile`);
  }, phrase);
}
const textOf = async (page: Page, id: string) => (await read(page)).resources.find(resource => resource.id === `${id}-resource`)?.data.text;

test('a click writes at the click point, saves while typing, and Esc commits without discarding', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [note('api', 'API compatibility\nKeep stable', { x: 700, y: 560 })]);
  const tile = page.locator('[data-item-id="api"]'), editor = tile.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toHaveCount(0);
  const point = await pointBefore(page, 'api', 'stable');
  await page.mouse.click(point.x, point.y);
  await expect(editor).toBeFocused();
  const caret = await editor.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]);
  expect(caret[0]).toBe(caret[1]); expect(Math.abs(caret[0] - 'API compatibility\nKeep '.length)).toBeLessThanOrEqual(1);
  await editor.evaluate((element: HTMLTextAreaElement, at) => element.setSelectionRange(at, at), 'API compatibility\nKeep '.length);
  await page.keyboard.type('very ');
  await expect(page.locator('.paper-tools')).toBeVisible();
  await page.mouse.move(4, 4); await expect(page).toHaveScreenshot('note-edit-caret.png');
  await expect.poll(() => textOf(page, 'api'), { timeout: 3000 }).toBe('API compatibility\nKeep very stable');
  await expect(editor).toBeFocused();
  // Map shortcuts and Delete belong to the text while writing.
  await page.keyboard.type(' nm'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  await expect(page.locator('.attention-list')).toHaveCount(0);
  await expect(page.locator('.map-area')).toHaveAttribute('data-overview', 'false');
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
  await expect(editor).toHaveValue(''); await page.keyboard.press('Meta+z');
  await expect(editor).toHaveValue('API compatibility\nKeep very stable');
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('!'); await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect.poll(() => textOf(page, 'api')).toBe('API compatibility\nKeep very stable!');
  await expect(tile.locator('.paper-face')).toContainText('Keep very stable!');
  await expect(page.locator('.map-selection [data-selected-id="api"]')).toHaveCount(1);
  // Enter edits a selected tile with the caret at the end; ⌘↵ commits.
  await page.keyboard.press('Enter'); await expect(editor).toBeFocused();
  expect(await editor.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe('API compatibility\nKeep very stable!'.length);
  await page.keyboard.type('\nShip it'); await page.keyboard.press('Meta+Enter');
  await expect(editor).toHaveCount(0);
  await expect.poll(() => textOf(page, 'api')).toBe('API compatibility\nKeep very stable!\nShip it');
  // Clicking the map commits too.
  await tile.locator('.paper-face').click(); await expect(editor).toBeFocused();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('.');
  await page.mouse.click(200, 700); await expect(editor).toHaveCount(0);
  await expect.poll(() => textOf(page, 'api')).toBe('API compatibility\nKeep very stable!\nShip it.');
  await page.reload();
  await expect(page.locator('[data-item-id="api"] .paper-face')).toContainText('Ship it.');
});

test('dragging a tile moves it, Delete on a selected tile archives it with Undo, and an emptied note is discarded', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [note('api', 'API compatibility\nKeep stable', { x: 700, y: 560 }), note('empty', 'Scratch', { x: 1000, y: 560 })]);
  const tile = page.locator('[data-item-id="api"]'), editor = tile.getByRole('textbox', { name: 'Note text' });
  const before = (await read(page)).nodes.find(node => node.id === 'api')!.position, box = (await tile.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'api')!.position.x).toBeGreaterThan(before.x + 40);
  await expect(editor).toHaveCount(0);
  await tile.locator('.paper-face').click(); await expect(editor).toBeFocused();
  await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect.poll(async () => Boolean((await read(page)).nodes.find(node => node.id === 'api')?.archivedAt)).toBe(true);
  const toast = page.getByRole('status').filter({ hasText: 'Note archived' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => Boolean((await read(page)).nodes.find(node => node.id === 'api')?.archivedAt)).toBe(false);
  await expect(tile).toBeVisible();
  const scratch = page.locator('[data-item-id="empty"]');
  await scratch.locator('.paper-face').click();
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
  await expect(scratch.getByRole('textbox', { name: 'Note text' })).toHaveValue('');
  await page.waitForTimeout(800);
  expect(await textOf(page, 'empty')).toBe('Scratch');
  await page.keyboard.press('Escape');
  await expect.poll(async () => Boolean((await read(page)).nodes.find(node => node.id === 'empty')?.archivedAt)).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Note archived' })).toHaveCount(0);
});

test('the ring creates a note with the caret already in it; leaving it empty creates nothing', async ({ visual: { page } }) => {
  await page.mouse.dblclick(450, 330);
  const ring = page.getByRole('form', { name: 'New item' });
  const slot = ring.getByRole('group', { name: 'Quick item types' }).getByRole('button', { name: 'Note', exact: true });
  await expect(slot).toHaveAttribute('aria-keyshortcuts', 'N');
  await page.keyboard.press('n');
  await expect(ring).toHaveCount(0);
  const editor = page.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeFocused(); await expect(editor).toHaveValue('');
  await expect(page.locator('.attention-list')).toHaveCount(0);
  const box = (await editor.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 450)).toBeLessThan(60); expect(Math.abs(box.y + box.height / 2 - 330)).toBeLessThan(60);
  const body = 'Architecture notes\n\nKeep the existing API stable.\n<script>window.noteInjected = true</script>\n日本語 · Preserve whitespace.  ';
  await editor.fill(body); await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).resources.find(resource => resource.pluginId === 'workspace.note')?.data.text).toBe(body);
  const state = await read(page), created = state.nodes.find(node => node.resourceId === state.resources.find(resource => resource.pluginId === 'workspace.note')!.id)!;
  expect(created.projectId).toBe('billing');
  const tile = page.locator(`[data-item-id="${created.id}"]`);
  await expect(tile).toHaveAttribute('aria-label', 'Note: API compatibility plan', { timeout: 15000 });
  await expect(tile.locator('.paper-face')).toContainText('<script>window.noteInjected = true</script>');
  await expect(tile.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => 'noteInjected' in window)).toBe(false);
  await capture(page, 'note-created.png');
  const count = state.nodes.length;
  await page.mouse.dblclick(450, 680);
  await ring.getByRole('button', { name: 'Note', exact: true }).click();
  await expect(editor).toBeFocused(); await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0); await expect(page.locator('[data-paper]')).toHaveCount(1);
  await page.waitForTimeout(700);
  expect((await read(page)).nodes).toHaveLength(count);
});

test('an empty note from the ring keeps its resized width while unsaved and saves it with its first text', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  const count = (await read(page)).nodes.length;
  await page.mouse.dblclick(450, 680);
  await page.keyboard.press('n');
  const editor = page.getByRole('textbox', { name: 'Note text' }), tile = page.locator('[data-paper]').filter({ has: editor });
  await expect(editor).toBeFocused(); await expect(tile).toHaveCSS('width', '160px');
  const handle = tile.getByRole('button', { name: 'Resize Note', exact: true });
  await handle.hover(); const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  await expect(tile).toHaveCSS('width', '280px');
  await expect(page.getByRole('button', { name: 'Dismiss error' })).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect((await read(page)).nodes).toHaveLength(count);
  const sized = (await tile.boundingBox())!;
  await page.keyboard.type('Wider scratch'); await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).resources.find(resource => resource.data.text === 'Wider scratch')?.id).toBeTruthy();
  const state = await read(page), saved = state.nodes.find(node => node.resourceId === state.resources.find(resource => resource.data.text === 'Wider scratch')!.id)!;
  expect(saved.mapDimensions?.width).toBe(280);
  const savedTile = page.locator(`[data-item-id="${saved.id}"]`);
  await expect(savedTile).toHaveCSS('width', '280px');
  const placed = (await savedTile.boundingBox())!;
  expect(Math.abs(placed.x - sized.x)).toBeLessThan(2); expect(Math.abs(placed.y - sized.y)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Dismiss error' })).toHaveCount(0);
});

test('pasting text on the empty map creates a note at the pointer; a pasted URL still creates a link', async ({ visual: { page, app } }) => {
  await app.evaluate(({ clipboard }) => clipboard.writeText('Pasted decision\n- [ ] Follow up'));
  await page.mouse.move(470, 650); await page.mouse.click(470, 650);
  await page.keyboard.press('Meta+v');
  await expect.poll(async () => (await read(page)).resources.find(resource => resource.pluginId === 'workspace.note')?.data.text).toBe('Pasted decision\n- [ ] Follow up');
  const state = await read(page), pasted = state.nodes.find(node => node.resourceId === state.resources.find(resource => resource.pluginId === 'workspace.note')!.id)!;
  const tile = (await page.locator(`[data-item-id="${pasted.id}"]`).boundingBox())!;
  expect(Math.abs(tile.x + tile.width / 2 - 470)).toBeLessThan(80); expect(Math.abs(tile.y + tile.height / 2 - 650)).toBeLessThan(80);
  await app.evaluate(({ clipboard }) => clipboard.writeText('https://example.com/spec'));
  await page.mouse.move(1000, 650); await page.mouse.click(1000, 650);
  await page.keyboard.press('Meta+v');
  const form = page.getByRole('form', { name: 'New item' });
  await expect(form.getByLabel('Item URL')).toHaveValue('https://example.com/spec');
  expect((await read(page)).resources.filter(resource => resource.pluginId === 'workspace.note')).toHaveLength(1);
});

test('light markdown renders on the tile: bold first line, lists, clickable checkboxes, code and guarded links', async ({ visual: { page, app } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  const text = 'API compatibility\nKeep **/v1/plans** stable and `plan_tier` safe.\n- [x] Freeze response shape\n- [ ] Version switcher fields\n1. Read [the spec](https://example.com/spec)\n<b>inert</b>';
  await apply(page, [note('api', text, { x: 700, y: 560 })]);
  await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
  const tile = page.locator('[data-item-id="api"]'), face = tile.locator('.paper-face');
  await expect(face.locator('.paper-first')).toHaveText('API compatibility');
  await expect(face.locator('strong', { hasText: '/v1/plans' })).toHaveCount(1);
  await expect(face.locator('code')).toHaveText('plan_tier');
  await expect(face.locator('b')).toHaveCount(0); await expect(face).toContainText('<b>inert</b>');
  const boxes = face.getByRole('checkbox');
  await expect(boxes).toHaveCount(2); await expect(boxes.first()).toBeChecked(); await expect(boxes.nth(1)).not.toBeChecked();
  await expect(boxes.nth(1)).toHaveAccessibleName('Version switcher fields');
  await capture(page, 'note-markdown.png');
  await boxes.nth(1).click();
  await expect(tile.getByRole('textbox', { name: 'Note text' })).toHaveCount(0);
  await expect.poll(() => textOf(page, 'api')).toBe(text.replace('- [ ] Version', '- [x] Version'));
  await expect(boxes.nth(1)).toBeChecked();
  await boxes.first().click();
  await expect.poll(() => textOf(page, 'api')).toBe(text.replace('- [ ] Version', '- [x] Version').replace('- [x] Freeze', '- [ ] Freeze'));
  await face.getByRole('link', { name: 'the spec' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrls)).toEqual(['https://example.com/spec']);
  await expect(tile.getByRole('textbox', { name: 'Note text' })).toHaveCount(0);
  // Editing shows the raw text.
  await face.locator('.paper-first').click();
  await expect(tile.getByRole('textbox', { name: 'Note text' })).toHaveValue(text.replace('- [ ] Version', '- [x] Version').replace('- [x] Freeze', '- [ ] Freeze'));
});

test('agent notes carry copper tape and a byline; an agent edit while typing keeps the draft and agents read saved text only', async ({ visual: { page, app } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await applyAsAgent(app, page, [note('legacy', 'Annual plan notes\nAnnual plans renew in January.', { x: 1000, y: 560 }, { paper: 'peach' })]);
  await apply(page, [note('mine', 'My note', { x: 700, y: 560 })]);
  const tile = page.locator('[data-item-id="legacy"]'), editor = tile.getByRole('textbox', { name: 'Note text' });
  await expect(tile).toHaveAttribute('data-writer', 'agent');
  await expect(tile.locator('.paper-byline')).toHaveText(/^Claude · /);
  await expect(page.locator('[data-item-id="mine"]')).not.toHaveAttribute('data-writer', 'agent');
  // The service stamps real time while the page clock is fixed, so the time is masked.
  await page.mouse.move(4, 4); await expect(page).toHaveScreenshot('note-agent.png', { mask: [tile.locator('.paper-byline')] });
  await tile.locator('.paper-first').click(); await expect(editor).toBeFocused();
  await page.keyboard.press('Meta+a'); await page.keyboard.type('My draft');
  await applyAsAgent(app, page, [{ type: 'item.update', id: 'legacy', data: { text: 'Agent rewrite', paper: 'peach' } }]);
  const strip = page.getByRole('group', { name: 'Note changed elsewhere' });
  await expect(strip).toBeVisible();
  await expect(editor).toHaveValue('My draft');
  await page.waitForTimeout(900);
  expect(await textOf(page, 'legacy')).toBe('Agent rewrite');
  const context = await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'resource.context', nodeId: 'legacy', arguments: {} })) as { content: string };
  expect(context.content).toBe('Agent rewrite');
  await strip.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved version' })).toContainText('Agent rewrite');
  await expect(editor).toHaveValue('My draft');
  await strip.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await expect(strip).toHaveCount(0);
  await expect.poll(() => textOf(page, 'legacy')).toBe('My draft');
  await page.keyboard.press('Escape');
  await expect(tile).not.toHaveAttribute('data-writer', 'agent');
});

test('at mid zoom a note shows its generated title and checklist progress; far away it is a paper square', async ({ visual: { page } }) => {
  await apply(page, [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-resource', pluginId: 'workspace.note', data: { text: 'Rollout checklist\n- [x] Flag in staging\n- [x] Dashboards\n- [ ] Support macro\n- [ ] Email customers' }, position: { x: 1500, y: 400 } },
    { type: 'item.add', id: 'plain', resourceId: 'plain-resource', pluginId: 'workspace.note', data: { text: 'Plain words\nsecond line\nthird line\nfourth line' }, position: { x: 1500, y: 800 } },
  ]);
  const rollout = page.locator('[data-item-id="rollout"]'), plain = page.locator('[data-item-id="plain"]');
  await expect(rollout).toHaveAttribute('aria-label', 'Note: API compatibility plan', { timeout: 15000 });
  const near = (await rollout.boundingBox())!;
  await page.getByRole('slider', { name: 'Map zoom' }).fill('0.5');
  await expect(rollout.locator('.paper-mid-title')).toHaveText('API compatibility plan');
  await expect(rollout.locator('.paper-face')).toHaveCount(0);
  await expect(rollout.getByRole('meter', { name: 'Checklist' })).toHaveAttribute('aria-valuenow', '2');
  await expect(rollout.locator('.paper-progress')).toContainText('2/4');
  await expect(plain.locator('.paper-progress')).toContainText('4 lines');
  const title = (await rollout.locator('.paper-mid-title').boundingBox())!;
  expect(title.height).toBeGreaterThan(12);
  const mid = (await rollout.boundingBox())!;
  expect(mid.width / near.width).toBeCloseTo(.5 / .7, 1);
  await capture(page, 'note-mid-zoom.png');
  await page.getByRole('slider', { name: 'Map zoom' }).fill('0.3');
  await expect(rollout).toHaveClass(/compact/); await expect(rollout.locator('.paper-fold')).toHaveCount(1);
  await expect(rollout).toHaveAttribute('data-paper', 'mint');
});

test('a note has no full view: opening it from the menu or keyboard writes on the tile', async ({ visual: { page } }) => {
  await apply(page, [note('api', 'API compatibility\nKeep stable', { x: 700, y: 600 })]);
  const tile = page.locator('[data-item-id="api"]'), editor = tile.getByRole('textbox', { name: 'Note text' });
  await tile.click({ button: 'right', position: { x: 20, y: 6 } });
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await expect(editor).toBeFocused();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await expect(page.locator('[data-expanded-item-id="api"]')).toHaveCount(0);
  await expect(page.locator('.note-detail')).toHaveCount(0);
  const profile = await page.evaluate(async () => (await window.craftingTable.workspacePlugins()).find(plugin => plugin.id === 'workspace.note')?.view);
  expect(profile).toEqual({ mode: 'inline' });
});

test('highlighting a note never moves it', async ({ visual: { page } }) => {
  await apply(page, [note('still', 'Stay put\nHover me', { x: 700, y: 600 })]);
  const card = page.locator('[data-item-id="still"]');
  await page.mouse.move(5, 5);
  const before = (await card.boundingBox())!;
  await card.hover();
  await page.waitForTimeout(250);
  const during = (await card.boundingBox())!;
  expect([during.x, during.y]).toEqual([before.x, before.y]);
});

async function dragGrip(page: Page, tile: ReturnType<Page['locator']>, dx: number, dy: number) {
  const handle = tile.getByRole('button', { name: /^Resize / });
  await handle.hover(); const grip = (await handle.boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
}

test('resizing a note keeps its top-left corner: its height follows the text and its width stops at the minimum', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [note('plan', 'Keep the public API stable\nShip in small steps\nRetain rollback\nVerify sessions', { x: 520, y: 700 })]);
  const tile = page.locator('[data-item-id="plan"]'), corner = async () => { const box = (await tile.boundingBox())!; return [Math.round(box.x), Math.round(box.y)]; };
  const resting = (await tile.boundingBox())!, origin = await corner();
  for (const [dx, dy] of [[0, 120], [0, -80], [-200, 0], [-120, -120]]) {
    await dragGrip(page, tile, dx, dy);
    await expect(tile).toHaveCSS('width', '160px'); await expect(tile).toHaveCSS('height', `${resting.height}px`);
    expect(await corner()).toEqual(origin);
  }
  await dragGrip(page, tile, 120, 60);
  await expect(tile).toHaveCSS('width', '280px');
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'plan')?.mapDimensions?.width).toBe(280);
  expect((await tile.boundingBox())!.height).toBeLessThan(resting.height);
  expect(await corner()).toEqual(origin);
  await dragGrip(page, tile, 900, 900);
  await expect(tile).toHaveCSS('width', '640px');
  expect(await corner()).toEqual(origin);
  const grip = tile.getByRole('button', { name: /^Resize / });
  await grip.focus(); await page.keyboard.press('Shift+ArrowLeft');
  await expect(tile).toHaveCSS('width', '616px');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  expect(await corner()).toEqual(origin);
  await expect(page.getByRole('button', { name: 'Dismiss error' })).toHaveCount(0);
});

test('resizing a note while writing keeps the caret in it and fits the text to the new width', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await apply(page, [note('draft', 'Keep the public API stable while replacing the billing internals', { x: 520, y: 700 })]);
  const tile = page.locator('[data-item-id="draft"]'), editor = tile.getByRole('textbox', { name: 'Note text' });
  await tile.locator('.paper-face').click(); await expect(editor).toBeFocused();
  await page.keyboard.press('Meta+ArrowDown');
  const narrow = (await tile.boundingBox())!;
  await dragGrip(page, tile, 140, 0);
  await expect(tile).toHaveCSS('width', '300px');
  await expect(editor).toBeFocused();
  expect((await tile.boundingBox())!.height).toBeLessThan(narrow.height);
  await page.keyboard.type(' today'); await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).resources.find(resource => resource.id === 'draft-resource')?.data.text).toBe('Keep the public API stable while replacing the billing internals today');
  expect((await read(page)).nodes.find(node => node.id === 'draft')?.mapDimensions?.width).toBe(300);
});
