import type { ChoiceConfirm, ChoiceHighlight, ChoiceSource, JsonObject, ResourceFields, ResourceMenuGroup } from '../../src/resource-plugins/types.ts';
import { plotPalette } from '../../src/graph/plot-palette.ts';
import { isPlotColor } from '../../src/graph/plots.ts';
import { isHexColor } from '../../src/graph/colors.ts';
import type { PlotColor, PlotView } from '../../src/graph/plots.ts';
import type { GraphNode } from '../../src/graph/graph.ts';
import { plotMapOrder } from '../../src/graph/project-column.ts';

export type MenuScope = 'board' | 'neighborhood' | 'item' | 'project' | 'link';
export type MenuActionId = 'open' | 'connect' | 'new-item' | 'new-project' | 'archive-browser' | 'edit' | 'complete' | 'reopen' | 'archive' | 'below' | 'surface' | 'remove-link' | 'make-blocking' | 'make-normal' | 'reverse-link' | 'open-web' | 'copy-url' | 'add-todo' | 'remove-todo' | 'auto-title' | 'move-plot' | 'plot-new' | 'plot-unpin' | `plot-pin:${string}` | 'plot-select' | 'plot-rename' | 'plot-auto' | 'plot-color' | 'plot-color-auto' | 'plot-hide' | 'plot-leave' | 'plot-below' | 'delete' | 'delete-cancel' | 'delete-confirm' | 'plots-toggle' | 'plots-unhide' | 'send-project' | 'context-show' | 'context-hide' | 'context-add' | 'context-clear' | 'archive-stale' | 'mute' | 'unmute' | 'settings' | 'size-default' | 'standup-report' | 'show-hidden' | 'hide-item' | `send:${string}` | `convert:${string}` | `plugin:${string}` | `field:${string}`;
/** One choice of a row: `swatch` is the colour it is drawn in. */
export interface MenuRowChoice { value: string; label: string; swatch?: string; checked: boolean }
/** `remote` marks actions that write to a provider (drawn with a remote glyph). An action with a `row` is a labelled
 * row of choices side by side (one radio group); a pick reaches `act` with its `value`. */
export interface MenuAction { id: MenuActionId; label: string; /** Menu ids a pick of this entry runs together instead of itself. */ runs?: MenuActionId[]; description?: string; divider?: boolean; destructive?: boolean; remote?: boolean; children?: MenuAction[]; choices?: ChoiceSource; selection?: { label: string; children: readonly string[] }; mutation?: { actionId: string; input: JsonObject; label?: string; runtime?: string }; checked?: boolean; disabled?: boolean; highlight?: ChoiceHighlight; confirm?: ChoiceConfirm; row?: MenuRowChoice[]; /** A row of colours that also takes a custom `#rrggbb` (picked as its `value`); `shown` is the custom colour the item shows. */ customColor?: { shown?: string }; value?: string }

/** Entries that replace each other by state share one slot, so a saved order places both variants alike. The Settings
 * submenu holds the `edit` slot, the place of the entry it contains. */
export function menuSlot(id: string): string {
  return id === 'settings' ? 'edit' : id === 'reopen' ? 'complete' : id === 'remove-todo' ? 'add-todo' : id === 'unmute' ? 'mute' : id.startsWith('convert:') ? 'convert' : id;
}

/** A separator's place in a menu layout. No action id can be this: ids are words, optionally `prefix:name`. */
export const MENU_SEPARATOR = '---';
const isSeparator = (id: string) => id === MENU_SEPARATOR;
/** One item type's saved menu: `layout` lists slots and separators in the user's order, `hidden` the slots the menu
 * leaves out. `order` is the earlier shape, slots only with separators derived from default groups; it is read,
 * never written. */
export interface ItemMenuCustom { layout?: readonly string[]; order?: readonly string[]; hidden?: readonly string[] }
export interface MenuSettings { order: Record<string, string[]>; layout: Record<string, string[]>; hidden: Record<string, string[]> }
export const itemMenuCustom = (menus: MenuSettings | undefined, type: string): ItemMenuCustom => ({ layout: menus?.layout[type], order: menus?.order[type], hidden: menus?.hidden[type] });

const slotsOf = (layout: readonly string[]) => [...new Set(layout.filter(id => !isSeparator(id)).map(menuSlot))];
/** Slots the saved list does not name (added later, or shown only in some states) follow their default predecessor. */
function insertMissing(slots: readonly string[], result: string[]) {
  slots.forEach((slot, index) => { if (!result.includes(slot)) result.splice(index ? result.indexOf(slots[index - 1]!) + 1 : 0, 0, slot); });
  return result;
}
/** Each slot once, separators as often as they occur. */
function oncePerSlot(layout: readonly string[], known?: readonly string[]) {
  const seen = new Set<string>();
  return layout.map(menuSlot).filter(id => isSeparator(id) || ((!known || known.includes(id)) && !seen.has(id) && Boolean(seen.add(id))));
}

/** An earlier saved order (slots only) applied to the default slots. Ids that are not in the menu are ignored. */
export function mergeMenuOrder(defaults: readonly string[], saved: readonly string[] = []): string[] {
  const slots = slotsOf(defaults), result = slotsOf(saved).filter(slot => slots.includes(slot));
  return result.length ? insertMissing(slots, result) : slots;
}

/** The rows of a menu: its slots and separators in the saved layout. `defaults` is the default layout, with a
 * separator between its groups. A saved layout keeps its separators as placed and gains none: a slot it does not name
 * follows its default predecessor, in that entry's block. An earlier saved order is converted by drawing a separator
 * wherever neighbouring slots belong to different default groups, which is how it was drawn before. Saved ids the menu
 * does not have are ignored; a saved list that names nothing the menu has is the default layout. */
export function menuLayout(defaults: readonly string[], custom: ItemMenuCustom = {}): string[] {
  const slots = slotsOf(defaults), named = (ids?: readonly string[]) => Boolean(ids?.some(id => slots.includes(menuSlot(id))));
  if (named(custom.layout)) return insertMissing(slots, oncePerSlot(custom.layout!, slots));
  if (named(custom.order)) {
    const group = new Map<string, number>(); let current = 0;
    for (const id of defaults) if (isSeparator(id)) current++; else group.set(menuSlot(id), current);
    return mergeMenuOrder(slots, custom.order).flatMap((slot, index, all) => index && group.get(slot) !== group.get(all[index - 1]!) ? [MENU_SEPARATOR, slot] : [slot]);
  }
  return oncePerSlot(defaults);
}

/** What a menu draws of a layout: no hidden slot, and never a line first, last or twice in a row, so separators
 * around hidden or missing entries fold into one. A menu whose every entry is hidden draws them all instead of
 * opening empty. */
export function drawnMenuLayout(layout: readonly string[], hidden: readonly string[] = []): string[] {
  const off = new Set(slotsOf(hidden)), shown = layout.filter(id => !off.has(menuSlot(id))), drawn: string[] = [];
  for (const id of shown.some(id => !isSeparator(id)) ? shown : layout) if (!isSeparator(id) || (drawn.length && !isSeparator(drawn.at(-1)!))) drawn.push(id);
  if (drawn.length && isSeparator(drawn.at(-1)!)) drawn.pop();
  return drawn;
}

const clamp = (index: number, length: number) => Math.max(0, Math.min(Math.trunc(index), length - 1));
/** A layout with the row at `from` moved to `to`; rows are addressed by place because separators are alike. */
export function moveMenuRow(layout: readonly string[], from: number, to: number): string[] {
  const next = [...layout];
  if (Number.isInteger(from) && from >= 0 && from < next.length) next.splice(clamp(to, next.length), 0, ...next.splice(from, 1));
  return next;
}
/** A layout with one more separator, after the row at `after` or at the end. */
export function addMenuSeparator(layout: readonly string[], after?: number): string[] {
  const next = [...layout];
  next.splice(after === undefined ? next.length : clamp(after, next.length) + 1, 0, MENU_SEPARATOR);
  return next;
}
/** A layout without the separator at `index`; an entry is never removed. */
export function removeMenuSeparator(layout: readonly string[], index: number): string[] {
  return layout.filter((id, at) => at !== index || !isSeparator(id));
}

/** Whether the slot can be hidden: it is shown now and is not the last entry the type's menu still shows. */
export function canHideMenuEntry(layout: readonly string[], hidden: readonly string[], id: string): boolean {
  const off = new Set(slotsOf(hidden)), shown = slotsOf(layout).filter(slot => !off.has(slot));
  return shown.includes(menuSlot(id)) && shown.length > 1;
}
/** The hidden slots after hiding or showing one; unchanged when hiding is refused. Ids the menu does not have are kept. */
export function setMenuEntryHidden(layout: readonly string[], hidden: readonly string[], id: string, hide: boolean): string[] {
  const slot = menuSlot(id), current = [...new Set(hidden.map(menuSlot))];
  if (!hide) return current.filter(other => other !== slot);
  return canHideMenuEntry(layout, current, slot) ? [...current, slot] : current;
}

/** Whether a type's saved menu differs from its default one. */
export function isCustomMenu(defaults: readonly string[], custom: ItemMenuCustom = {}): boolean {
  const layout = menuLayout(defaults, custom), slots = slotsOf(defaults);
  return layout.length !== defaults.length || layout.some((id, index) => id !== defaults[index]) || slotsOf(custom.hidden ?? []).some(slot => slots.includes(slot));
}
/** The menu settings with one type back to its default menu, every entry shown. */
export function resetItemMenu<T extends MenuSettings>(menus: T, type: string): T {
  const next = { ...menus, order: { ...menus.order }, layout: { ...menus.layout }, hidden: { ...menus.hidden } };
  delete next.order[type]; delete next.layout[type]; delete next.hidden[type];
  return next;
}
/** The menu settings after one type's rows changed. The default layout is saved as nothing, and the earlier order
 * of that type is dropped because the layout now says everything it said. */
export function saveItemMenu<T extends MenuSettings>(menus: T, type: string, defaults: readonly string[], layout: readonly string[], hidden: readonly string[] = menus.hidden[type] ?? []): T {
  const next = resetItemMenu(menus, type), off = slotsOf(hidden);
  if (isCustomMenu(defaults, { layout })) next.layout[type] = [...layout];
  if (off.length) next.hidden[type] = off;
  return next;
}

export const itemEditLabel = (type?: { name: string; generatedTitle?: unknown }) => type?.generatedTitle ? `Edit ${type.name.toLowerCase()}…` : 'Item settings…';

const SLOT_LABELS: Readonly<Record<string, string>> = { complete: 'Mark done / Reopen', 'add-todo': 'Turn into todo / Remove from to-dos', convert: 'Convert to a specific type' };
export interface ItemMenuRow { id: string; label: string; separator?: true; hidden?: true }
/** The rows Settings lists for an item type: every entry its menu can show, one per slot, and the separators between
 * them, in the saved layout. Entries that depend on the item's state or on another setting are included, since their
 * place is kept either way, and so are hidden ones. */
export function itemMenuEntries(type: { name: string; generatedTitle?: unknown; fields?: ResourceFields; contextMenu?: readonly ResourceMenuGroup[]; webLink?: { label: string }; todoSupport?: unknown; activityTitle?: unknown; creation?: { urlFallback?: boolean } }, custom: ItemMenuCustom = {}): ItemMenuRow[] {
  const actions = contextMenuActions('item', false, itemEditLabel(type), type.contextMenu, type.todoSupport ? { enabled: false } : undefined, undefined, type.webLink, Boolean(type.activityTitle), undefined, moveToProjectAction([]), undefined,
    type.creation?.urlFallback ? [{ id: 'convert:', label: '' }] : [], {}, undefined, {}, fieldMenuActions(type.fields), [moveToPlotAction([]), removeFromPlotAction()]);
  const labels = new Map(actions.map(action => { const id = menuSlot(action.id); return [id, SLOT_LABELS[id] ?? action.label]; }));
  const off = new Set(slotsOf(custom.hidden ?? []));
  return menuLayout(actions.flatMap(action => action.divider ? [MENU_SEPARATOR, action.id] : [action.id]), custom)
    .map(id => isSeparator(id) ? { id, label: 'Separator', separator: true as const } : { id, label: labels.get(id)!, ...(off.has(id) ? { hidden: true as const } : {}) });
}

/** Context determines the list; plugins may contribute a short action submenu.
 * Below the map, items can only return to it or move on to the archive.
 * `custom` is the user's saved menu for this item type (MAP-27): its order, separators and hidden entries. It
 * applies to an item on the map only; every other menu draws its default layout, a separator between its groups.
 * `size.disabled` is why Use size as default has nothing to change for this item. `plot` holds an item's Move to plot and
 * Remove from plot entries, which follow Move to project. */
export function contextMenuActions(scope: MenuScope, completed = false, editLabel = 'Item settings…', groups: readonly ResourceMenuGroup[] = [], todo?: { enabled: boolean }, below?: { blocker?: string }, web?: { label: string }, autoTitle = false, plots?: { shown: boolean; hidden: number }, send?: MenuAction, mute?: MenuAction, convert: readonly MenuAction[] = [], custom: ItemMenuCustom = {}, size?: { disabled?: string }, visibility: { show?: string; hide?: string } = {}, fields: readonly MenuAction[] = [], plot: readonly MenuAction[] = []): MenuAction[] {
  const open = web && scope === 'item' ? [{ id: 'open-web' as const, label: web.label }, { id: 'copy-url' as const, label: 'Copy URL' }] : [];
  if (scope === 'link') return [{ id: 'remove-link', label: 'Remove connection' }];
  if (below) {
    if (scope === 'board' || scope === 'neighborhood') return [{ id: 'archive-browser', label: 'Open archive' }];
    return [
      { id: 'surface', label: 'Bring back to map', ...(below.blocker ? { disabled: true, description: below.blocker } : {}) },
      ...open,
      { id: 'edit', label: scope === 'project' ? 'Project settings…' : editLabel },
      { id: 'archive', label: scope === 'project' ? 'Archive project' : 'Archive', divider: true },
    ];
  }
  if (scope === 'neighborhood') return [{ id: 'new-item', label: 'New item' }, ...(mute ? [{ ...mute, divider: true }] : [])];
  if (scope === 'board') return [{ id: 'new-item', label: 'New item' }, { id: 'new-project', label: 'New project' }, { id: 'archive-browser', label: 'Open archive' }];
  const project = scope === 'project';
  // Items group their verbs: basics, provider actions, opening elsewhere, then map housekeeping.
  const sections: MenuAction[][] = [
    project ? [] : [{ id: 'open', label: 'Open' }, { id: 'connect', label: 'Connect to…' }, ...(visibility.show ? [{ id: 'show-hidden' as const, label: `Show ${visibility.show}` }] : [])],
    project ? [] : groups.map(group => ({ id: `plugin:${group.id}` as const, label: group.choices?.irreversible ? `${group.label}…` : group.label, remote: true,
      ...(group.choices ? { choices: group.choices } : {}), ...(group.selection ? { selection: { label: group.selection.label, children: group.selection.children.map(id => `plugin:${id}`) } } : {}),
      children: group.children.map(({ runs, ...action }) => ({ ...action, id: `plugin:${action.id}` as const, ...(runs ? { runs: runs.map(id => `plugin:${id}` as const) } : {}) })) })),
    [...open, ...(project ? [{ id: 'edit' as const, label: 'Project settings…' }] : [...convert, ...fields, { id: 'settings' as const, label: 'Settings', children: [{ id: 'edit' as const, label: editLabel },
      { id: 'size-default' as const, label: 'Use size as default', ...(size?.disabled ? { disabled: true, description: size.disabled } : {}) }] }])],
    [
      ...(send && !project ? [send] : []),
      ...(project ? [] : plot),
      ...(todo ? [{ id: todo.enabled ? 'remove-todo' as const : 'add-todo' as const, label: todo.enabled ? 'Remove from to-dos' : 'Turn into todo' }] : []),
      ...(autoTitle && !project ? [{ id: 'auto-title' as const, label: 'Auto-name from activity' }] : []),
      ...(plots && project ? [{ id: 'plots-toggle' as const, label: 'Show plots', checked: plots.shown }, ...(plots.hidden ? [{ id: 'plots-unhide' as const, label: `Show hidden plots (${plots.hidden})` }] : [])] : []),
      { id: completed ? 'reopen' : 'complete', label: completed ? 'Reopen' : 'Mark done' },
      ...(mute && project ? [mute] : []),
      ...(visibility.hide && !project ? [{ id: 'hide-item' as const, label: `Hide ${visibility.hide}` }] : []),
      { id: 'below', label: project ? 'Send project to Undermap' : 'Send to Undermap' },
    ],
  ];
  const actions = sections.flat(), defaults = sections.filter(section => section.length).flatMap((section, index) => [...(index ? [MENU_SEPARATOR] : []), ...section.map(action => action.id)]);
  const menu: MenuAction[] = []; let divider = false;
  for (const id of drawnMenuLayout(menuLayout(defaults, project ? {} : custom), project ? [] : custom.hidden)) {
    if (isSeparator(id)) { divider = true; continue; }
    for (const action of actions) if (menuSlot(action.id) === id) { menu.push(divider ? { ...action, divider: true } : action); divider = false; }
  }
  return menu;
}

/** An item's fields that have a `menu`: a submenu of their options or a row of swatches, the shown value checked. `shown`
 * names the value an item shows when that differs from its data, such as a note that became a badge on its own. */
export function fieldMenuActions(fields: ResourceFields = {}, data: JsonObject = {}, shown: Readonly<Record<string, string>> = {}): MenuAction[] {
  return Object.entries(fields).flatMap(([key, field]) => {
    const menu = field.menu;
    if (!menu) return [];
    const options = menu.options ?? field.options ?? [], label = (option: string) => menu.optionLabels?.[option] ?? field.optionLabels?.[option] ?? option;
    const custom = field.customColor && isHexColor(data[key]) ? (data[key] as string).toLowerCase() : undefined;
    const saved = typeof data[key] === 'string' && options.includes(data[key] as string) ? data[key] as string : custom, value = shown[key] ?? saved ?? menu.fallback;
    const id = `field:${key}` as const;
    return [menu.swatches ? { id, label: menu.label, row: options.map(option => ({ value: option, label: label(option), swatch: menu.swatches![option], checked: option === value })), ...(field.customColor ? { customColor: { shown: value === custom ? custom : undefined } } : {}) }
      : { id, label: menu.label, children: options.map(option => ({ id: `field:${key}:${option}` as const, label: label(option), checked: option === value })) }];
  });
}

/** Mute sits above Send project to Undermap, the stronger of the two (MAP-25). `needs` is how
 * many of the project's items wait in Needs me, so the entry says what it silences. */
export function muteProjectAction(muted: boolean, needs = 0): MenuAction {
  return muted ? { id: 'unmute', label: 'Unmute project' } : { id: 'mute', label: needs ? `Mute project (Needs me: ${needs})` : 'Mute project' };
}

/** A generic link whose URL a more specific type claims can become that type (RES-10);
 * `types` are the registry's conversions for the item, usually one. */
export function convertLinkActions(types: readonly { pluginId: string; name: string }[]): MenuAction[] {
  return types.map(type => ({ id: `convert:${type.pluginId}` as const, label: `Convert to ${type.name}` }));
}

type ProjectTarget = { id: string; title: string; current: boolean };
const projectSubmenu = (label: string, targets: readonly ProjectTarget[]): MenuAction => ({ id: 'send-project', label, children: targets.length
  ? targets.map(target => ({ id: `send:${target.id}` as const, label: target.title, checked: target.current, ...(target.current ? { disabled: true } : {}) }))
  : [{ id: 'send:' as const, label: 'No projects yet', disabled: true }] });
/** A to-do list row's Send to project submenu; `targets` come from `sendTargets`, already in list order. */
export const sendToProjectAction = (targets: readonly ProjectTarget[]): MenuAction => projectSubmenu('Send to project', targets);
/** A to-do list row's context entries (TODO-11); the text itself is never in the menu. */
export const todoContextActions = (hasContext: boolean, shown: boolean): MenuAction[] => hasContext
  ? [{ id: shown ? 'context-hide' : 'context-show', label: shown ? 'Hide context' : 'Show context', divider: true }, { id: 'context-clear', label: 'Clear context', destructive: true }]
  : [{ id: 'context-add', label: 'Add context…', divider: true }];
/** The Later group's menu in the to-do list (TODO-12): rows untouched for `days` go to Archive. */
export const laterGroupActions = (stale: number, days: number): MenuAction[] => [{ id: 'archive-stale', label: `Archive rows untouched for ${days} days`, ...(stale ? {} : { disabled: true }) }];
/** A map item's (or selection's) Move to project submenu; `targets` come from `moveTargets`. */
export const moveToProjectAction = (targets: readonly ProjectTarget[]): MenuAction => projectSubmenu('Move to project', targets);
type PlotTarget = { id: string; name: string; hidden: boolean; current: boolean };
/** A map item's (or selection's) Move to plot submenu (MAP-24): the plots of the project every item is in, in map order, the
 * one they are all pinned in checked, then New plot. `undefined` plots: the items are not all in one project. */
export const moveToPlotAction = (plots: readonly PlotTarget[] | undefined): MenuAction => ({ id: 'move-plot', label: 'Move to plot', children: plots
  ? [...plots.map(plot => ({ id: `plot-pin:${plot.id}` as const, label: plot.hidden ? `${plot.name} (hidden)` : plot.name, checked: plot.current, ...(plot.current ? { disabled: true } : {}) })),
    { id: 'plot-new' as const, label: 'New plot', ...(plots.length ? { divider: true } : {}) }]
  : [{ id: 'plot-pin:' as const, label: 'Items in one project only', disabled: true }] });
/** For an item pinned in a plot, or a selection all pinned in the same one. */
export const removeFromPlotAction = (): MenuAction => ({ id: 'plot-unpin', label: 'Remove from plot' });
/** The plot entries for map items `ids`: Move to plot with their project's plots (hidden ones too) in map order, and Remove
 * from plot when every item is pinned in the same plot. */
export function itemPlotActions(nodes: readonly Pick<GraphNode, 'id' | 'projectId' | 'position'>[], plots: readonly Pick<PlotView, 'id' | 'projectId' | 'memberIds' | 'pinnedMemberIds' | 'name' | 'hidden'>[], ids: readonly string[]): MenuAction[] {
  const projects = new Set(ids.map(id => nodes.find(node => node.id === id)?.projectId)), projectId = projects.size === 1 ? [...projects][0] : undefined;
  const pinnedIn = ids.map(id => plots.find(plot => plot.pinnedMemberIds.includes(id))?.id), shared = pinnedIn.every(id => id !== undefined && id === pinnedIn[0]) ? pinnedIn[0] : undefined;
  const own = new Map(plots.filter(plot => plot.projectId === projectId).map(plot => [plot.id, plot]));
  const targets = projectId === undefined ? undefined : plotMapOrder([...own.values()], nodes).map(id => { const plot = own.get(id)!; return { id, name: plot.name, hidden: plot.hidden, current: id === shared }; });
  return [moveToPlotAction(targets), ...shared ? [removeFromPlotAction()] : []];
}

/** Groups whose `when` package setting is not on are left out; `settings` has defaults filled in. */
export function enabledMenuGroups(groups: readonly ResourceMenuGroup[] = [], settings: Readonly<Record<string, JsonObject>> = {}): ResourceMenuGroup[] {
  return groups.filter(group => !group.when || settings[group.when.plugin]?.[group.when.setting] === true);
}

/** A plot's signpost menu (MAP-24). Name automatically needs Name plots on. With the plot's colors it offers
 * the six swatches of its project's neighborhood, the shown one checked, and Automatic, checked while no color is chosen. */
/** A sign's menu. With `targets` (from `moveTargets` for its members) the whole plot can move to another project or to none, or go to Undermap. */
export function plotMenuActions(naming = true, colors?: { color: PlotColor; chosenColor?: PlotColor | string }, neighborhoodColor?: string, targets?: readonly ProjectTarget[]): MenuAction[] {
  const shown = colors && (colors.chosenColor ?? colors.color), palette = plotPalette(neighborhoodColor);
  return [
    { id: 'plot-select', label: 'Select items' },
    { id: 'plot-rename', label: 'Rename plot…' },
    { id: 'plot-auto', label: 'Name automatically', ...(naming ? {} : { disabled: true, description: 'Turn on Name plots in Settings → AI features' }) },
    ...colors ? [
      { id: 'plot-color' as const, label: 'Color', divider: true, row: palette.map(({ slot, name, color }) => ({ value: slot, label: name, swatch: color, checked: slot === shown })), customColor: { shown: isPlotColor(shown) ? undefined : shown } },
      { id: 'plot-color-auto' as const, label: `Automatic · ${palette.find(swatch => swatch.slot === colors.color)!.name}`, checked: !colors.chosenColor },
    ] : [],
    ...targets ? [
      { id: 'send-project' as const, label: 'Move plot to', divider: true, children: [...projectSubmenu('', targets).children!.filter(child => child.id !== 'send:'), { id: 'plot-leave' as const, label: 'No project', divider: true }] },
      { id: 'plot-below' as const, label: 'Send plot to Undermap' },
    ] : [],
    { id: 'plot-hide', label: 'Hide this plot', divider: true },
  ];
}

/** An item's Delete…, on when Settings allows it. Its submenu is the confirmation; nothing is deleted until Delete permanently. */
export const deleteItemAction = (): MenuAction => ({ id: 'delete', label: 'Delete…', destructive: true, divider: true, children: [
  { id: 'delete-cancel', label: 'Cancel' },
  { id: 'delete-confirm', label: 'Delete permanently', destructive: true, description: 'Provider data and sessions are kept. This can’t be undone.' },
] });

/** A connection can become blocking (source blocks target) and back, or be removed. */
export function linkMenuActions(kind: 'reference' | 'context' | 'blocks', source: string, target: string): MenuAction[] {
  return [
    ...(kind === 'blocks' ? [{ id: 'make-normal' as const, label: 'Make normal' }, { id: 'reverse-link' as const, label: 'Reverse blocking', description: `${target} blocks ${source}` }]
      : [{ id: 'make-blocking' as const, label: 'Make blocking', description: `${source} blocks ${target}` }]),
    { id: 'remove-link', label: 'Remove connection', divider: true },
  ];
}

/** Only actions with an atomic shared-command meaning can apply to a group, plus a plugin group every item offers
 * for a selection: it runs its named children once per item. */
export function sharedContextMenuActions(menus: readonly MenuAction[][]): MenuAction[] {
  const batchable: MenuActionId[] = ['copy-url', 'send-project', 'move-plot', 'plot-unpin', 'complete', 'reopen', 'archive', 'below', 'surface', 'add-todo', 'remove-todo'];
  return (menus[0] ?? []).filter(action => (batchable.includes(action.id) || action.selection) && menus.every(menu => menu.some(other => other.id === action.id)))
    .map(action => action.selection ? { id: action.id, label: action.selection.label, remote: true, children: (action.children ?? []).filter(child => action.selection!.children.includes(child.id)) }
      : action.id === 'copy-url' ? { id: action.id, label: 'Copy URLs' } : action.id === 'archive' ? { ...action, label: 'Archive selection' } : action.id === 'below' ? { ...action, label: 'Send selection to Undermap' }
      : action.id === 'surface' ? { id: action.id, label: 'Bring selection back', ...(menus.some(menu => menu.find(other => other.id === 'surface')?.disabled) ? { disabled: true, description: 'Some of these cannot return yet' } : {}) } : action);
}
