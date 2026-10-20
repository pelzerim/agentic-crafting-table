import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from './server.ts';
import { WorkspaceConnection } from './connection.ts';
import type { WorkspaceSnapshot } from './protocol.ts';
import type { Reminder, ReminderDue, RemindersSnapshot } from '../core/reminders.ts';

const at = (hours: number, minutes = 0) => new Date(2026, 9, 7, hours, minutes).getTime();
const stretch: Reminder = { id: 'stretch', label: 'Stretch', enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '12:30' }] };

test('the service carries reminders in its snapshot, changes them by RPC and relays due events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-reminders-service-'));
  const clock = { now: at(10) }, ticks: (() => void)[] = [];
  const service = await startWorkspaceService(directory, undefined, undefined, { reminderClock: { now: () => clock.now, schedule: tick => { ticks.push(tick); return () => {}; } } });
  const connection = new WorkspaceConnection(directory, process.execPath, 'unused');
  const snapshots: WorkspaceSnapshot[] = [], due: ReminderDue[] = [];
  connection.on('snapshot', snapshot => snapshots.push(snapshot)); connection.on('reminder-due', event => due.push(event));
  try {
    await connection.connect();
    assert.deepEqual(snapshots[0].reminders!.list.map(reminder => reminder.label), []);
    assert.equal(ticks.length, 1, 'the clock starts with the service');
    const changed = once(connection, 'snapshot', { signal: AbortSignal.timeout(5000) });
    const saved = await connection.call<RemindersSnapshot>('reminders.save', { list: [stretch] });
    assert.deepEqual(saved.list, [stretch]);
    const [broadcast] = await changed as [WorkspaceSnapshot];
    assert.equal(broadcast.cursor, snapshots[0].cursor, 'a reminder change keeps the workspace cursor');
    assert.deepEqual(broadcast.reminders!.today.map(today => today.state), ['upcoming']);
    await assert.rejects(connection.call('reminders.save', { list: [{ ...stretch, label: '' }] }));
    await assert.rejects(connection.call('reminders.snooze', { id: 'stretch', minutes: 15 }));

    clock.now = at(12, 30);
    const fired = once(connection, 'reminder-due', { signal: AbortSignal.timeout(5000) }), refreshed = once(connection, 'snapshot', { signal: AbortSignal.timeout(5000) });
    ticks[0]();
    assert.deepEqual((await fired)[0], { reminder: stretch, day: { reminderId: 'stretch', date: '2026-10-07', dueAt: at(12, 30), firedAt: at(12, 30) } });
    assert.equal(due.length, 1);
    assert.equal(((await refreshed)[0] as WorkspaceSnapshot).reminders!.today[0].state, 'due');

    assert.equal((await connection.call<RemindersSnapshot>('reminders.snooze', { id: 'stretch', minutes: 10 })).today[0].state, 'snoozed');
    assert.equal((await connection.call<RemindersSnapshot>('reminders.done', { id: 'stretch' })).today[0].state, 'done');
    assert.equal((await connection.call<WorkspaceSnapshot>('read')).reminders!.today[0].state, 'done');
  } finally { connection.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
