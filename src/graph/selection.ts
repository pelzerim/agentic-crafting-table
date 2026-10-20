import type { GraphNode } from './graph.ts';
import type { MoveIntent } from './movement.ts';

/** A selected project's members translate once through the shared mover. */
export function selectionMoves(nodes: readonly GraphNode[], ids: readonly string[], anchorId: string, position: GraphNode['position']): MoveIntent[] {
  const anchor = nodes.find(node => node.id === anchorId);
  if (!anchor) return [];
  const selected = new Set(ids.includes(anchorId) ? ids : [anchorId]);
  return nodes.filter(node => selected.has(node.id) && !(node.projectId && selected.has(node.projectId)))
    .map(node => ({ id: node.id, position: { x: node.position.x + position.x - anchor.position.x, y: node.position.y + position.y - anchor.position.y } }));
}
