import type { Badge } from '../../../src/graph/badges.ts';

/** An item's note badges as small paper chips beside its name in a list row (Needs me, dashboards). */
export function BadgeChips({ badges }: { badges?: readonly Badge[] }) {
  if (!badges?.length) return null;
  return <span className="badge-chips">{badges.map(badge => <span key={badge.noteId} className="badge-chip" data-paper={badge.paper}>{badge.text}</span>)}</span>;
}
