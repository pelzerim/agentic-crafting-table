import { STANDUP_ENABLED } from '../../../packages/core/standup.ts';

/** The left rail's tools, top to bottom. A slot's position here is its number key, so a tool
 * added here gets the next key without touching the shortcut registry. Nine at most: 0 resets zoom. */
const ALL_SLOTS = ['attention', 'todos', 'reminders', 'inbox', 'undermap', 'actions', 'settings'] as const;
export type RailSlot = (typeof ALL_SLOTS)[number];
/** The slots shown. Actions is away while the standup report is disabled; its key stays reserved so the others keep theirs. */
export const RAIL_SLOTS: readonly RailSlot[] = ALL_SLOTS.filter(slot => slot !== 'actions' || STANDUP_ENABLED);
export const railKey = (slot: RailSlot) => String(ALL_SLOTS.indexOf(slot) + 1);
export const RAIL_LABELS: Record<RailSlot, string> = { attention: 'Needs me', todos: 'To-dos', reminders: 'Reminders', inbox: 'GitHub inbox', undermap: 'Undermap', actions: 'Actions', settings: 'Settings' };
