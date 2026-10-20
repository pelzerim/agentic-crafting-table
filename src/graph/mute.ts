import type { GraphNode } from './graph.ts';
import { attentionItems } from './attention.ts';
import type { AttentionItem } from './attention.ts';

type MuteNode = GraphNode & { activity?: string; attention?: string };

/** Mute is a display preference on a project (MAP-25): the app stops showing and
 * announcing what its items need, and changes nothing about what runs. */
export function mutedProjectIds(nodes: readonly GraphNode[]): Set<string> {
  return new Set(nodes.filter(node => !node.resourceId && !node.projectId && node.mutedAt).map(node => node.id));
}

/** A project is muted by its own flag; an item by the project it is in now. */
export function isMuted(node: GraphNode, nodes: readonly GraphNode[], muted: ReadonlySet<string> = mutedProjectIds(nodes)): boolean {
  return muted.has(node.resourceId ? node.projectId ?? '' : node.id);
}

/** Needs me as the button, Dock badge, notifications and panel count it (`shown`),
 * and the rows a muted project holds back (`muted`). An item also placed in an
 * unmuted project stays shown through that alias. Nothing is acknowledged. */
export function splitAttention<T extends MuteNode>(nodes: readonly T[]): { shown: AttentionItem[]; muted: AttentionItem[] } {
  const quiet = mutedProjectIds(nodes);
  if (!quiet.size) return { shown: attentionItems(nodes), muted: [] };
  const shown = attentionItems(nodes.filter(node => !isMuted(node, nodes, quiet) || !node.resourceId)), identities = new Set(shown.map(item => item.identity));
  return { shown, muted: attentionItems(nodes).filter(item => !identities.has(item.identity)) };
}
