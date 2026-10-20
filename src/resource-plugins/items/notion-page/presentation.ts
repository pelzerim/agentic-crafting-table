import { createHash } from 'node:crypto';
import type { PresentationHooks } from '../../../../packages/plugin-sdk/host.ts';
import type { SqliteStore } from '../../../../packages/workspace-service/sqlite-store.ts';
import type { ResourceRecord, ResourceSnapshot } from '../../types.ts';
import { unreadCommentsIndicator } from '../../indicators.ts';
import { savedComments, type SavedComment } from './comments.ts';

/** Comments created before `at`, or listed in `ids`, are read. `at` is a whole minute because
 * Notion reports comment times to the minute; comments of that minute are told apart by id. */
export interface CommentWatermark { at: string; ids: string[] }
export const commentWatermarkKey = (resource: ResourceRecord) => JSON.stringify([resource.connectionId, resource.data.pageId]);
const WATERMARK = 'comment-watermark', ALERTED = 'comment-alerted';
const minute = (time: number) => new Date(Math.floor(time / 60_000) * 60_000).toISOString();

/** Everything visible at `time` is read; later comments of the same minute are still unread. */
export function watermarkAt(comments: readonly SavedComment[], time: number, previous?: CommentWatermark): CommentWatermark {
  const at = minute(time), from = Date.parse(at);
  const ids = comments.filter(comment => Date.parse(comment.at) >= from).map(comment => comment.id);
  return { at, ids: [...new Set([...(previous?.at === at ? previous.ids : []), ...ids])].slice(-500) };
}

/** The saved watermark; the first observation of a page's comments records the existing ones as read. */
function watermark(resource: ResourceRecord, comments: readonly SavedComment[], observedAt: string, store: SqliteStore): CommentWatermark {
  const key = commentWatermarkKey(resource), saved = store.resourceCache(resource.id, WATERMARK, key)?.value as CommentWatermark | undefined;
  if (saved && typeof saved.at === 'string' && Array.isArray(saved.ids)) return saved;
  const initial = watermarkAt(comments, Date.parse(observedAt) || Date.now());
  store.cacheResource(resource.id, WATERMARK, key, initial as never, Date.now());
  return initial;
}

/** Comments by someone else that arrived after the watermark. `me` adds configured identities
 * to the integration's own (the bot, and an OAuth integration's owner). */
export function unreadComments(resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore, me: readonly string[] = []) {
  const saved = savedComments(snapshot.detail?.comments);
  if (!saved?.available) return undefined;
  const mine = new Set([...saved.viewers, ...me]), mark = watermark(resource, saved.items, snapshot.observedAt, store), from = Date.parse(mark.at), read = new Set(mark.ids);
  return saved.items.filter(comment => !mine.has(comment.author) && Date.parse(comment.at) >= from && !read.has(comment.id));
}


/** The unread-comment cue (the shared comment indicator), Needs me once per batch of new comments, and reading on open.
 * Unread state is local: nothing is marked read in Notion. Reading resets only the count;
 * Needs me stays until the person marks the item seen. */
export function notionPagePresentation(me: () => readonly string[] = () => []): PresentationHooks {
  return {
    indicators(resource, snapshot, store) {
      const indicators = (snapshot.indicators ?? []).filter(cue => cue.id !== 'comments');
      const count = unreadComments(resource, snapshot, store, me())?.length ?? 0;
      if (count) indicators.push(unreadCommentsIndicator(count, 'unread', { showLabel: true }));
      return indicators;
    },
    attention(resource, snapshot, store) {
      const unread = unreadComments(resource, snapshot, store, me());
      if (!unread) return undefined;
      const key = commentWatermarkKey(resource), ids = unread.map(comment => comment.id);
      const record = store.resourceCache(resource.id, ALERTED, key)?.value as string[] | undefined, alerted = new Set(record ?? []);
      const fresh = ids.filter(id => !alerted.has(id));
      if (fresh.length) store.cacheResource(resource.id, ALERTED, key, [...new Set([...(record ?? []), ...fresh])].slice(-2000), Date.now());
      if (!fresh.length) return undefined;
      return { source: 'notion.comments', reason: 'comment', note: fresh.length === 1 ? 'New comment' : `${fresh.length} new comments`, eventId: createHash('sha256').update(fresh.sort().join('\n')).digest('hex') };
    },
    opened(resource, snapshot, store, now) {
      const saved = savedComments(snapshot?.detail?.comments);
      if (!saved?.available) return;
      const key = commentWatermarkKey(resource), previous = store.resourceCache(resource.id, WATERMARK, key)?.value as CommentWatermark | undefined;
      store.cacheResource(resource.id, WATERMARK, key, watermarkAt(saved.items, now, previous) as never, now);
    },
  };
}
