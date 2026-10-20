export interface PullRequestSnapshot {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  assignees: readonly string[];
  state: 'open' | 'closed' | 'merged';
}

export interface AssignedPullRequest {
  /** Store each connected account's attention state independently. */
  accountId: string;
  pr: PullRequestSnapshot;
  projectId?: string;
  /** Provider sync metadata, not a separate user-facing category. */
  assigned: boolean;
  /** Feeds the shared Needs me state alongside agents waiting for input. */
  needsMe: boolean;
  assignedAt: string;
  viewedAt?: string;
}

/** Call only after a complete, successful, paginated discovery snapshot. */
export function reconcileAssignments(
  previous: readonly AssignedPullRequest[],
  account: { id: string; login: string },
  snapshots: readonly PullRequestSnapshot[],
  projects: readonly { id: string; repository: string }[],
  now: string,
): AssignedPullRequest[] {
  const incoming = new Map(snapshots.map(pr => [pr.id, pr]));
  const oldEntries = new Map(previous.filter(e => e.accountId === account.id).map(e => [e.pr.id, e]));
  const result = previous.filter(e => e.accountId !== account.id);
  for (const id of new Set([...oldEntries.keys(), ...incoming.keys()])) {
    const old = oldEntries.get(id);
    const pr = incoming.get(id) ?? old!.pr;
    const assigned = incoming.has(id) && pr.state === 'open'
      && pr.assignees.some(login => login.toLowerCase() === account.login.toLowerCase());
    if (!assigned && !old) continue;
    const matches = projects.filter(project => project.repository.toLowerCase() === pr.repository.toLowerCase());
    const projectId = old?.projectId ?? (matches.length === 1 ? matches[0].id : undefined);
    result.push({
      accountId: account.id, pr, projectId, assigned,
      needsMe: assigned && (!old?.assigned || old.needsMe),
      assignedAt: assigned && !old?.assigned ? now : old!.assignedAt,
      viewedAt: assigned && !old?.assigned ? undefined : old?.viewedAt,
    });
  }
  return result;
}

/** Called after the PR detail successfully opens, never on hover or discovery. */
export function markPullRequestViewed(
  entries: readonly AssignedPullRequest[], accountId: string, prId: string, now: string,
): AssignedPullRequest[] {
  if (!entries.some(e => e.accountId === accountId && e.pr.id === prId)) throw new Error('Unknown inbox item');
  return entries.map(entry => entry.accountId === accountId && entry.pr.id === prId
    ? { ...entry, needsMe: false, viewedAt: now } : entry);
}
