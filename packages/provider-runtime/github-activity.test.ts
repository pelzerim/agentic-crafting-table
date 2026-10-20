import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, activityPath } from './github.ts';
import { githubTransport } from './github-transport.ts';

const item = (repo: string, number: number, updated: string, extra: object = {}) => ({ number, title: `PR ${number}`, html_url: `https://github.com/${repo}/pull/${number}`, repository_url: `https://api.github.com/repos/${repo}`, user: { login: 'me' }, updated_at: updated, pull_request: {}, ...extra });

test('activity reads PRs I authored or reviewed in the range, merged per PR with their reasons, newest first', async () => {
  const paths: string[] = [];
  const client = new GitHubClient({ async get(path) {
    paths.push(path);
    const items = path === activityPath('author', '2026-10-11', '2026-10-12') ? [item('acme/billing', 7, '2026-10-12T10:00:00Z'), item('acme/billing', 3, '2026-10-11T10:00:00Z', { pull_request: undefined })]
      : [item('acme/billing', 7, '2026-10-12T10:00:00Z'), item('acme/platform', 9, '2026-10-12T12:00:00Z')];
    return { status: 200, headers: new Headers(), body: { items } };
  } });
  const pulls = await client.activity('2026-10-11', '2026-10-12', AbortSignal.timeout(1000));
  assert.deepEqual(paths.map(path => decodeURIComponent(path)), ['author', 'reviewed-by'].map(reason => `/search/issues?q=is:pr ${reason}:@me updated:2026-10-11..2026-10-12&sort=updated&order=desc&per_page=50`));
  assert.deepEqual(pulls.map(pull => [pull.key, pull.reasons]), [['acme/platform/pull/9', ['reviewed']], ['acme/billing/pull/7', ['authored', 'reviewed']]]);
  assert.throws(() => activityPath('author', '2026-10-11', 'x' as string), /date/);
});

test('the transport allows the fixed activity searches and PR commits, read only', async () => {
  const requests: { url: string; method?: string }[] = [];
  const transport = githubTransport('me', { async accounts() { return []; }, async token() { return 'fake'; } }, async (url, init) => { requests.push({ url: String(url), method: init?.method }); return Response.json({ items: [] }); });
  await transport.get(activityPath('author', '2026-10-05', '2026-10-11'), AbortSignal.timeout(1000));
  await transport.get(activityPath('reviewed-by', '2026-10-05', '2026-10-11'), AbortSignal.timeout(1000));
  await transport.get('/repos/acme/billing/pulls/7/commits?per_page=100&page=1', AbortSignal.timeout(1000));
  assert.equal(requests.length, 3); assert.ok(requests.every(request => request.method === 'GET'));
  for (const path of [activityPath('author', '2026-10-05', '2026-10-11').replace('author', 'involves'), activityPath('author', '2026-10-05', '2026-10-11') + '&page=2',
    '/search/issues?q=is%3Apr%20author%3Asomeone%20updated%3A2026-10-05..2026-10-11&sort=updated&order=desc&per_page=50', '/repos/acme/billing/commits']) await assert.rejects(transport.get(path, AbortSignal.timeout(1000)), /Unsupported/);
});

test('commits of a PR are read page by page with their messages and dates', async () => {
  const client = new GitHubClient({ async get(path) {
    assert.equal(path, '/repos/acme/billing/pulls/7/commits?per_page=100&page=1');
    return { status: 200, headers: new Headers(), body: [{ sha: 'a'.repeat(40), commit: { message: 'fix: round cart totals', author: { date: '2026-10-12T09:00:00Z' }, committer: { date: '2026-10-12T09:05:00Z' } } }] };
  } });
  assert.deepEqual(await client.commits({ owner: 'acme', repo: 'billing', number: 7 }, AbortSignal.timeout(1000)), [{ sha: 'a'.repeat(40), message: 'fix: round cart totals', date: '2026-10-12T09:05:00Z' }]);
});
