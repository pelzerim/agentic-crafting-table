import { useEffect, useRef } from 'react';
import { RAIL_LABELS, RAIL_SLOTS, railKey } from './rail-slots.ts';
import type { RailSlot } from './rail-slots.ts';

export type ShortcutGroup = 'Hotbar' | 'Map' | 'Views' | 'App' | 'Sheets';
/** `primary` is ⌘ on macOS and Ctrl elsewhere; `hidden` keeps a second gesture off the controls card. */
interface ShortcutBinding { id: string; label: string; key: string; group: ShortcutGroup; aliases?: readonly string[]; display?: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; primary?: boolean; hidden?: boolean; platform?: 'mac' | 'other' }
const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
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
  { id: 'map.find', label: 'Find an item and open it', key: 'f', meta: true, display: '⌘F', group: 'Map' },
  { id: 'project.mute', label: 'Mute focused project', key: 'm', shift: true, display: '⇧M', group: 'Map' },
  { id: 'map.undo', label: 'Undo the last map change', key: 'z', primary: true, group: 'Map' },
  { id: 'map.redo', label: 'Redo', key: 'z', primary: true, shift: true, group: 'Map' },
  { id: 'map.redo', label: 'Redo', key: 'y', ctrl: true, platform: 'other', hidden: true, group: 'Map' },
  { id: 'map.zoomIn', label: 'Zoom in', key: '+', aliases: ['='], group: 'Map' },
  { id: 'map.zoomOut', label: 'Zoom out', key: '-', group: 'Map' },
  { id: 'map.zoomReset', label: 'Zoom to 100%', key: '0', group: 'Map' },
  { id: 'rollout.jobsRail', label: 'Fold the rollout jobs rail', key: '[', group: 'Views' },
  { id: 'view.closeSeen', label: 'Close and mark seen', key: 'e', meta: true, display: '⌘E', group: 'Views' },
  { id: 'terminal.find', label: 'Find in terminal', key: 'f', meta: true, display: '⌘F', group: 'Views' },
  { id: 'settings.open', label: 'Settings', key: ',', group: 'App' },
  { id: 'shortcuts.help', label: 'Controls', key: '?', group: 'App' },
  { id: 'sheet.close', label: 'Close sheet or menu', key: 'Escape', display: 'esc', group: 'Sheets' },
] as const satisfies readonly ShortcutBinding[];
export type ShortcutId = typeof WORKSPACE_SHORTCUTS[number]['id'];
type KeyGesture = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>;

/** Keys like `?` and `+` need Shift on many layouts, so Shift only counts for letters. */
const letter = (key: string) => /^[a-z]$/.test(key);

export function matchWorkspaceShortcut(event: KeyGesture, mac = isMac()): ShortcutId | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return WORKSPACE_SHORTCUTS.find((binding: ShortcutBinding) => (binding.key === key || binding.aliases?.includes(key))
    && (!binding.platform || (binding.platform === 'mac') === mac)
    && Boolean(binding.ctrl || (binding.primary && !mac)) === event.ctrlKey && Boolean(binding.meta || (binding.primary && mac)) === event.metaKey
    && Boolean(binding.alt) === event.altKey && (!letter(binding.key) || Boolean(binding.shift) === event.shiftKey))?.id;
}

/** The key as a keycap shows it: letters upper case, named keys by their display name. */
export function shortcutKey(id: ShortcutId, mac = isMac()) {
  const binding: ShortcutBinding | undefined = WORKSPACE_SHORTCUTS.find((binding: ShortcutBinding) => binding.id === id && !binding.hidden);
  if (!binding) return '';
  const key = binding.display ?? (letter(binding.key) ? binding.key.toUpperCase() : binding.key);
  return binding.primary ? `${mac ? '⌘' : 'Ctrl+'}${binding.shift ? (mac ? '⇧' : 'Shift+') : ''}${key}` : key;
}

/** Rows for the controls card, in registry order within each group. */
export function shortcutGroups() {
  const groups = new Map<ShortcutGroup, { id: ShortcutId; label: string; key: string }[]>();
  for (const binding of WORKSPACE_SHORTCUTS as readonly ShortcutBinding[]) if (!binding.hidden) groups.set(binding.group, [...groups.get(binding.group) ?? [], { id: binding.id as ShortcutId, label: binding.label, key: shortcutKey(binding.id as ShortcutId) }]);
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

/** Panels that stay open beside the map and keep workspace keys working. */
export const OPEN_ALONGSIDE = '.attention-list,.rail-panel-sheet,.controls-card';

/** Menus, editors, modal dialogs, drags and link previews keep the keyboard. */
export const shortcutsPaused = () => Boolean(document.querySelector(`.inline-editor:not(${OPEN_ALONGSIDE}),.canvas-menu,.session-manager,[role="dialog"]:not(${OPEN_ALONGSIDE}),[data-dragging="true"],[data-map-dragging="true"],.connection-preview`));

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
      if (shortcutsPaused()) return;
      if (handler() === false) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}
