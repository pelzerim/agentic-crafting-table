import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('the Dock badge shows the Needs me count and clears when switched off', async ({ visual: { app, page } }) => {
  const badge = () => app.evaluate(({ app }) => app.getBadgeCount());
  const count = Number((await page.locator('.needs-me-button').getAttribute('aria-label'))?.match(/\d+/)?.[0]);
  expect(count).toBeGreaterThan(0);
  await expect.poll(badge).toBe(count);
  await page.evaluate(async () => {
    const settings = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, notifications: { ...settings.value.notifications, dockBadge: false } } });
  });
  await expect.poll(badge).toBe(0);
});
