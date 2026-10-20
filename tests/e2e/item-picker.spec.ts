import { openProjectPicker } from './project-picker.ts';
import { expect } from '@playwright/test';
import { test, capture, resize } from './visual-fixture.ts';
import { itemChoices } from '../../packages/core/item-picker.ts';
import type { Page } from '@playwright/test';

/** Every bundled non-URL type is a default shortcut; moving Note out gives All a layer to show. */
const noteInAll = (page: Page) => page.evaluate(async () => {
  const saved = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, quickItemTypes: ['project', 'agent.session', 'terminal.session', 'from-url', 'workspace.todo'] } });
});

test('hover and keyboard choices preview the center without selecting or moving anything', async ({ visual: { page } }) => {
  await noteInAll(page);
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  await page.mouse.dblclick(450, 350);
  const form = page.getByRole('form', { name: 'New item' }), seed = form.locator('.picker-center');
  const initial = (await seed.boundingBox())!;
  const placement = await form.evaluate(el => [el.getAttribute('data-world-x'), el.getAttribute('data-world-y')]);
  await expect(seed).toBeEmpty();
  const agent = form.getByRole('button', { name: 'Agent session', exact: true });
  await agent.hover(); await expect(seed).toHaveAttribute('data-preview-choice', 'agent.session');
  await expect(seed).toContainText('Agent'); await expect(seed.locator('.brand-claude')).toHaveCount(1);
  await expect(seed).toHaveCSS('background-color', 'rgb(32, 55, 53)');
  const large = (await seed.boundingBox())!;
  expect(large.width).toBeLessThan(136); expect(large.width).toBeGreaterThan(initial.width);
  expect(large.x + large.width / 2).toBeCloseTo(initial.x + initial.width / 2, 0);
  expect(large.y + large.height / 2).toBeCloseTo(initial.y + initial.height / 2, 0);
  await expect(page).toHaveScreenshot('creation-picker-preview.png');
  await form.getByRole('button', { name: 'To-do', exact: true }).hover();
  await expect(seed).toHaveAttribute('data-preview-choice', 'workspace.todo');
  await expect(seed).toHaveText('To-do'); expect((await seed.boundingBox())!.height).toBeLessThan(large.height);
  await form.getByRole('button', { name: 'All', exact: true }).hover(); await expect(seed).toBeEmpty();
  // Keyboard movement previews, while initial/programmatic focus alone stays blank.
  await agent.focus(); await page.keyboard.press('ArrowRight');
  await expect(seed).toHaveAttribute('data-preview-choice', 'terminal.session');
  await expect(seed).toHaveText('Terminal');
  await page.keyboard.press('End'); await expect(seed).toBeEmpty();
  await page.keyboard.press('Enter'); await expect(seed).toBeEmpty();
  await form.getByRole('button', { name: 'Note', exact: true }).hover();
  await expect(seed).toHaveAttribute('data-preview-choice', 'workspace.note');
  await expect(seed).toHaveText('Note');
  await page.mouse.move(80, 80); await expect(seed).toBeEmpty();
  await expect(seed).toHaveCSS('background-color', 'rgb(68, 53, 38)');
  expect(await seed.boundingBox()).toEqual(initial);
  expect(await form.evaluate(el => [el.getAttribute('data-world-x'), el.getAttribute('data-world-y')])).toEqual(placement);
  await expect(form.locator('fieldset,.card-detail')).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
});

test('center preview transitions are bounded and reduced motion settles them immediately', async ({ visual: { page } }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.dblclick(450, 350);
  const form = page.getByRole('form', { name: 'New item' }), seed = form.locator('.picker-center');
  await form.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  await form.getByRole('button', { name: 'Agent session', exact: true }).hover();
  await expect(seed).toHaveAttribute('data-preview-choice', 'agent.session');
  const widths = await seed.evaluate(element => {
    const animation = element.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'width');
    if (!animation) throw new Error('Expected the center to transition into a preview');
    animation.pause(); const duration = Number(animation.effect!.getTiming().duration);
    const values = [0, duration / 2, duration].map(time => { animation.currentTime = time; return element.getBoundingClientRect().width; });
    return values;
  });
  expect(widths[0]).toBe(64); expect(widths[1]).toBeGreaterThan(64); expect(widths[1]).toBeLessThan(widths[2]); expect(widths[2]).toBe(112);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => form.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await form.getByRole('button', { name: 'To-do', exact: true }).hover(); await expect(seed).toHaveText('To-do');
  expect(await form.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.mouse.move(80, 80); await expect(seed).toBeEmpty();
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
});

test('the picker shields map items and links through gaps and dismissal does not activate them', async ({ visual: { page } }) => {
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const agent = page.locator('[data-item-id="agent"]'), original = (await agent.boundingBox())!;
  const background = await agent.evaluate(element => getComputedStyle(element).backgroundImage);
  await agent.hover(); await expect(agent).toHaveAttribute('data-preview', 'false');
  await openProjectPicker(page, 'Billing redesign');
  const form = page.getByRole('form', { name: 'New item' });
  await expect(form).toHaveClass(/radial-picker/);
  await expect(agent).toHaveAttribute('data-preview', 'false');
  // Find an exposed gap above the actual card, rather than a choice or seed.
  const gap = await agent.evaluate(element => {
    const r = element.getBoundingClientRect();
    for (let y = r.top + 4; y < r.bottom - 4; y += 8) for (let x = r.left + 4; x < r.right - 4; x += 8) {
      if (document.elementFromPoint(x, y)?.classList.contains('picker-backdrop')) return { x, y };
    }
    throw new Error('Expected a picker gap over the map card');
  });
  await page.mouse.move(gap.x, gap.y);
  await expect(agent).toHaveAttribute('data-preview', 'false');
  await expect(agent).toHaveCSS('background-image', background);
  await expect(agent.locator('.connect-handle')).toHaveCSS('opacity', '0');
  await expect(page.locator('.connection-active,.connection-muted,.connection-meaning-tip')).toHaveCount(0);
  const shielded = (await agent.boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(shielded[key]).toBeCloseTo(original[key], 0);
  const edgePoint = await page.locator('.react-flow__edge-path').first().evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2), screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!); return { x: screen.x, y: screen.y };
  });
  await page.mouse.move(edgePoint.x, edgePoint.y);
  await expect(page.locator('.connection-active,.connection-muted,.connection-meaning-tip')).toHaveCount(0);
  await page.mouse.click(gap.x, gap.y); await expect(form).toHaveCount(0);
  await expect(page.locator('.picker-backdrop')).toHaveCount(0);
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await page.mouse.move(90, 80); await agent.hover(); await expect(agent).toHaveAttribute('data-preview', 'false');
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
});

test('All disappears when only Project or nothing remains outside the quick ring', async ({ visual: { page } }) => {
  const choices = itemChoices(await page.evaluate(() => window.craftingTable.workspacePlugins()));
  const allItems = choices.filter(choice => choice.id !== 'project').map(choice => choice.id);
  await page.evaluate(async quickItemTypes => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, quickItemTypes } }); }, allItems);
  const form = page.getByRole('form', { name: 'New item' });
  for (const point of [{ x: 450, y: 190 }, { x: 24, y: 550 }]) {
    await page.mouse.dblclick(point.x, point.y);
    await expect(form.locator('.picker-choice')).toHaveCount(allItems.length + (await form.getAttribute('data-project-id') ? 1 : 0));
    await expect(form.getByRole('button', { name: 'All', exact: true })).toHaveCount(0);
    await expect(form.locator('.picker-center')).toHaveCSS('background-color', 'rgb(68, 53, 38)');
    await page.keyboard.press('End'); await expect(form.locator('.picker-choice').last()).toBeFocused();
    await page.keyboard.press('Escape');
  }
  await page.evaluate(async quickItemTypes => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, quickItemTypes } }); }, allItems.filter(id => id !== 'workspace.note'));
  await page.mouse.dblclick(450, 190); await form.getByRole('button', { name: 'All', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Note', exact: true })).toBeVisible();
});

test('double-click opens circular plugin layers, preserves placement and navigates back without creating anything', async ({ visual: { page } }) => {
  await noteInAll(page);
  const read = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
  const before = await read(), zoom = await page.locator('.map-area').getAttribute('data-zoom');
  const form = page.getByRole('form', { name: 'New item' });
  await page.mouse.click(450, 190); await expect(form).toHaveCount(0);
  await page.mouse.dblclick(450, 190);
  await expect(page.getByRole('group', { name: 'Quick item types' })).toBeVisible();
  await expect(form).toHaveAttribute('data-project-id', 'billing');
  await expect(form.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Close item form' })).toHaveCount(0);
  await expect(form.locator('.picker-center')).toBeEmpty();
  const placement = await form.evaluate(el => [el.getAttribute('data-world-x'), el.getAttribute('data-world-y')]);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Quick item types' })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Agent session', exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Note', exact: true })).toBeVisible();
  await capture(page, 'creation-picker-all.png');
  await page.mouse.click(12, 700, { button: 'right' });
  await expect(page.getByRole('group', { name: 'Quick item types' })).toBeVisible(); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.click(12, 700, { button: 'right' }); await expect(form).toHaveCount(0); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.dblclick(450, 190);
  await expect(form.getByRole('button', { name: 'Agent session', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(form.getByRole('button', { name: 'All', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('group', { name: 'All other item types' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('group', { name: 'Quick item types' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(form.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  expect(await form.evaluate(el => [el.getAttribute('data-world-x'), el.getAttribute('data-world-y')])).toEqual(placement);
  await form.getByRole('button', { name: 'Back', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0); expect(await read()).toEqual(before); await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', zoom!);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).dblclick();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr'); await expect(form).toHaveCount(0);
});

test('edge-of-canvas rings stay reachable and retain the floating creation point through type selection', async ({ visual: { app, page } }) => {
  await resize(app, page, 900, 640);
  const form = page.getByRole('form', { name: 'New item' });
  await page.mouse.dblclick(24, 550);
  await expect(form).toBeVisible(); await expect(form).toHaveAttribute('data-project-id', '');
  await expect(form.getByRole('button', { name: 'Project', exact: true })).toBeVisible();
  const placement = await form.evaluate(el => ({ x: Number(el.getAttribute('data-world-x')), y: Number(el.getAttribute('data-world-y')) }));
  const canvas = (await page.locator('.map-area').boundingBox())!;
  for (const button of await form.locator('.picker-choice').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(canvas.x); expect(box.y).toBeGreaterThanOrEqual(canvas.y);
    expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width); expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height);
  }
  await form.getByRole('button', { name: 'To-do', exact: true }).click(); await form.getByLabel('Title', { exact: true }).fill('Floating task');
  await form.getByRole('button', { name: 'Add to-do', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.title === 'Floating task'))).toMatchObject({ position: placement });
  const node = await page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.title === 'Floating task'));
  expect(node?.projectId).toBeUndefined();
});

test('settings reorder shortcuts, persist them and keep removed types discoverable in All', async ({ visual: { page } }) => {
  const legacy = ['project', 'agent.session', 'terminal.session', 'github.pull-request', 'slack.message', 'workspace.todo'];
  await page.evaluate(async quickItemTypes => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, quickItemTypes } }); }, legacy);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Items', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByText('New item shortcuts', { exact: true }).click();
  await expect(settings.getByRole('checkbox', { name: 'From URL', exact: true })).toBeChecked();
  expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.quickItemTypes).toEqual(legacy);
  await settings.getByRole('checkbox', { name: 'Agent session', exact: true }).uncheck();
  await settings.getByRole('checkbox', { name: 'Note', exact: true }).check();
  await settings.getByRole('button', { name: 'Move To-do earlier', exact: true }).click();
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(settings).toHaveCount(0);
  const expected = ['project', 'terminal.session', 'workspace.todo', 'from-url', 'workspace.note'];
  expect(await page.evaluate(async () => (await window.craftingTable.settingsRead()).value.quickItemTypes)).toEqual(expected);
  await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
  await page.mouse.dblclick(450, 190);
  const form = page.getByRole('form', { name: 'New item' });
  await expect(page.getByRole('group', { name: 'Quick item types' }).getByRole('button')).toHaveText(['Terminal', 'To-do', 'From URL', 'Note', 'Run skill', 'All']);
  await form.getByRole('button', { name: 'All', exact: true }).click(); await expect(form.getByRole('button', { name: 'Agent session', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // An empty shortcut preference remains intentional, and does not hide any type.
  await page.evaluate(async () => { const saved = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, quickItemTypes: [] } }); });
  await page.mouse.dblclick(450, 190); await expect(form.locator('.picker-choice')).toHaveText(['Run skill', 'All']);
  await form.getByRole('button', { name: 'All', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0);
  const bounds = await form.locator('.picker-choice').evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
  }));
  for (const [i, first] of bounds.entries()) for (const second of bounds.slice(i + 1)) {
    expect(first.x + first.width <= second.x || second.x + second.width <= first.x || first.y + first.height <= second.y || second.y + second.height <= first.y).toBe(true);
  }
  await expect(form.getByRole('button', { name: 'From URL', exact: true })).toBeVisible();
  for (const name of ['Slack', 'GitHub pull request', 'Notion page', 'Linear ticket', 'Web link', 'Bookmark']) await expect(form.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(form.locator('.picker-choice')).toHaveText(['Run skill', 'All']);
});

test('the empty creation seed grows into the selected form and keeps its placement after dragging', async ({ visual: { page } }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.dblclick(450, 350);
  const form = page.getByRole('form', { name: 'New item' });
  await form.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const seed = (await form.locator('.picker-center').boundingBox())!;
  const world = await form.evaluate(el => [el.getAttribute('data-world-x'), el.getAttribute('data-world-y')]);
  const centers = await form.locator('.picker-choice').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  for (const point of centers) expect(Math.hypot(point.x - seed.x - seed.width / 2, point.y - seed.y - seed.height / 2)).toBeCloseTo(136, 0);
  await form.getByRole('button', { name: 'To-do', exact: true }).hover();
  await expect(form.locator('.picker-center')).toHaveAttribute('data-preview-choice', 'workspace.todo');
  await form.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const preview = (await form.locator('.picker-center').boundingBox())!;
  await form.getByRole('button', { name: 'To-do', exact: true }).click();
  const [start, middle, end] = await form.evaluate(element => {
    const animation = element.getAnimations().find(animation => animation.id === 'bubble-expansion');
    if (!animation) throw new Error('Expected the selected form to grow from the center bubble');
    animation.pause(); const duration = Number(animation.effect!.getTiming().duration);
    const samples = [0, duration / 2, duration].map(time => { animation.currentTime = time; const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; });
    animation.finish(); return samples;
  });
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(start[key]).toBeCloseTo(preview[key], 0);
  expect(middle.width).toBeGreaterThan(start.width); expect(middle.width).toBeLessThan(end.width);
  expect(end.x + end.width / 2).toBeCloseTo(seed.x + seed.width / 2, 0);
  expect(end.y + end.height / 2).toBeCloseTo(seed.y + seed.height / 2, 0);
  await form.getByLabel('Title', { exact: true }).fill('New task draft');
  const heading = (await form.locator('.editor-heading').boundingBox())!;
  await page.mouse.move(heading.x + 30, heading.y + 10); await page.mouse.down(); await page.mouse.move(heading.x + 90, heading.y + 50, { steps: 6 }); await page.mouse.up();
  expect((await form.boundingBox())!.x).toBeCloseTo(end.x + 60, 0);
  await expect(form.getByLabel('Title', { exact: true })).toHaveValue('New task draft');
  expect(await form.evaluate(el => [el.getAttribute('data-world-x'), el.getAttribute('data-world-y')])).toEqual(world);
  await page.mouse.click(12, 700, { button: 'right' }); await expect(form.locator('.picker-center')).toBeVisible();
  await page.mouse.click(12, 700, { button: 'right' }); await expect(form).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.some(node => node.title === 'New task draft')).toBe(false);
});

test('From URL detects providers and invalidates changed URLs without creating anything', async ({ visual: { page } }) => {
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  await page.mouse.dblclick(450, 190);
  const form = page.getByRole('form', { name: 'New item' });
  await form.getByRole('button', { name: 'From URL', exact: true }).click();
  const input = form.getByLabel('Item URL');
  for (const [url, name] of [
    ['https://github.com/fixture/billing/pull/42', 'GitHub pull request'],
    ['https://fixture.slack.com/archives/C0123456789/p1727172000000001', 'Slack'],
    ['https://linear.app/acme/issue/BIL-128/title', 'Linear ticket'],
    ['https://www.notion.so/0123456789abcdef0123456789abcdef', 'Notion page'],
    ['https://example.com/docs?q=1#section', 'Web link'],
  ]) {
    await input.fill(url); await expect(form.locator('.detected-item')).toHaveText(name);
  }
  await input.fill('javascript:alert(1)');
  await expect(form.locator('.detected-item')).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Attach item', exact: true })).toBeDisabled();
  await expect(form).toContainText('Enter a valid http or https URL.');
  await input.fill('https://github.com/fixture/billing/pull/42');
  await input.fill('https://example.com/changed');
  await expect(form.locator('.detected-item')).toHaveText('Web link');
  await expect(form.getByRole('button', { name: 'Add web link', exact: true })).toBeEnabled();
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
  await page.keyboard.press('Escape'); await expect(form.locator('.picker-center')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
});

test('opening grows the center from nothing and spreads choices outward with stable placement and cancellable motion', async ({ visual: { page } }) => {
  await noteInAll(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const zoom = await page.locator('.map-area').getAttribute('data-zoom');
  await page.mouse.dblclick(450, 350);
  const form = page.getByRole('form', { name: 'New item' });
  const samples = await form.evaluate(element => {
    const animations = element.getAnimations({ subtree: true });
    const seed = element.querySelector<HTMLElement>('.picker-center')!, choices = [...element.querySelectorAll<HTMLElement>('.picker-choice')];
    if (!animations.some(animation => animation.id === 'picker-seed-enter') || animations.filter(animation => animation.id === 'picker-choice-enter').length !== choices.length) throw new Error('Missing picker entrance animations');
    animations.forEach(animation => animation.pause());
    const sample = (time: number) => {
      animations.forEach(animation => { animation.currentTime = time; });
      return [seed, ...choices].map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height, opacity: Number(getComputedStyle(node).opacity) }; });
    };
    const start = sample(0), middle = sample(140), end = sample(500);
    sample(140); return { start, middle, end };
  });
  for (const [index, initial] of samples.start.entries()) {
    expect(initial.width).toBe(0); expect(initial.height).toBe(0); expect(initial.opacity).toBe(0);
    expect(initial.x).toBeCloseTo(samples.end[0].x, 0); expect(initial.y).toBeCloseTo(samples.end[0].y, 0);
    expect(samples.middle[index].width).toBeGreaterThan(0); expect(samples.middle[index].width).toBeLessThan(samples.end[index].width);
    if (index) {
      const distance = (point: typeof initial) => Math.hypot(point.x - samples.end[0].x, point.y - samples.end[0].y);
      expect(distance(samples.middle[index])).toBeGreaterThan(0); expect(distance(samples.middle[index])).toBeLessThan(136);
      expect(distance(samples.end[index])).toBeCloseTo(136, 0);
    }
  }
  // The picker is sampled mid-entry above. Freeze unrelated map activity too:
  // the fixture agent's working rim otherwise prevents any two stable frames.
  await page.evaluate(() => document.getAnimations().forEach(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (target instanceof Element && !target.closest('form[aria-label="New item"]')) {
      animation.pause(); animation.currentTime = 0;
    }
  }));
  await expect(page).toHaveScreenshot('creation-picker-entering.png', { animations: 'allow' });
  // Escape remains immediate during the opening motion, with no phantom creation.
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', zoom!);
  await page.mouse.dblclick(450, 350);
  await form.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 1; }));
  // A keyboard choice works before the visual entry has completed.
  await page.keyboard.press('Enter'); await expect(form.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await form.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  await form.getByRole('button', { name: 'All', exact: true }).click();
  const layerAnimations = await form.evaluate(element => element.getAnimations({ subtree: true }).map(animation => animation.id));
  expect(layerAnimations).toContain('picker-choice-enter'); expect(layerAnimations).not.toContain('picker-seed-enter');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(before);
});

test('reduced motion skips picker entry and changing the preference settles an active ring', async ({ visual: { page } }) => {
  await noteInAll(page);
  await page.mouse.dblclick(450, 350);
  const form = page.getByRole('form', { name: 'New item' });
  expect(await form.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(form.locator('.picker-center')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Escape'); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.dblclick(450, 350);
  await form.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 1; }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => form.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  for (const choice of await form.locator('.picker-choice').all()) await expect(choice).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  expect(await form.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.mouse.click(12, 700, { button: 'right' }); await page.mouse.click(12, 700, { button: 'right' });
  await expect(form).toHaveCount(0);
});

test('ring choices read as raised UI: opaque raised fill, bevel and a hard shadow', async ({ visual: { page } }) => {
  await page.mouse.dblclick(450, 350);
  const form = page.getByRole('form', { name: 'New item' }), choice = form.locator('.picker-choice').last();
  const raised = await page.evaluate(() => {
    const probe = document.createElement('i'); probe.style.color = 'var(--act-raised)'; document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
  await expect(choice).toHaveCSS('background-color', raised);
  await expect(choice).toHaveCSS('box-shadow', /inset/);
  await expect(form.locator('.picker-ring')).toHaveCSS('filter', /drop-shadow/);
});
