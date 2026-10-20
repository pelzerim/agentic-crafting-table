import { WEEKDAYS, clockTime, reminderSchema } from '../../../packages/core/reminders.ts';
import type { Reminder, ReminderDue, ReminderRule, ReminderToday, RemindersSnapshot, Weekday } from '../../../packages/core/reminders.ts';

export const WEEKDAY_DAYS: readonly Weekday[] = WEEKDAYS.slice(0, 5);

function untilWords(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000)), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `in ${hours} h${rest ? ` ${rest}` : ''}` : `in ${minutes} min`;
}

/** Today's line for a reminder row: "in 2 h 15", "Due · 12:30", "Snoozed until 12:50", "Done 12:41". */
export function reminderStateWords(entry: ReminderToday, now: number) {
  switch (entry.state) {
    case 'none': return 'Not today';
    case 'off': return 'Off';
    case 'upcoming': return entry.dueAt === undefined ? 'Later today' : untilWords(entry.dueAt - now);
    case 'due': return `Due · ${entry.time ?? ''}`;
    case 'snoozed': return entry.snoozedUntil === undefined ? 'Snoozed' : `Snoozed until ${clockTime(entry.snoozedUntil)}`;
    case 'done': return entry.doneAt === undefined ? 'Done' : `Done ${clockTime(entry.doneAt)}`;
    case 'missed': return 'Missed';
  }
}

export function railReminders(today: readonly ReminderToday[]) {
  return { due: today.filter(entry => entry.state === 'due').length, snoozed: today.some(entry => entry.state === 'snoozed') };
}

export const newReminderDraft = (id: string): Reminder => ({ id, label: '', enabled: true, rules: [{ days: [...WEEKDAY_DAYS], time: '09:00' }] });

const ordered = (days: readonly Weekday[]) => WEEKDAYS.filter(day => days.includes(day));
/** Gives `days` to one rule and takes them from the others; a rule left without days goes with them. */
export function setRuleDays(rules: readonly ReminderRule[], index: number, days: readonly Weekday[]): ReminderRule[] {
  return rules.flatMap((rule, position) => {
    if (position === index) return [{ ...rule, days: ordered(days) }];
    const rest = rule.days.filter(day => !days.includes(day));
    return rest.length ? [{ ...rule, days: rest }] : [];
  });
}
/** A chip: a day on the clicked rule turns off; any other day moves to it, since each day has one time. */
export function toggleRuleDay(rules: readonly ReminderRule[], index: number, day: Weekday): ReminderRule[] {
  const days = rules[index].days;
  return days.includes(day) ? rules.map((rule, position) => position === index ? { ...rule, days: days.filter(other => other !== day) } : rule) : setRuleDays(rules, index, [...days, day]);
}
export const addRule = (rules: readonly ReminderRule[]): ReminderRule[] => [...rules, { days: WEEKDAYS.filter(day => !rules.some(rule => rule.days.includes(day))), time: rules.at(-1)?.time ?? '12:30' }];
export const removeRule = (rules: readonly ReminderRule[], index: number): ReminderRule[] => rules.length > 1 ? rules.filter((_, position) => position !== index) : [...rules];

/** Why the draft cannot be saved yet, in words, or nothing when it can. */
export function draftProblem(draft: Reminder) {
  const label = draft.label.trim();
  if (!label) return 'Give the reminder a name.';
  if (label.length > 120) return 'Keep the name under 120 characters.';
  if (draft.rules.some(rule => !rule.days.length)) return 'Choose at least one day for each time.';
  if (draft.rules.some(rule => !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time))) return 'Enter a time between 00:00 and 23:59.';
  const parsed = reminderSchema.safeParse(draft);
  return parsed.success ? undefined : parsed.error.issues[0]?.message ?? 'This reminder cannot be saved.';
}

export interface NoticeReminder { reminder: Reminder; time: string; firing: number }
/** Reminders the in-app notice offers, in list order. A due event can arrive before the snapshot that
 * shows it due, so it counts until the snapshot shows the reminder done, snoozed since, off, gone or
 * on another day. `dismissed` holds the firing each reminder's notice was closed at. */
export function noticeReminders(snapshot: RemindersSnapshot | undefined, events: ReadonlyMap<string, ReminderDue>, dismissed: ReadonlyMap<string, number>): NoticeReminder[] {
  if (!snapshot) return [];
  return snapshot.list.flatMap((reminder, index) => {
    const entry = snapshot.today[index], event = events.get(reminder.id);
    if (entry?.reminderId !== reminder.id) return [];
    let firing: number | undefined;
    if (entry.state === 'due') firing = entry.firedAt ?? entry.dueAt;
    else if (event?.day.firedAt !== undefined && event.day.date === entry.date && entry.state !== 'off' && entry.state !== 'none' && entry.doneAt === undefined
      && !(entry.snoozedUntil !== undefined && entry.snoozedUntil > event.day.firedAt)) firing = event.day.firedAt;
    if (firing === undefined || dismissed.get(reminder.id) === firing) return [];
    return [{ reminder, time: entry.time ?? clockTime(event?.day.dueAt ?? firing), firing }];
  });
}
