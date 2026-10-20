import type { Locator, Page } from '@playwright/test';

/** Opens a PixelCombobox and picks the option with this value. */
export async function choose(scope: Page | Locator, label: string, value: string) {
  const list = scope.getByRole('listbox', { name: label, exact: true });
  if (!await list.isVisible()) await scope.getByRole('combobox', { name: label, exact: true }).click();
  await list.locator(`[role=option][data-value="${value}"]`).click();
}
