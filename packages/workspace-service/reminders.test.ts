import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { Reminders } from './reminders.ts';
import { CATCH_UP_MS, REMINDER_TICK_MS } from '../core/reminders.ts';
import type { Reminder, ReminderDue } from '../core/reminders.ts';

// 7 October 2026 is a Wednesday; every time below is machine-local.
const at = (hours: number, minutes = 0, day = 7) => new Date(2026, 9, day, hours, minutes).getTime();
const stretch: Reminder = { id: 'stretch', label: 'Stretch', enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '12:30' }] };
const plants: Reminder = { id: 'plants', label: 'Water plants', enabled: true, rules: [{ days: ['wed'], time: '15:00' }] };

type Fixture = { file: string; store: SqliteStore; clock: { now: number }; open(): Reminders; due: ReminderDue[]; changes: number[] };
async function fixture(run: (value: Fixture) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-reminders-'));
  const file = join(directory, 'workspace.sqlite'), store = new SqliteStore(file), clock = { now: at(10) }, due: ReminderDue[] = [], changes: number[] = [], opened: Reminders[] = [];
  const open = () => {
    const reminders = new Reminders(store, { now: () => clock.now, schedule: () => () => {}, changed: () => { changes.push(clock.now); } });
    reminders.on('due', event => due.push(event)); opened.push(reminders); return reminders;
  };
  try { await run({ file, store, clock, open, due, changes }); }
  finally { for (const reminders of opened) await reminders.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('a reminder fires once when its time passes, across ticks and restarts', () => fixture(({ store, clock, open, due, changes }) => {
  store.saveReminders([stretch]);
  const reminders = open();
  assert.deepEqual(reminders.tick(), []);
  assert.equal(reminders.snapshot().today[0].state, 'upcoming');
  clock.now = at(12, 30);
  const fired = reminders.tick();
  assert.deepEqual(fired, [{ reminder: stretch, day: { reminderId: 'stretch', date: '2026-10-07', dueAt: at(12, 30), firedAt: at(12, 30) } }]);
  assert.deepEqual(due, fired, 'a due event is emitted');
  assert.deepEqual(changes, [at(12, 30)]);
  clock.now = at(12, 31);
  assert.deepEqual(reminders.tick(), []);
  assert.deepEqual(open().tick(), [], 'a restarted clock does not fire it again');
  assert.equal(reminders.snapshot().today[0].state, 'due');
}));

test('on start a missed time fires within 90 minutes; later the day is missed', () => fixture(({ store, clock, open, due }) => {
  store.saveReminders([stretch, plants]);
  clock.now = at(12, 30) + CATCH_UP_MS - 60_000;
  const reminders = open(); reminders.start();
  assert.deepEqual(due.map(event => event.reminder.id), ['stretch']);
  clock.now = at(15) + CATCH_UP_MS;
  assert.deepEqual(reminders.tick(), []);
  assert.deepEqual(reminders.snapshot().today.map(today => today.state), ['due', 'missed']);
  assert.deepEqual(store.reminderDays('2026-10-07').find(day => day.reminderId === 'plants'), { reminderId: 'plants', date: '2026-10-07', dueAt: at(15) });
}));

test('a disabled reminder never fires', () => fixture(({ store, clock, open }) => {
  store.saveReminders([{ ...stretch, enabled: false }]);
  clock.now = at(12, 30);
  const reminders = open();
  assert.deepEqual(reminders.tick(), []);
  assert.equal(reminders.snapshot().today[0].state, 'off');
}));

test('snooze fires again at its end; done ends the day', () => fixture(({ store, clock, open, due }) => {
  store.saveReminders([stretch]);
  clock.now = at(12, 30);
  const reminders = open(); reminders.tick();
  const revision = reminders.snapshot().revision;
  reminders.snooze('stretch', 10);
  assert.ok(reminders.snapshot().revision > revision);
  assert.equal(reminders.snapshot().today[0].state, 'snoozed');
  assert.equal(reminders.snapshot().today[0].snoozedUntil, at(12, 40));
  clock.now = at(12, 39); assert.deepEqual(reminders.tick(), []);
  clock.now = at(12, 40); assert.equal(reminders.tick().length, 1);
  assert.equal(due.length, 2);
  assert.equal(reminders.snapshot().today[0].state, 'due');
  clock.now = at(12, 41); reminders.done('stretch');
  assert.equal(reminders.snapshot().today[0].state, 'done');
  assert.equal(reminders.snapshot().today[0].doneAt, at(12, 41));
  assert.throws(() => reminders.snooze('stretch', 30), /not due/);
}));

test('done before the time keeps it from firing; snoozing needs a due reminder', () => fixture(({ store, clock, open }) => {
  store.saveReminders([stretch, plants]);
  const reminders = open();
  assert.throws(() => reminders.snooze('stretch', 10), /not due/);
  reminders.done('stretch');
  clock.now = at(12, 30);
  assert.deepEqual(reminders.tick(), []);
  assert.throws(() => reminders.done('missing'), /no longer exists/);
  store.saveReminders([{ ...plants, rules: [{ days: ['thu'], time: '15:00' }] }]);
  assert.throws(() => reminders.done('plants'), /not set for today/);
}));

test('saving after a time passed marks it missed instead of firing; moving it later gives a new chance', () => fixture(({ store, clock, open }) => {
  clock.now = at(13);
  const reminders = open();
  reminders.save([stretch]);
  assert.deepEqual(reminders.tick(), [], 'a reminder created after its time does not fire');
  assert.equal(reminders.snapshot().today[0].state, 'missed');
  reminders.save([{ ...stretch, rules: [{ days: ['wed'], time: '14:00' }] }]);
  assert.equal(reminders.snapshot().today[0].state, 'upcoming');
  clock.now = at(14);
  assert.equal(reminders.tick().length, 1);
  reminders.save([{ ...stretch, label: 'Stretch break', rules: [{ days: ['wed'], time: '16:00' }] }]);
  assert.equal(reminders.snapshot().today[0].state, 'due', 'a reminder that fired today stays fired');
  reminders.save([{ ...stretch, enabled: false }]); reminders.save([stretch]);
  assert.equal(reminders.snapshot().today[0].state, 'due');
}));

test('the day ends: today moves on, nothing carries over, old rows are pruned', () => fixture(({ store, clock, open, changes }) => {
  store.saveReminders([stretch]);
  store.writeReminderDay({ reminderId: 'stretch', date: '2026-08-01', dueAt: at(12, 30, 1) - 67 * 86_400_000 });
  clock.now = at(12, 30);
  const reminders = open(); reminders.tick(); reminders.snooze('stretch', 10);
  const revision = reminders.snapshot().revision;
  clock.now = at(9, 0, 8);
  assert.deepEqual(reminders.tick(), []);
  assert.ok(reminders.snapshot().revision > revision);
  assert.equal(changes.at(-1), at(9, 0, 8));
  assert.deepEqual(reminders.snapshot().today.map(today => [today.date, today.state]), [['2026-10-08', 'upcoming']]);
  assert.deepEqual(store.reminderDays('2026-08-01'), []);
}));

test('the clock ticks every 30 seconds while started and stops when paused or closed', () => fixture(async ({ store, clock }) => {
  store.saveReminders([stretch]);
  const ticks: (() => void)[] = []; let cancelled = 0;
  const reminders = new Reminders(store, { now: () => clock.now, schedule: (run, ms) => { assert.equal(ms, REMINDER_TICK_MS); ticks.push(run); return () => { cancelled++; }; } });
  const due: ReminderDue[] = []; reminders.on('due', event => due.push(event));
  reminders.start(); reminders.start();
  assert.equal(ticks.length, 1);
  clock.now = at(12, 30); ticks[0]();
  assert.equal(due.length, 1);
  await reminders.pause(); assert.equal(cancelled, 1);
  await reminders.close(); reminders.start();
  assert.equal(ticks.length, 1, 'a closed clock does not restart');
}));
