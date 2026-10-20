import { BaseEdge, useInternalNode } from '@xyflow/react';
import type { EdgeProps, InternalNode } from '@xyflow/react';
import { straightConnection } from '../../../src/graph/straight-connection.ts';

function bounds(node: InternalNode) {
  const width = node.measured.width ?? node.width ?? 0, height = node.measured.height ?? node.height ?? 0;
  return { id: node.id, x: node.internals.positionAbsolute.x + width / 2, y: node.internals.positionAbsolute.y + height / 2, width, height };
}

/** Subscribe only to the two endpoints. Pan doesn't recalculate world geometry;
 * movement, semantic zoom and completion follow the actual displayed dimensions. */
function DirectEdge({ id, source, target, markerStart, markerEnd, style, interactionWidth, data }: EdgeProps) {
  const from = useInternalNode(source), to = useInternalNode(target);
  const line = from && to && straightConnection(bounds(from), bounds(to));
  if (!line) return null;
  const edge = <BaseEdge id={id} path={`M ${line.source.x},${line.source.y} L ${line.target.x},${line.target.y}`}
    markerStart={markerStart} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />;
  if (!data?.stop) return edge;
  // A blocking link ends in a stop bar across the line at the blocked item.
  const dx = line.target.x - line.source.x, dy = line.target.y - line.source.y, length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length, x = line.target.x - ux * 3, y = line.target.y - uy * 3;
  // A chevron at the middle points from blocker to blocked.
  const mx = (line.source.x + line.target.x) / 2, my = (line.source.y + line.target.y) / 2;
  const chevron = `M ${mx - ux * 4 - uy * 5},${my - uy * 4 + ux * 5} L ${mx + ux * 4},${my + uy * 4} L ${mx - ux * 4 + uy * 5},${my - uy * 4 - ux * 5}`;
  return <>{edge}<path className="blocks-chevron" d={chevron} /><path className="blocks-stop" d={`M ${x - uy * 7},${y + ux * 7} L ${x + uy * 7},${y - ux * 7}`} /></>;
}

export const edgeTypes = { direct: DirectEdge };
