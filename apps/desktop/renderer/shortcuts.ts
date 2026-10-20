import { useEffect, useRef } from 'react';
import { RAIL_LABELS, RAIL_SLOTS, railKey } from './rail-slots.ts';
import type { RailSlot } from './rail-slots.ts';

export type ShortcutGroup = 'Hotbar' | 'Map' | 'Views' | 'App' | 'Sheets';
interface ShortcutBinding { id: string; label: string; key: string; group: ShortcutGroup; aliases?: readonly string[]; display?: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }
/** Add future workspace actions here, then supply their handler at the owning view.
 * The controls card, rail tooltips and menus read their key labels from this list.
 * Views keys work while that item view has focus; the view handles them itself. */
const RAIL_SHORTCUTS = RAIL_SLOTS.slice(0, 9).map(slot => ({ id: `rail.${slot}` as `rail.${RailSlot}`, label: RAIL_LABELS[slot], key: railKey(slot), group: 'Hotbar' as const }));
export const WORKSPACE_SHORTCUTS = [
  ...RAIL_SHORTCUTS,
  { id: 'todos.toggle', label: 'Toggle to-do list', key: 't', group: 'Hotbar' },
  { id: 'attention.toggle', label: 'Needs me', key: 'n', group: 'Map' },
  { id: 'map.overview', label: 'Toggle map overview', key: 'm', group: 'Map' },
  { id: 'layer.toggle', label: 'Undermap and back', key: 'u', group: 'Map' },
  { id: 'undermap.search', label: 'Find in Undermap', key: '/', group: 'Map' },
  { id: 'project.mute', label: 'Mute focused project', key: 'm', shift: true, display: '⇧M', group: 'Map' },
  { id: 'map.zoomIn', label: 'Zoom in', key: '+', aliases: ['='], group: 'Map' },
  { id: 'map.zoomOut', label: 'Zoom out', key: '-', group: 'Map' },
  { id: 'map.zoomReset', label: 'Zoom to 100%', key: '0', group: 'Map' },
  { id: 'rollout.jobsRail', label: 'Fold the rollout jobs rail', key: '[', group: 'Views' },
  { id: 'settings.open', label: 'Settings', key: ',', group: 'App' },
  { id: 'shortcuts.help', label: 'Controls', key: '?', group: 'App' },
  { id: 'sheet.close', label: 'Close sheet or menu', key: 'Escape', display: 'esc', group: 'Sheets' },
] as const satisfies readonly ShortcutBinding[];
export type ShortcutId = typeof WORKSPACE_SHORTCUTS[number]['id'];
type KeyGesture = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>;

/** Keys like `?` and `+` need Shift on many layouts, so Shift only counts for letters. */
const letter = (key: string) => /^[a-z]$/.test(key);

export function matchWorkspaceShortcut(event: KeyGesture): ShortcutId | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return WORKSPACE_SHORTCUTS.find((binding: ShortcutBinding) => (binding.key === key || binding.aliases?.includes(key))
    && Boolean(binding.ctrl) === event.ctrlKey && Boolean(binding.meta) === event.metaKey
    && Boolean(binding.alt) === event.altKey && (!letter(binding.key) || Boolean(binding.shift) === event.shiftKey))?.id;
}

/** The key as a keycap shows it: letters upper case, named keys by their display name. */
export function shortcutKey(id: ShortcutId) {
  const binding: ShortcutBinding | undefined = WORKSPACE_SHORTCUTS.find(binding => binding.id === id);
  return binding ? binding.display ?? (letter(binding.key) ? binding.key.toUpperCase() : binding.key) : '';
}

/** Rows for the controls card, in registry order within each group. */
export function shortcutGroups() {
  const groups = new Map<ShortcutGroup, { id: ShortcutId; label: string; key: string }[]>();
  for (const binding of WORKSPACE_SHORTCUTS) groups.set(binding.group, [...groups.get(binding.group) ?? [], { id: binding.id, label: binding.label, key: shortcutKey(binding.id) }]);
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

/** Panels that stay open beside the map and keep workspace keys working. */
const OPEN_ALONGSIDE = '.attention-list,.rail-panel-sheet,.controls-card';

/** These are app-view shortcuts, never native/global keys. Inputs and modal/drag
 * scopes retain their keys; handlers can additionally return false to decline. */
export function useWorkspaceShortcuts(handlers: Partial<Record<ShortcutId, () => void | boolean>>) {
  const latest = useRef(handlers); latest.current = handlers;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const id = matchWorkspaceShortcut(event), handler = id && latest.current[id];
      if (!handler) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.terminal-surface,.xterm,[data-shortcuts="off"]')) return;
      if (document.querySelector(`.inline-editor:not(${OPEN_ALONGSIDE}),.canvas-menu,.session-manager,[role="dialog"]:not(${OPEN_ALONGSIDE}),[data-dragging="true"],[data-map-dragging="true"],.connection-preview`)) return;
      if (handler() === false) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}
