import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('Cmd+F finds an item on the map, a pick flies there and opens it, and Escape closes the view', async ({ visual: { page } }, testInfo) => {
  const find = page.getByRole('combobox', { name: 'Find on map' }), area = page.locator('.map-area');
  await expect(find).toHaveCount(0);
  await page.keyboard.press('Meta+f');
  await expect(find).toBeFocused();
  await find.fill('plan sw');
  const options = page.getByRole('listbox', { name: 'Items on map' }).getByRole('option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('Plan switcher');
  await page.screenshot({ path: testInfo.outputPath('map-find.png') });
  await page.evaluate(() => {
    const area = document.querySelector('.map-area')!, viewport = () => getComputedStyle(document.querySelector('.react-flow__viewport')!).transform;
    const before = viewport(), probe = window as unknown as { moved?: boolean };
    new MutationObserver((_, observer) => { if (area.getAttribute('data-focus')) { probe.moved = viewport() !== before; observer.disconnect(); } }).observe(area, { attributes: true, attributeFilter: ['data-focus'] });
  });
  await options.first().click();
  await expect(find).toHaveCount(0);
  await expect(area).toHaveAttribute('data-focus', 'pr');
  expect(await page.evaluate(() => (window as unknown as { moved?: boolean }).moved), 'the map moved before the item opened').toBe(true);
  await page.keyboard.press('Escape');
  await expect(area).toHaveAttribute('data-focus', '');
  const card = (await page.locator('[data-item-id="pr"]').boundingBox())!, map = (await area.boundingBox())!;
  const centre = { x: map.x + map.width / 2, y: map.y + map.height / 2 };
  expect(Math.hypot(Math.max(card.x - centre.x, 0, centre.x - card.x - card.width), Math.max(card.y - centre.y, 0, centre.y - card.y - card.height)), 'the item sits at the middle of the map').toBeLessThan(40);
});

test('with nothing typed, the find bar lists the items opened last, newest first, ready for the arrows', async ({ visual: { page } }, testInfo) => {
  const find = page.getByRole('combobox', { name: 'Find on map' }), area = page.locator('.map-area');
  const options = page.getByRole('listbox', { name: 'Recently opened' }).getByRole('option');
  await page.keyboard.press('Meta+f');
  await expect(options).toHaveCount(0);
  for (const title of ['switcher', 'plan changes']) {
    await find.fill(title);
    await page.keyboard.press('Enter');
    await expect(area).not.toHaveAttribute('data-focus', '');
    await page.keyboard.press('Escape');
    await expect(area).toHaveAttribute('data-focus', '');
    await page.keyboard.press('Meta+f');
  }
  await expect(find).toBeFocused();
  await expect(options).toHaveText([/Plan changes/, /Plan switcher/]);
  await page.screenshot({ path: testInfo.outputPath('map-find-recent.png') });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(area).toHaveAttribute('data-focus', 'pr');
});

test('the find bar wears the map colours, not the Undermap ones, in the dark and the light theme', async ({ visual: { page } }, testInfo) => {
  await page.keyboard.press('Meta+f');
  await page.getByRole('combobox', { name: 'Find on map' }).fill('plan');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const colours = await page.evaluate(() => {
      const probe = (value: string, property = 'color') => {
        const element = document.createElement('i'); element.style.setProperty(property, value); document.body.append(element);
        const resolved = getComputedStyle(element).getPropertyValue(property); element.remove(); return resolved;
      };
      const bar = getComputedStyle(document.querySelector('.map-find-bar')!), input = getComputedStyle(document.querySelector('.map-find-bar input')!);
      const results = getComputedStyle(document.querySelector('.map-find-bar .undermap-search-results')!);
      return {
        actual: [bar.borderTopColor, bar.color, input.backgroundColor, results.backgroundColor],
        expected: [probe('var(--act-line)'), probe('var(--act-ink)'), probe('var(--act-sunken)'), probe('var(--act-surface)')],
      };
    });
    expect(colours.actual, theme).toEqual(colours.expected);
    await page.screenshot({ path: testInfo.outputPath(`map-find-${theme}.png`) });
  }
});

test('the find bar takes the keyboard: arrows choose, Enter opens, Escape closes it without opening anything', async ({ visual: { page } }) => {
  const find = page.getByRole('combobox', { name: 'Find on map' }), area = page.locator('.map-area');
  await page.keyboard.press('Meta+f');
  await find.fill('zzzz no such item');
  await expect(page.getByText('Nothing on the map matches “zzzz no such item”.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(area).toHaveAttribute('data-focus', '');
  await page.keyboard.press('Meta+f');
  await expect(find).toHaveValue('');
  await find.fill('switcher');
  await page.keyboard.press('Enter');
  await expect(area).toHaveAttribute('data-focus', 'pr');
});
