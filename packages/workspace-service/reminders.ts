import { EventEmitter } from 'node:events';
import { CATCH_UP_MS, REMINDER_DAYS_KEPT, REMINDER_TICK_MS, localDate, reminderListSchema, reminderSlot, reminderToday } from '../core/reminders.ts';
import type { ReminderDay, ReminderDue, RemindersSnapshot } from '../core/reminders.ts';
import type { SqliteStore } from './sqlite-store.ts';

export interface ReminderClockOptions { now?: () => number; schedule?: (tick: () => void, ms: number) => () => void; changed?: () => unknown }
const interval = (tick: () => void, ms: number) => { const timer = setInterval(tick, ms); return () => clearInterval(timer); };

/** The reminders clock (MAP-REMINDERS). Day rows make firing idempotent per reminder and local
 * date across ticks and restarts; it emits `due` with a {@link ReminderDue} for each firing. */
export class Reminders extends EventEmitter<{ due: [ReminderDue] }> {
  private store: SqliteStore;
  private now: () => number;
  private schedule: (tick: () => void, ms: number) => () => void;
  private changed: () => unknown;
  private cancel?: () => void;
  private closed = false;
  private date?: string;
  private revision = 0;
  constructor(store: SqliteStore, options: ReminderClockOptions = {}) {
    super(); this.store = store; this.now = options.now ?? Date.now; this.schedule = options.schedule ?? interval; this.changed = options.changed ?? (() => {});
  }
  snapshot(): RemindersSnapshot {
    const now = this.now(), list = this.store.reminders(), days = new Map(this.store.reminderDays(localDate(now)).map(day => [day.reminderId, day]));
    return { list, today: list.map(reminder => reminderToday(reminder, now, days.get(reminder.id))), revision: this.revision };
  }
  /** Saves the whole list. A reminder new, re-enabled or re-timed after its time today is missed, never fired late. */
  save(input: unknown) {
    const list = reminderListSchema.parse(input), now = this.now(), date = localDate(now);
    const before = new Map(this.store.reminders().map(reminder => [reminder.id, reminder])), days = new Map(this.store.reminderDays(date).map(day => [day.reminderId, day]));
    this.store.saveReminders(list);
    for (const reminder of list) {
      const slot = reminderSlot(reminder, now), old = before.get(reminder.id), day = days.get(reminder.id);
      if (old?.enabled && reminder.enabled && reminderSlot(old, now)?.time === slot?.time) continue;
      if (day?.firedAt !== undefined || day?.doneAt !== undefined) continue;
      if (day) this.store.deleteReminderDay(reminder.id, date);
      if (reminder.enabled && slot && slot.dueAt <= now) this.store.writeReminderDay({ reminderId: reminder.id, date, dueAt: slot.dueAt });
    }
    this.revision++;
    return this.snapshot();
  }
  done(id: string) {
    const { day, now } = this.today(id);
    this.store.writeReminderDay({ ...day, doneAt: now, snoozedUntil: undefined });
    this.revision++;
    return this.snapshot();
  }
  snooze(id: string, minutes: number) {
    const { reminder, day, now } = this.today(id), state = reminderToday(reminder, now, this.store.reminderDays(day.date).find(row => row.reminderId === id)).state;
    if (state !== 'due' && state !== 'snoozed') throw new Error('This reminder is not due.');
    this.store.writeReminderDay({ ...day, firedAt: day.firedAt ?? now, snoozedUntil: now + minutes * 60_000 });
    this.revision++;
    return this.snapshot();
  }
  private today(id: string) {
    const now = this.now(), reminder = this.store.reminders().find(reminder => reminder.id === id);
    if (!reminder) throw new Error('This reminder no longer exists.');
    const slot = reminderSlot(reminder, now), date = localDate(now);
    if (!slot) throw new Error('This reminder is not set for today.');
    const day: ReminderDay = this.store.reminderDays(date).find(day => day.reminderId === id) ?? { reminderId: id, date, dueAt: slot.dueAt };
    return { reminder, day, now };
  }
  /** Fires every enabled reminder whose time (or snooze) has passed today and records a missed one. */
  tick(): ReminderDue[] {
    const now = this.now(), date = localDate(now), fired: ReminderDue[] = [];
    let changed = this.date !== undefined && this.date !== date;
    if (this.date !== date) { this.date = date; this.store.pruneReminderDays(localDate(now - REMINDER_DAYS_KEPT * 86_400_000)); }
    const days = new Map(this.store.reminderDays(date).map(day => [day.reminderId, day]));
    for (const reminder of this.store.reminders()) {
      const slot = reminder.enabled ? reminderSlot(reminder, now) : undefined, day = days.get(reminder.id);
      if (!slot) continue;
      let next: ReminderDay | undefined;
      if (!day) {
        if (now < slot.dueAt) continue;
        if (now - slot.dueAt >= CATCH_UP_MS) { this.store.writeReminderDay({ reminderId: reminder.id, date, dueAt: slot.dueAt }); changed = true; continue; }
        next = { reminderId: reminder.id, date, dueAt: slot.dueAt, firedAt: now };
      } else if (day.firedAt !== undefined && day.doneAt === undefined && day.snoozedUntil !== undefined && now >= day.snoozedUntil) next = { ...day, firedAt: now, snoozedUntil: undefined };
      if (!next) continue;
      this.store.writeReminderDay(next); fired.push({ reminder, day: next });
    }
    if (!changed && !fired.length) return fired;
    this.revision++;
    for (const event of fired) this.emit('due', event);
    void Promise.resolve(this.changed()).catch(() => {});
    return fired;
  }
  start() {
    if (this.closed || this.cancel) return;
    this.cancel = this.schedule(() => this.safeTick(), REMINDER_TICK_MS);
    this.safeTick();
  }
  private safeTick() { try { this.tick(); } catch { /* A closing store; the next tick tries again. */ } }
  async pause() { this.cancel?.(); this.cancel = undefined; }
  async close() { this.closed = true; await this.pause(); }
}
