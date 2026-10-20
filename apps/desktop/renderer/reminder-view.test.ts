import test from 'node:test';
import assert from 'node:assert/strict';
import { addRule, draftProblem, newReminderDraft, noticeReminders, railReminders, reminderStateWords, removeRule, setRuleDays, toggleRuleDay } from './reminder-view.ts';
import type { Reminder, ReminderDue, ReminderToday, RemindersSnapshot } from '../../../packages/core/reminders.ts';

const at = (hours: number, minutes = 0) => new Date(2026, 9, 7, hours, minutes).getTime();
const today = (state: ReminderToday['state'], extra: Partial<ReminderToday> = {}): ReminderToday => ({ reminderId: 'stretch', date: '2026-10-07', state, ...extra });
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;

test('today’s state reads as words', () => {
  const now = at(10, 15);
  assert.equal(reminderStateWords(today('none'), now), 'Not today');
  assert.equal(reminderStateWords(today('off'), now), 'Off');
  assert.equal(reminderStateWords(today('upcoming', { time: '12:30', dueAt: at(12, 30) }), now), 'in 2 h 15');
  assert.equal(reminderStateWords(today('upcoming', { time: '12:15', dueAt: at(12, 15) }), now), 'in 2 h');
  assert.equal(reminderStateWords(today('upcoming', { time: '10:40', dueAt: at(10, 40) }), now), 'in 25 min');
  assert.equal(reminderStateWords(today('upcoming', { time: '10:15', dueAt: at(10, 15) + 20_000 }), now), 'in 1 min', 'part of a minute rounds up');
  assert.equal(reminderStateWords(today('upcoming', { time: '10:00', dueAt: at(10) }), now), 'in 1 min', 'a renderer clock ahead of the service never shows a negative time');
  assert.equal(reminderStateWords(today('due', { time: '12:30', dueAt: at(12, 30) }), now), 'Due · 12:30');
  assert.equal(reminderStateWords(today('snoozed', { time: '12:30', snoozedUntil: at(12, 50) }), now), 'Snoozed until 12:50');
  assert.equal(reminderStateWords(today('done', { time: '12:30', doneAt: at(12, 41) }), now), 'Done 12:41');
  assert.equal(reminderStateWords(today('missed', { time: '12:30' }), now), 'Missed');
});

test('the rail slot counts reminders due now and notices a snoozed one', () => {
  assert.deepEqual(railReminders([]), { due: 0, snoozed: false });
  assert.deepEqual(railReminders([today('due'), today('upcoming'), today('due')]), { due: 2, snoozed: false });
  assert.deepEqual(railReminders([today('snoozed'), today('done')]), { due: 0, snoozed: true });
});

test('a new reminder starts as Weekdays at 09:00 with an empty name', () => {
  assert.deepEqual(newReminderDraft('r1'), { id: 'r1', label: '', enabled: true, rules: [{ days: [...weekdays], time: '09:00' }] });
});

test('a weekday belongs to one rule: choosing it on another rule moves it there', () => {
  const rules = [{ days: ['mon', 'wed', 'thu', 'fri'], time: '12:30' }, { days: ['tue'], time: '13:00' }] as Reminder['rules'];
  assert.deepEqual(toggleRuleDay(rules, 0, 'thu'), [{ days: ['mon', 'wed', 'fri'], time: '12:30' }, { days: ['tue'], time: '13:00' }], 'a chip toggles off');
  assert.deepEqual(toggleRuleDay(rules, 1, 'sat'), [rules[0], { days: ['tue', 'sat'], time: '13:00' }], 'a free day toggles on');
  assert.deepEqual(toggleRuleDay(rules, 1, 'mon'), [{ days: ['wed', 'thu', 'fri'], time: '12:30' }, { days: ['mon', 'tue'], time: '13:00' }], 'a taken day moves to the clicked rule');
  assert.deepEqual(toggleRuleDay(rules, 0, 'tue'), [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '12:30' }], 'a rule whose last day moves away goes with it');
  assert.deepEqual(toggleRuleDay([{ days: ['mon'], time: '12:30' }], 0, 'mon'), [{ days: [], time: '12:30' }], 'the clicked rule may become empty; saving says so');
});

test('Weekdays and Daily set a rule’s days and take them from the others', () => {
  const rules = [{ days: ['sat'], time: '10:00' }, { days: ['tue'], time: '13:00' }] as Reminder['rules'];
  assert.deepEqual(setRuleDays(rules, 1, weekdays), [{ days: ['sat'], time: '10:00' }, { days: [...weekdays], time: '13:00' }]);
  assert.deepEqual(setRuleDays(rules, 0, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '10:00' }]);
});

test('another time takes the days no rule has yet; a rule can be removed while another remains', () => {
  assert.deepEqual(addRule([{ days: [...weekdays], time: '12:30' }]), [{ days: [...weekdays], time: '12:30' }, { days: ['sat', 'sun'], time: '12:30' }]);
  assert.deepEqual(addRule([{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '09:00' }]).at(-1), { days: [], time: '09:00' });
  const two = [{ days: ['mon'], time: '09:00' }, { days: ['tue'], time: '10:00' }] as Reminder['rules'];
  assert.deepEqual(removeRule(two, 0), [two[1]]);
  assert.deepEqual(removeRule([two[0]], 0), [two[0]], 'the last rule stays');
});

test('a draft that cannot be saved says why in words', () => {
  const draft = { ...newReminderDraft('r1'), label: 'Stretch' };
  assert.equal(draftProblem(draft), undefined);
  assert.equal(draftProblem({ ...draft, label: '  ' }), 'Give the reminder a name.');
  assert.equal(draftProblem({ ...draft, rules: [{ days: [], time: '12:30' }] }), 'Choose at least one day for each time.');
  assert.equal(draftProblem({ ...draft, rules: [{ days: ['mon'], time: '' }] }), 'Enter a time between 00:00 and 23:59.');
  assert.equal(draftProblem({ ...draft, label: 'x'.repeat(121) }), 'Keep the name under 120 characters.');
});

const stretch: Reminder = { id: 'stretch', label: 'Stretch', enabled: true, rules: [{ days: [...weekdays], time: '12:30' }] };
const snapshot = (entry: Partial<ReminderToday>, reminder = stretch): RemindersSnapshot => ({ list: [reminder], today: [{ reminderId: reminder.id, date: '2026-10-07', state: 'upcoming', time: '12:30', dueAt: at(12, 30), ...entry }], revision: 1 });
const due = (firedAt = at(12, 30)): ReminderDue => ({ reminder: stretch, day: { reminderId: 'stretch', date: '2026-10-07', dueAt: at(12, 30), firedAt } });

test('the in-app notice shows due reminders until they are acted on, closed or the day changes', () => {
  const none = new Map<string, number>(), events = new Map([['stretch', due()]]);
  assert.deepEqual(noticeReminders(snapshot({ state: 'due', firedAt: at(12, 30) }), new Map(), none), [{ reminder: stretch, time: '12:30', firing: at(12, 30) }], 'a due reminder in the snapshot');
  assert.deepEqual(noticeReminders(snapshot({ state: 'upcoming' }), events, none), [{ reminder: stretch, time: '12:30', firing: at(12, 30) }], 'the due event can arrive before the snapshot that shows it');
  assert.deepEqual(noticeReminders(snapshot({ state: 'snoozed', firedAt: at(12, 30), snoozedUntil: at(12, 40) }), new Map([['stretch', due(at(12, 40))]]), none).length, 1, 'a snooze ending fires again before the snapshot catches up');
  assert.deepEqual(noticeReminders(snapshot({ state: 'snoozed', firedAt: at(12, 30), snoozedUntil: at(12, 40) }), events, none), [], 'snoozed after this firing');
  assert.deepEqual(noticeReminders(snapshot({ state: 'done', firedAt: at(12, 30), doneAt: at(12, 31) }), events, none), [], 'done');
  assert.deepEqual(noticeReminders(snapshot({ state: 'off' }, { ...stretch, enabled: false }), events, none), [], 'turned off');
  assert.deepEqual(noticeReminders({ list: [], today: [], revision: 2 }, events, none), [], 'deleted');
  assert.deepEqual(noticeReminders(snapshot({ state: 'upcoming', date: '2026-10-08', dueAt: at(36, 30) }), events, none), [], 'the day changed');
  assert.deepEqual(noticeReminders(snapshot({ state: 'due', firedAt: at(12, 30) }), events, new Map([['stretch', at(12, 30)]])), [], 'closed with Escape');
  assert.equal(noticeReminders(snapshot({ state: 'due', firedAt: at(12, 40) }), events, new Map([['stretch', at(12, 30)]])).length, 1, 'a later firing shows again after Escape');
});
