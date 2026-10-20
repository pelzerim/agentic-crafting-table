import type { ResourceIndicator } from '../resource-plugins/indicators.ts';
import { assertNoBlockingCycle } from './blocking.ts';
export const ITEM_SIZES = ['small', 'medium', 'large'] as const;
export type ItemSize = typeof ITEM_SIZES[number];

export interface GraphNode {
  id: string;
  title: string;
  /** Identifies the resource behind a visual alias. Project nodes can omit it. */
  resourceId?: string;
  /** Optional per-alias map footprint; absent values inherit plugin appearance. */
  mapSize?: ItemSize;
  /** Optional pointer-resized footprint; tier defaults remain the fallback. */
  mapDimensions?: { width: number; height: number };
  projectId?: string;
  /** Reversible visibility; the service applies provider-specific archive lifecycle. */
  archivedAt?: string;
  /** Sent below the map: hidden from it, kept readable in the layer below. */
  belowAt?: string;
  /** Kept off the map while it stays live: not drawn, no obstacle, no Needs me source. Its work and links go on. */
  hiddenAt?: string;
  /** What Show and Hide call the item, e.g. "validation agent"; it stays when the item is shown. */
  hideLabel?: string;
  /** A muted project: its place on the map is covered and it raises no Needs me, counts or
   * notifications. Display only; nothing it runs is paused. Project nodes only. */
  mutedAt?: string;
  /** Map position to return to when its Undermap placement moved it. */
  mapPosition?: { x: number; y: number };
  /** Title of the deleted project this below item belonged to; it cannot return. */
  lostProject?: string;
  /** User completion on the map, independent of live provider activity. */
  completedAt?: string;
  inTodoList?: boolean;
  todoLabel?: { title: string; sourceTitle: string };
  /** Title last set by automation; any other title is the user's and stays. */
  generatedTitle?: string;
  /** List rank for tasks, group rank for projects; independent of map position. */
  todoOrder?: number;
  /** A map to-do's context (TODO-11): text for whoever picks it up later, with its last writer. Read it through `todoContext`. */
  todoContext?: string;
  todoContextBy?: { kind: 'user' | 'agent' | 'provider' | 'system'; id: string; title?: string };
  todoContextAt?: string;
  /** Where a map to-do sits in the list (TODO-12); none reads as Next. */
  todoHorizon?: 'next' | 'later';
  /** When a person last edited, moved, ticked or wrote context on this to-do. */
  todoTouchedAt?: string;
  /** Ticked in the to-do list only: an item kept in the list completes there without its provider. */
  todoDoneAt?: string;
  /** The ticket item this to-do brought to the map; the to-do follows its completion. */
  todoTicketId?: string;
  /** Independent provider/workflow reasons; clearing one must preserve others. */
  attentionSources?: Record<string, string>;
  /** Short trigger-supplied reason per attention source, shown in Needs me. */
  attentionNotes?: Record<string, string>;
  /** Short trigger-supplied reason for the item's own `attention`. */
  attentionNote?: string;
  /** Durable unread cycle, separate from the underlying attention/status. */
  attentionVersion?: number;
  attentionSeenVersion?: number;
  /** When the current unread cycle was raised; Needs me shows it as an age. */
  attentionAt?: string;
  /** Last event per source prevents replayed completions from alerting again. */
  attentionEvents?: Record<string, string>;
  indicators?: ResourceIndicator[];
  /** Last observed change of activity, attention or indicators. */
  activityAt?: string;
  /** How many helpers (subagents, teammates) a working item has busy right now; absent means none. Only a working item has it. */
  helpers?: number;
  /** The item itself only waits on its busy helpers. Only a working item with helpers has it. */
  waiting?: true;
  /** What the item itself is doing or held by, where one word says it. Kept only while it can be true:
   * gate and asking with input attention, fallen with error attention, shearing and command on a working
   * item, ended on one that is not working. */
  pose?: 'gate' | 'asking' | 'fallen' | 'shearing' | 'command' | 'ended';
  /** How many background shells and watchers the item's session runs beside its prompt. */
  beside?: number;
  /** Progress of the session's current task list. */
  tasks?: { done: number; total: number };
  /** The session runs on another model than it started with. */
  bell?: true;
  /** The session works in a worktree of its own. */
  pen?: true;
  /** Something that just happened once; the map plays it when `at` (epoch ms) is now. Never cleared. */
  moment?: { kind: 'stumble' | 'bump' | 'enter' | 'leave'; at: number };
  /** Project neighborhood base color (#rrggbb); absent uses the default. */
  color?: string;
  position: { x: number; y: number };
  acceptsContext?: boolean;
}

export interface GraphLink {
  id: string;
  sourceId: string;
  targetId: string;
  /** blocks: the source must resolve before the target (see blocking.ts). */
  kind: 'reference' | 'context' | 'blocks';
  label: string;
  /** hover: drawn only while revealed (see shownLinks); absent: always drawn. */
  reveal?: 'hover';
}

/** The links to draw: every link without `reveal` that is not `implied`, and a hover or implied link while `revealed`
 * holds one of its ends or its own id. */
export function shownLinks<T extends Pick<GraphLink, 'id' | 'sourceId' | 'targetId' | 'reveal'>>(links: readonly T[], revealed: ReadonlySet<string>, implied: ReadonlySet<string> = new Set()): T[] {
  return links.filter(link => (link.reveal !== 'hover' && !implied.has(link.id)) || revealed.has(link.id) || revealed.has(link.sourceId) || revealed.has(link.targetId));
}

/** Links whose ends a path of two or more other drawn links already joins (LINK-06). A blocking link needs a blocking
 * path that follows its direction; a reference or context link takes a path of any kinds, where context follows its
 * direction and reference and blocking links run both ways. Hover links are no path. Later links are tried first and
 * each one hidden stays out of the paths for the rest, so a cycle or two equal paths lose one link, not both. */
export function impliedLinks(links: readonly Pick<GraphLink, 'id' | 'sourceId' | 'targetId' | 'kind' | 'reveal'>[]): Set<string> {
  const implied = new Set<string>();
  const drawn = links.filter(link => link.reveal !== 'hover' && link.sourceId !== link.targetId);
  for (const blocking of [true, false]) {
    const tried = drawn.filter(link => (link.kind === 'blocks') === blocking), paths = blocking ? tried : drawn;
    const out = new Map<string, { id: string; to: string }[]>();
    const step = (from: string, to: string, id: string) => { const next = out.get(from); if (next) next.push({ id, to }); else out.set(from, [{ id, to }]); };
    for (const link of paths) { step(link.sourceId, link.targetId, link.id); if (!blocking && link.kind !== 'context') step(link.targetId, link.sourceId, link.id); }
    for (const link of [...tried].reverse()) {
      const from = link.sourceId, to = link.targetId, seen = new Set([from]);
      const queue = (out.get(from) ?? []).filter(edge => edge.to !== to && !implied.has(edge.id)).map(edge => edge.to);
      for (const node of queue) seen.add(node);
      let found = false;
      for (let i = 0; i < queue.length && !found; i++) {
        for (const edge of out.get(queue[i]) ?? []) {
          if (edge.id === link.id || implied.has(edge.id) || seen.has(edge.to)) continue;
          if (edge.to === to) { found = true; break; }
          seen.add(edge.to); queue.push(edge.to);
        }
      }
      if (found) implied.add(link.id);
    }
  }
  return implied;
}

/** New spatial links give context to a capable endpoint, preferring the drop
 * target if both can receive it. Validation still rejects duplicates, aliases
 * and occupied single-partner items; those errors never downgrade to reference.
 */
export function automaticLink(id: string, from: Pick<GraphNode, 'id' | 'acceptsContext'>, to: Pick<GraphNode, 'id' | 'acceptsContext'>): GraphLink & { kind: 'reference' | 'context' } {
  const reverse = !to.acceptsContext && Boolean(from.acceptsContext);
  return {
    id, sourceId: reverse ? to.id : from.id, targetId: reverse ? from.id : to.id,
    kind: from.acceptsContext || to.acceptsContext ? 'context' : 'reference', label: '',
  };
}

/** Position is independent of project membership, agent state, and links. */
export function moveNode(nodes: readonly GraphNode[], id: string, position: GraphNode['position']): GraphNode[] {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Position must be finite');
  if (!nodes.some(node => node.id === id)) throw new Error('Node does not exist');
  return nodes.map(node => node.id === id ? { ...node, position: { ...position } } : node);
}

/** Translate a project and all its members together, including archived items. */
export function moveProject(nodes: readonly GraphNode[], projectId: string, position: GraphNode['position']): GraphNode[] {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Position must be finite');
  const project = nodes.find(node => node.id === projectId);
  if (!project || project.projectId || project.resourceId) throw new Error('Project does not exist');
  const dx = position.x - project.position.x, dy = position.y - project.position.y;
  return nodes.map(node => node.id === projectId || node.projectId === projectId
    ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
    : node);
}

/** Resolve trusted plugin metadata, not client-supplied node settings. Defaults to unrestricted. */
export type RelationshipCardinality = (node: GraphNode) => 'one' | 'many';

const identity = (node: GraphNode) => node.resourceId ? `resource:${node.resourceId}` : `node:${node.id}`;
const sameEndpoint = (nodes: readonly GraphNode[], nodeId: string, node: GraphNode) => {
  const candidate = nodes.find(n => n.id === nodeId);
  return candidate && identity(candidate) === identity(node);
};
/** Another link that already holds this relationship: same kind between the same items (aliases count as one item),
 * in the same direction, or either direction for a reference. */
export function existingRelationship<L extends GraphLink>(nodes: readonly GraphNode[], links: readonly L[], link: GraphLink): L | undefined {
  const source = nodes.find(node => node.id === link.sourceId), target = nodes.find(node => node.id === link.targetId);
  if (!source || !target) return undefined;
  return links.find(existing => existing.id !== link.id && existing.kind === link.kind && (
    (sameEndpoint(nodes, existing.sourceId, source) && sameEndpoint(nodes, existing.targetId, target)) ||
    (link.kind === 'reference' && sameEndpoint(nodes, existing.sourceId, target) && sameEndpoint(nodes, existing.targetId, source))
  ));
}

export function validateLink(nodes: readonly GraphNode[], links: readonly GraphLink[], link: GraphLink, cardinality: RelationshipCardinality = () => 'many'): void {
  if (!link.id.trim()) throw new Error('A link id is required');
  const source = nodes.find(node => node.id === link.sourceId);
  const target = nodes.find(node => node.id === link.targetId);
  if (!source || !target) throw new Error('Both endpoints must exist');
  if (source.id === target.id || (source.resourceId && source.resourceId === target.resourceId)) {
    throw new Error('Cannot connect an item to itself');
  }
  if (!['reference', 'context', 'blocks'].includes(link.kind)) throw new Error('Unknown relationship type');
  if (link.kind === 'context' && !target.acceptsContext) throw new Error('Context must point to an agent');
  if (existingRelationship(nodes, links, link)) throw new Error('These items already have this relationship');
  if (link.kind === 'blocks') assertNoBlockingCycle(nodes, links, link);
  for (const [endpoint, other] of [[source, target], [target, source]]) {
    if (cardinality(endpoint) !== 'one') continue;
    const neighbors = new Set([identity(other)]);
    for (const existing of links) {
      if (existing.id === link.id) continue; // A link edit replaces its old endpoints atomically.
      const otherId = sameEndpoint(nodes, existing.sourceId, endpoint) ? existing.targetId
        : sameEndpoint(nodes, existing.targetId, endpoint) ? existing.sourceId : undefined;
      const neighbor = nodes.find(n => n.id === otherId);
      if (neighbor) neighbors.add(identity(neighbor));
    }
    if (neighbors.size > 1) throw new Error(`${endpoint.title} can connect to only one item. Remove or update its existing connection first.`);
  }
}

export function saveLink(nodes: readonly GraphNode[], links: readonly GraphLink[], link: GraphLink, cardinality?: RelationshipCardinality): GraphLink[] {
  validateLink(nodes, links, link, cardinality);
  return [...links.filter(existing => existing.id !== link.id), { ...link }];
}

/** Direct incoming context only. Related-to links never expand an agent's scope. */
export function incomingContextSources(agentId: string, nodes: readonly GraphNode[], links: readonly GraphLink[]): GraphNode[] {
  const agent = nodes.find(node => node.id === agentId);
  if (!agent?.acceptsContext) throw new Error('The target does not accept context');
  const seen = new Set<string>();
  const sources: GraphNode[] = [];
  for (const link of links) {
    const target = nodes.find(node => node.id === link.targetId);
    const sameAgent = target && (target.id === agentId || (target.resourceId && target.resourceId === agent.resourceId));
    if (link.kind !== 'context' || !sameAgent) continue;
    const source = nodes.find(node => node.id === link.sourceId);
    if (!source || source.id === agentId || (source.resourceId && source.resourceId === agent.resourceId)) continue;
    const key = source.resourceId ? `resource:${source.resourceId}` : `node:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

export interface ConnectedContext {
  nodeId: string;
  title: string;
  summary: string;
  reference?: string;
}

/** readBrief dispatches to the resource plugin's getContext, or project summary. */
export async function collectConnectedContext(
  agentId: string,
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
  readBrief: (node: GraphNode) => Promise<{ summary: string; reference?: string }>,
): Promise<ConnectedContext[]> {
  return Promise.all(incomingContextSources(agentId, nodes, links).map(async node => ({
    nodeId: node.id, title: node.title, ...await readBrief(node),
  })));
}
