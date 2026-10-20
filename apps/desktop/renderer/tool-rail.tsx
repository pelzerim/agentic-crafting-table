import { useRail } from './rail-state.ts';
import { shortcutKey } from './shortcuts.ts';
import type { ShortcutId } from './shortcuts.ts';
import { RAIL_LABELS, RAIL_SLOTS } from './rail-slots.ts';
import type { RailSlot } from './rail-slots.ts';
/** Fixed tools at the left edge, drawn as a vertical Minecraft-style hotbar and the one origin
 * of every workspace menu: Needs me on top, then to-dos, reminders, GitHub inbox and Undermap, and
 * Actions and Settings below a divider. Each owns one slot. */
export const RAIL = { left: 12, top: 108, slot: 44, pitch: 52, padding: 4, divider: 12 } as const;
export { RAIL_SLOTS } from './rail-slots.ts';
export type { RailSlot } from './rail-slots.ts';
/** The divider sits above this slot. */
const AFTER_DIVIDER: RailSlot = RAIL_SLOTS.includes('actions') ? 'actions' : 'settings';
/** A slot's own action key, shown after its number. */
const SLOT_LETTERS: Partial<Record<RailSlot, ShortcutId>> = { attention: 'attention.toggle', todos: 'todos.toggle', undermap: 'layer.toggle', settings: 'settings.open' };
const slotKeys = (slot: RailSlot) => [shortcutKey(`rail.${slot}`), ...(SLOT_LETTERS[slot] ? [shortcutKey(SLOT_LETTERS[slot])] : [])].join(' ');
/** Top-left of a slot's content, in workspace pixels. */
export function railSlot(slot: RailSlot) {
  const index = RAIL_SLOTS.indexOf(slot), divider = index >= RAIL_SLOTS.indexOf(AFTER_DIVIDER) ? RAIL.divider : 0;
  return { x: RAIL.left + RAIL.padding, y: RAIL.top + RAIL.padding + index * RAIL.pitch + divider };
}
export const RAIL_HEIGHT = RAIL.padding * 2 + RAIL.slot + (RAIL_SLOTS.length - 1) * RAIL.pitch + RAIL.divider;
/** Every slot shows "open" the same way: the tool whose sheet is showing, Undermap while you are in it,
 * Settings while its dialog is up. A pinned tool adds the selected-slot plate. Names and keys appear
 * beside a hovered or focused slot. */
export function ToolRail({ below, settings, actions = false }: { below: boolean; settings: boolean; actions?: boolean }) {
  const { open, pinned } = useRail(), active = (slot: RailSlot) => slot === open || (slot === 'undermap' && below) || (slot === 'settings' && settings) || (slot === 'actions' && actions);
  return <div className="tool-rail" aria-hidden="true" style={{ left: RAIL.left, top: RAIL.top, height: RAIL_HEIGHT }}>
    {RAIL_SLOTS.map(slot => <i key={slot} className="tool-rail-slot" data-slot={slot} data-active={active(slot) || undefined} data-pinned={slot === pinned || undefined} style={{ top: railSlot(slot).y - RAIL.top }} />)}
    <i className="tool-rail-divider" style={{ top: railSlot(AFTER_DIVIDER).y - RAIL.top - RAIL.padding - RAIL.divider / 2 }} />
    {RAIL_SLOTS.map(slot => <span key={slot} className="tool-rail-tip" data-slot={slot} style={{ top: railSlot(slot).y - RAIL.top + 10 }}>{slot === 'undermap' && below ? 'Back to the map' : RAIL_LABELS[slot]}<kbd>{slotKeys(slot)}</kbd></span>)}
  </div>;
}
