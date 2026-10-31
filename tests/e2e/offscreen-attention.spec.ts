import { expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

test.use({ mapCorner: 'projects' });

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'offscreen-fixture' }, commands }); }, JSON.stringify(commands));
}
const mark = (page: Page) => page.locator('.offscreen-attention');
const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform));
/** Drags the empty board, in strokes short enough to start and end inside the window. */
async function pan(page: Page, x: number, y: number) {
  for (let left = { x, y }; left.x || left.y;) {
    const stroke = { x: Math.sign(left.x) * Math.min(Math.abs(left.x), 500), y: Math.sign(left.y) * Math.min(Math.abs(left.y), 300) };
    const from = { x: 640 - stroke.x / 2, y: 400 - stroke.y / 2 };
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + stroke.x, from.y + stroke.y, { steps: 4 }); await page.mouse.up();
    left = { x: left.x - stroke.x, y: left.y - stroke.y };
  }
  await page.mouse.move(4, 4);
}
async function expectClear(marks: Locator, chrome: Locator) {
  await expect.poll(async () => {
    const b = (await chrome.boundingBox())!;
    return (await Promise.all((await marks.all()).map(async mark => {
      const a = (await mark.boundingBox())!;
      return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    }))).every(Boolean);
  }).toBe(true);
}
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });

test('a circle on the edge points at the nearest waiting item outside the view and slides to it', async ({ visual: { page } }, testInfo) => {
  await expect(mark(page)).toHaveCount(0);
  // Everything leaves through the left edge, so the two waiting items share a circle, led by the nearer Plan switcher.
  await pan(page, -1300, 0);
  await expect(mark(page)).toHaveCount(1);
  await expect(mark(page)).toHaveAttribute('data-offscreen-target', 'pr');
  await expect(mark(page)).toHaveText('2');
  await expect(mark(page)).toHaveAttribute('data-tier', 'asking');
  await expect(mark(page)).toHaveCSS('background-color', 'rgb(255, 217, 138)');
  await expect(mark(page)).toHaveAttribute('aria-label', 'Show the nearest of 2 waiting items on map: Plan switcher');
  const rail = (await page.locator('.tool-rail').boundingBox())!, left = (await mark(page).boundingBox())!;
  expect(left.x).toBeGreaterThan(rail.x + rail.width);
  await shot(page, testInfo, 'edge-left');
  // The spot follows the direction, so moving the board moves it along the edge.
  await pan(page, 0, -500);
  await expect.poll(async () => (await mark(page).boundingBox())!.y).toBeLessThan(left.y - 40);
  await shot(page, testInfo, 'edge-moved');

  const before = await read(page), zoom = (await camera(page)).a;
  await mark(page).click();
  await expect(page.locator('.react-flow__node[data-id="pr"]')).toBeInViewport();
  await expect(mark(page)).toHaveCount(0);
  expect((await camera(page)).a).toBeCloseTo(zoom);
  // Showing an item neither opens it nor marks it seen (STATE-02).
  await expect(page.locator('.item-view[data-item-view="pr"]:not([hidden])')).toHaveCount(0);
  expect(await read(page)).toEqual(before);
  await shot(page, testInfo, 'after-click');
});

test('items in different directions get a circle each, and each slides to its own', async ({ visual: { page } }, testInfo) => {
  await apply(page, [{ type: 'node.move', id: 'agent', position: { x: 4000, y: 240 } }, { type: 'node.move', id: 'pr', position: { x: -3000, y: 300 } }]);
  await expect(mark(page)).toHaveCount(2);
  const left = page.locator('[data-offscreen-target="pr"]'), right = page.locator('[data-offscreen-target="agent"]');
  await expect(left).toHaveAttribute('data-tier', 'turn'); await expect(left).toHaveCSS('background-color', 'rgb(232, 189, 114)'); await expect(left).toHaveText('');
  await expect(right).toHaveAttribute('data-tier', 'asking'); await expect(right).toHaveCSS('background-color', 'rgb(255, 217, 138)');
  expect((await left.boundingBox())!.x).toBeLessThan(200); expect((await right.boundingBox())!.x).toBeGreaterThan(1000);
  await shot(page, testInfo, 'two-directions');
  await right.click();
  await expect(page.locator('.react-flow__node[data-id="agent"]')).toBeInViewport();
  await expect(mark(page)).toHaveCount(1);
  await expect(left).toBeVisible();
});

test('the circle stays out from under map chrome and open panels', async ({ visual: { page } }, testInfo) => {
  // The straight line to the items leaves the view under the zoom bar.
  await pan(page, -1120, 900);
  await expect(mark(page).first()).toBeVisible();
  await expectClear(mark(page), page.locator('.zoom-markers'));
  await expectClear(mark(page), page.locator('.map-locator'));
  await shot(page, testInfo, 'clear-of-zoom-bar');
  await pan(page, 0, -900);
  // A panel opened with the camera still moves the circle too.
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await expectClear(mark(page), page.getByRole('dialog', { name: 'Needs me', exact: true }));
  await shot(page, testInfo, 'clear-of-panel');
});

test('an open item hides the circle, and a muted project raises none', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.move', id: 'agent', position: { x: 4000, y: 240 } }]);
  await expect(mark(page)).toHaveAttribute('data-offscreen-target', 'agent');
  await expect(mark(page)).toHaveAttribute('data-tier', 'asking');
  await expect(mark(page)).toHaveCSS('background-color', 'rgb(255, 217, 138)');
  await page.locator('.react-flow__node[data-id="pr"]').click();
  await expect(page.locator('[data-expanded-item-id="pr"]')).toBeVisible();
  await expect(mark(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(mark(page)).toHaveAttribute('data-offscreen-target', 'agent');
  await apply(page, [{ type: 'project.mute', id: 'billing', muted: true }]);
  await expect(mark(page)).toHaveCount(0);
});
