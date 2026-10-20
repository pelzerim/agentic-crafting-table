import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as workspaceTest, openTerminal, resize } from './visual-fixture.ts';

test('wheel zoom preserves world coordinates and focus retains the terminal mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-spatial-'));
  const app = await electron.launch({ args: ['.', '--renderer-spike'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const card = page.locator('[data-item-id="terminal"]');
    await expect(card).toBeVisible();
    const coordinates = await card.evaluate(element => [element.getAttribute('data-world-x'), element.getAttribute('data-world-y')]);
    const map = page.locator('.map-area');
    const startZoom = Number(await map.getAttribute('data-zoom'));
    const frameTimes = page.evaluate(() => new Promise<number[]>(resolve => {
      const samples: number[] = []; let previous = performance.now();
      const frame = (time: number) => { samples.push(time - previous); previous = time; if (samples.length === 90) resolve(samples.slice(1)); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }));
    await page.mouse.move(300, 160);
    await page.mouse.wheel(0, 130);
    await expect.poll(async () => Number(await map.getAttribute('data-zoom'))).toBeLessThan(startZoom);
    expect(await card.evaluate(element => [element.getAttribute('data-world-x'), element.getAttribute('data-world-y')])).toEqual(coordinates);
    await expect(page.locator('[data-project-outline="billing"]')).toBeVisible();
    await card.click();
    await expect(map).toHaveAttribute('data-focus', 'terminal');
    const terminal = page.locator('[data-terminal-id="renderer-fixture"]');
    await expect(terminal).toBeVisible();
    const mount = await terminal.getAttribute('data-mount-id');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.type('hello table');
    await expect(page.locator('[data-project-field="billing"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/spatial-focus.png' });
    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect(map).toHaveAttribute('data-focus', '');
    await card.click();
    await expect(terminal).toHaveAttribute('data-mount-id', mount!);
    expect(await card.evaluate(element => [element.getAttribute('data-world-x'), element.getAttribute('data-world-y')])).toEqual(coordinates);
    expect(errors).toEqual([]);
    const samples = (await frameTimes).sort((a, b) => a - b);
    console.log(`Four-item renderer fixture p95 frame interval: ${samples[Math.floor(samples.length * .95)].toFixed(1)} ms`);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('surface dragging a project translates members and panning leaves world positions intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-drag-'));
  const app = await electron.launch({ args: ['.', '--renderer-spike'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    const positions = () => page.locator('[data-item-id]').evaluateAll(items => Object.fromEntries(items.map(item => [item.getAttribute('data-item-id'), [Number(item.getAttribute('data-world-x')), Number(item.getAttribute('data-world-y'))]])));
    await expect(page.locator('[data-item-id="billing"]')).toBeVisible();
    const before = await positions();
    const project = (await page.locator('[data-item-id="billing"]').boundingBox())!;
    await page.mouse.move(project.x + project.width / 2, project.y + project.height / 2);
    await page.mouse.down();
    await page.mouse.move(project.x + project.width / 2 + 70, project.y + project.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await positions()).billing[0]).toBeGreaterThan(before.billing[0]);
    const after = await positions();
    for (const id of ['terminal', 'pr', 'ticket']) {
      expect(after[id][0] - after.billing[0]).toBeCloseTo(before[id][0] - before.billing[0]);
      expect(after[id][1] - after.billing[1]).toBeCloseTo(before[id][1] - before.billing[1]);
    }
    await page.mouse.move(400, 170); await page.mouse.down();
    await page.mouse.move(460, 205, { steps: 8 }); await page.mouse.up();
    expect(await positions()).toEqual(after);
    await page.locator('.react-flow__node[data-id="billing"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await positions()).billing[0]).toBe(after.billing[0] + 10);
    for (const id of ['terminal', 'pr', 'ticket']) expect((await positions())[id][0]).toBe(after[id][0] + 10);
    await page.screenshot({ path: 'test-results/spatial-map.png' });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('project titles and generous outlines share stable geometry at every zoom', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-neighborhood-'));
  const app = await electron.launch({ args: ['.', '--renderer-spike'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), map = page.locator('.map-area');
    const project = page.getByRole('article', { name: 'Billing redesign' });
    const outline = page.locator('[data-project-outline="billing"]');
    await expect(project).toHaveClass('project-neighborhood-title');
    await expect(project).toContainText('Billing redesign');
    await expect(project).toContainText('1 asking · 1 my turn · 1 working');
    const labelRect = (await project.boundingBox())!, outlineRect = (await outline.boundingBox())!;
    // Title sits above the outline, with a viewport-edge fallback for a clipped cap.
    // The SVG bounding box includes its half-stroke beyond the mathematical edge.
    expect(Math.abs(labelRect.y - Math.max(20, outlineRect.y - labelRect.height - 12))).toBeLessThan(1);
    expect(labelRect.x + labelRect.width / 2).toBeCloseTo(outlineRect.x + outlineRect.width / 2, 0);
    const originalPath = await outline.getAttribute('d');
    const positions = () => page.locator('[data-item-id]').evaluateAll(items => Object.fromEntries(items.map(item => [item.getAttribute('data-item-id'), [item.getAttribute('data-world-x'), item.getAttribute('data-world-y')]])));
    const originalPositions = await positions();
    await expect(page.locator('.project-membership-edge')).toHaveCount(0);
    await page.evaluate(() => window.craftingPerformance.reset());
    const slider = page.getByRole('slider', { name: 'Map zoom' });
    // The lowest zoom that still shows titles and items; below it projects become dashboards (MAP-23).
    await slider.fill('0.66');
    await expect(map).toHaveAttribute('data-level', 'neighborhood');
    await expect(project).toHaveClass('project-neighborhood-title');
    await expect(page.locator('.map-card[data-item-id="billing"]')).toHaveCount(0);
    const title = project;
    await expect(title).toBeVisible();
    const titleBounds = (await title.boundingBox())!, outlineBounds = (await outline.boundingBox())!;
    if (outlineBounds.y >= 60) expect(titleBounds.y + titleBounds.height).toBeLessThan(outlineBounds.y);
    else expect(titleBounds.y).toBeCloseTo(20); // Clipped outline keeps its title reachable.
    expect(titleBounds.y).toBeGreaterThanOrEqual(20);
    expect(await title.evaluate(element => parseFloat(getComputedStyle(element.querySelector('strong')!).fontSize))).toBe(15);
    await expect(page.locator('.project-membership-edge')).toHaveCount(0);
    expect(await outline.getAttribute('d')).toBe(originalPath);
    expect(await positions()).toEqual(originalPositions);
    await page.screenshot({ path: 'test-results/neighborhood-overview.png' });
    await slider.focus(); await page.keyboard.press('End');
    await expect(map).toHaveAttribute('data-level', 'close');
    await expect(project).toHaveClass('project-neighborhood-title');
    expect(await outline.getAttribute('d')).toBe(originalPath);
    expect(await positions()).toEqual(originalPositions);
    expect((await page.evaluate(() => window.craftingPerformance.snapshot())).metrics['map.geometry'].count).toBe(0);
    const markers = await page.locator('[data-zoom-threshold]').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-zoom-threshold'))));
    expect(markers).toEqual([.65, 1.15]);
    await page.screenshot({ path: 'test-results/neighborhood-close.png' });
    const card = page.getByRole('article', { name: 'Renderer terminal' });
    const before = (await card.boundingBox())!;
    await card.hover();
    await expect(card).toHaveAttribute('data-preview', 'false');
    await card.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    const preview = (await card.boundingBox())!;
    expect(preview.width).toBe(before.width); expect(preview.height).toBe(before.height);
    expect(preview.x + preview.width / 2).toBeCloseTo(before.x + before.width / 2, 0);
    expect(preview.y + preview.height / 2).toBeCloseTo(before.y + before.height / 2, 0);
    expect(await outline.getAttribute('d')).toBe(originalPath); expect(await positions()).toEqual(originalPositions);
    expect(await card.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer');
    await expect.poll(() => card.evaluate(element => getComputedStyle(element).backgroundImage)).not.toBe('none');
    expect(await page.locator('.react-flow__pane').evaluate(element => getComputedStyle(element).cursor)).toBe('grab');
    await page.locator('.react-flow__node[data-id="pr"]').focus();
    await page.keyboard.press('Enter');
    await expect(map).toHaveAttribute('data-focus', 'pr');
    await page.keyboard.press('Escape');
    await expect(map).toHaveAttribute('data-focus', '');
    await page.keyboard.press('Escape');
    await expect(map).toHaveAttribute('data-level', 'overview');
    await expect(map).toHaveAttribute('data-dashboards', 'true');
    expect(await outline.getAttribute('d')).toBe(originalPath);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});


workspaceTest('dragging one member grows and recenters its neighborhood without moving the project anchor', async ({ visual: { page } }) => {
  const outline = page.locator('[data-project-outline="billing"]');
  const label = page.locator('[data-project-label="billing"]');
  const pr = page.getByRole('article', { name: 'Plan switcher' });
  const read = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
  const before = await read(), oldBounds = (await outline.boundingBox())!, oldPath = await outline.getAttribute('d');
  const card = (await pr.boundingBox())!;
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 240, card.y + card.height / 2, { steps: 12 });
  await expect.poll(() => outline.getAttribute('d')).not.toBe(oldPath); // Live, before drop.
  const held = (await outline.boundingBox())!;
  expect(held.width).toBeGreaterThan(oldBounds.width);
  expect(held.x + held.width / 2).toBeGreaterThan(oldBounds.x + oldBounds.width / 2);
  expect(await page.evaluate(() => {
    const path = document.querySelector<SVGGeometryElement>('[data-project-outline="billing"]')!;
    const inverse = path.getScreenCTM()!.inverse();
    return ['agent', 'pr', 'ticket', 'brief'].every(id => {
      const rect = document.querySelector(`[data-item-id="${id}"]`)!.getBoundingClientRect();
      return [rect.left, rect.right].every(x => [rect.top, rect.bottom].every(y => path.isPointInFill(new DOMPoint(x, y).matrixTransform(inverse))));
    });
  })).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => (await read()).nodes.find(node => node.id === 'pr')!.position.x).toBeGreaterThan(before.nodes.find(node => node.id === 'pr')!.position.x);
  const after = await read();
  for (const node of before.nodes.filter(node => node.id !== 'pr')) expect(after.nodes.find(item => item.id === node.id)!.position).toEqual(node.position);
  const grownPath = await outline.getAttribute('d');
  const bounds = (await outline.boundingBox())!, title = (await label.boundingBox())!;
  // A pinned label may shift to avoid the tool rail; its world stays fixed.
  const controls = (await page.locator('.tool-rail').boundingBox())!;
  expect(title.x >= controls.x + controls.width || title.x + title.width <= controls.x || title.y >= controls.y + controls.height || title.y + title.height <= controls.y).toBe(true);
  // Bring the cap into view to verify that the title is outside and centered.
  const dy = Math.round(120 - bounds.y);
  await page.mouse.move(90, 80); await page.mouse.down();
  await page.mouse.move(90, 80 + dy, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await outline.boundingBox())!.y).toBeCloseTo(bounds.y + dy, 0);
  const visibleTitle = (await label.boundingBox())!, visibleOutline = (await outline.boundingBox())!;
  expect(visibleTitle.y + visibleTitle.height).toBeLessThan(visibleOutline.y);
  expect(visibleTitle.x + visibleTitle.width / 2).toBeCloseTo(visibleOutline.x + visibleOutline.width / 2, 0);
  expect(await outline.getAttribute('d')).toBe(grownPath);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('0.66');
  await expect(page.locator('.map-area')).toHaveAttribute('data-level', 'neighborhood');
  const project = (await page.getByRole('article', { name: 'Billing redesign' }).boundingBox())!, overviewOutline = (await outline.boundingBox())!;
  expect(project.x + project.width / 2).toBeCloseTo(overviewOutline.x + overviewOutline.width / 2, 0);
  const outlineTop = await outline.evaluate((path: SVGGraphicsElement) => new DOMPoint(0, path.getBBox().y).matrixTransform(path.getScreenCTM()!).y);
  expect(project.y).toBeCloseTo(Math.max(20, outlineTop - project.height - 12), 0);
  expect(await outline.getAttribute('d')).toBe(grownPath);
  expect((await read()).nodes.map(node => node.position)).toEqual(after.nodes.map(node => node.position));
});


workspaceTest('zoom slider preserves the visible canvas center for pointer and keyboard input after pan and resize', async ({ visual: { app, page } }) => {
  const slider = page.getByRole('slider', { name: 'Map zoom' });
  const nodes = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes;
  // Recover world coordinates from the rendered SVG transform, independently of
  // the slider handler and saved camera. Include the actual canvas screen offset.
  const worldAt = (point?: { x: number; y: number }) => page.locator('[data-project-outline="billing"]').evaluate((outline: SVGPathElement, point) => {
    const rect = document.querySelector('.react-flow')!.getBoundingClientRect();
    const screen = point ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const matrix = outline.getScreenCTM()!;
    const world = new DOMPoint(screen.x, screen.y).matrixTransform(matrix.inverse());
    return { x: world.x, y: world.y, zoom: matrix.a };
  }, point);
  async function centered(change: () => Promise<unknown>) {
    const before = await worldAt(); await change();
    await expect.poll(async () => (await worldAt()).zoom).not.toBe(before.zoom);
    const after = await worldAt();
    expect(after.x).toBeCloseTo(before.x, 3); expect(after.y).toBeCloseTo(before.y, 3);
  }
  for (const size of [[1280, 800], [900, 640]]) {
    await resize(app, page, size[0], size[1]);
    await page.mouse.move(80, 500); await page.mouse.down(); await page.mouse.move(160, 540, { steps: 8 }); await page.mouse.up();
    await slider.focus();
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) await centered(() => page.keyboard.press(key));
    const box = (await slider.boundingBox())!;
    await centered(() => page.mouse.click(box.x + box.width * .4, box.y + box.height / 2));
    await centered(async () => {
      const value = await slider.evaluate((input: HTMLInputElement) => (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)));
      await page.mouse.move(box.x + 8 + (box.width - 16) * value, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
    });
    // Wheel zoom retains its separate pointer anchor.
    const pointer = { x: 290, y: 170 }, before = await worldAt(pointer);
    await page.mouse.move(pointer.x, pointer.y); await page.mouse.wheel(0, 180);
    await expect.poll(async () => (await worldAt(pointer)).zoom).toBeLessThan(before.zoom);
    const after = await worldAt(pointer);
    expect(after.x).toBeCloseTo(before.x, 3); expect(after.y).toBeCloseTo(before.y, 3);
  }
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes).toEqual(nodes);
});

workspaceTest('item expansion grows from its retained bubble and reverses from a moved view without changing map geometry', async ({ visual: { page } }) => {
  // This journey measures geometry-only navigation with the fixture's PR already seen.
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision,
      actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'attention.acknowledge', id: 'pr', versions: { pr: 0 } }] });
  });
  await expect(page.locator('[data-project-label="billing"]')).toContainText('1 asking · 1 working');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const bubble = page.getByRole('article', { name: 'Plan switcher', exact: true });
  const card = page.locator('[data-expanded-item-id="pr"]');
  const original = (await bubble.boundingBox())!;
  const world = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes;
  const edgePaths = () => page.locator('.explicit-edge path.react-flow__edge-path').evaluateAll(edges => edges.map(edge => edge.getAttribute('d')));
  const originalEdges = await edgePaths(); expect(originalEdges).toHaveLength(2);
  const outline = page.locator('[data-project-outline="billing"]');
  const beforeOutline = await outline.boundingBox(), beforePath = await outline.getAttribute('d');
  await bubble.hover();
  await expect(bubble).toHaveAttribute('data-preview', 'false');
  await bubble.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const preview = (await bubble.boundingBox())!;
  await page.evaluate(() => window.craftingPerformance.reset());
  await bubble.click();
  const sample = () => card.evaluate(element => {
    const animation = element.getAnimations().find(animation => animation.id === 'bubble-expansion')!;
    if (!animation) throw new Error('Expected a real, non-reduced-motion bubble transition');
    animation.pause();
    const duration = Number(animation.effect!.getTiming().duration);
    const frames = [0, duration / 2, duration].map(time => {
      animation.currentTime = time;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
    animation.finish(); return frames;
  });
  const [start, middle, end] = await sample();
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(start[key]).toBeCloseTo(preview[key], 0);
  expect(middle.width).toBeGreaterThan(start.width); expect(middle.width).toBeLessThan(end.width);
  expect(middle.height).toBeGreaterThan(start.height); expect(middle.height).toBeLessThan(end.height);
  expect(end.width).toBeCloseTo(1040, 0); // PRs have their own bounded detail size.
  await expect(page.getByRole('slider', { name: 'Map zoom' })).not.toBeVisible();
  await expect(page.locator('[data-project-field="billing"]')).toBeVisible();
  for (const key of ['x', 'y', 'width', 'height'] as const) expect((await bubble.boundingBox())![key]).toBeCloseTo(original[key], 0);
  await expect(bubble).toHaveAttribute('data-view-open', 'true');
  const openedEdges = await edgePaths();
  // React Flow rounds initial DOM measurements to whole world pixels. A data
  // update replaces those with the declared fractional dimensions; endpoints
  // may settle by less than half a pixel, but must stay at the map bubbles.
  const coordinates = (paths: (string | null)[]) => paths.flatMap(path => path!.match(/-?\d+(?:\.\d+)?/g)!.map(Number));
  const originalCoordinates = coordinates(originalEdges);
  for (const [index, value] of coordinates(openedEdges).entries()) expect(value).toBeCloseTo(originalCoordinates[index], 0);
  const heading = (await card.locator('.card-heading').boundingBox())!;
  await page.mouse.move(heading.x + 45, heading.y + 12); await page.mouse.down();
  await page.mouse.move(heading.x + 125, heading.y + 42, { steps: 8 }); await page.mouse.up();
  const moved = (await card.boundingBox())!;
  expect(moved.x).toBeCloseTo(end.x + 80, 0); expect(moved.y).toBeCloseTo(end.y + 30, 0);
  expect(await edgePaths()).toEqual(openedEdges);
  for (const key of ['x', 'y', 'width', 'height'] as const) expect((await bubble.boundingBox())![key]).toBeCloseTo(original[key], 0);
  await page.getByRole('button', { name: 'Back to project' }).click();
  const [returnStart, returnMiddle, returnEnd] = await sample();
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(returnStart[key]).toBeCloseTo(moved[key], 0);
  expect(returnMiddle.width).toBeLessThan(returnStart.width); expect(returnMiddle.width).toBeGreaterThan(returnEnd.width);
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(returnEnd[key]).toBeCloseTo(original[key], 0);
  await expect(card).toBeHidden(); for (const key of ['x', 'y', 'width', 'height'] as const) expect((await bubble.boundingBox())![key]).toBeCloseTo(original[key], 0);
  expect(await outline.boundingBox()).toEqual(beforeOutline); expect(await outline.getAttribute('d')).toBe(beforePath);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes).toEqual(world);
  expect((await page.evaluate(() => window.craftingPerformance.snapshot())).metrics['map.geometry'].count).toBe(0);
  // Reduced motion takes the same route with no intermediate animation.
  await page.emulateMedia({ reducedMotion: 'reduce' }); await bubble.click();
  expect(await card.evaluate(element => element.getAnimations().length)).toBe(0);
  // Reopening during the return transition starts from its current visible
  // bounds, rather than snapping back to the original bubble first.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Back to project' }).click();
  const returning = await card.evaluate(element => {
    const animation = element.getAnimations().find(animation => animation.id === 'bubble-expansion')!;
    animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
  });
  await bubble.evaluate(element => (element as HTMLElement).click());
  const [reopening] = await sample();
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(reopening[key]).toBeCloseTo(returning[key], 0);
});

workspaceTest('expanded views move independently and preserve connections, map positions and the running terminal', async ({ visual: { page } }) => {
  await openTerminal(page);
  const terminal = page.locator('.terminal-surface'), mount = await terminal.getAttribute('data-mount-id');
  const sessionId = (await terminal.getAttribute('data-terminal-id'))!;
  const pid = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid;
  const read = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
  const before = await read(), item = before.nodes.find(node => node.title === 'Development terminal')!;
  await page.evaluate(async id => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'terminal-pr-link', actor: { kind: 'user', id: 'fixture' }, expectedRevision: state.revision,
      commands: [{ type: 'link.save', link: { id: 'terminal-pr', sourceId: id, targetId: 'pr', kind: 'reference', label: '' } }] });
  }, item.id);
  await page.getByRole('button', { name: 'Open connected item: Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await page.getByRole('button', { name: 'Open connected item: Billing experience', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'brief');
  await page.getByRole('button', { name: 'Open connected item: Plan switcher', exact: true }).click();
  await page.getByRole('button', { name: 'Open connected item: Development terminal', exact: true }).click();
  await expect(terminal).toHaveAttribute('data-mount-id', mount!);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(pid);
  const card = page.getByRole('region', { name: 'Development terminal', exact: true });
  const bubble = page.getByRole('article', { name: 'Development terminal', exact: true });
  await page.evaluate(async () => {
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, itemViews: { ...saved.value.itemViews, 'terminal.session': { width: 920, height: 520 } } } });
  });
  await expect.poll(async () => Math.round((await card.boundingBox())!.width)).toBe(920);
  await expect(terminal).toHaveAttribute('data-mount-id', mount!);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(pid);
  const original = (await card.boundingBox())!, bubbleBounds = await bubble.boundingBox(), graph = await read();
  const paths = await page.locator('.explicit-edge path.react-flow__edge-path').evaluateAll(edges => edges.map(edge => edge.getAttribute('d')));
  const outline = await page.locator('[data-project-outline="billing"]').getAttribute('d');
  const heading = (await card.locator('.card-heading').boundingBox())!;
  await page.mouse.move(heading.x + 35, heading.y + 14); await page.mouse.down();
  await page.mouse.move(heading.x + 37, heading.y + 14); // Click/jitter does not move or close it.
  expect(await card.boundingBox()).toEqual(original);
  await page.mouse.move(heading.x + 155, heading.y + 84, { steps: 10 });
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', item.id);
  const moved = (await card.boundingBox())!;
  expect(moved.x).toBeCloseTo(original.x + 120, 0); expect(moved.y).toBeCloseTo(original.y + 70, 0);
  expect(await bubble.boundingBox()).toEqual(bubbleBounds);
  await page.mouse.up();
  expect((await read()).nodes).toEqual(graph.nodes); expect((await read()).links).toEqual(graph.links);
  expect(await page.locator('.explicit-edge path.react-flow__edge-path').evaluateAll(edges => edges.map(edge => edge.getAttribute('d')))).toEqual(paths);
  expect(await page.locator('[data-project-outline="billing"]').getAttribute('d')).toBe(outline);
  await expect(terminal).toHaveAttribute('data-mount-id', mount!);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(pid);
  // Header movement does not change terminal geometry or consume its input.
  const session = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session;
  for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture', 'blur']) {
    const bar = (await card.locator('.card-heading').boundingBox())!;
    await page.mouse.move(bar.x + 35, bar.y + 14); await page.mouse.down(); await page.mouse.move(bar.x - 80, bar.y - 70, { steps: 8 });
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await page.locator('.map-area').dispatchEvent(cancel);
    await page.mouse.up(); expect(await card.boundingBox()).toEqual(moved);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', item.id);
  }
  await card.locator('.card-heading').focus(); await page.keyboard.press('ArrowLeft');
  expect((await card.boundingBox())!.x).toBeCloseTo(moved.x - 10, 0);
  await page.getByRole('button', { name: 'Back to project' }).click(); await bubble.click();
  expect((await card.boundingBox())!.x).toBeCloseTo(moved.x - 10, 0);
  await expect(terminal).toHaveAttribute('data-mount-id', mount!);
  const after = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session;
  expect([after.pid, after.cols, after.rows]).toEqual([session.pid, session.cols, session.rows]);
  expect((await read()).nodes).toEqual(graph.nodes);
});
