import type { PluginDescription } from '../../src/resource-plugins/describe.client.ts';
import type { ResourceAppearance } from '../../src/resource-plugins/types.ts';
import type { MenuAction } from './context-menu.ts';

export const FROM_URL = 'from-url';
export const RUN_SKILL = 'run-skill';
export const DEFAULT_QUICK_ITEMS = ['project', 'agent.session', 'terminal.session', FROM_URL, 'workspace.todo', 'workspace.note'];
export const MAX_QUICK_ITEMS = 7;
export interface ItemChoice { id: string; name: string; shortLabel?: string; icon: string; brand?: string; tint?: boolean; tone?: string; size?: ResourceAppearance['size']; aliases?: string[]; alwaysQuick?: boolean; hotkey?: string; /** A map menu entry, run as that entry instead of creating an item. */ menuAction?: true }

/** The catalog owns item discovery; missing preferences remain stored for when a plugin returns. */
export function itemChoices(plugins: PluginDescription[], projectId?: string, canRunSkill = false): ItemChoice[] {
  const urls = plugins.filter(plugin => plugin.creation?.mode === 'url' || plugin.creation?.group === 'url');
  return [...(projectId ? canRunSkill ? [{ id: RUN_SKILL, name: 'Run skill', icon: 'sparkles', tone: 'amber', alwaysQuick: true }] : [] : [{ id: 'project', name: 'Project', icon: 'project' }]), ...(urls.length ? [{ id: FROM_URL, name: 'From URL', icon: 'link', aliases: urls.map(plugin => plugin.id) }] : []), ...plugins.filter(plugin => plugin.creation && plugin.creation.mode !== 'url' && plugin.creation.group !== 'url').map(plugin => ({
    id: plugin.id, name: plugin.name, shortLabel: plugin.creation?.shortLabel, icon: plugin.icon, brand: plugin.brand, ...(plugin.appearance?.brandTint ? { tint: true } : {}), tone: plugin.appearance?.tone, size: plugin.appearance?.size, ...(plugin.creation?.hotkey ? { hotkey: plugin.creation.hotkey } : {}),
  }))];
}
/** Project legacy shortcuts into one choice without rewriting saved/missing IDs. */
export function normalizedQuickIds(choices: ItemChoice[], quickIds: string[]): string[] {
  const aliases = new Map(choices.flatMap(choice => (choice.aliases ?? []).map(id => [id, choice.id] as const)));
  return [...new Set(quickIds.map(id => aliases.get(id) ?? id))];
}
export function itemChoiceLayers(choices: ItemChoice[], quickIds: string[]) {
  const catalog = new Map(choices.map(choice => [choice.id, choice]));
  const ids = new Set(normalizedQuickIds(choices, quickIds));
  const fixed = choices.filter(choice => choice.alwaysQuick);
  const configured = [...ids].flatMap(id => catalog.has(id) && !catalog.get(id)!.alwaysQuick ? [catalog.get(id)!] : []);
  const quick = [...(fixed.length ? configured.slice(0, MAX_QUICK_ITEMS - fixed.length) : configured), ...fixed];
  const shown = new Set(quick.map(choice => choice.id));
  return { quick, remaining: choices.filter(choice => !shown.has(choice.id)) };
}

const GROUND_ICONS: Readonly<Record<string, string>> = { 'new-project': 'project', 'archive-browser': 'archive', mute: 'bell', unmute: 'bell' };
/** The ground menu's entries as ring choices (MAP-31). New item is left out because the ring is that entry; New project is
 * the ring's Project choice, so it is added only when `quick` does not show one. Counts in a label stay in the tooltip. */
export function groundRingChoices(actions: readonly MenuAction[], quick: readonly ItemChoice[]): ItemChoice[] {
  return actions.flatMap((action): ItemChoice[] => {
    if (action.id === 'new-item' || (action.id === 'new-project' && quick.some(choice => choice.id === 'project'))) return [];
    const icon = GROUND_ICONS[action.id] ?? 'item';
    return [action.id === 'new-project' ? { id: 'project', name: action.label, icon } : { id: action.id, name: action.label, shortLabel: action.label.replace(/ \(.*\)$/, ''), icon, menuAction: true }];
  });
}
