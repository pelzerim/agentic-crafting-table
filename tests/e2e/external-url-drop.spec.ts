import { test } from './visual-fixture.ts';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Browser drag payload fixture; does not automate another native app. */
async function dropLink(page: Page, payload: Record<string, string>, point = { x: 450, y: 350 }, target = '.map-area', files = false) {
  return page.locator(target).evaluate((element, { payload, point, files }) => {
    const dataTransfer = new DataTransfer();
    for (const [type, value] of Object.entries(payload)) dataTransfer.setData(type, value);
    if (files) dataTransfer.items.add(new File(['fixture'], 'fixture.txt', { type: 'text/plain' }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: point.x, clientY: point.y });
    element.dispatchEvent(over);
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: point.x, clientY: point.y });
    element.dispatchEvent(drop);
    return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
  }, { payload, point, files });
}

test('external URL drops open the provider form at the map position without creating or navigating', async ({ visual: { page } }) => {
  const read = async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const before = await read(), originalUrl = page.url();
  const form = page.getByRole('form', { name: 'New item' });
  const cases = [
    { url: 'https://github.com/example/billing/pull/48', name: 'GitHub pull request', type: 'text/uri-list' },
    { url: 'https://linear.app/example/issue/BIL-128/plan-changes', name: 'Linear ticket', type: 'text/plain' },
    { url: 'https://example.slack.com/archives/C123/p1234567890123456', name: 'Slack', type: 'text/x-moz-url' },
    { url: 'https://www.notion.so/11111111111111111111111111111111', name: 'Notion page', type: 'text/uri-list' },
    { url: 'https://example.org/guide', name: 'Web link', type: 'text/plain' },
  ];
  for (const entry of cases) {
    const text = entry.type === 'text/x-moz-url' ? `${entry.url}\nAn external title` : entry.type === 'text/uri-list' ? `# browser link\r\n${entry.url}` : entry.url;
    expect(await dropLink(page, { [entry.type]: text })).toEqual({ overPrevented: true, dropPrevented: true });
    await expect(form.getByLabel('Item URL')).toHaveValue(entry.url);
    await expect(form.locator('.detected-item')).toHaveText(entry.name);
    await expect(form).toHaveAttribute('data-project-id', 'billing');
    expect(await read()).toEqual(before); expect(page.url()).toBe(originalUrl);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
  }
  // Camera transforms and canvas offsets must not alter the requested world point.
  await page.mouse.move(450, 350); await page.mouse.wheel(0, -180);
  await page.mouse.move(1100, 520); await page.mouse.down(); await page.mouse.move(1000, 570, { steps: 6 }); await page.mouse.up();
  const point = { x: 40, y: 660 };
  const world = await page.locator('.react-flow__viewport').evaluate((element, point) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform), rect = element.closest('.map-area')!.getBoundingClientRect();
    return { x: (point.x - rect.left - matrix.e) / matrix.a, y: (point.y - rect.top - matrix.f) / matrix.d };
  }, point);
  await dropLink(page, { 'text/plain': 'https://example.org/floating' }, point);
  await expect(form).toHaveAttribute('data-project-id', '');
  // Computed CSS serializes the matrix with less precision than React Flow.
  expect(Number(await form.getAttribute('data-world-x'))).toBeCloseTo(world.x, 3);
  expect(Number(await form.getAttribute('data-world-y'))).toBeCloseTo(world.y, 3);
  expect(await read()).toEqual(before);
});

test('unsupported drops and drops over an existing draft or expanded item leave the workspace intact', async ({ visual: { page } }) => {
  const originalUrl = page.url(), before = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const form = page.getByRole('form', { name: 'New item' });
  for (const text of ['not a link', 'file:///tmp/file', 'javascript:alert(1)', 'https://user:secret@example.org']) {
    expect((await dropLink(page, { 'text/plain': text })).dropPrevented).toBe(true);
    await expect(form).toHaveCount(0); expect(page.url()).toBe(originalUrl);
  }
  await dropLink(page, { 'text/uri-list': 'https://example.org' }, undefined, undefined, true);
  await expect(form).toHaveCount(0);
  await dropLink(page, { 'text/plain': 'https://example.org/original' });
  await expect(form.getByLabel('Item URL')).toHaveValue('https://example.org/original');
  await dropLink(page, { 'text/plain': 'https://example.org/replacement' }, { x: 1000, y: 600 });
  await expect(form.getByLabel('Item URL')).toHaveValue('https://example.org/original');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const read = async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  expect(await read()).toEqual(before);
  // Native text inputs retain normal text dropping; map creation does not consume it.
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'agent');
  // Opening the agent changes nothing, and neither do drops over it.
  const opened = await read();
  expect(opened).toEqual(before);
  await dropLink(page, { 'text/plain': 'https://example.org/focused' });
  await expect(form).toHaveCount(0);
  await page.locator('.expanded .resource-detail').evaluate(element => {
    const input = document.createElement('textarea'); input.setAttribute('data-drop-fixture', 'true'); element.append(input);
  });
  expect(await dropLink(page, { 'text/plain': 'https://example.org/input' }, undefined, '[data-drop-fixture]')).toEqual({ overPrevented: false, dropPrevented: false });
  await page.locator('[data-drop-fixture]').evaluate(element => element.remove());
  await expect(form).toHaveCount(0); expect(page.url()).toBe(originalUrl);
  expect(await read()).toEqual(opened);
});
