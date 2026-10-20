import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { test, capture, captureTerminal, resize, openTerminal, terminalResized } from './visual-fixture.ts';

async function sizeBy(page: Page, handle: Locator, dx: number, dy: number, release = true) {
  const grip = (await handle.boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  if (release) await page.mouse.up();
}

test('native terminal refits during view resizing without a remount, process restart or map change', async ({ visual: { page } }) => {
  await openTerminal(page);
  const terminal = page.locator('.terminal-surface'), mount = await terminal.getAttribute('data-mount-id');
  const id = (await terminal.getAttribute('data-terminal-id'))!;
  const session = () => page.evaluate(id => window.craftingTable.sessionRead(id), id);
  const before = await session(), graph = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const view = page.getByRole('region', { name: 'Development terminal', exact: true }), box = (await view.boundingBox())!;
  const handle = page.getByRole('button', { name: 'Resize view: Development terminal' });
  await sizeBy(page, handle, -240, -180); await terminalResized(page);
  const smaller = (await view.boundingBox())!;
  expect(smaller).toEqual({ ...box, width: box.width - 240, height: box.height - 180 });
  await expect(terminal).toHaveAttribute('data-mount-id', mount!); expect((await session()).session.pid).toBe(before.session.pid);
  expect((await session()).session.cols).toBeLessThan(before.session.cols); expect((await session()).session.rows).toBeLessThan(before.session.rows);
  await sizeBy(page, handle, -2000, -2000); await terminalResized(page);
  expect((await view.boundingBox())!.width).toBe(480); expect((await view.boundingBox())!.height).toBe(280);
  await captureTerminal(page, 'terminal-view-resized.png');
  const controls = await view.evaluate(element => {
    const outer = element.getBoundingClientRect();
    return [...element.querySelectorAll('.card-heading button')].every(button => { const b = button.getBoundingClientRect(); return b.left >= outer.left && b.right <= outer.right && b.top >= outer.top; });
  });
  expect(controls).toBe(true);
  await handle.focus(); await page.keyboard.press('Home');
  // A small terminal already fits inside a newly enlarged host. Wait for the
  // restored grid before checking its last row rather than sampling the old fit.
  await expect(page.locator('.xterm-accessibility-tree > div')).toHaveCount(before.session.rows);
  await terminalResized(page);
  expect(await view.boundingBox()).toEqual(box); await expect(terminal).toHaveAttribute('data-mount-id', mount!);
  expect((await session()).session.pid).toBe(before.session.pid);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes).toEqual(graph.nodes);
});

test('a resized terminal view fills its saved size on the first open after a restart', async ({ visual: { page } }) => {
  await openTerminal(page);
  const handle = page.getByRole('button', { name: 'Resize view: Development terminal' });
  await sizeBy(page, handle, 200, 120); await terminalResized(page);
  await page.getByRole('button', { name: 'Back to project' }).click();
  await page.reload();
  await page.getByRole('article', { name: 'Development terminal' }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await terminalResized(page);
  // The terminal grid fills the view's surface to within one cell in both directions.
  const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const { rows } = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  const fit = await page.locator('.terminal-surface').evaluate((surface, rows) => {
    const screen = surface.querySelector('.xterm-screen')!.getBoundingClientRect(), host = surface.querySelector('.terminal-host')!.getBoundingClientRect();
    return { width: host.width - screen.width, height: host.height - screen.height, cell: screen.height / rows };
  }, rows);
  expect(fit.height).toBeLessThan(fit.cell + 1); expect(fit.width).toBeLessThan(fit.cell * 2 + 24); // Within a cell plus xterm's scrollbar gutter.
});

test('an opened item keeps the size and place it was given across a reload', async ({ visual: { page } }) => {
  await openTerminal(page);
  const view = page.locator('.item-view').filter({ has: page.locator('.native-terminal') }), handle = page.getByRole('button', { name: 'Resize view: Development terminal' });
  await sizeBy(page, handle, -160, -90); await terminalResized(page);
  const heading = (await view.locator('.card-heading').boundingBox())!;
  await page.mouse.move(heading.x + 120, heading.y + 12); await page.mouse.down(); await page.mouse.move(heading.x + 180, heading.y + 52, { steps: 8 }); await page.mouse.up();
  const before = (await view.boundingBox())!;
  await expect.poll(async () => Object.values((await page.evaluate(() => window.craftingTable.viewRead())).itemViewBounds ?? {}).map(bounds => [Math.round(bounds.x ?? -1), Math.round(bounds.width ?? -1)])).toEqual([[Math.round(before.x), Math.round(before.width)]]);
  await page.getByRole('button', { name: 'Back to project' }).click();
  await page.reload();
  await page.getByRole('article', { name: 'Development terminal' }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await expect.poll(async () => { const box = (await view.boundingBox())!; return [box.x, box.y, box.width, box.height].map(Math.round); }).toEqual([before.x, before.y, before.width, before.height].map(Math.round));
});
