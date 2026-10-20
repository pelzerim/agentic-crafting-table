import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullDiscussion } from './discussion.ts';
const comment = { id: 1, body: '**Keep Markdown**', user: { login: 'reviewer' }, created_at: '2026-09-27', updated_at: '2026-09-27' };
test('PR conversation retains discussion, inline comments and review bodies with their own identities', () => {
  const value = pullDiscussion([{ ...comment, created_at: '2026-09-28' }], [{ ...comment, user: null }], [
    { id: 1, body: 'Review body', user: comment.user, state: 'APPROVED', submitted_at: '2026-09-29', commit_id: null },
    { id: 2, body: '', user: null, state: 'COMMENTED', submitted_at: null, commit_id: null },
  ]);
  assert.equal(value.discussionTotal, 3);
  assert.deepEqual(value.discussion.map(entry => entry.kind), ['inline', 'discussion', 'review']);
  assert.equal(value.discussion[0].author, 'Deleted user');
  assert.equal(value.discussion[1].body, comment.body);
});
test('large PR conversations retain recent whole comments within the count and encoded-byte budget', () => {
  const comments = Array.from({ length: 150 }, (_, id) => ({ ...comment, id: id + 1 }));
  const value = pullDiscussion(comments, [], []);
  assert.equal(value.discussionTotal, 150); assert.equal(value.discussion.length, 100);
  assert.equal(value.discussion[0].id, 51); assert.equal(value.discussion.at(-1)!.id, 150);
  const unicode = pullDiscussion(comments.map(entry => ({ ...entry, body: '🪵'.repeat(30_000) })), [], []);
  assert.equal(unicode.discussionTotal, 150); assert.ok(unicode.discussion.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) < 1024 * 1024);
  assert.equal(unicode.discussion.at(-1)!.id, 150);
  assert.deepEqual(pullDiscussion([], [], []), { discussion: [], discussionTotal: 0 });
});

test('bodyless approvals and change requests retain state and revision, without fabricating review text', () => {
  const result = pullDiscussion([], [], ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].map((state, id) => ({ id, state, body: '', user: null, submitted_at: null, commit_id: 'head' })));
  assert.equal(result.discussionTotal, 3);
  assert.deepEqual(result.discussion.map(entry => [entry.reviewState, entry.headSha, entry.body]), [['APPROVED', 'head', ''], ['CHANGES_REQUESTED', 'head', ''], ['DISMISSED', 'head', '']]);
});

import { DEFAULT_CONVERSATION, visibleComments } from './discussion.ts';
import { settingsSchema } from '../../../../packages/core/settings.ts';
test('default PR conversation hides bots and empty review events but keeps human comments and thread replies', () => {
  const result = pullDiscussion([
    comment, { ...comment, id: 2, user: { login: 'automation-app', type: 'Bot' } },
    { ...comment, id: 3, user: { login: 'github-actions[bot]' } },
  ], [{ ...comment, id: 4, in_reply_to_id: 10 }], [
    { id: 5, state: 'APPROVED', body: '', user: comment.user, submitted_at: '', commit_id: null },
    { id: 6, state: 'APPROVED', body: 'Please retain this substantive feedback.', user: comment.user, submitted_at: '', commit_id: null },
  ]);
  assert.equal(result.discussion.find(c => c.id === 2)?.authorType, 'Bot');
  assert.equal(result.discussion.find(c => c.id === 4)?.replyToId, 10);
  assert.deepEqual(visibleComments(result.discussion, DEFAULT_CONVERSATION).map(c => c.id).sort(), [1, 4, 6]);
  assert.equal(visibleComments(result.discussion, { ...DEFAULT_CONVERSATION, bots: true, activity: true }).length, 6);
  assert.equal(visibleComments(result.discussion, { ...DEFAULT_CONVERSATION, comments: false, threads: false, reviewBodies: false }).length, 0);
  assert.deepEqual(settingsSchema.parse({}).pullRequestConversation, DEFAULT_CONVERSATION);
});

import { conversationThreads, commentPreview, type PullComment } from './discussion.ts';
test('threads preserve provider parents, latest activity order, chronological replies and hidden-root context', () => {
  const make = (id: number, date: string, replyToId?: number): PullComment => ({ id, date, replyToId, kind: 'inline', author: 'Reviewer', body: 'Text' });
  const all = [make(1, '01'), make(2, '02'), make(3, '04', 1), make(4, '03', 1), make(5, '05', 99)];
  assert.deepEqual(conversationThreads(all, all).map(g => g.comments.map(c => c.id)), [[5], [1, 4, 3], [2]]);
  const hidden = conversationThreads(all.slice(1), all).find(g => g.rootId === 1)!;
  assert.equal(hidden.hiddenRoot?.id, 1); assert.deepEqual(hidden.comments.map(c => c.id), [4, 3]);
  assert.equal(conversationThreads([{ ...all[0], kind: 'discussion' }, all[0]], all).length, 2);
});
test('plain comment previews normalize spacing and truncate code points without breaking emoji', () => {
  assert.equal(commentPreview('  Hello\n world  '), 'Hello world');
  assert.equal(commentPreview('🪵'.repeat(181)), '🪵'.repeat(180) + '…');
  assert.equal(commentPreview('🪵'.repeat(180)), '🪵'.repeat(180));
});
test('inline source locations survive projection, including outdated line locations', () => {
  const result = pullDiscussion([], [{ ...comment, path: 'src/billing.ts', line: null, original_line: 42 }], []);
  assert.equal(result.discussion[0].path, 'src/billing.ts'); assert.equal(result.discussion[0].line, 42);
});
