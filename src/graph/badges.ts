import type { GraphLink, GraphNode } from './graph.ts';
import { isArchived, isDrawn } from './archive.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';

/** Note badges (MAP-BADGES): a note of one or two words shows as a tab on every item it is connected to. */
export const BADGE_CHARACTERS = 12, PINNED_BADGE_CHARACTERS = 24;
export const NOTE_DISPLAYS = ['auto', 'badge', 'note'] as const;
export type NoteDisplay = typeof NOTE_DISPLAYS[number];
/** A badge is drawn in its note's paper; a note without one is mint. */
export interface Badge { noteId: string; text: string; paper: string }

/** The words a note shows as a badge, or undefined while it stays paper. A badge is one plain line; on its own a note
 * qualifies with one or two words of at most 12 characters, `display: "badge"` takes any words up to 24, `"note"` none. */
export function badgeWords(text: string, display?: unknown): string | undefined {
  const words = text.trim();
  if (!words || display === 'note' || /[\r\n]/.test(words)) return undefined;
  if (/^([-*+>#]|\d+[.)]|\[[ xX]?\])/.test(words) || /[`*[\]<>]/.test(words)) return undefined;
  if (display === 'badge') return words.length <= PINNED_BADGE_CHARACTERS ? words : undefined;
  return words.split(/\s+/).length <= 2 && words.length <= BADGE_CHARACTERS ? words : undefined;
}

/** Which notes are badges on which items, and the map without them: an attached badge note is not drawn as paper and its
 * links are not drawn, because the connection is the attachment. A badge note connected to no item stays paper. `editing`
 * names notes kept as paper while someone writes in them. */
export function mapBadges<N extends GraphNode, L extends GraphLink>(nodes: readonly N[], resources: readonly ResourceRecord[], links: readonly L[], editing: ReadonlySet<string> = new Set()) {
  const byId = new Map(nodes.map(node => [node.id, node])), records = new Map(resources.map(resource => [resource.id, resource]));
  const isNote = (node: GraphNode) => records.get(node.resourceId ?? '')?.pluginId === 'workspace.note';
  const onItems = new Map<string, Badge[]>(), attached = new Set<string>();
  for (const node of nodes) {
    if (!isNote(node) || editing.has(node.id) || isArchived(node, nodes) || !isDrawn(node, nodes)) continue;
    const data = records.get(node.resourceId!)!.data, text = badgeWords(typeof data.text === 'string' ? data.text : '', data.display);
    if (!text) continue;
    const targets = links.flatMap(link => link.sourceId === node.id ? [link.targetId] : link.targetId === node.id ? [link.sourceId] : [])
      .map(id => byId.get(id)).filter((target): target is N => Boolean(target?.resourceId && !isNote(target) && isDrawn(target, nodes)));
    if (!targets.length) continue;
    attached.add(node.id);
    for (const target of new Set(targets)) onItems.set(target.id, [...onItems.get(target.id) ?? [], { noteId: node.id, text, paper: typeof data.paper === 'string' ? data.paper : 'mint' }]);
  }
  for (const badges of onItems.values()) badges.sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }) || a.noteId.localeCompare(b.noteId));
  return { onItems, attached, nodes: attached.size ? nodes.filter(node => !attached.has(node.id)) : [...nodes],
    links: attached.size ? links.filter(link => !attached.has(link.sourceId) && !attached.has(link.targetId)) : [...links] };
}
