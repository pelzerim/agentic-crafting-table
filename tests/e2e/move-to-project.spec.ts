import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
/** Applies as the user. A background write (plots, titles) can take the revision first, so a conflict is retried on a fresh read. */
const apply = (page: Page, commands: WorkspaceCommand[]) => page.evaluate(async (commands: unknown[]) => {
  for (let attempt = 0; ; attempt++) {
    const { state } = await window.craftingTable.workspaceRead();
    try { await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never }); return; }
    catch (error) { if (attempt >= 4 || !String((error as Error).message).includes('Revision conflict')) throw error; }
  }
}, commands as unknown[]);
const projects: WorkspaceCommand[] = [
  { type: 'project.create', id: 'docs', title: 'Docs site', summary: '', position: { x: 2300, y: 300 } },
  { type: 'item.add', id: 'quickstart', resourceId: 'quickstart-resource', pluginId: 'github.pull-request', title: 'Quickstart rewrite', data: { owner: 'example', repo: 'docs', number: 7 }, projectId: 'docs', position: { x: 2300, y: 300 } },
  { type: 'project.create', id: 'spare', title: 'Spare', summary: '', position: { x: 300, y: 1500 } },
  { type: 'project.create', id: 'old', title: 'Old', summary: '', position: { x: 2300, y: 1500 } }, { type: 'node.archive', id: 'old' },
  { type: 'project.create', id: 'deep', title: 'Deep', summary: '', position: { x: 3600, y: 1500 } }, { type: 'node.below', id: 'deep' },
];
const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Context actions', exact: true });
const submenu = (page: Page) => page.getByRole('menu', { name: 'Move to project', exact: true });
const target = (page: Page, name: string) => submenu(page).getByRole('menuitemradio', { name, exact: true });
/** How far the card's middle is from the middle of the map, in screen pixels. */
const offCentre = async (page: Page, name: string) => {
  const box = (await card(page, name).boundingBox())!, map = (await page.locator('.map-area').boundingBox())!;
  return Math.hypot(box.x + box.width / 2 - (map.x + map.width / 2), box.y + box.height / 2 - (map.y + map.height / 2));
};
const selected = (page: Page) => page.locator('.map-selection [data-selected-id]').evaluateAll(rects => rects.map(rect => rect.getAttribute('data-selected-id')!).sort());
const openMove = async (page: Page, name: string) => {
  await card(page, name).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Move to project', exact: true }).click();
  await expect(submenu(page)).toBeVisible();
};

test('Move to project sends a card to the chosen project and the map follows it without opening it', async ({ visual: { page } }) => {
  await apply(page, projects);
  const before = await read(page);
  await card(page, 'Plan switcher').click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Connect to…', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', 'Open on GitHub', 'Copy URL', 'Settings', 'Move to project', 'Move to plot', 'Mark done', 'Send to Undermap']);
  await menu(page).getByRole('menuitem', { name: 'Move to project', exact: true }).click();
  // Active map projects only, the card's own project checked and unavailable.
  await expect(submenu(page).getByRole('menuitemradio')).toHaveText(['Billing redesign', 'Docs site', 'Spare']);
  await expect(target(page, 'Billing redesign')).toHaveAttribute('aria-checked', 'true'); await expect(target(page, 'Billing redesign')).toBeDisabled();
  await expect(target(page, 'Docs site')).toHaveAttribute('aria-checked', 'false'); await expect(target(page, 'Docs site')).toBeEnabled();
  await capture(page, 'move-to-project-menu.png');
  await target(page, 'Docs site').click();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'pr')?.projectId).toBe('docs');
  const after = await read(page), at = (id: string, state = after) => state.nodes.find(node => node.id === id)!;
  expect(after.revision).toBe(before.revision + 1);
  expect(at('pr')).toEqual({ ...at('pr', before), projectId: 'docs', position: at('pr').position });
  expect(Math.hypot(at('pr').position.x - at('quickstart').position.x, at('pr').position.y - at('quickstart').position.y)).toBeLessThan(700);
  // The linked brief stays; the link and everything else are untouched.
  expect(after.nodes.filter(node => node.id !== 'pr')).toEqual(before.nodes.filter(node => node.id !== 'pr'));
  expect(after.links).toEqual(before.links); expect(after.resources).toEqual(before.resources);
  // The view follows: centred like Show on map, still selected, never opened.
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1');
  await expect.poll(() => offCentre(page, 'Plan switcher')).toBeLessThan(4);
  expect(await selected(page)).toEqual(['pr']);
  await expect(page.locator('.item-view:visible')).toHaveCount(0);
  await expect(page.locator('[data-project-label="docs"]')).toContainText('1 my turn');
  // Its new project is now the checked one; an empty project takes the card on its anchor.
  await openMove(page, 'Plan switcher');
  await expect(target(page, 'Docs site')).toHaveAttribute('aria-checked', 'true'); await expect(target(page, 'Docs site')).toBeDisabled();
  await expect(target(page, 'Billing redesign')).toHaveAttribute('aria-checked', 'false');
  await target(page, 'Spare').click();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'pr')).toMatchObject({ projectId: 'spare', position: { x: 300, y: 1500 } });
  await expect.poll(() => offCentre(page, 'Plan switcher')).toBeLessThan(4);
  await page.reload(); await expect(card(page, 'Plan switcher')).toBeVisible();
  expect((await read(page)).nodes.find(node => node.id === 'pr')).toMatchObject({ projectId: 'spare', position: { x: 300, y: 1500 } });
});

test('a floating card has no project checked, and a to-do card has one Move to project entry that brings its attached items', async ({ visual: { page } }) => {
  await apply(page, [...projects,
    { type: 'item.add', id: 'loose', resourceId: 'loose-resource', pluginId: 'workspace.note', title: 'Loose thought', data: { text: 'Loose thought' }, position: { x: 1500, y: 300 } },
    { type: 'item.add', id: 'task', resourceId: 'task-resource', pluginId: 'workspace.todo', title: 'Ship the switcher', data: {}, projectId: 'billing', position: { x: 640, y: 620 } },
    { type: 'link.save', link: { id: 'task-pr', sourceId: 'task', targetId: 'pr', kind: 'reference', label: '' } },
  ]);
  await page.reload(); await expect(page.locator('[data-item-id="loose"]')).toBeVisible();
  await page.locator('[data-item-id="loose"]').click({ button: 'right', position: { x: 12, y: 12 } });
  await menu(page).getByRole('menuitem', { name: 'Move to project', exact: true }).click();
  await expect(submenu(page).getByRole('menuitemradio')).toHaveText(['Billing redesign', 'Docs site', 'Spare']);
  await expect(submenu(page).locator('[aria-checked="true"]')).toHaveCount(0); await expect(submenu(page).locator(':disabled')).toHaveCount(0);
  await target(page, 'Docs site').click();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'loose')?.projectId).toBe('docs');
  expect(await selected(page)).toEqual(['loose']);

  await page.evaluate(async () => window.craftingTable.viewWrite({ ...(await window.craftingTable.viewRead()), camera: { x: 140, y: 100, zoom: .7 } }));
  await page.reload(); await expect(page.locator('[data-item-id="task"]')).toBeVisible();
  const before = await read(page);
  await page.locator('[data-item-id="task"]').click({ button: 'right', position: { x: 6, y: 6 } });
  await expect(menu(page).getByRole('menuitem', { name: 'Move to project', exact: true })).toHaveCount(1);
  await expect(menu(page).getByRole('menuitem', { name: 'Send to project', exact: true })).toHaveCount(0);
  await menu(page).getByRole('menuitem', { name: 'Move to project', exact: true }).click();
  await expect(target(page, 'Billing redesign')).toBeDisabled();
  await target(page, 'Docs site').click();
  await expect.poll(async () => (await read(page)).nodes.filter(node => ['task', 'pr', 'brief'].includes(node.id)).map(node => [node.id, node.projectId])).toEqual([['pr', 'docs'], ['brief', 'billing'], ['task', 'docs']]);
  const after = await read(page), offset = (state: typeof after) => { const a = state.nodes.find(node => node.id === 'task')!.position, b = state.nodes.find(node => node.id === 'pr')!.position; return { x: b.x - a.x, y: b.y - a.y }; };
  expect(offset(after)).toEqual(offset(before)); expect(after.links).toEqual(before.links);
  await expect.poll(async () => { const box = (await page.locator('[data-item-id="task"]').boundingBox())!, map = (await page.locator('.map-area').boundingBox())!; return Math.hypot(box.x + box.width / 2 - map.x - map.width / 2, box.y + box.height / 2 - map.y - map.height / 2); }).toBeLessThan(4);
  expect(await selected(page)).toEqual(['task']);
});

test('a selection moves as one block from the right-clicked card and stays selected', async ({ visual: { page } }) => {
  await apply(page, projects);
  const before = await read(page);
  await card(page, 'Plan switcher').click({ modifiers: ['Shift'] }); await card(page, 'BIL-128 · Plan changes').click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual(['pr', 'ticket']);
  await card(page, 'BIL-128 · Plan changes').click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Move to project', 'Move to plot', 'Mark done', 'Send selection to Undermap']);
  await menu(page).getByRole('menuitem', { name: 'Move to project', exact: true }).click();
  await expect(target(page, 'Billing redesign')).toBeDisabled();
  await target(page, 'Docs site').click();
  await expect.poll(async () => (await read(page)).nodes.filter(node => ['pr', 'ticket'].includes(node.id)).map(node => node.projectId)).toEqual(['docs', 'docs']);
  const after = await read(page), offset = (state: typeof after) => { const a = state.nodes.find(node => node.id === 'ticket')!.position, b = state.nodes.find(node => node.id === 'pr')!.position; return { x: b.x - a.x, y: b.y - a.y }; };
  expect(after.revision).toBe(before.revision + 1); expect(offset(after)).toEqual(offset(before));
  expect(after.nodes.filter(node => !['pr', 'ticket'].includes(node.id))).toEqual(before.nodes.filter(node => !['pr', 'ticket'].includes(node.id)));
  expect(after.links).toEqual(before.links);
  await expect.poll(() => offCentre(page, 'BIL-128 · Plan changes')).toBeLessThan(4);
  expect(await selected(page)).toEqual(['pr', 'ticket']);
  await expect(page.locator('.item-view:visible')).toHaveCount(0);
});

test('moving into a muted project lands the card under the cover, which parts for a moment as with Show on map', async ({ visual: { page } }) => {
  await apply(page, [...projects, { type: 'project.mute', id: 'docs', muted: true }]);
  await expect(page.locator('[data-mute-cover="docs"]')).toHaveCount(1);
  await openMove(page, 'Plan switcher');
  await expect(submenu(page).getByRole('menuitemradio')).toHaveText(['Billing redesign', 'Docs site', 'Spare']);
  await target(page, 'Docs site').click();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'pr')?.projectId).toBe('docs');
  expect((await read(page)).nodes.find(node => node.id === 'docs')!.mutedAt).toEqual(expect.any(String));
  await expect(page.locator('[data-mute-cover="docs"]')).toHaveAttribute('data-peek', 'true');
  await expect(card(page, 'Plan switcher')).toBeVisible();
  await expect.poll(() => offCentre(page, 'Plan switcher')).toBeLessThan(4);
  await expect(page.locator('.react-flow__node[data-id="pr"]')).toHaveClass(/muted-member/);
  // Moved out of sight of Needs me with its new project.
  await expect(page.locator('[data-project-label="billing"]')).toContainText('1 asking');
});
