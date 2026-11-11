import { createHash } from 'node:crypto';
import type { PresentationHooks } from '../../../../packages/plugin-sdk/host.ts';
import type { SqliteStore } from '../../../../packages/workspace-service/sqlite-store.ts';
import type { ResourceRecord, ResourceSnapshot } from '../../types.ts';
import { unreadCommentsIndicator } from '../../indicators.ts';
import { visibleComments, type PullComment } from './discussion.ts';
import { commentKey, commentVersion } from './comment-state.ts';

export const commentReceiptFingerprint = (resource: ResourceRecord) => JSON.stringify([resource.connectionId, resource.data.owner, resource.data.repo, resource.data.number]);
export const commentDigest = (comment: PullComment) => createHash('sha256').update(commentVersion(comment)).digest('hex');

/** Unseen comments (under the saved conversation filters) keyed by comment and content version. */
function unseenPullComments(resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore) {
  const comments = (snapshot.detail?.discussion ?? []) as unknown as PullComment[];
  const receipts = (store.resourceCache(resource.id, 'comment-seen', commentReceiptFingerprint(resource))?.value ?? {}) as Record<string, string>;
  const me = typeof snapshot.detail?.viewer === 'string' ? snapshot.detail.viewer.toLowerCase() : undefined;
  return visibleComments(comments, store.readSettings().value.pullRequestConversation).filter(comment => comment.author.toLowerCase() !== me && receipts[commentKey(comment)] !== commentDigest(comment))
    .map(comment => `${commentKey(comment)}:${commentDigest(comment)}`);
}

/** Local overlays for a PR: the unseen-comment badge, and new comments entering Needs me once
 * each (edits count again). Marking some seen never re-alerts the rest; marking all seen clears
 * it. A PR's first observation only records existing comments, so attaching never floods Needs me. */
export const pullRequestPresentation: PresentationHooks = {
  indicators(resource, snapshot, store) {
    const indicators = (snapshot.indicators ?? []).filter(cue => cue.id !== 'comments');
    const count = unseenPullComments(resource, snapshot, store).length;
    if (count) indicators.push(unreadCommentsIndicator(count, 'unseen'));
    return indicators;
  },
  attention(resource, snapshot, store) {
    if (!Array.isArray(snapshot.detail?.discussion)) return undefined;
    const unseen = unseenPullComments(resource, snapshot, store), key = commentReceiptFingerprint(resource);
    const record = store.resourceCache(resource.id, 'comment-alerted', key)?.value as string[] | undefined, alerted = new Set(record ?? []);
    const fresh = unseen.filter(entry => !alerted.has(entry));
    if (fresh.length || !record) store.cacheResource(resource.id, 'comment-alerted', key, [...new Set([...(record ?? []), ...unseen])].slice(-2000), Date.now());
    if (!unseen.length) return { source: 'pr.comments', reason: null };
    if (!record || !fresh.length) return undefined;
    return { source: 'pr.comments', reason: 'comment', note: fresh.length === 1 ? '1 new comment' : `${fresh.length} new comments`, eventId: createHash('sha256').update(fresh.sort().join('\n')).digest('hex') };
  },
};
