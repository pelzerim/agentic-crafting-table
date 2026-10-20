import type { PullComment } from './discussion.ts';
export const commentKey = (comment: Pick<PullComment, 'kind' | 'id'>) => `${comment.kind}:${comment.id}`;
export const commentVersion = (comment: PullComment) => JSON.stringify([comment.body, comment.reviewState ?? '', comment.headSha ?? '']);
export function commentUrl(url: string, comment: Pick<PullComment, 'kind' | 'id'>) {
  return `${url}#${comment.kind === 'inline' ? 'discussion_r' : comment.kind === 'review' ? 'pullrequestreview-' : 'issuecomment-'}${comment.id}`;
}
