import type { GitHubComment, GitHubReview } from '../../../../packages/provider-runtime/github.ts';

export type PullComment = { id: number; kind: 'discussion' | 'inline' | 'review'; body: string; author: string; date: string; reviewState?: string; headSha?: string; authorType?: string; replyToId?: number; path?: string; line?: number }
/** Retain a bounded recent conversation with explicit coverage. Comment IDs use
 * separate GitHub namespaces; never deduplicate an inline comment by issue ID. */
export function pullDiscussion(comments: GitHubComment[], inline: GitHubComment[], reviews: GitHubReview[]) {
  const all: PullComment[] = [
    ...comments.map(value => ({ id: value.id, kind: 'discussion' as const, body: value.body, author: value.user?.login ?? 'Deleted user', authorType: value.user?.type, date: value.created_at })),
    ...inline.map(value => ({ id: value.id, kind: 'inline' as const, replyToId: value.in_reply_to_id, path: value.path, line: value.line ?? value.original_line ?? undefined, body: value.body, author: value.user?.login ?? 'Deleted user', authorType: value.user?.type, date: value.created_at })),
    ...reviews.filter(value => value.body?.trim() || ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(value.state)).map(value => ({ id: value.id, kind: 'review' as const, body: value.body ?? '', reviewState: value.state, headSha: value.commit_id ?? undefined, author: value.user?.login ?? 'Deleted user', authorType: value.user?.type, date: value.submitted_at ?? '' })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id || a.kind.localeCompare(b.kind));
  const discussion: PullComment[] = [], encoder = new TextEncoder(); let bytes = 0;
  for (const entry of all.reverse()) {
    const size = encoder.encode(JSON.stringify(entry)).length;
    if (discussion.length >= 100 || bytes + size > 1024 * 1024) break;
    discussion.push(entry); bytes += size;
  }
  return { discussion: discussion.reverse(), discussionTotal: all.length };
}

export interface ConversationVisibility { comments: boolean; threads: boolean; reviewBodies: boolean; bots: boolean; activity: boolean }
export const DEFAULT_CONVERSATION: ConversationVisibility = { comments: true, threads: true, reviewBodies: true, bots: false, activity: false };
/** Old cached snapshots lack authorType; GitHub's bot suffix remains recognizable. */
export function visibleComments(comments: PullComment[], visibility: ConversationVisibility): PullComment[] {
  return comments.filter(comment => {
    const automated = comment.authorType === 'Bot' || /\[bot\]$/i.test(comment.author) || /^(github-actions|dependabot|renovate)$/i.test(comment.author);
    if (automated && !visibility.bots) return false;
    if (comment.kind === 'review') return comment.body.trim() ? visibility.reviewBodies : visibility.activity;
    return comment.kind === 'inline' ? visibility.threads : visibility.comments;
  });
}

/** Group only provider-declared inline relationships, including hidden/missing roots. */
export function conversationThreads(visible: PullComment[], all: PullComment[]) {
  const inline = new Map(all.filter(c => c.kind === 'inline').map(c => [c.id, c]));
  const groups = new Map<string, { key: string; rootId?: number; comments: PullComment[]; hiddenRoot?: PullComment }>();
  for (const comment of visible) {
    let rootId = comment.kind === 'inline' ? comment.id : undefined;
    const visited = new Set<number>();
    while (rootId !== undefined && inline.get(rootId)?.replyToId && !visited.has(rootId)) {
      visited.add(rootId); rootId = inline.get(rootId)!.replyToId;
    }
    const key = `${comment.kind}:${rootId ?? comment.id}`;
    const group = groups.get(key) ?? { key, rootId, comments: [] };
    group.comments.push(comment); groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.comments.sort((a, b) => Number(b.id === group.rootId) - Number(a.id === group.rootId) || a.date.localeCompare(b.date) || a.id - b.id);
    if (group.rootId && !group.comments.some(c => c.id === group.rootId)) group.hiddenRoot = inline.get(group.rootId);
  }
  return [...groups.values()].sort((a, b) => {
    const latest = (g: typeof a) => g.comments.reduce((date, c) => c.date > date ? c.date : date, '');
    return latest(b).localeCompare(latest(a)) || a.key.localeCompare(b.key);
  });
}

export function commentPreview(text: string, limit = 180) {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  return characters.slice(0, limit).join('') + (characters.length > limit ? '…' : '');
}
