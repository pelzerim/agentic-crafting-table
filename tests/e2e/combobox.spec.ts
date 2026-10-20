import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('the Connect "To" combobox filters by typing, groups by project, shows icons and keeps Escape local', async ({ visual: { page } }) => {
  const opener = page.getByRole('button', { name: 'Connect Plan switcher', exact: true });
  await opener.focus(); await page.keyboard.press('Enter');
  const form = page.getByRole('form', { name: 'Connect items' }), box = form.getByRole('combobox', { name: 'Connect to', exact: true });
  await expect(box).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const list = form.getByRole('listbox', { name: 'Connect to', exact: true });
  await expect(list.getByRole('group', { name: 'Billing redesign' })).toBeVisible();
  await expect(list.locator('[role=option] .item-icon').first()).toBeVisible();
  await expect(list.getByRole('option').filter({ hasText: 'Plan switcher' })).toHaveCount(0);
  await box.fill('impl');
  await expect(list.getByRole('option')).toHaveText(['Claude · implementation']);
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(box).toHaveValue('Claude · implementation');
  await page.keyboard.press('ArrowDown'); await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0); await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(opener).toBeFocused();
});
