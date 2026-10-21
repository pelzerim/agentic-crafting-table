import { expect, type Locator, type Page } from '@playwright/test';

/** Stop session lives in the agent's Session menu; the open menu's item is returned so a test can check its state. */
export async function stopSessionItem(page: Page, scope: Locator | Page = page) {
  await scope.getByRole('button', { name: 'Agent session menu' }).click();
  return page.getByRole('menu', { name: 'Agent session actions' }).getByRole('menuitem', { name: 'Stop session', exact: true });
}

export async function stopSession(page: Page, scope: Locator | Page = page) {
  await (await stopSessionItem(page, scope)).click();
}

/** Opens the menu, checks whether Stop session is enabled, and closes it again. */
export async function expectStopSession(page: Page, enabled: boolean, scope: Locator | Page = page) {
  const item = await stopSessionItem(page, scope);
  if (enabled) await expect(item).toBeEnabled(); else await expect(item).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Agent session actions' })).toHaveCount(0);
}
