import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, INBOX_QUERIES, inboxPath } from './github.ts';
import { githubTransport } from './github-transport.ts';

const item = (repo: string, number: number, extra: object = {}) => ({ number, title: `PR ${number}`, html_url: `https://github.com/${repo}/pull/${number}`, repository_url: `https://api.github.com/repos/${repo}`, user: { login: 'author' }, updated_at: `2026-09-2${number % 9}T10:00:00Z`, draft: false, comments: 2, pull_request: { url: 'x' }, ...extra });
export function inboxResponses(): Record<string, unknown[]> {
  return { review: [item('acme/app', 1), item('acme/app', 2, { draft: true })], assigned: [item('acme/app', 1)], authored: [item('acme/api', 7)], mentioned: [item('acme/app', 3, { pull_request: undefined })] };
}

test('the inbox merges review, assigned, authored and mentioned PRs with their reasons, newest first', async () => {
  const responses = inboxResponses(), paths: string[] = [];
  const client = new GitHubClient({ async get(path) {
    paths.push(path);
    const reason = (Object.keys(INBOX_QUERIES) as (keyof typeof INBOX_QUERIES)[]).find(key => inboxPath(key) === path)!;
    return { status: 200, headers: new Headers(), body: { items: responses[reason] } };
  } });
  const inbox = await client.inbox(AbortSignal.timeout(1000));
  assert.deepEqual(paths.map(path => decodeURIComponent(path)), Object.values(INBOX_QUERIES).map(query => `/search/issues?q=${query}&sort=updated&order=desc&per_page=50`));
  assert.deepEqual(inbox.map(pull => [pull.key, pull.reasons]), [['acme/api/pull/7', ['authored']], ['acme/app/pull/2', ['review']], ['acme/app/pull/1', ['review', 'assigned']]]);
  assert.equal(inbox[1].draft, true); assert.equal(inbox[2].url, 'https://github.com/acme/app/pull/1');
  assert.ok(!inbox.some(pull => pull.number === 3), 'issues are not pull requests');
});

test('the transport allows only the four fixed inbox searches', async () => {
  let requests = 0;
  const transport = githubTransport('reviewer', { async accounts() { return []; }, async token() { return 'fake'; } }, async () => { requests++; return Response.json({ items: [] }); });
  for (const reason of Object.keys(INBOX_QUERIES) as (keyof typeof INBOX_QUERIES)[]) await transport.get(inboxPath(reason), AbortSignal.timeout(1000));
  assert.equal(requests, 4);
  for (const path of ['/search/issues?q=repo%3Aacme%2Fsecret&sort=updated&order=desc&per_page=50', '/search/code?q=token', `${inboxPath('review')}&page=2`]) await assert.rejects(transport.get(path, AbortSignal.timeout(1000)), /Unsupported/);
  assert.equal(requests, 4);
});
