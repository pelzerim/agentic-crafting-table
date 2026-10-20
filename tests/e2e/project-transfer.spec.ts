import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, openTerminal } from './visual-fixture.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const screenPoint = (page: Page, point: { x: number; y: number }) => page.locator('[data-project-outline]').first().evaluate((path: SVGGeometryElement, point) => {
  const p = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!); return { x: p.x, y: p.y };
}, point);
async function grab(page: Page, id: string) {
  const card = page.locator(`[data-item-id="${id}"]`); await expect(card).toBeVisible();
  const bounds = (await card.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
}
async function move(page: Page, point: { x: number; y: number }) {
  const screen = await screenPoint(page, point); await page.mouse.move(screen.x, screen.y, { steps: 12 });
}

test('dragging between populated projects previews and commits ownership with collision placement, links and to-do grouping', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'transfer-setup', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'project.create', id: 'release', title: 'Release', summary: '', position: { x: 1900, y: 400 } },
      { type: 'item.add', id: 'destination', resourceId: 'destination-r', pluginId: 'workspace.note', projectId: 'release', title: 'Release notes', position: { x: 1900, y: 400 }, data: { text: 'Watch the release' } },
      { type: 'todo.save', todo: { id: 'follow', title: 'Follow implementation', completed: false, nodeIds: ['agent'] } },
    ] });
    await window.craftingTable.viewWrite({ ...(await window.craftingTable.viewRead()), camera: { x: 50, y: 100, zoom: .5 } });
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, enabled: false, belowZoom: .65, placement: 'center' } } });
  });
  await page.reload(); await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.5');
  const before = await read(page), destination = before.nodes.find(node => node.id === 'destination')!;
  await grab(page, 'agent'); await move(page, destination.position);
  await expect(page.getByText('Move to Release', { exact: true })).toBeVisible();
  await expect(page.locator('[data-project-outline="release"]')).toHaveAttribute('data-attach-preview', 'true');
  expect(await read(page)).toEqual(before);
  const preview = await page.locator('[data-item-id="destination"]').boundingBox();
  const held = await page.locator('[data-item-id="agent"]').evaluate(element => ({ x: Number(element.getAttribute('data-world-x')), y: Number(element.getAttribute('data-world-y')) }));
  expect(held.x).toBeCloseTo(destination.position.x, 0); expect(held.y).toBeCloseTo(destination.position.y, 0);
  await expect(page).toHaveScreenshot('project-transfer-preview.png');
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'agent')?.projectId).toBe('release');
  const after = await read(page);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.nodes.find(node => node.id === 'agent')).toEqual({ ...before.nodes.find(node => node.id === 'agent'), position: held, projectId: 'release' });
  expect(after.nodes.find(node => node.id === 'destination')!.position).not.toEqual(destination.position);
  expect(await page.locator('[data-item-id="destination"]').boundingBox()).toEqual(preview);
  expect(after.resources).toEqual(before.resources); expect(after.links).toEqual(before.links); expect(after.todos).toEqual(before.todos);
  await expect(page.locator('[data-project-label="billing"]')).not.toContainText('working');
  await expect(page.locator('[data-project-label="release"]')).toContainText('1 working');
  await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).hover();
  // The to-do follows its attachment's project, shown as the chip on its row (TODO-02).
  await expect(page.locator('.todo-row', { hasText: 'Follow implementation' }).locator('.todo-project')).toHaveText('Release');
  await page.reload(); await expect(page.locator('[data-item-id="agent"]')).toBeVisible();
  expect((await read(page)).nodes).toEqual(after.nodes);
  await page.locator('.react-flow__node[data-id="release"]').focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'agent')!.position.x).toBe(held.x + 10);
  expect((await read(page)).nodes.find(node => node.id === 'ticket')).toEqual(before.nodes.find(node => node.id === 'ticket'));
  await grab(page, 'agent'); await move(page, { x: 800, y: 350 });
  await expect(page.getByText('Move to Billing redesign', { exact: true })).toBeVisible(); await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'agent')!.projectId).toBe('billing');
  expect((await read(page)).links).toEqual(before.links);
});

test('an owned item transfers only inside the drawn, curved edge of a spread-out neighbourhood', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'curve-setup', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'project.create', id: 'release', title: 'Release', summary: '', position: { x: 1900, y: 400 } },
      ...[[1900, 400], [2900, 400], [1900, 1400]].map(([x, y], i) => ({ type: 'item.add' as const, id: `corner-${i}`, resourceId: `corner-${i}-r`, pluginId: 'workspace.note', projectId: 'release', title: `Corner ${i}`, position: { x, y }, data: { text: 'Release corner' } })),
    ] });
    await window.craftingTable.viewWrite({ ...(await window.craftingTable.viewRead()), camera: { x: 0, y: 40, zoom: .35 } });
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, enabled: false, belowZoom: .25, placement: 'center' } } });
  });
  await page.reload(); await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.35');
  const before = await read(page), owner = before.nodes.find(node => node.id === 'agent')!.projectId;
  // The lower-right stair corner of the diagonal run is where the curve bows furthest past the straight padded edge.
  const edge = await page.locator('[data-project-outline="release"]').evaluate(path => (path.getAttribute('d')!.match(/-?[\d.]+,-?[\d.]+/g) ?? [])
    .map(pair => pair.split(',').map(Number)).reduce((best, point) => point[0] + point[1] > best[0] + best[1] ? point : best));
  const note = (await page.locator('[data-item-id="corner-1"]').boundingBox())!;
  const straight = (2900 + note.width / .35 / 2 + 400 + note.height / .35 / 2) / Math.SQRT2 + 240;
  expect((edge[0] + edge[1] - 24) / Math.SQRT2).toBeGreaterThan(straight);
  await grab(page, 'agent'); await move(page, { x: edge[0] + 12, y: edge[1] + 12 });
  await expect(page.getByText('Move to Release', { exact: true })).toHaveCount(0);
  await move(page, { x: edge[0] - 12, y: edge[1] - 12 });
  await expect(page.getByText('Move to Release', { exact: true })).toBeVisible();
  await move(page, { x: edge[0] + 12, y: edge[1] + 12 });
  await expect(page.getByText('Move to Release', { exact: true })).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).revision).toBe(before.revision + 1);
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.projectId).toBe(owner);
  await grab(page, 'agent'); await move(page, { x: edge[0] - 12, y: edge[1] - 12 }); await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'agent')?.projectId).toBe('release');
});

test('a running terminal transfers as the last member to an empty project without restarting or moving its anchor', async ({ visual: { page } }) => {
  await openTerminal(page);
  const sessionId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const originalSession = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session;
  await page.getByRole('button', { name: 'Back to project' }).click();
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'terminal-transfer-setup', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      ...['agent', 'pr', 'ticket', 'brief'].map(id => ({ type: 'node.archive' as const, id })),
      { type: 'project.create', id: 'empty', title: 'Empty project', summary: '', position: { x: 1800, y: 400 } },
    ] });
    await window.craftingTable.viewWrite({ ...(await window.craftingTable.viewRead()), camera: { x: -400, y: 50, zoom: .8 } });
  });
  await page.reload(); await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.8');
  const before = await read(page), terminal = before.nodes.find(node => node.id === originalSession.nodeId)!;
  await grab(page, terminal.id); await move(page, { x: 1800, y: 400 });
  await expect(page.getByText('Move to Empty project', { exact: true })).toBeVisible();
  // Moving away cancels the transfer preview, but never detaches the item.
  await move(page, { x: 1150, y: 800 }); await expect(page.locator('.attachment-preview')).toHaveCount(0);
  expect(await read(page)).toEqual(before);
  await move(page, { x: 1800, y: 400 });
  await expect(page.getByText('Move to Empty project', { exact: true })).toBeVisible();
  const held = await page.locator(`[data-item-id="${terminal.id}"]`).evaluate(element => ({ x: Number(element.getAttribute('data-world-x')), y: Number(element.getAttribute('data-world-y')) }));
  expect(held.x).toBeCloseTo(1800, 0); expect(held.y).toBeCloseTo(400, 0);
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === terminal.id)!.projectId).toBe('empty');
  const after = await read(page);
  expect(after.nodes.find(node => node.id === 'empty')).toEqual(before.nodes.find(node => node.id === 'empty'));
  expect(after.nodes.find(node => node.id === terminal.id)).toEqual({ ...terminal, projectId: 'empty', position: held });
  expect(after.resources).toEqual(before.resources); expect(after.links).toEqual(before.links);
  await page.reload(); await expect(page.locator('[data-project-label="empty"]')).toBeVisible();
  const session = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session;
  expect(session.pid).toBe(originalSession.pid); expect(session.state).toBe('running'); expect(session.cwd).toBe(originalSession.cwd);
  expect((await read(page)).nodes.find(node => node.id === terminal.id)!.projectId).toBe('empty');
});
