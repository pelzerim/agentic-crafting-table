import test from 'node:test';
import assert from 'node:assert/strict';
import { CATCH_UP_MS, REMINDER_SEEDS, SNOOZE_MINUTES, clockTime, localDate, reminderListSchema, reminderSaveSchema, reminderSnoozeSchema, reminderSlot, reminderToday, scheduleWords } from './reminders.ts';
import type { Reminder, ReminderDay } from './reminders.ts';

// 7 October 2026 is a Wednesday; every time below is machine-local.
const at = (hours: number, minutes = 0, day = 7) => new Date(2026, 9, day, hours, minutes).getTime();
const stretch: Reminder = { id: 'stretch', label: 'Stretch', enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '12:30' }] };
const row = (extra: Partial<ReminderDay> = {}): ReminderDay => ({ reminderId: 'stretch', date: '2026-10-07', dueAt: at(12, 30), ...extra });

test('schedules read in words: weekday and daily shorthands, then each rule in order', () => {
  assert.equal(scheduleWords([{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '12:30' }]), 'Mon–Fri · 12:30');
  assert.equal(scheduleWords([{ days: ['mon', 'wed', 'thu', 'fri'], time: '12:30' }, { days: ['tue'], time: '13:00' }]), 'Mon Wed Thu Fri · 12:30 · Tue · 13:00');
  assert.equal(scheduleWords([{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '10:30' }]), 'Daily · 10:30');
  assert.equal(scheduleWords([{ days: ['sun', 'sat'], time: '09:00' }]), 'Sat Sun · 09:00');
});

test('local dates and times never use UTC', () => {
  assert.equal(localDate(at(0, 5)), '2026-10-07');
  assert.equal(localDate(at(23, 59)), '2026-10-07');
  assert.equal(clockTime(at(9, 5)), '09:05');
});

test("today's rule gives the due time; a day without a rule has none", () => {
  const split: Reminder = { ...stretch, rules: [{ days: ['mon', 'wed'], time: '12:30' }, { days: ['tue'], time: '13:00' }] };
  assert.deepEqual(reminderSlot(split, at(8)), { time: '12:30', dueAt: at(12, 30) });
  assert.deepEqual(reminderSlot(split, at(8, 0, 6)), { time: '13:00', dueAt: at(13, 0, 6) });
  assert.equal(reminderSlot(split, at(8, 0, 8)), undefined);
});

test("today's state is derived from the rule, the clock and the day row", () => {
  const state = (reminder: Reminder, now: number, day?: ReminderDay) => reminderToday(reminder, now, day).state;
  assert.equal(state(stretch, at(10)), 'upcoming');
  assert.equal(state(stretch, at(12, 31)), 'due', 'within catch-up, before the clock has fired');
  assert.equal(state(stretch, at(12, 30) + CATCH_UP_MS), 'missed');
  assert.equal(state(stretch, at(13), row({ firedAt: at(12, 30) })), 'due');
  assert.equal(state(stretch, at(13), row({ firedAt: at(12, 30), snoozedUntil: at(13, 10) })), 'snoozed');
  assert.equal(state(stretch, at(13, 11), row({ firedAt: at(12, 30), snoozedUntil: at(13, 10) })), 'due');
  assert.equal(state(stretch, at(13), row({ firedAt: at(12, 30), doneAt: at(12, 41) })), 'done');
  assert.equal(state(stretch, at(13), row()), 'missed', 'a row that never fired was missed');
  assert.equal(state({ ...stretch, enabled: false }, at(13)), 'off');
  assert.equal(state(stretch, at(13, 0, 10)), 'none', 'Saturday has no rule');
  assert.deepEqual(reminderToday(stretch, at(10)), { reminderId: 'stretch', date: '2026-10-07', state: 'upcoming', time: '12:30', dueAt: at(12, 30) });
});

test('inputs are bounded: labels, rules, days, times and snooze lengths', () => {
  const list = (reminder: unknown) => reminderListSchema.safeParse([reminder]).success;
  assert.equal(list(stretch), true);
  assert.equal(list({ ...stretch, label: 'x'.repeat(121) }), false);
  assert.equal(list({ ...stretch, label: '   ' }), false);
  assert.equal(list({ ...stretch, rules: [] }), false);
  assert.equal(list({ ...stretch, rules: Array.from({ length: 9 }, () => ({ days: ['mon'], time: '10:00' })) }), false);
  assert.equal(list({ ...stretch, rules: [{ days: [], time: '10:00' }] }), false);
  assert.equal(list({ ...stretch, rules: [{ days: ['mon'], time: '9:00' }] }), false);
  assert.equal(list({ ...stretch, rules: [{ days: ['mon'], time: '24:00' }] }), false);
  assert.equal(list({ ...stretch, rules: [{ days: ['mon'], time: '10:00' }, { days: ['mon', 'tue'], time: '11:00' }] }), false, 'one rule per weekday');
  assert.equal(reminderListSchema.safeParse([stretch, stretch]).success, false, 'ids are unique');
  assert.deepEqual(reminderSaveSchema.parse({ list: [{ ...stretch, label: '  Stretch ', rules: [{ days: ['fri', 'mon'], time: '12:30' }] }] }).list[0], { ...stretch, rules: [{ days: ['mon', 'fri'], time: '12:30' }] });
  assert.deepEqual(SNOOZE_MINUTES, [10, 30]);
  assert.equal(reminderSnoozeSchema.safeParse({ id: 'stretch', minutes: 10 }).success, true);
  assert.equal(reminderSnoozeSchema.safeParse({ id: 'stretch', minutes: 15 }).success, false);
});

test('first run seeds no reminders', () => {
  assert.deepEqual(REMINDER_SEEDS, []);
});
