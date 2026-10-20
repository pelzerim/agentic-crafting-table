import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('Needs me takes focus, closes on Escape and returns focus to its button', async ({ visual: { page } }) => {
  const button = page.getByRole('button', { name: 'Needs me: 2', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true })).toBeFocused();
  await expect(list.getByRole('heading', { name: 'Needs me', level: 2 })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('Settings is modal without a scrim: focus is trapped, the map is inert, Escape returns focus', async ({ visual: { page } }) => {
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.map-area')).toHaveJSProperty('inert', true);
  await expect(page.locator('.map-area')).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close settings', exact: true });
  const save = dialog.getByRole('button', { name: 'Save settings', exact: true });
  await save.focus(); await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await close.focus(); await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.map-area')).toHaveJSProperty('inert', false);
  await expect(opener).toBeFocused();
});

test('Escape in the GitHub inbox closes it and returns focus to its rail slot', async ({ visual: { page } }) => {
  const toggle = page.locator('.github-inbox-toggle');
  await toggle.click();
  const sheet = page.getByRole('dialog', { name: 'GitHub inbox', exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Open Connections', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.github-inbox')).toHaveAttribute('data-open', 'false');
  await expect(toggle).toBeFocused();
});
