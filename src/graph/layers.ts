import type { GraphLink, GraphNode } from './graph.ts';

/** The map and the Undermap below it (MAP-18). */
export type MapLayer = 'map' | 'below';
/** What a layer's snapshot says about the Undermap without carrying it: the items below and the projects drawn there. */
export interface LayerSummary { below: { items: number; projects: string[] } }
interface LayeredState<N extends GraphNode, L extends GraphLink, R extends { id: string }> { nodes: N[]; links: L[]; resources: R[]; todos: readonly { nodeIds: readonly string[] }[] }

/** Below the map, directly or through its project, and not archived; one pass over the projects keeps it linear. */
function belowTest(nodes: readonly GraphNode[]) {
  const projects = new Map(nodes.filter(node => !node.resourceId).map(node => [node.id, node]));
  return (node: GraphNode) => { const project = node.projectId ? projects.get(node.projectId) : undefined; return !node.archivedAt && !project?.archivedAt && Boolean(node.belowAt || project?.belowAt); };
}

/** The nodes a layer draws. The map: everything not below and not hidden. Below: what lies there and the projects
 * that hold it, as orientation. A map with nothing below or hidden is returned as it is. */
export function layerNodes<N extends GraphNode>(nodes: readonly N[], layer: MapLayer): readonly N[] {
  const below = belowTest(nodes);
  if (layer === 'map') return nodes.some(node => node.hiddenAt || below(node)) ? nodes.filter(node => !below(node) && !node.hiddenAt) : nodes;
  const projects = new Set(nodes.filter(below).map(node => node.projectId));
  return nodes.filter(node => below(node) || (!node.resourceId && projects.has(node.id) && !node.archivedAt));
}

/** How many items lie below and which projects the Undermap draws. */
export function belowSummary(nodes: readonly GraphNode[]): LayerSummary['below'] {
  const below = belowTest(nodes);
  return { items: nodes.filter(node => node.resourceId && below(node)).length, projects: layerNodes(nodes, 'below').filter(node => !node.resourceId).map(node => node.id).sort() };
}

/** The workspace as a subscriber on one layer receives it. The map leaves out the items below except those a node it keeps
 * links to or a to-do holds, so links, related items and to-do rows read as before; projects, hidden and archived items stay.
 * Resources and links follow the kept nodes. Below, the whole workspace is sent: Needs me, the badge, notifications and
 * the to-do list keep counting the map there. */
export function presentLayer<N extends GraphNode, L extends GraphLink, R extends { id: string }, S extends LayeredState<N, L, R>>(state: S, layer: MapLayer): { state: S; layers: LayerSummary } {
  if (![state.nodes, state.links, state.resources, state.todos].every(Array.isArray)) return { state, layers: { below: { items: 0, projects: [] } } };
  const layers = { below: belowSummary(state.nodes) };
  if (layer === 'below' || !layers.below.items) return { state, layers };
  const below = belowTest(state.nodes), kept = new Set(state.nodes.filter(node => !node.resourceId || !below(node)).map(node => node.id));
  const reached = new Set(state.todos.flatMap(todo => todo.nodeIds));
  for (const link of state.links) {
    if (kept.has(link.sourceId)) reached.add(link.targetId);
    if (kept.has(link.targetId)) reached.add(link.sourceId);
  }
  for (const id of reached) kept.add(id);
  const nodes = state.nodes.filter(node => kept.has(node.id)), used = new Set(nodes.map(node => node.resourceId));
  return { state: { ...state, nodes, resources: state.resources.filter(resource => used.has(resource.id)), links: state.links.filter(link => kept.has(link.sourceId) && kept.has(link.targetId)) }, layers };
}
