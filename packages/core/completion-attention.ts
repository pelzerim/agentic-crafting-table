import type { GraphNode } from '../../src/graph/graph.ts';
import type { WorkspaceCommand } from './control.ts';

/** Stable producer event IDs make completion replay/reconnect idempotent. The note
 * is the short Needs me reason, e.g. "Agent finished". */
export function completionAttention(node: GraphNode, eventId: string, note: string): WorkspaceCommand[] {
  return node.attentionEvents?.completion === eventId ? [] : [
    { type: 'attention.set', id: node.id, source: 'completion', reason: 'finished', note, eventId },
  ];
}
