import { expect } from '@playwright/test';
import { choose } from './combobox.ts';
import type { Page } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function plus(page: Page, name: string, target: { x: number; y: number }) {
  const card = page.getByRole('article', { name, exact: true }); await card.hover();
  const handle = (await card.getByRole('button', { name: `Connect ${name}`, exact: true }).boundingBox())!;
  const bounds = (await card.boundingBox())!;
  expect(handle.y + handle.height / 2).toBeCloseTo(bounds.y + bounds.height / 2, 0);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await expect(page.getByLabel('Connection preview', { exact: true })).toBeVisible();
  await page.mouse.up();
}

test('dragging connections creates directed context, supports keyboard selection, and creates connected items inline', async ({ visual: { page } }) => {
  const before = await read(page), agent = (await page.getByRole('article', { name: 'Claude · implementation', exact: true }).boundingBox())!;
  await plus(page, 'Billing experience', { x: agent.x + agent.width / 2, y: agent.y + agent.height / 2 });
  await expect.poll(async () => (await read(page)).links.length).toBe(before.links.length + 1);
  await expect(page.getByRole('form', { name: 'Connect items' })).toHaveCount(0);
  const connected = await read(page);
  expect(connected.nodes).toEqual(before.nodes);
  expect(connected.links.some(link => link.sourceId === 'brief' && link.targetId === 'agent' && link.kind === 'context')).toBe(true);
  // Verify the direct drop survived reload and start the keyboard capture without
  // a retained hover-compositor layer on the small, fractionally scaled source.
  await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
  expect((await read(page)).links).toEqual(connected.links);
  await page.getByRole('button', { name: 'Connect Plan switcher', exact: true }).focus();
  const prBounds = (await page.getByRole('article', { name: 'Plan switcher', exact: true }).boundingBox())!;
  await expect(page.getByRole('article', { name: 'Plan switcher', exact: true })).toHaveAttribute('data-preview', 'false');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Connect to', { exact: true })).toBeFocused();
  await choose(page, 'Connect to', 'agent');
  await expect(page.getByLabel('Relationship', { exact: true })).toHaveCount(0);
  const pickerBounds = (await page.getByRole('form', { name: 'Connect items' }).boundingBox())!;
  expect(pickerBounds.x).toBe(Math.round(pickerBounds.x)); expect(pickerBounds.y).toBe(Math.round(pickerBounds.y));
  const agentBounds = (await page.getByRole('article', { name: 'Claude · implementation', exact: true }).boundingBox())!;
  const overlaps = (a: typeof prBounds, b: typeof prBounds) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlaps(pickerBounds, prBounds)).toBe(false); expect(overlaps(pickerBounds, agentBounds)).toBe(false);
  await expect(page.locator('[data-map-highlight="agent"]')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: 'Context' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('form', { name: 'Connect items' })).toContainText('Context: the agent reads this item while it works.');
  await capture(page, 'connection-endpoint-picker.png');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(async () => (await read(page)).links.length).toBe(before.links.length + 2);
  expect((await read(page)).links).toContainEqual(expect.objectContaining({ sourceId: 'pr', targetId: 'agent', kind: 'context' }));
  await plus(page, 'Claude · implementation', { x: 450, y: 510 });
  const form = page.getByRole('form', { name: 'New item' });
  await expect(form).toHaveAttribute('data-project-id', 'billing');
  await page.getByRole('button', { name: 'To-do', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Validate plan changes');
  await expect(page.getByLabel('Relationship', { exact: true })).toHaveCount(0);
  const revision = (await read(page)).revision;
  await page.getByRole('button', { name: 'Add to-do', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Validate plan changes', exact: true })).toBeVisible();
  const created = await read(page), task = created.nodes.find(node => node.title === 'Validate plan changes')!;
  expect(created.revision).toBe(revision + 1); expect(task.projectId).toBe('billing');
  expect(created.links.some(link => link.sourceId === task.id && link.targetId === 'agent' && link.kind === 'context')).toBe(true);
  await page.reload(); await expect(page.getByRole('article', { name: 'Validate plan changes', exact: true })).toBeVisible();
  expect((await read(page)).links).toEqual(created.links);
  await plus(page, 'Validate plan changes', { x: 860, y: 620 });
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Connected terminal');
  await page.getByLabel('Working directory', { exact: true }).fill('/tmp');
  await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
  const terminal = page.getByRole('article', { name: 'Connected terminal', exact: true }); await expect(terminal).toBeVisible();
  const withTerminal = await read(page), terminalNode = withTerminal.nodes.find(node => node.title === 'Connected terminal')!;
  expect(withTerminal.links.some(link => link.sourceId === task.id && link.targetId === terminalNode.id && link.kind === 'reference')).toBe(true);
  await terminal.click(); await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');

});

test('direct drops reverse context toward the source agent, fall back to information, and reject duplicates without opening a menu', async ({ visual: { page } }) => {
  const drop = async (from: string, to: string) => {
    const bounds = (await page.getByRole('article', { name: to, exact: true }).boundingBox())!;
    await plus(page, from, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  };
  const before = await read(page);
  await drop('Claude · implementation', 'Billing experience');
  await expect.poll(async () => (await read(page)).links.length).toBe(before.links.length + 1);
  expect((await read(page)).links).toContainEqual(expect.objectContaining({ sourceId: 'brief', targetId: 'agent', kind: 'context' }));
  await drop('BIL-128 · Plan changes', 'Billing experience');
  await expect.poll(async () => (await read(page)).links.length).toBe(before.links.length + 2);
  expect((await read(page)).links).toContainEqual(expect.objectContaining({ sourceId: 'ticket', targetId: 'brief', kind: 'reference' }));
  const connected = await read(page);
  await drop('Billing experience', 'Claude · implementation');
  await expect(page.getByRole('alert')).toContainText('already have this relationship');
  expect(await read(page)).toEqual(connected);
  await expect(page.getByRole('form', { name: 'Connect items' })).toHaveCount(0);
  await expect(page.getByLabel('Relationship', { exact: true })).toHaveCount(0);
  // Earlier explicit links are never reclassified, including after a reload.
  for (const link of before.links) expect(connected.links).toContainEqual(link);
  await page.reload(); await expect(page.getByRole('article', { name: 'Billing experience', exact: true })).toBeVisible();
  expect((await read(page)).links).toEqual(connected.links);
});

test('a floating drop previews attachment, empty-space drops preserve ownership, and settings can detach', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'floating', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'float', resourceId: 'float-r', pluginId: 'workspace.todo', title: 'Floating task', data: {}, position: { x: 80, y: 600 } },
    ] });
  });
  const card = page.getByRole('article', { name: 'Floating task', exact: true }); await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(470, 510, { steps: 12 });
  await expect(page.locator('[data-project-outline="billing"]')).toHaveAttribute('data-attach-preview', 'true');
  await expect(page.getByText('Attach to Billing redesign', { exact: true })).toBeVisible();
  expect((await read(page)).nodes.find(node => node.id === 'float')!.projectId).toBeUndefined();
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'float')!.projectId).toBe('billing');
  const owned = (await card.boundingBox())!;
  await page.mouse.move(owned.x + owned.width / 2, owned.y + owned.height / 2); await page.mouse.down(); await page.mouse.move(160, 650, { steps: 12 }); await page.mouse.up();
  expect((await read(page)).nodes.find(node => node.id === 'float')!.projectId).toBe('billing');
  await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Item settings…' }).click();
  await page.getByLabel('Project membership', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'float')!.projectId).toBeUndefined();
  await page.reload(); await expect(card).toBeVisible();
  expect((await read(page)).nodes.find(node => node.id === 'float')!.projectId).toBeUndefined();
});

test('connections are direct boundary-to-boundary lines through dragging and semantic zoom', async ({ visual: { page } }) => {
  // Covers item icons at far zoom, which show when project dashboards are off.
  await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, enabled: false, belowZoom: .45, placement: 'center' } } }); });
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'diagonal-links', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'node.move', id: 'ticket', position: { x: 960, y: 620 } },
    ] });
  });
  const path = page.locator('.react-flow__edge[data-id="ticket-agent"] .react-flow__edge-path');
  await expect(path).toBeVisible();
  async function check(source: string, target: string, id: string, directed: boolean) {
    const edge = page.locator(`.react-flow__edge[data-id="${id}"]`), visible = edge.locator('.react-flow__edge-path');
    await expect(visible).toHaveAttribute('d', /^M [-\d.e]+,[-\d.e]+ L [-\d.e]+,[-\d.e]+$/);
    const errors = await visible.evaluate((path: SVGPathElement, { source, target }) => {
      const a = document.querySelector(`[data-item-id="${source}"]`)!.getBoundingClientRect();
      const b = document.querySelector(`[data-item-id="${target}"]`)!.getBoundingClientRect();
      const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const dx = bc.x - ac.x, dy = bc.y - ac.y;
      return [0, path.getTotalLength()].map((distance, i) => {
        const p = path.getPointAtLength(distance), point = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
        const rect = i ? b : a;
        return {
          boundary: Math.min(Math.abs(point.x - rect.left), Math.abs(point.x - rect.right), Math.abs(point.y - rect.top), Math.abs(point.y - rect.bottom)),
          line: Math.abs((point.x - ac.x) * dy - (point.y - ac.y) * dx) / Math.hypot(dx, dy),
          within: point.x >= rect.left - .1 && point.x <= rect.right + .1 && point.y >= rect.top - .1 && point.y <= rect.bottom + .1,
        };
      });
    }, { source, target });
    for (const error of errors) { expect(error.boundary).toBeLessThan(.1); expect(error.line).toBeLessThan(.1); expect(error.within).toBe(true); }
    expect(Boolean(await visible.getAttribute('marker-end'))).toBe(directed);
    expect(await edge.locator('.react-flow__edge-interaction').getAttribute('d')).toBe(await visible.getAttribute('d'));
    await expect(edge.locator('.react-flow__edge-interaction')).toHaveAttribute('stroke-width', '24');
  }
  await check('ticket', 'agent', 'ticket-agent', true);
  await check('brief', 'pr', 'brief-pr', false);
  await capture(page, 'map-direct-connections.png');
  const original = await path.getAttribute('d'), agent = (await page.getByRole('article', { name: 'Claude · implementation', exact: true }).boundingBox())!;
  await page.mouse.move(agent.x + agent.width / 2, agent.y + agent.height / 2); await page.mouse.down();
  await page.mouse.move(agent.x + agent.width / 2 - 100, agent.y + agent.height / 2 + 100, { steps: 10 });
  await expect.poll(() => path.getAttribute('d')).not.toBe(original);
  await check('ticket', 'agent', 'ticket-agent', true); // Correct before releasing the pointer.
  await page.mouse.up();
  await check('ticket', 'agent', 'ticket-agent', true);
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  // Move off the dragged item as a user would to reach the zoom control. A
  // programmatic focus alone deliberately retains its preview through zoom;
  // at overview scale that preview can cover the other endpoint completely.
  await slider.hover();
  for (const key of ['Home', 'End']) {
    await slider.focus(); await page.keyboard.press(key);
    await check('ticket', 'agent', 'ticket-agent', true);
    await check('brief', 'pr', 'brief-pr', false);
    for (const d of await page.locator('.project-membership-edge .react-flow__edge-path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))) expect(d).toMatch(/^M [^L]+ L [^L]+$/);
  }
});
