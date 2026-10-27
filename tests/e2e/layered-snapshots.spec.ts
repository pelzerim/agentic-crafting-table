import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const apply = (page: Page, commands: WorkspaceCommand[]) => page.evaluate(async (commands: unknown[]) => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
}, commands as unknown[]);
const stored = Array.from({ length: 50 }, (_, index) => `stored-${index}`);
type Frame = { layer?: string; ids: string[]; below?: number; cursor: number };
/** The snapshots the renderer receives from its subscription, in order. */
const frames = (page: Page) => page.evaluate(() => (window as unknown as { layerFrames: Frame[] }).layerFrames);
const last = async (page: Page) => (await frames(page)).at(-1)!;

test('the map layer receives none of the 50 items below; travelling down brings them and coming back lets them go', async ({ visual: { page } }) => {
  await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, undermapLayout: 'classic' } }); });
  const before = (await read(page)).nodes.length;
  await apply(page, [{ type: 'project.create', id: 'stored', title: 'Stored work', summary: '', position: { x: 500, y: 900 } },
    ...stored.map((id, index): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-resource`, pluginId: 'workspace.note', title: `Stored ${index}`, data: { text: `Stored ${index}` }, projectId: 'stored', position: { x: 300 + index % 10 * 200, y: 900 + Math.floor(index / 10) * 120 } })),
    { type: 'node.below', id: 'stored' }]);
  await page.evaluate(() => {
    const list: Frame[] = []; (window as unknown as { layerFrames: Frame[] }).layerFrames = list;
    window.craftingTable.onWorkspace(snapshot => list.push({ layer: snapshot.layer, ids: snapshot.state.nodes.map(node => node.id), below: snapshot.layers?.below.items, cursor: snapshot.cursor }));
  });
  await apply(page, [{ type: 'node.move', id: 'pr', position: { x: 760, y: 320 } }]);
  await expect.poll(async () => (await frames(page)).length).toBeGreaterThan(0);
  const onMap = await last(page);
  expect(onMap.layer).toBe('map'); expect(onMap.below).toBe(50);
  expect(onMap.ids.filter(id => stored.includes(id))).toEqual([]);
  expect(onMap.ids).toContain('stored');
  expect((await read(page)).nodes).toHaveLength(before + 51);
  await expect(page.locator('[data-item-id^="stored-"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'below');
  await expect(page.locator('.below-bar [role="status"]')).toHaveText('Undermap · 50 items');
  await expect(page.locator('[data-item-id^="stored-"]')).toHaveCount(50);
  const down = await last(page);
  expect(down.layer).toBe('below'); expect(stored.every(id => down.ids.includes(id))).toBe(true);

  await page.getByRole('button', { name: '↑ Back to map', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'map');
  await expect.poll(async () => (await last(page)).layer).toBe('map');
  expect((await last(page)).ids.filter(id => stored.includes(id))).toEqual([]);
  await expect(page.locator('[data-item-id^="stored-"]')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toBeVisible();
});

test('from the map layer, Needs me’s earlier list names an item that went below and Show on map travels to it', async ({ visual: { page } }) => {
  await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, undermapLayout: 'classic' } }); });
  const needs = page.locator('.needs-me-button'), list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await needs.click();
  await list.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(list).toBeHidden();
  // Its only link leads below too, so the map layer's snapshot holds neither.
  await apply(page, [{ type: 'node.below', id: 'pr' }, { type: 'node.below', id: 'brief' }]);
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => { let held: string[] = []; const off = window.craftingTable.onWorkspace(snapshot => { held = snapshot.state.nodes.map(node => node.id); }); await new Promise(resolve => setTimeout(resolve, 50)); off(); return held; })).not.toContain('pr');
  await needs.click();
  const earlier = list.getByRole('button', { name: 'Open earlier Plan switcher', exact: true });
  await expect(earlier).toContainText('In Undermap');
  await list.getByRole('button', { name: 'Go to earlier Plan switcher on map', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'below');
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toBeVisible();
});
