import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import { WEEKDAYS, scheduleWords } from '../../packages/core/reminders.ts';
import type { Reminder, ReminderDue } from '../../packages/core/reminders.ts';

// The app runs with TZ=UTC and the service keeps real time, so schedules are built around the current UTC minute.
const pad = (value: number) => String(value).padStart(2, '0');
const utcTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const nowMinutes = () => { const now = new Date(); return now.getUTCHours() * 60 + now.getUTCMinutes(); };
const todayDay = () => WEEKDAYS[(new Date().getUTCDay() + 6) % 7];
const mailTime = utcTime(Math.max(0, nowMinutes() - 5)), laterTime = utcTime(Math.min(23 * 60 + 59, nowMinutes() + 60));
const mail: Reminder = { id: 'mail', label: 'Check mail', enabled: true, rules: [{ days: [...WEEKDAYS], time: mailTime }] };
// Half a day from now, whatever the hour: never inside the catch-up window after its time, so it is never due here.
const farTime = (offset = 0) => utcTime((nowMinutes() + 12 * 60 + offset) % (24 * 60));
const plants: Reminder = { id: 'plants', label: 'Water plants', enabled: true, rules: [{ days: ['mon', 'wed', 'thu', 'fri'], time: farTime() }, { days: ['tue'], time: farTime(30) }] };
const backup: Reminder = { id: 'backup', label: 'Back up laptop', enabled: true, rules: [{ days: WEEKDAYS.filter(day => day !== todayDay()), time: '15:30' }] };
const stretch: Reminder = { id: 'stretch', label: 'Stretch', enabled: false, rules: [{ days: [...WEEKDAYS], time: '10:30' }] };
const later: Reminder = { id: 'later', label: 'Tidy desk', enabled: true, rules: [{ days: [...WEEKDAYS], time: laterTime }] };

const row = (page: Page, id: string) => page.locator(`.reminders-row[data-reminder-id="${id}"]`);
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Reminders', exact: true });
const slotButton = (page: Page) => page.locator('.reminders-tool > .rail-panel-toggle');

test.describe('with a due reminder, one not today and one off', () => {
  test.use({ reminders: [[mail, plants, backup, stretch], { scope: 'test' }] });

  test('the Reminders slot sits third and the sheet lists, acts on and edits reminders', async ({ visual: { page } }) => {
    // A reminder whose time passed minutes before the service started fires on start.
    await expect(slotButton(page)).toHaveAccessibleName('Reminders: 1 due');
    await expect(slotButton(page)).toHaveAttribute('aria-keyshortcuts', '3');
    await expect(page.locator('.reminders-tool')).toHaveAttribute('data-due', 'true');
    await expect(page.locator('.reminders-count')).toHaveText('1');
    const order = await page.locator('.rail-panel-toggle,.below-portal').evaluateAll(elements => elements.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y).map(element => element.getAttribute('aria-label')));
    expect(order.slice(1, 4)).toEqual(['Keep to-dos open', 'Reminders: 1 due', 'GitHub inbox']);

    await page.keyboard.press('3');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Reminders' })).toBeVisible();
    await expect(page.locator('.tool-rail-slot[data-slot=reminders]')).toHaveAttribute('data-pinned', 'true');
    await expect(page.locator('.reminders-row .reminders-label')).toHaveText(['Check mail', 'Water plants', 'Back up laptop', 'Stretch']);
    await expect(row(page, 'mail').locator('.reminders-schedule')).toHaveText(`Daily · ${mailTime}`);
    await expect(row(page, 'mail').locator('.reminders-state > span')).toHaveText(`Due · ${mailTime}`);
    await expect(row(page, 'plants').locator('.reminders-schedule')).toHaveText(scheduleWords(plants.rules));
    await expect(row(page, 'backup').locator('.reminders-schedule')).toHaveText(scheduleWords(backup.rules));
    await expect(row(page, 'backup').locator('.reminders-state')).toHaveText('Not today');
    await expect(row(page, 'stretch').locator('.reminders-state')).toHaveText('Off');

    // Snooze, then Done: the row says so and the slot lets go of its count.
    await row(page, 'mail').getByRole('button', { name: 'Snooze Check mail 10 minutes' }).click();
    await expect(row(page, 'mail').locator('.reminders-state > span')).toHaveText(/^Snoozed until \d\d:\d\d$/);
    await expect(slotButton(page)).toHaveAccessibleName('Reminders');
    await expect(page.locator('.reminders-tool')).toHaveAttribute('data-snoozed', 'true');
    await expect(row(page, 'mail').getByRole('button', { name: /^Snooze/ })).toHaveCount(0);
    await row(page, 'mail').getByRole('button', { name: 'Mark Check mail done' }).click();
    await expect(row(page, 'mail').locator('.reminders-state > span')).toHaveText(/^Done \d\d:\d\d$/);
    await expect(page.locator('.reminders-tool')).not.toHaveAttribute('data-snoozed');

    // A chip that is another rule's day moves there; a rule left without days goes. Cancel keeps the saved reminder.
    await row(page, 'plants').getByRole('button', { name: 'Edit Water plants' }).click();
    const plantsEditor = sheet(page).getByRole('group', { name: 'Edit Water plants' });
    await expect(plantsEditor.getByRole('group', { name: /^Time / })).toHaveCount(2);
    await plantsEditor.getByRole('group', { name: 'Time 1' }).getByRole('button', { name: 'Tue', exact: true }).click();
    await expect(plantsEditor.getByRole('group', { name: /^Time / })).toHaveCount(1);
    await expect(plantsEditor.getByRole('group', { name: 'Time 1' }).getByRole('button', { name: 'Tue', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await plantsEditor.getByRole('button', { name: 'Cancel' }).click();
    await expect(row(page, 'plants').locator('.reminders-schedule')).toHaveText(scheduleWords(plants.rules));

    // Edit and save: name, Daily, another time, off.
    await row(page, 'backup').getByRole('button', { name: 'Edit Back up laptop' }).click();
    const backupEditor = sheet(page).getByRole('group', { name: 'Edit Back up laptop' });
    await backupEditor.getByRole('textbox', { name: 'Name' }).fill('Back up photos');
    await backupEditor.getByRole('button', { name: 'Weekdays' }).click();
    await backupEditor.getByRole('button', { name: '+ another time' }).click();
    const second = backupEditor.getByRole('group', { name: 'Time 2' });
    await expect(second.getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'true');
    await second.getByLabel('Time', { exact: true }).fill('10:00');
    await backupEditor.getByRole('switch').uncheck();
    await backupEditor.getByRole('button', { name: 'Save' }).click();
    await expect(row(page, 'backup').locator('.reminders-label')).toHaveText('Back up photos');
    await expect(row(page, 'backup').locator('.reminders-schedule')).toHaveText('Mon–Fri · 15:30 · Sat Sun · 10:00');
    await expect(row(page, 'backup').locator('.reminders-state')).toHaveText('Off');

    // Add: Weekdays · 09:00, a name is required; then delete it again.
    await sheet(page).getByRole('button', { name: '+ Add a reminder' }).click();
    const added = sheet(page).getByRole('group', { name: 'New reminder' });
    await expect(added.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await added.getByRole('button', { name: 'Save' }).click();
    await expect(sheet(page).getByRole('alert')).toHaveText('Give the reminder a name.');
    await added.getByRole('textbox', { name: 'Name' }).fill('Sort inbox');
    await added.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.reminders-row .reminders-label')).toHaveText(['Check mail', 'Water plants', 'Back up photos', 'Stretch', 'Sort inbox']);
    await expect(page.locator('.reminders-row').last().locator('.reminders-schedule')).toHaveText('Mon–Fri · 09:00');
    await page.locator('.reminders-row').last().getByRole('button', { name: 'Edit Sort inbox' }).click();
    await sheet(page).getByRole('button', { name: 'Delete Sort inbox' }).click();
    await expect(page.locator('.reminders-row .reminders-label')).toHaveText(['Check mail', 'Water plants', 'Back up photos', 'Stretch']);

    // Saved for real: a reload reads the list back from the service.
    await page.reload();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await slotButton(page).click();
    await expect(page.locator('.reminders-row .reminders-label')).toHaveText(['Check mail', 'Water plants', 'Back up photos', 'Stretch']);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(slotButton(page)).toBeFocused();
  });

  test('a due reminder shows a notice beside its slot while the window is in front', async ({ visual: { page } }) => {
    const notice = page.getByRole('status', { name: 'Reminder: Check mail' });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(slotButton(page)).toHaveAccessibleName('Reminders: 1 due');
    await expect(notice).toHaveCount(0);
    // Coming back to the window shows a reminder that is still unhandled.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`Check mail${mailTime} · Daily · ${mailTime}`);
    const [box, slot] = [await notice.boundingBox(), await slotButton(page).boundingBox()];
    expect(Math.abs(box!.y - slot!.y)).toBeLessThanOrEqual(4); expect(box!.x).toBeGreaterThan(slot!.x + slot!.width);
    // Escape closes the notice without marking anything, and it stays closed for this firing.
    await notice.getByRole('button', { name: 'Mark Check mail done' }).focus();
    await page.keyboard.press('Escape');
    await expect(notice).toHaveCount(0);
    await expect(slotButton(page)).toHaveAccessibleName('Reminders: 1 due');
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await expect(notice).toHaveCount(0);
  });
});

test.describe('with a reminder later today', () => {
  test.use({ reminders: [[later], { scope: 'test' }] });

  test('a due event shows the notice beside the slot and Done closes it', async ({ visual: { app, page } }) => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(slotButton(page)).toHaveAccessibleName('Reminders');
    await expect(page.getByRole('status', { name: /^Reminder:/ })).toHaveCount(0);
    const firedAt = Date.now(), event: ReminderDue = { reminder: later, day: { reminderId: 'later', date: new Date(firedAt).toISOString().slice(0, 10), dueAt: firedAt, firedAt } };
    await app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('workspace:reminder-due', event), event);
    const notice = page.getByRole('status', { name: 'Reminder: Tidy desk' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button')).toHaveText(['Done', 'Snooze 10', '30 min']);
    await notice.getByRole('button', { name: 'Mark Tidy desk done' }).click();
    await expect(notice).toHaveCount(0);
    await page.keyboard.press('3');
    await expect(row(page, 'later').locator('.reminders-state > span')).toHaveText(/^Done \d\d:\d\d$/);
    await page.keyboard.press('Escape');
  });
});
