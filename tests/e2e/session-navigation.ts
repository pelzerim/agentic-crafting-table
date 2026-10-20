import { expect, type Page } from '@playwright/test';
export async function openDiagnosticSessions(page: Page) {
  await expect(page.getByRole('button', { name: 'Sessions', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.session-manager')).toBeVisible();
}
