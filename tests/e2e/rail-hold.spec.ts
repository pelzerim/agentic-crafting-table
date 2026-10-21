import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('right-clicking a rail tool holds it open through Escape, map clicks and other tools, with a lock on its slot; right-clicking again releases it', async ({ visual: { page } }) => {
  const tool = page.locator('.rail-panel.todo-overlay'), toggle = tool.locator('.rail-panel-toggle'), list = page.getByRole('form', { name: 'To-dos', exact: true });
  await expect(tool).not.toHaveAttribute('data-held', /.*/);
  await expect(toggle).toHaveAttribute('title', /Right-click to hold open$/);
  await toggle.click({ button: 'right' });
  await expect(tool).toHaveAttribute('data-held', 'true');
  await expect(list).toBeVisible();
  await expect(toggle.locator('.rail-held')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-description', 'Held open');
  await expect(toggle).toHaveAttribute('title', /Held open · Right-click to release$/);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__pane').click({ position: { x: 600, y: 500 } });
  await toggle.click();
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeVisible();
  await toggle.click({ button: 'right' });
  await expect(tool).not.toHaveAttribute('data-held', /.*/);
  await expect(tool).toHaveAttribute('data-open', 'false');
  await expect(toggle.locator('.rail-held')).toHaveCount(0);
});
