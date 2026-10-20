import { expect, type Page } from '@playwright/test';

/** Observe compositor pixels, not xterm's one-second-debounced accessibility
 * tree. The selected fixture cells change only when the CLI handles the input. */
export async function terminalPaintProbe(page: Page, column = 0, columns?: number) {
  const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const { session } = await page.evaluate(id => window.craftingTable.sessionRead(id), id);
  const box = (await page.locator('.xterm-screen').boundingBox())!;
  const clip = { x: box.x + box.width / session.cols * column, y: box.y,
    width: box.width / session.cols * (columns ?? session.cols - column), height: box.height / session.rows };
  const image = () => page.screenshot({ clip, caret: 'hide', scale: 'css' });
  let previous = await image();
  return async () => {
    let next = previous;
    await expect.poll(async () => { next = await image(); return !previous.equals(next); }, { intervals: [10], timeout: 1500 }).toBe(true);
    previous = next;
  };
}
