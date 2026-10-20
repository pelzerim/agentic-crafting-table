/** How a plugin names its pipeline (PRs) or tally (tickets) on far-zoom dashboards. */
export interface PipelineName { singular: string; plural: string }

export function activityAge(at: string | undefined, now: number) {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return minutes < 1 ? 'active just now' : minutes < 60 ? `active ${minutes}m ago` : minutes < 24 * 60 ? `active ${Math.floor(minutes / 60)}h ago` : `active ${Math.floor(minutes / 1440)}d ago`;
}
