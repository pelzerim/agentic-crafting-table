import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('the zoom bar is a slider with a percentage that resets to 100%; − and + are keys, not buttons', async ({ visual: { page } }) => {
  const bar = page.locator('.zoom-markers'), slider = page.getByRole('slider', { name: 'Map zoom' });
  const readout = bar.getByRole('button', { name: 'Reset zoom to 100%', exact: true });
  const level = async () => Number((await readout.textContent())!.replace('%', ''));
  await expect(slider).toHaveAttribute('aria-valuetext', '70%'); await expect(readout).toHaveText('70%');
  await expect(bar.getByRole('button')).toHaveCount(1);
  await expect(bar.getByRole('button', { name: /^Zoom (in|out)$/ })).toHaveCount(0);
  await page.mouse.move(4, 4);
  await page.keyboard.press('+');
  await expect.poll(level).toBeGreaterThan(70);
  await page.keyboard.press('-'); await page.keyboard.press('-');
  await expect.poll(level).toBeLessThan(70);
  await page.keyboard.press('0');
  await expect(readout).toHaveText('100%');
  await slider.fill('0.7');
  await expect(readout).toHaveText('70%');
  await readout.click();
  await expect(readout).toHaveText('100%'); await expect(slider).toHaveAttribute('aria-valuetext', '100%');
  await expect(bar.locator('.zoom-tick-label')).toHaveCount(2);
  await expect(bar.locator('.zoom-tick-label[data-tier=board]')).toHaveAttribute('title', '65% · Dashboards below');
  await expect(bar.locator('.zoom-tick-label[data-tier=card]')).toHaveAttribute('title', '115% · Close cards above');
  await slider.fill('0.7'); await page.mouse.move(4, 4);
  await expect(bar).toHaveScreenshot('zoom-bar.png');
});
