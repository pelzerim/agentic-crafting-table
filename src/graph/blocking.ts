import type { GraphLink, GraphNode } from './graph.ts';

type Node = Pick<GraphNode, 'id' | 'resourceId' | 'completedAt' | 'archivedAt' | 'indicators'>;
const identity = (node: Pick<GraphNode, 'id' | 'resourceId'>) => node.resourceId ? `resource:${node.resourceId}` : `node:${node.id}`;

/** A blocker stops blocking once it is finished by its own measure: marked done,
 * archived, deleted, or a plugin indicator that reports the finished stage (a merged
 * or closed PR, a done ticket, a passed rollout). Nothing here depends on item type. */
export function blockerResolved(node: Node | undefined) {
  return !node || Boolean(node.completedAt || node.archivedAt || node.indicators?.some(cue => cue.stage === 'done'));
}

export interface BlockingState<T extends Node = GraphNode> {
  /** Every alias of a blocked item maps to its unresolved blockers, in link order. */
  blocked: Map<string, T[]>;
  /** Each blocks link id and whether its blocker has resolved. */
  resolved: Map<string, boolean>;
}

export function blockingState<T extends Node>(nodes: readonly T[], links: readonly GraphLink[]): BlockingState<T> {
  const byId = new Map(nodes.map(node => [node.id, node])), byIdentity = new Map<string, T[]>(), resolved = new Map<string, boolean>();
  for (const link of links) {
    if (link.kind !== 'blocks') continue;
    const source = byId.get(link.sourceId), target = byId.get(link.targetId), done = blockerResolved(source);
    resolved.set(link.id, done);
    if (done || !target) continue;
    const key = identity(target), list = byIdentity.get(key) ?? [];
    if (!list.some(other => identity(other) === identity(source!))) list.push(source!);
    byIdentity.set(key, list);
  }
  const blocked = new Map<string, T[]>();
  if (byIdentity.size) for (const node of nodes) { const list = byIdentity.get(identity(node)); if (list) blocked.set(node.id, list); }
  return { blocked, resolved };
}

export function blockedBy<T extends Node>(nodeId: string, nodes: readonly T[], links: readonly GraphLink[]): T[] {
  return blockingState(nodes, links).blocked.get(nodeId) ?? [];
}

/** Items that were blocked and no longer are because their blockers resolved; an
 * item whose blocking link was removed instead is not reported. One per resource. */
export function unblockedSince<T extends Node>(before: BlockingState<Node>, nodes: readonly T[], links: readonly GraphLink[]): T[] {
  if (!before.blocked.size) return [];
  const now = blockingState(nodes, links), byId = new Map(nodes.map(node => [node.id, node]));
  const stillLinked = new Set(links.flatMap(link => link.kind === 'blocks' && byId.has(link.targetId) ? [identity(byId.get(link.targetId)!)] : []));
  const seen = new Set<string>();
  return nodes.filter(node => {
    const key = identity(node);
    if (!before.blocked.has(node.id) || now.blocked.has(node.id) || !stillLinked.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Refuses a blocks link whose target already blocks its source, directly or through other items. */
export function assertNoBlockingCycle(nodes: readonly GraphNode[], links: readonly GraphLink[], link: GraphLink) {
  const byId = new Map(nodes.map(node => [node.id, node])), source = byId.get(link.sourceId)!, target = byId.get(link.targetId)!;
  const next = new Map<string, string[]>();
  for (const existing of links) {
    const from = byId.get(existing.sourceId), to = byId.get(existing.targetId);
    if (existing.kind !== 'blocks' || existing.id === link.id || !from || !to) continue;
    next.set(identity(from), [...next.get(identity(from)) ?? [], identity(to)]);
  }
  const goal = identity(source), direct = next.get(identity(target))?.includes(goal);
  const seen = new Set<string>(), queue = [identity(target)];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] === goal) throw new Error(`${target.title} already blocks ${source.title}${direct ? '' : ', through other items'}. This would create a blocking cycle.`);
    for (const to of next.get(queue[i]) ?? []) if (!seen.has(to)) { seen.add(to); queue.push(to); }
  }
}

/** “#64 Thumbnail refresh loop”: a plugin's short reference before the title, unless the title has it. */
export function blockerName(title: string, reference?: string) {
  return reference && !title.includes(reference) ? `${reference} ${title}` : title;
}
/** “A, B and 2 more”, each name kept short, so a warning stays one line. */
export function blockerList(names: readonly string[], max = 3) {
  const shown = names.slice(0, max).map(name => name.length > 60 ? `${name.slice(0, 59)}…` : name);
  if (names.length > max) shown.push(`${names.length - max} more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] ?? '';
}
