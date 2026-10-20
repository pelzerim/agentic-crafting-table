import { expect } from '@playwright/test';
import { test, capture, captureTerminal, openTerminal, resize, terminalResized } from './visual-fixture.ts';

test.skip(process.platform !== 'darwin', 'The supported desktop visual baseline is macOS.');

test('connection inspection emphasizes only direct relationships and explains pointer and keyboard focus', async ({ visual: { page } }) => {
  await page.getByRole('article', { name: 'Claude · implementation' }).hover();
  await expect(page.locator('.context-edge')).toHaveClass(/connection-active/);
  await expect(page.locator('.reference-edge .react-flow__edge-path')).toHaveCSS('opacity', '0.2');
  await page.mouse.move(90, 80);
  await page.locator('.context-edge').focus();
  await expect(page.getByRole('tooltip')).toHaveText('Provides context to Claude · implementation');
  await page.locator('.reference-edge').focus();
  await expect(page.getByRole('tooltip')).toHaveText('Related information');
  await page.getByRole('slider', { name: 'Map zoom' }).focus();
  await expect(page.locator('.connection-muted')).toHaveCount(0);
});

test('pinned project titles avoid real floating controls on resize without moving map items', async ({ visual: { app, page } }) => {
  const positions = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.map(node => node.position);
  for (const width of [900, 1280]) {
    await resize(app, page, width, 640);
    await expect.poll(() => page.evaluate(() => {
      const label = document.querySelector('[data-project-label="billing"]')!.getBoundingClientRect();
      return [...document.querySelectorAll('.map-status,.map-locator,.zoom-markers,.tool-rail')].every(element => {
        const r = element.getBoundingClientRect(); return !r.width || !r.height || label.right <= r.left || label.left >= r.right || label.bottom <= r.top || label.top >= r.bottom;
      });
    })).toBe(true);
  }
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.map(node => node.position)).toEqual(positions);
});

test('visual map: overview, neighborhood and hover', async ({ visual: { page } }) => {
  await expect(page.locator('[data-project-label="billing"]')).toHaveAttribute('data-over-outline', 'true');
  await capture(page, 'map-neighborhood.png');
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  await slider.focus(); await page.keyboard.press('Home');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.5');
  // Below the default dashboard threshold the project reads as its dashboard, not as icons.
  const dashboard = page.locator('[data-dashboard="billing"]');
  await expect(dashboard).toBeVisible();
  await expect(page.getByRole('article', { name: 'Billing redesign', exact: true })).toHaveCount(0);
  await capture(page, 'map-overview.png');
  await dashboard.locator('.dashboard-title').click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-level', 'neighborhood');
  await page.getByRole('article', { name: 'Claude · implementation' }).hover();
  await expect(page).toHaveScreenshot('map-item-hover.png');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Claude · implementation', exact: true })).not.toHaveAttribute('title');
  await page.mouse.move(90, 80);
  await page.locator('.react-flow__node[data-id="agent"]').focus();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Claude · implementation', exact: true })).not.toHaveAttribute('title');
  await slider.focus();
  const outline = page.locator('[data-project-outline="billing"]');
  const top = (await outline.boundingBox())!.y, dy = Math.round(120 - top);
  await page.mouse.move(90, 80); await page.mouse.down();
  await page.mouse.move(90, 80 + dy, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await outline.boundingBox())!.y).toBeCloseTo(top + dy, 0);
  const label = (await page.locator('[data-project-label="billing"]').boundingBox())!, enclosure = (await outline.boundingBox())!;
  expect(label.y + label.height).toBeLessThan(enclosure.y);
  expect(label.x + label.width / 2).toBeCloseTo(enclosure.x + enclosure.width / 2, 0);
  await capture(page, 'map-title-above.png');
});

test('visual diagonal neighborhood follows its two members and hit tests the same enclosure', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'diagonal-group', actor: { kind: 'user', id: 'fixture' }, expectedRevision: state.revision, commands: [
      { type: 'node.archive', id: 'pr' }, { type: 'node.archive', id: 'ticket' }, { type: 'node.archive', id: 'brief' },
      { type: 'node.move', id: 'agent', position: { x: 900, y: 300 } },
      { type: 'item.add', id: 'todo', resourceId: 'todo-resource', pluginId: 'workspace.todo', title: 'Check sizing', data: {}, projectId: 'billing', position: { x: 300, y: 600 } },
    ] });
  });
  await expect(page.getByRole('article', { name: 'Check sizing' })).toBeVisible();
  await expect(page.locator('.map-card')).toHaveCount(2);
  const outline = page.locator('[data-project-outline="billing"]'), bounds = (await outline.boundingBox())!;
  expect(bounds.width).toBeGreaterThan(bounds.height * 1.4);
  const inside = await outline.evaluate((path: SVGGeometryElement) => [
    new DOMPoint(300, 600), new DOMPoint(600, 450), new DOMPoint(900, 300),
    new DOMPoint(200, 50), new DOMPoint(1000, 850),
  ].map(point => path.isPointInFill(point)));
  expect(inside).toEqual([true, true, true, false, false]);
  await capture(page, 'map-diagonal-neighborhood.png');
  // Use the actual rendered transform: creation must agree with the visible fill.
  for (const [point, project] of [[{ x: 600, y: 450 }, 'billing'], [{ x: 200, y: 50 }, '']] as const) {
    const screen = await outline.evaluate((path: SVGGeometryElement, point) => {
      const p = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!); return { x: p.x, y: p.y };
    }, point);
    await page.mouse.click(screen.x, screen.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'New item', exact: true }).click();
    await expect(page.getByRole('form', { name: 'New item' })).toHaveAttribute('data-project-id', project);
    await page.keyboard.press('Escape');
  }
});

test('visual forms: item picker, new agent, URL attachment and settings', async ({ visual: { app, page } }) => {
  await page.mouse.click(450, 190, { button: 'right' });
  await page.getByRole('menuitem', { name: 'New item', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agent session', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'New item' })).toHaveAttribute('data-project-id', 'billing');
  await capture(page, 'creation-picker.png');
  await page.getByRole('button', { name: 'Agent session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue('/tmp');
  await capture(page, 'creation-agent.png');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'From URL', exact: true }).click();
  await page.getByLabel('Item URL').fill('https://github.com/fixture/billing/pull/42');
  await expect(page.locator('.detected-item')).toHaveText('GitHub pull request');
  await capture(page, 'creation-pr.png');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Remote Control', { exact: true })).toBeChecked();
  await capture(page, 'settings.png');
  const linear = page.locator('[data-provider=linear]');
  await linear.getByRole('button', { name: 'How to connect', exact: true }).click();
  await expect(linear.getByRole('button', { name: 'Copy command for step 2', exact: true })).toBeVisible();
  await linear.scrollIntoViewIfNeeded(); await capture(page, 'settings-connections-setup.png');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await resize(app, page, 900, 640);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Remote Control', { exact: true })).toBeChecked();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await dialog.locator('.settings-content').hover(); await page.mouse.wheel(0, await dialog.locator('.settings-content').evaluate(element => element.scrollHeight));
  await expect.poll(async () => {
    const panel = (await dialog.boundingBox())!, save = (await page.getByRole('button', { name: 'Save settings' }).boundingBox())!;
    return save.y + save.height <= panel.y + panel.height - 2;
  }).toBe(true);
  await capture(page, 'settings-narrow.png');
  await page.getByLabel('Neighborhood padding', { exact: true }).fill('320');
  await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await expect(page.getByLabel('Neighborhood padding', { exact: true })).toHaveValue('320');
  await expect(page.getByRole('status').filter({ hasText: '1 unsaved change · Map' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Map', exact: true }).locator('.settings-tree-marker')).toHaveAttribute('data-marker', 'dirty');
  for (const name of ['Save settings', 'Discard', 'Close settings']) {
    const control = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(control.y).toBeGreaterThanOrEqual(0); expect(control.y + control.height).toBeLessThanOrEqual(640);
  }
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.neighborhoodPadding).toBe(240);
});

test('visual native terminal: full item at regular and narrow sizes', async ({ visual: { app, page } }) => {
  await openTerminal(page);
  await expect(page.locator('[data-project-label="billing"]')).not.toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Map location' })).toBeVisible();
  await terminalResized(page);
  const todoIcon = (await page.getByRole('button', { name: /Keep to-dos open|Close to-dos/ }).boundingBox())!, terminal = (await page.locator('.terminal-host').boundingBox())!;
  expect(todoIcon.x + todoIcon.width).toBeLessThan(terminal.x);
  await captureTerminal(page, 'terminal-expanded.png');
  await resize(app, page, 900, 640);
  // Wait for the real PTY resize and ANSI redraw, not an arbitrary screenshot delay.
  await terminalResized(page);
  await expect(page.locator('footer')).toHaveCount(0);
  await expect(page.locator('[data-project-field="billing"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toHaveClass('session-stop');
  await captureTerminal(page, 'terminal-narrow.png');
});


test('pixel controls retain clear normal, selected, disabled, hover and keyboard-focus states', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await expect(settings.getByText('New item shortcuts', { exact: true })).toBeHidden();
  await settings.getByLabel('Neighborhood padding').focus();
  await settings.getByRole('button', { name: /^Advanced settings/ }).hover();
  await expect(settings.getByLabel('Neighborhood padding')).toBeFocused();
  await expect(settings.locator('.settings-field:focus-within')).not.toHaveCSS('box-shadow', 'none');
  await expect(settings.getByRole('treeitem', { name: 'Map', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(settings).toHaveScreenshot('pixel-controls-states.png');
  await settings.getByRole('treeitem', { name: 'Items', exact: true }).click();
  await settings.getByText('New item shortcuts', { exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Move Project earlier' })).toBeDisabled();
});
