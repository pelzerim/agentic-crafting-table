/** How old a quiet agent session looks on the map (MAP-33): cracks after one, two and four weeks without activity. */
const WEEK = 7 * 86_400_000;
const LEVEL_WEEKS = [1, 2, 4] as const;
export type CrackLevel = 0 | 1 | 2 | 3;

type Quiet = { activity?: string; activityAt?: string; turnEndedAt?: string };

/** Milliseconds since the session last did anything we know of; undefined when nothing dated is known. */
function quietFor(node: Quiet, now: number): number | undefined {
  if (node.activity === 'working') return undefined;
  const last = Math.max(...[node.activityAt, node.turnEndedAt].map(at => Date.parse(at ?? '')).filter(Number.isFinite));
  return Number.isFinite(last) && now >= last ? now - last : undefined;
}

export function crackLevel(node: Quiet, now: number): CrackLevel {
  const quiet = quietFor(node, now);
  if (quiet === undefined) return 0;
  return LEVEL_WEEKS.reduce<CrackLevel>((level, weeks, index) => quiet >= weeks * WEEK ? (index + 1) as CrackLevel : level, 0);
}

/** Tooltip and accessible name for a cracked card; undefined while it has no cracks. */
export function crackLabel(node: Quiet, now: number): string | undefined {
  if (!crackLevel(node, now)) return undefined;
  const weeks = Math.floor(quietFor(node, now)! / WEEK);
  return `Quiet for ${weeks} week${weeks === 1 ? '' : 's'}`;
}

/** One crack: where it starts on the card's edge (as fractions of width and height), then its zigzag and an optional
 * branch in layout pixels from there. Pixel lengths keep every crack small and at the edge whatever the card's size. */
type Crack = { from: readonly [number, number]; path: readonly (readonly [number, number])[]; branch?: readonly (readonly [number, number])[] };

/** The cracks each level adds; a level keeps the cracks before it. */
export const CRACKS: readonly (readonly Crack[])[] = [
  [{ from: [.8, 0], path: [[2, 4], [-1, 8], [2, 13]], branch: [[2, 4], [6, 6]] }],
  [{ from: [0, .68], path: [[4, 1], [7, -2], [12, 0], [15, -2]], branch: [[7, -2], [9, -6]] },
    { from: [.3, 1], path: [[1, -4], [-2, -7], [0, -11]] }],
  [{ from: [1, .38], path: [[-4, 1], [-7, 4], [-12, 3], [-15, 6]], branch: [[-7, 4], [-8, 9]] },
    { from: [.14, 0], path: [[-1, 4], [2, 7], [1, 11]] },
    { from: [.88, 1], path: [[-2, -3], [1, -7], [-1, -11], [2, -14]], branch: [[1, -7], [5, -9]] }],
];

/** SVG path data for the cracks of `level` on a card of `width` × `height` layout pixels. */
export function crackPaths(level: number, width: number, height: number): string[] {
  return CRACKS.slice(0, level).flat().flatMap(crack => {
    const x = Math.round(crack.from[0] * width), y = Math.round(crack.from[1] * height);
    const line = (points: readonly (readonly [number, number])[], begin: readonly [number, number]) => `M${begin[0]} ${begin[1]}${points.map(([dx, dy]) => ` L${x + dx} ${y + dy}`).join('')}`;
    return [line(crack.path, [x, y]), ...crack.branch ? [line(crack.branch.slice(1), [x + crack.branch[0][0], y + crack.branch[0][1]])] : []];
  });
}
