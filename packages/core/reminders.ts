import * as z from 'zod/v4';

/** Daily reminders (MAP-REMINDERS): a rail tool, never an item, a Needs me reason or agent-visible.
 * Every schedule is in the machine's local time; dates are local `YYYY-MM-DD`. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = typeof WEEKDAYS[number];
export const SNOOZE_MINUTES = [10, 30] as const;
/** A reminder whose time passed while the service was not running still fires this long after it. */
export const CATCH_UP_MS = 90 * 60_000;
export const REMINDER_DAYS_KEPT = 30;
export const REMINDER_TICK_MS = 30_000;

const WORDS: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const reminderId = z.string().min(1).max(200);
export const reminderRuleSchema = z.object({
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7).refine(days => new Set(days).size === days.length, 'Choose each day only once')
    .transform(days => WEEKDAYS.filter(day => days.includes(day))),
  time: z.string().regex(/^\d\d:\d\d$/).refine(time => Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60, 'Enter a time between 00:00 and 23:59'),
}).strict();
export const reminderSchema = z.object({
  id: reminderId,
  label: z.string().max(400).transform(label => label.trim().replace(/\s+/g, ' ')).pipe(z.string().min(1).max(120).regex(/^[^\x00-\x1f\x7f]*$/)),
  enabled: z.boolean(),
  // One rule per weekday keeps a single due time, and a single day row, per reminder and date.
  rules: z.array(reminderRuleSchema).min(1).max(8).refine(rules => { const days = rules.flatMap(rule => rule.days); return new Set(days).size === days.length; }, 'Each day can have only one time'),
}).strict();
export const reminderListSchema = z.array(reminderSchema).max(100).refine(list => new Set(list.map(reminder => reminder.id)).size === list.length, 'Reminder ids must be unique');
export const reminderSaveSchema = z.object({ list: reminderListSchema }).strict();
export const reminderDoneSchema = z.object({ id: reminderId }).strict();
export const reminderSnoozeSchema = z.object({ id: reminderId, minutes: z.union(SNOOZE_MINUTES.map(minutes => z.literal(minutes))) }).strict();

export type ReminderRule = z.infer<typeof reminderRuleSchema>;
export type Reminder = z.infer<typeof reminderSchema>;
/** The stored outcome of one reminder on one local date. A row without `firedAt` was missed. */
export interface ReminderDay { reminderId: string; date: string; dueAt: number; firedAt?: number; doneAt?: number; snoozedUntil?: number }
export type ReminderState = 'none' | 'upcoming' | 'due' | 'snoozed' | 'done' | 'missed' | 'off';
export interface ReminderToday extends Omit<ReminderDay, 'dueAt'> { state: ReminderState; time?: string; dueAt?: number }
export interface RemindersSnapshot { list: Reminder[]; today: ReminderToday[]; revision: number }
export interface ReminderDue { reminder: Reminder; day: ReminderDay }

export const REMINDER_SEEDS: readonly Omit<Reminder, 'id'>[] = [];

const pad = (value: number) => String(value).padStart(2, '0');
export const localDate = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export const clockTime = (ms: number) => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const weekday = (ms: number): Weekday => WEEKDAYS[(new Date(ms).getDay() + 6) % 7];

function dayWords(days: readonly Weekday[]) {
  if (days.length === 7) return 'Daily';
  if (days.length === 5 && days.every(day => WEEKDAYS.indexOf(day) < 5)) return 'Mon–Fri';
  return WEEKDAYS.filter(day => days.includes(day)).map(day => WORDS[day]).join(' ');
}
/** "Mon–Fri · 15:00", "Mon Wed · 09:00 · Fri · 16:00", "Daily · 10:30". */
export const scheduleWords = (rules: readonly ReminderRule[]) => rules.map(rule => `${dayWords(rule.days)} · ${rule.time}`).join(' · ');

/** The rule for the local day containing `now`, as a time and the instant it falls due. */
export function reminderSlot(reminder: Reminder, now: number): { time: string; dueAt: number } | undefined {
  const rule = reminder.rules.find(rule => rule.days.includes(weekday(now)));
  if (!rule) return undefined;
  const date = new Date(now);
  return { time: rule.time, dueAt: new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(rule.time.slice(0, 2)), Number(rule.time.slice(3))).getTime() };
}

export function reminderToday(reminder: Reminder, now: number, day?: ReminderDay): ReminderToday {
  const slot = reminderSlot(reminder, now), base: ReminderToday = { reminderId: reminder.id, date: localDate(now), state: 'none', ...slot };
  if (day) Object.assign(base, day, { time: clockTime(day.dueAt) });
  const state: ReminderState = !reminder.enabled ? 'off'
    : day?.doneAt !== undefined ? 'done'
      : day?.firedAt !== undefined ? (day.snoozedUntil !== undefined && day.snoozedUntil > now ? 'snoozed' : 'due')
        : day ? 'missed'
          : !slot ? 'none' : now < slot.dueAt ? 'upcoming' : now - slot.dueAt < CATCH_UP_MS ? 'due' : 'missed';
  return { ...base, state };
}
