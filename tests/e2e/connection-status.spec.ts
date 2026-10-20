import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('the connection chip is silent while connected, amber while reconnecting and says Reconnected briefly', async ({ visual: { app, page } }) => {
  const status = page.locator('.connection-status'), chip = status.locator('.connection-chip');
  await expect(status).toHaveAccessibleName('Desktop connected');
  await expect(chip).toBeHidden();
  const send = (value: string) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('workspace:status', value), value);
  await send('disconnected');
  await expect(chip).toBeVisible(); await expect(chip).toHaveText('Reconnecting…');
  await expect(status).toHaveAttribute('data-state', 'reconnecting');
  await expect(page.locator('.map-status')).toHaveScreenshot('connection-reconnecting.png');
  await send('connected');
  await expect(chip).toHaveText('Reconnected'); await expect(status).toHaveAttribute('data-state', 'reconnected');
  await expect(chip).toBeHidden({ timeout: 4_000 });
  await expect(status).toHaveAttribute('data-state', 'connected');
});
