import type { GraphNode } from '../../../src/graph/graph.ts';
import { recentOnMap, searchMap, searchProjects } from '../../../src/graph/map-search.ts';
import { RAIL_SLOTS } from './rail-slots.ts';
import { shortcutKey } from './shortcuts.ts';
import type { ShortcutId } from './shortcuts.ts';

/** Commands the host runs itself, not through a key. */
export type CommandMenuAction = 'new-item' | 'new-project';
export interface CommandMenuCommand { id: `shortcut:${ShortcutId}` | `action:${CommandMenuAction}`; title: string; hint?: string; run: { shortcut: ShortcutId } | { action: CommandMenuAction } }
export interface CommandMenuRow { id: string; kind: 'item' | 'project' | 'command'; target: string; title: string; detail?: string; hint?: string }
export interface CommandMenuSection { label: string; rows: CommandMenuRow[] }

const shortcut = (id: ShortcutId, title: string): CommandMenuCommand => ({ id: `shortcut:${id}`, title, hint: shortcutKey(id), run: { shortcut: id } });
const action = (id: CommandMenuAction, title: string): CommandMenuCommand => ({ id: `action:${id}`, title, run: { action: id } });
const shown = (slot: string) => RAIL_SLOTS.some(rail => rail === slot);

/** What the command menu can do: map and app actions with their keys, and the creations a person starts most.
 * Keys that only work inside an open view, and the menu itself, stay out. Rail panels say Toggle: their key closes a
 * panel that is held open. */
export const COMMAND_MENU_COMMANDS: readonly CommandMenuCommand[] = [
  action('new-item', 'New item…'),
  action('new-project', 'New project…'),
  shortcut('rail.attention', 'Toggle Needs me'),
  shortcut('todos.toggle', 'Toggle to-do list'),
  shortcut('rail.reminders', 'Toggle reminders'),
  shortcut('rail.inbox', 'Toggle GitHub inbox'),
  ...shown('actions') ? [shortcut('rail.actions', 'Toggle actions')] : [],
  shortcut('layer.toggle', 'Go to Undermap and back'),
  shortcut('map.overview', 'Toggle map overview'),
  shortcut('map.find', 'Find an item on the map'),
  shortcut('map.zoomIn', 'Zoom in'),
  shortcut('map.zoomOut', 'Zoom out'),
  shortcut('map.zoomReset', 'Zoom to 100%'),
  shortcut('settings.open', 'Open Settings'),
  shortcut('shortcuts.help', 'Show controls'),
];

const LIMITS = { recent: 5, items: 6, projects: 3, commands: 6 };
const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const commandRow = (command: CommandMenuCommand): CommandMenuRow => ({ id: command.id, kind: 'command', target: command.id, title: command.title, ...(command.hint ? { hint: command.hint } : {}) });
const itemRow = (match: { id: string; title: string; project: string | undefined }): CommandMenuRow => ({ id: `item:${match.id}`, kind: 'item', target: match.id, title: match.title, ...(match.project ? { detail: match.project } : {}) });

/** The menu's sections for a query: before typing, recent items and every command; then the items, projects and
 * commands that hold every word. Empty sections are left out, so no sections means nothing matches. On the Undermap
 * the creations stay out: new items land on the map only. */
export function commandMenuSections(nodes: readonly GraphNode[], recent: readonly string[], query: string, { below = false }: { below?: boolean } = {}): CommandMenuSection[] {
  const typed = words(query), commands = below ? COMMAND_MENU_COMMANDS.filter(command => !('action' in command.run)) : COMMAND_MENU_COMMANDS;
  const sections: CommandMenuSection[] = typed.length ? [
    { label: 'Items', rows: searchMap(nodes, query, LIMITS.items).map(itemRow) },
    { label: 'Projects', rows: searchProjects(nodes, query, LIMITS.projects).map(match => ({ id: `project:${match.id}`, kind: 'project' as const, target: match.id, title: match.title, detail: 'Project' })) },
    { label: 'Commands', rows: commands.filter(command => typed.every(word => command.title.toLowerCase().includes(word))).slice(0, LIMITS.commands).map(commandRow) },
  ] : [
    { label: 'Recently opened', rows: recentOnMap(nodes, recent, LIMITS.recent).map(itemRow) },
    { label: 'Commands', rows: commands.map(commandRow) },
  ];
  return sections.filter(section => section.rows.length);
}
