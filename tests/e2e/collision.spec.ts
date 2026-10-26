import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const preview = (page: Page) => page.locator('[data-item-id]').evaluateAll(items => Object.fromEntries(items.map(item => [item.getAttribute('data-item-id')!, { x: Number(item.getAttribute('data-world-x')), y: Number(item.getAttribute('data-world-y')) }])));
async function expectClear(page: Page) {
  expect(await page.locator('.map-card').evaluateAll(items => {
    const boxes = items.map(item => item.getBoundingClientRect());
    const gap = Number(document.querySelector('.map-area')!.getAttribute('data-zoom')) * 20;
    return boxes.every((a, i) => boxes.slice(i + 1).every(b => a.right + gap <= b.left + .01 || b.right + gap <= a.left + .01 || a.bottom + gap <= b.top + .01 || b.bottom + gap <= a.top + .01));
  })).toBe(true);
}

test.describe('older overlapping layouts', () => {
  test.use({ legacyLayout: true });
  test('clear overlaps repairs the table explicitly and persists without changing metadata', async ({ visual: { page } }) => {
    const before = await read(page);
    expect(new Set(before.nodes.filter(node => node.resourceId).map(node => JSON.stringify(node.position))).size).toBe(1);
    const slider = page.getByRole('slider', { name: 'Map zoom' });
    await slider.focus(); await page.keyboard.press('End');
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1.35');
    expect((await read(page)).nodes).toEqual(before.nodes);
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    expect((await read(page)).nodes).toEqual(before.nodes);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    await page.getByRole('button', { name: 'Clear overlaps…', exact: true }).click(); await page.getByRole('button', { name: 'Clear overlaps', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Overlaps cleared.' })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect.poll(async () => (await read(page)).revision).toBe(before.revision + 1);
    await expectClear(page);
    const repaired = await read(page);
    expect(repaired.nodes.map(({ position, ...node }) => node)).toEqual(before.nodes.map(({ position, ...node }) => node));
    expect(repaired.resources).toEqual(before.resources); expect(repaired.links).toEqual(before.links);
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    expect((await read(page)).nodes).toEqual(repaired.nodes); await expectClear(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    await page.getByRole('button', { name: 'Clear overlaps…', exact: true }).click(); await page.getByRole('button', { name: 'Clear overlaps', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Overlaps cleared.' })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect.poll(async () => (await read(page)).revision).toBe(repaired.revision + 1);
    expect((await read(page)).nodes).toEqual(repaired.nodes);
  });
});

test('max-zoom drag displaces full cards before drop, commits the preview once and survives reload', async ({ visual: { page } }, testInfo) => {
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  await slider.focus(); await page.keyboard.press('End');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1.35');
  // Pan the enlarged cards into the viewport before starting the surface drag.
  await page.mouse.move(600, 200); await page.mouse.down();
  await page.mouse.move(100, 100, { steps: 10 }); await page.mouse.up();
  const before = await read(page), pr = page.getByRole('article', { name: 'Plan switcher' }), agent = page.getByRole('article', { name: 'Claude · implementation' });
  await page.evaluate(() => window.craftingPerformance.reset());
  const from = (await pr.boundingBox())!, to = (await agent.boundingBox())!;
  const target = { x: Math.round(to.x + to.width / 2), y: Math.round(to.y + to.height / 2) };
  await page.mouse.move(Math.round(from.x + from.width / 2), Math.round(from.y + from.height / 2)); await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await expect.poll(async () => (await preview(page)).agent).not.toEqual(before.nodes.find(node => node.id === 'agent')!.position);
  await expectClear(page);
  const held = (await pr.boundingBox())!;
  expect(Math.abs(held.x + held.width / 2 - target.x)).toBeLessThan(1);
  expect(Math.abs(held.y + held.height / 2 - target.y)).toBeLessThan(1);
  const projected = await preview(page);
  expect((await read(page)).nodes).toEqual(before.nodes); // Nothing persisted before mouse-up.
  expect((await page.evaluate(() => window.craftingPerformance.snapshot())).metrics['map.placement'].count).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('collision-preview.png') });
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).revision).toBe(before.revision + 1);
  const saved = await read(page);
  for (const node of saved.nodes) {
    expect(node.position.x).toBeCloseTo(projected[node.id].x, 6);
    expect(node.position.y).toBeCloseTo(projected[node.id].y, 6);
  }
  expect(saved.resources).toEqual(before.resources); expect(saved.links).toEqual(before.links);
  for (const id of ['billing', 'ticket', 'brief']) expect(saved.nodes.find(node => node.id === id)).toEqual(before.nodes.find(node => node.id === id));
  await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
  expect((await read(page)).nodes).toEqual(saved.nodes); await expectClear(page);
  await page.evaluate(() => window.craftingPerformance.reset());
  await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('End');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1.35');
  await expectClear(page);
  expect((await read(page)).nodes).toEqual(saved.nodes);
  expect((await page.evaluate(() => window.craftingPerformance.snapshot())).metrics['map.placement'].count).toBe(0);
});

test('project dragging keeps member offsets while clearing a floating obstruction; keyboard moves use the same rule', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'obstacle', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'obstacle', resourceId: 'obstacle-r', pluginId: 'linear.ticket', title: 'Floating obstacle', data: { issueId: 'T-200' }, position: { x: 1260, y: 300 } },
    ] });
  });
  await expect(page.getByRole('article', { name: 'Floating obstacle' })).toBeVisible();
  const before = await read(page), title = (await page.locator('[data-project-label="billing"]').boundingBox())!;
  await page.mouse.move(Math.round(title.x + title.width / 2), Math.round(title.y + title.height / 2)); await page.mouse.down();
  await page.mouse.move(Math.round(title.x + title.width / 2) + 210, Math.round(title.y + title.height / 2), { steps: 12 });
  await expect.poll(async () => (await preview(page)).obstacle).not.toEqual(before.nodes.find(node => node.id === 'obstacle')!.position);
  await expectClear(page);
  const projected = await preview(page);
  const dx = projected.billing.x - before.nodes[0].position.x, dy = projected.billing.y - before.nodes[0].position.y;
  expect(dx).toBeCloseTo(300, 6); expect(dy).toBeCloseTo(0, 6);
  for (const node of before.nodes.filter(node => node.projectId === 'billing')) {
    expect(projected[node.id].x - node.position.x).toBeCloseTo(dx, 6);
    expect(projected[node.id].y - node.position.y).toBeCloseTo(dy, 6);
  }
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).revision).toBe(before.revision + 1);
  expect(Object.fromEntries((await read(page)).nodes.map(node => [node.id, node.position]))).toEqual(projected);
  // Move the obstacle toward the PR by keyboard: it stays at the requested spot,
  // while the PR is displaced. No node is opened and membership remains floating.
  const prior = await read(page), obstruction = prior.nodes.find(node => node.id === 'obstacle')!, pr = prior.nodes.find(node => node.id === 'pr')!;
  const key = obstruction.position.y < pr.position.y ? 'ArrowDown' : 'ArrowUp';
  await page.locator('.react-flow__node[data-id="obstacle"]').focus(); await page.keyboard.press(key);
  await expect.poll(async () => (await read(page)).revision).toBe(prior.revision + 1);
  const after = await read(page), shifted = after.nodes.find(node => node.id === 'obstacle')!;
  expect(shifted.position).toEqual({ x: obstruction.position.x, y: obstruction.position.y + (key === 'ArrowDown' ? 10 : -10) });
  expect(shifted.projectId).toBeUndefined();
  expect(after.nodes.find(node => node.id === 'pr')!.position).not.toEqual(pr.position);
  await expectClear(page);
});

test('with solid collisions a dragged card stops at the card in its way and nothing is pushed aside', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapCollisions: 'solid' } });
  });
  const before = await read(page), pr = page.getByRole('article', { name: 'Plan switcher' }), agent = page.getByRole('article', { name: 'Claude · implementation' });
  const from = (await pr.boundingBox())!, to = (await agent.boundingBox())!, { pr: start, ...resting } = await preview(page);
  await page.mouse.move(Math.round(from.x + from.width / 2), Math.round(from.y + from.height / 2)); await page.mouse.down();
  await page.mouse.move(Math.round(to.x + to.width / 2), Math.round(to.y + to.height / 2), { steps: 12 });
  const { pr: held, ...dragging } = await preview(page);
  expect(dragging).toEqual(resting); expect(held).not.toEqual(start);
  await expectClear(page);
  await page.mouse.up();
  const others = (nodes: { id: string; position: unknown }[]) => nodes.filter(node => node.id !== 'pr').map(node => node.position);
  await expect.poll(async () => (await read(page)).revision).toBe(before.revision + 1);
  const after = await read(page);
  expect(others(after.nodes)).toEqual(others(before.nodes));
  expect(after.nodes.find(node => node.id === 'pr')!.position).not.toEqual(before.nodes.find(node => node.id === 'pr')!.position);
  await expectClear(page);
});
