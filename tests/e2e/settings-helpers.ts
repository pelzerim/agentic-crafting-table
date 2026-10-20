import type { Page } from '@playwright/test';

/** Opens the visible settings page's Advanced disclosure; it stays open while the dialog is open. */
export async function showAdvanced(page: Page) {
  const toggle = page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /^Advanced settings/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
