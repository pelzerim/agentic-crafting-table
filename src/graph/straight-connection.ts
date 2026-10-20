import type { SpatialBox } from './spatial.ts';

/** Clip the center-to-center segment to the displayed item bounds. This follows
 * any arrangement without fixed ports, elbow routing, or persistent graph edits. */
export function straightConnection(source: SpatialBox, target: SpatialBox) {
  const dx = target.x - source.x, dy = target.y - source.y;
  if ((!dx && !dy) || ![source, target].every(box => box.width > 0 && box.height > 0
    && [box.x, box.y, box.width, box.height].every(Number.isFinite))) return undefined;
  const exit = (box: SpatialBox) => 1 / Math.max(Math.abs(dx) / (box.width / 2), Math.abs(dy) / (box.height / 2));
  const from = exit(source), to = 1 - exit(target);
  // Overlapping/touching items have no exposed segment; don't reverse the arrow.
  if (from >= to) return undefined;
  return { source: { x: source.x + dx * from, y: source.y + dy * from }, target: { x: source.x + dx * to, y: source.y + dy * to } };
}
