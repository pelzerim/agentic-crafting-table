import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { showAdvanced } from './settings-helpers.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const apply = (page: Page, commands: WorkspaceCommand[]) => page.evaluate(async (commands: unknown[]) => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
}, commands as unknown[]);
const layer = (page: Page) => page.locator('.map-area');
/** The journeys below describe the Classic layout: stored positions, arrival beside the project's items. Mirror, the default, is covered in undermap-mirror.spec.ts. */
const classic = (page: Page) => page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, undermapLayout: 'classic' } }); });
async function menu(page: Page, title: string, name: string) {
  await page.getByRole('article', { name: title, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('Classic layout: items sent below stay readable in place, rising by zooming out, and return to the nearest free spot', async ({ visual: { page } }) => {
  await classic(page);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  // The portal is still until hovered, then swirls.
  const frame = () => page.locator('.portal-art').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const portal = page.locator('.below-portal');
  await page.mouse.move(600, 700); await page.waitForTimeout(50);
  const still = await frame(); await page.waitForTimeout(400); expect(await frame()).toBe(still);
  await portal.hover(); await expect.poll(frame, { timeout: 2000 }).not.toBe(still);
  const inset = await portal.evaluate(button => { const b = button.getBoundingClientRect(), c = button.querySelector('canvas')!.getBoundingClientRect();
    return { left: c.left - b.left, right: b.right - c.right, top: c.top - b.top, bottom: b.bottom - c.bottom }; });
  expect(Math.abs(inset.left - inset.right)).toBeLessThanOrEqual(1); expect(Math.abs(inset.top - inset.bottom)).toBeLessThanOrEqual(1);
  await page.mouse.move(600, 700);
  const pr = page.getByRole('article', { name: 'Plan switcher', exact: true }), before = (await read(page)).nodes.find(node => node.id === 'pr')!.position;
  await page.locator('.below-portal').evaluate(element => { (element as HTMLElement).style.zoom = '4'; });
  await page.locator('.below-portal').screenshot({ path: 'test-results/below-portal-map.png' });
  await page.locator('.below-portal').evaluate(element => { (element as HTMLElement).style.zoom = ''; });
  await menu(page, 'Plan switcher', 'Send to Undermap');
  await expect(page.locator('.below-sink')).toHaveCount(1);
  // The effect is anchored to the map: panning mid-animation carries it along.
  const sinkBox = async () => (await page.locator('.below-sink').boundingBox())!;
  const start = await sinkBox();
  await page.mouse.move(1000, 560); await page.mouse.down(); await page.mouse.move(900, 510, { steps: 4 }); await page.mouse.up();
  const moved = await sinkBox();
  expect(moved.x - start.x).toBeCloseTo(-100, -1); expect(moved.y - start.y).toBeCloseTo(-50, -1);
  await page.screenshot({ path: 'test-results/below-sink-mid.png' });
  await expect(page.locator('.below-sink')).toHaveCount(1); // Single items keep the prototype's ~900 ms pace.
  await expect(pr).toHaveCount(0); await expect(page.locator('.below-sink')).toHaveCount(0);
  expect((await read(page)).nodes.find(node => node.id === 'pr')).toMatchObject({ belowAt: expect.any(String), position: before });
  expect((await read(page)).nodes.find(node => node.id === 'pr')!.archivedAt).toBeUndefined();

  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await expect(layer(page)).toHaveAttribute('data-layer', 'below'); await expect(layer(page)).toHaveAttribute('data-undermap-layout', 'classic');
  await expect(pr).toBeVisible(); await expect(pr).toContainText('⬇');
  await expect(page.getByRole('article', { name: 'Billing redesign', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true })).toHaveCount(0);
  await expect(page.locator('.below-wipe')).toHaveCount(0);
  await expect(page.locator('[data-project-field="billing"] .neighborhood-paint')).toHaveAttribute('data-color', '#374635'); // Very dark Grass.
  await page.screenshot({ path: 'test-results/below-map-layer.png' });
  await page.locator('.below-portal').evaluate(element => { (element as HTMLElement).style.zoom = '4'; });
  await page.locator('.below-portal').screenshot({ path: 'test-results/below-portal-below.png' });
  await page.locator('.below-portal').evaluate(element => { (element as HTMLElement).style.zoom = ''; });
  // Nothing can be created below the map.
  await page.mouse.click(1000, 560, { button: 'right' });
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Open archive']);
  await page.keyboard.press('Escape');

  // Zooming out past the minimum rises back to the map at the previous zoom.
  const zoomBefore = (await page.evaluate(() => window.craftingTable.viewRead())).camera?.zoom;
  await page.mouse.move(700, 420);
  for (let i = 0; i < 60 && await layer(page).getAttribute('data-layer') === 'below'; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(40); }
  await expect(layer(page)).toHaveAttribute('data-layer', 'map');
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.viewRead())).camera?.zoom).toBeCloseTo(zoomBefore ?? .85, 2);

  // Another item takes the spot; bringing it back never moves that item.
  await apply(page, [{ type: 'node.move', id: 'brief', position: before }]);
  const brief = (await read(page)).nodes.find(node => node.id === 'brief')!.position;
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await menu(page, 'Plan switcher', 'Bring back to map');
  await expect(page.locator('.below-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
  await expect(pr).toBeVisible();
  const returned = (await read(page)).nodes;
  expect(returned.find(node => node.id === 'brief')!.position).toEqual(brief);
  const position = returned.find(node => node.id === 'pr')!;
  expect(position.belowAt).toBeUndefined(); expect(position.projectId).toBe('billing'); expect(position.position).not.toEqual(before);
  expect(Math.hypot(position.position.x - before.x, position.position.y - before.y)).toBeLessThan(500);
  await expect(page.getByRole('button', { name: 'Go to Undermap', exact: true })).toBeVisible();
  await expect(page.locator('.below-portal')).toHaveText('');
});

test('Classic layout: items sent to the Undermap one by one or as a selection land beside each other, and surface where they were', async ({ visual: { page } }) => {
  await classic(page);
  const ids = ['pr', 'brief', 'agent', 'ticket'];
  const original = Object.fromEntries((await read(page)).nodes.filter(node => ids.includes(node.id)).map(node => [node.id, node.position]));
  await menu(page, 'Plan switcher', 'Send to Undermap');
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toHaveCount(0);
  expect((await read(page)).nodes.find(node => node.id === 'pr')!.position, 'the first item below keeps its spot').toEqual(original.pr);
  // Occupy the spot the next item would overlay without arrival placement.
  await apply(page, [{ type: 'node.move', id: 'pr', position: original.brief }]);
  await menu(page, 'Billing experience', 'Send to Undermap');
  await expect(page.getByRole('article', { name: 'Billing experience', exact: true })).toHaveCount(0);
  for (const id of ['agent', 'ticket']) {
    const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
    await page.keyboard.down('Shift'); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.keyboard.up('Shift');
  }
  await menu(page, 'BIL-128 · Plan changes', 'Send selection to Undermap');
  await expect(page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true })).toHaveCount(0);
  const below = (await read(page)).nodes;
  for (const id of ['brief', 'agent', 'ticket']) expect(below.find(node => node.id === id)!.mapPosition).toEqual(original[id]);

  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await expect(layer(page)).toHaveAttribute('data-layer', 'below');
  const boxes = await Promise.all(ids.map(async id => ({ id, ...(await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())! })));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} overlaps ${b.id} in the Undermap`).toBe(true);
  }
  await menu(page, 'Billing experience', 'Bring back to map');
  await expect(page.getByRole('article', { name: 'Billing experience', exact: true })).toHaveCount(0);
  await apply(page, [{ type: 'nodes.action', ids: ['pr', 'agent', 'ticket'], action: 'surface' }]);
  const returned = (await read(page)).nodes;
  for (const id of ['brief', 'agent', 'ticket']) expect(returned.find(node => node.id === id)!.position, `${id} returns to its map position`).toEqual(original[id]);
});

test('the below-map animation can be turned off in advanced map settings', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click(); await showAdvanced(page);
  await expect(page.getByLabel('Below animation duration')).toHaveValue('260');
  await page.getByLabel('Animate sending items to Undermap and travelling').uncheck();
  await expect(page.getByLabel('Below animation duration')).toBeDisabled();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' }); // Only the setting may turn it off here.
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.belowAnimation).toEqual({ enabled: false, durationMs: 260 });
  let sinks = 0;
  await page.exposeFunction('countSink', () => { sinks++; });
  await page.evaluate(() => new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if ((node as HTMLElement).classList?.contains('below-sink') || (node as HTMLElement).classList?.contains('below-wipe')) (window as unknown as { countSink(): void }).countSink(); }).observe(document.body, { childList: true, subtree: true }));
  await menu(page, 'Billing experience', 'Send to Undermap');
  await expect(page.getByRole('article', { name: 'Billing experience', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await expect(layer(page)).toHaveAttribute('data-layer', 'below');
  expect(sinks).toBe(0);
});

test('the archive groups archived items by project', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.below', id: 'ticket' }, { type: 'node.archive', id: 'ticket' }, { type: 'node.below', id: 'brief' }, { type: 'node.archive', id: 'brief' }]);
  await page.mouse.click(100, 650, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Open archive', exact: true }).click();
  const group = page.getByRole('region', { name: 'Billing redesign', exact: true });
  await expect(group.locator('.settings-list-title strong')).toHaveText(['BIL-128 · Plan changes', 'Billing experience']);
  await expect(group.locator('.settings-list-meta').first()).toHaveText('Returns to Undermap');
});
