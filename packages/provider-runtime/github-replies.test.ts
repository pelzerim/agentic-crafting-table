import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from './github.ts';
import { githubCommentTransport } from './github-transport.ts';
const identity = { owner: 'fixture', repo: 'repo', number: 42 }, signal = () => AbortSignal.timeout(1000);
const comment = { id: 2, in_reply_to_id: 1, body: 'Please fix this', user: { login: 'reviewer' }, created_at: '2026-09-28', updated_at: '2026-09-28' };
test('comment replies validate ownership, use root inline thread and canonical discussion link', async () => {
  const posts: { path: string; body: string }[] = [];
  const client = new GitHubClient({ async get() { return { status: 200, headers: new Headers(), body: [comment] }; }, async postComment(path, body) { posts.push({ path, body }); return { status: 201, headers: new Headers(), body: { ...comment, id: 3, body } }; } });
  await client.reply(identity, 'inline', 2, 'Fixed', signal());
  assert.equal(posts[0].path, '/repos/fixture/repo/pulls/42/comments/1/replies');
  await client.reply(identity, 'discussion', 2, 'Thanks', signal());
  assert.equal(posts[1].path, '/repos/fixture/repo/issues/42/comments');
  assert.match(posts[1].body, /pull\/42#issuecomment-2\n\nThanks/);
  await assert.rejects(client.reply(identity, 'inline', 999, 'No', signal()), /no longer available/);
  assert.equal(posts.length, 2);
});
test('uncertain reply responses cannot be treated as safe failures', async () => {
  const client = new GitHubClient({ async get() { return { status: 200, headers: new Headers(), body: [comment] }; }, async postComment() { return { status: 502, headers: new Headers(), body: null }; } });
  await assert.rejects(client.reply(identity, 'inline', 2, 'Fixed', signal()), (error: any) => error.outcomeUnknown === true);
});
test('comment transport allows only comment writes and sends the supplied text', async () => {
  const requests: RequestInit[] = [];
  const transport = githubCommentTransport('fixture', { token: async () => 'fixture-token', accounts: async () => [] }, async (_url, init) => { requests.push(init!); return new Response(JSON.stringify(comment), { status: 201 }); });
  await transport.postComment!('/repos/fixture/repo/pulls/42/comments/1/replies', 'Unicode ✓ reply', signal());
  assert.equal(requests[0].body, JSON.stringify({ body: 'Unicode ✓ reply' }));
  await assert.rejects(transport.postComment!('/repos/fixture/repo/pulls/42/merge', 'No', signal()), /Unsupported/);
  await assert.rejects(transport.postComment!('/repos/fixture/repo/actions/runs/42/approve', 'No', signal()), /Unsupported/);
  assert.equal(requests.length, 1);
});
