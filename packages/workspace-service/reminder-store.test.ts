import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrations } from './sqlite-store.ts';
import type { Reminder } from '../core/reminders.ts';

const at = (hours: number, minutes = 0, day = 7) => new Date(2026, 9, day, hours, minutes).getTime();
const stretch: Reminder = { id: 'stretch', label: 'Stretch', enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '12:30' }] };
const plants: Reminder = { id: 'plants', label: 'Water plants', enabled: true, rules: [{ days: ['wed'], time: '15:00' }] };

async function fixture(run: (value: { file: string; store: SqliteStore }) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-reminder-store-'));
  const file = join(directory, 'workspace.sqlite'), store = new SqliteStore(file);
  try { run({ file, store }); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('a first run starts with no reminders', () => fixture(({ store }) => {
  assert.deepEqual(store.reminders(), []);
}));

test('seeds are written once; deleting them sticks', () => fixture(({ file }) => {
  const seeds = [{ label: 'Stretch', enabled: false, rules: stretch.rules }];
  const first = new SqliteStore(file, { reminderSeeds: seeds });
  try {
    const seeded = first.reminders();
    assert.deepEqual(seeded.map(reminder => [reminder.label, reminder.enabled]), [['Stretch', false]]);
    assert.deepEqual(first.reminders(), seeded, 'ids are stable');
    first.saveReminders([]);
  } finally { first.close(); }
  const reopened = new SqliteStore(file, { reminderSeeds: seeds });
  try { assert.deepEqual(reopened.reminders(), []); } finally { reopened.close(); }
}));

test('stored reminders stay as they are when the app opens them again', () => fixture(({ file, store }) => {
  store.saveReminders([stretch, plants]);
  const reopened = new SqliteStore(file);
  try { assert.deepEqual(reopened.reminders(), [stretch, plants]); } finally { reopened.close(); }
}));

test('the list is saved whole and in order; a removed reminder takes its day rows with it', () => fixture(({ store }) => {
  store.saveReminders([stretch, plants]);
  store.writeReminderDay({ reminderId: 'plants', date: '2026-10-07', dueAt: at(15), firedAt: at(15) });
  store.saveReminders([plants, { ...stretch, label: 'Stretch break' }]);
  assert.deepEqual(store.reminders().map(reminder => reminder.label), ['Water plants', 'Stretch break']);
  store.saveReminders([stretch]);
  assert.deepEqual(store.reminderDays('2026-10-07'), []);
}));

test('day rows round-trip and rows older than the kept window are pruned', () => fixture(({ store }) => {
  store.saveReminders([stretch]);
  store.writeReminderDay({ reminderId: 'stretch', date: '2026-09-01', dueAt: at(12, 30, 1), firedAt: at(12, 30, 1) });
  store.writeReminderDay({ reminderId: 'stretch', date: '2026-10-07', dueAt: at(12, 30), firedAt: at(12, 30), snoozedUntil: at(12, 40) });
  assert.deepEqual(store.reminderDays('2026-10-07'), [{ reminderId: 'stretch', date: '2026-10-07', dueAt: at(12, 30), firedAt: at(12, 30), snoozedUntil: at(12, 40) }]);
  store.pruneReminderDays('2026-09-07');
  assert.deepEqual(store.reminderDays('2026-09-01'), []);
  assert.equal(store.reminderDays('2026-10-07').length, 1);
}));

test('an existing workspace gains the reminder tables without losing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-reminders-'));
  try {
    const file = join(directory, 'existing.sqlite');
    let store = new SqliteStore(file);
    await store.update(state => ({ ...state, nodes: [{ id: 'project', title: 'Kept', position: { x: 0, y: 0 } }] } as typeof state));
    store.close();
    const before = migrations.findIndex(migration => migration.includes('reminder_days'));
    const old = new DatabaseSync(file); old.exec(`DROP TABLE reminders; DROP TABLE reminder_days; PRAGMA user_version = ${before};`); old.close();
    store = new SqliteStore(file);
    try {
      assert.ok(store.backupFile, 'the upgrade backs up first');
      assert.deepEqual(store.reminders(), []);
      assert.equal((await store.read()).nodes[0].title, 'Kept');
    } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
