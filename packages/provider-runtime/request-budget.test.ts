import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHubClient } from './github.ts';
import { githubCommentTransport, githubTransport } from './github-transport.ts';
import { budgetLine, inBackground, requestBudget, resetRequestBudgets, useValidatorStore, withBudgetLines } from './request-budget.ts';
import { linearTransport } from './linear.ts';
import { linearFixture } from '../../tests/fixtures/linear.ts';

const identity = { owner: 'fixture', repo: 'billing', number: 42 }, signal = () => new AbortController().signal;
const pull = { id: 124, number: 42, title: 'Keep plans predictable', body: null, state: 'open', draft: false, merged: false, user: { login: 'fixture-developer' },
  head: { sha: 'a'.repeat(40), ref: 'plans', repo: { full_name: 'fixture/billing' } }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'fixture/billing' } },
  created_at: '2026-09-25T10:00:00Z', updated_at: '2026-09-25T11:00:00Z', additions: 1, deletions: 1, changed_files: 1 };
const review = (id: number) => ({ id, body: `Review ${id}`, user: { login: 'fixture-reviewer' }, state: 'COMMENTED', submitted_at: '2026-09-25', commit_id: 'a'.repeat(40) });
const credentials = { accounts: async () => [], token: async () => 'fixture-token' };
type Reply = { status?: number; headers?: Record<string, string>; body?: unknown };
/** Strong ETags over each JSON body; If-None-Match with the current tag answers 304. */
function server(route: (path: string) => Reply) {
  const sent: { path: string; ifNoneMatch?: string; ifModifiedSince?: string; status: number }[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url)), path = pathname + search, headers = new Headers(init?.headers), reply = route(path);
    const etag = reply.headers?.etag ?? `"${createHash('sha256').update(JSON.stringify(reply.body)).digest('hex').slice(0, 16)}"`;
    const status = reply.status ?? (headers.get('if-none-match') === etag ? 304 : 200);
    sent.push({ path, ...(headers.get('if-none-match') ? { ifNoneMatch: headers.get('if-none-match')! } : {}), ...(headers.get('if-modified-since') ? { ifModifiedSince: headers.get('if-modified-since')! } : {}), status });
    return status === 304 ? new Response(null, { status, headers: { ...reply.headers, etag } }) : Response.json(reply.body, { status, headers: { etag, ...reply.headers } });
  }) as typeof fetch;
  return { fetcher, sent };
}

test('conditional GETs send the stored ETag and reuse the parsed body on 304', async () => {
  resetRequestBudgets(); useValidatorStore();
  const api = server(() => ({ body: pull, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } }));
  const client = new GitHubClient(githubTransport('etag-reader', credentials, api.fetcher));
  const first = await client.pull(identity, signal()), second = await client.pull(identity, signal());
  assert.deepEqual(second, first);
  assert.equal(api.sent[0].ifNoneMatch, undefined); assert.match(api.sent[1].ifNoneMatch!, /^"/); assert.equal(api.sent[1].status, 304);
  const status = requestBudget('github', 'etag-reader').status();
  assert.equal(status.requests, 2); assert.equal(status.notModified, 1); assert.equal(status.remaining, 4990);
  assert.equal(budgetLine(status), 'GitHub · 4,990/5,000 left · 1 unchanged');
  // Another account never receives this account's validators.
  await new GitHubClient(githubTransport('other-reader', credentials, api.fetcher)).pull(identity, signal());
  assert.equal(api.sent[2].ifNoneMatch, undefined);
});

test('Last-Modified is the fallback validator and a changed body replaces the cached one', async () => {
  resetRequestBudgets(); useValidatorStore();
  let title = pull.title, modified = 'Wed, 30 Sep 2026 08:00:00 GMT';
  const api = server(() => ({ body: { ...pull, title }, headers: { etag: '', 'last-modified': modified } }));
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const since = new Headers(init?.headers).get('if-modified-since');
    if (since === modified) { api.sent.push({ path: new URL(String(url)).pathname, ifModifiedSince: since, status: 304 }); return new Response(null, { status: 304 }); }
    const response = await api.fetcher(url, init); const headers = new Headers(response.headers); headers.delete('etag');
    return new Response(response.body, { status: response.status, headers });
  }) as typeof fetch;
  const client = new GitHubClient(githubTransport('modified-reader', credentials, fetcher));
  await client.pull(identity, signal()); assert.equal((await client.pull(identity, signal())).title, pull.title);
  assert.equal(api.sent.at(-1)?.ifModifiedSince, modified);
  title = 'Retitled'; modified = 'Wed, 30 Sep 2026 09:00:00 GMT';
  assert.equal((await client.pull(identity, signal())).title, 'Retitled');
  assert.equal((await client.pull(identity, signal())).title, 'Retitled');
});

test('paginated reads revalidate every page on its own and follow the cached Link of a 304 page', async () => {
  resetRequestBudgets(); useValidatorStore();
  let pages: unknown[][] = [[review(1)], [review(2)]];
  const api = server(path => {
    const page = Number(/&page=(\d+)/.exec(path)![1]);
    return { body: pages[page - 1] ?? [], headers: page < pages.length ? { link: `<https://api.github.com/repos/fixture/billing/pulls/42/reviews?per_page=100&page=${page + 1}>; rel="next"` } : {} as Record<string, string> };
  });
  const client = new GitHubClient(githubTransport('page-reader', credentials, api.fetcher));
  assert.deepEqual((await client.reviews(identity, signal())).map(entry => entry.id), [1, 2]);
  assert.deepEqual((await client.reviews(identity, signal())).map(entry => entry.id), [1, 2], 'two 304 pages rebuild the full collection');
  assert.deepEqual(api.sent.slice(2).map(entry => entry.status), [304, 304]);
  pages = [[review(1)], [review(2), review(3)]];
  assert.deepEqual((await client.reviews(identity, signal())).map(entry => entry.id), [1, 2, 3], 'an unchanged first page never hides a changed later page');
  assert.deepEqual(api.sent.slice(4).map(entry => entry.status), [304, 200]);
  pages = [[review(1), review(2), review(3)]];
  assert.deepEqual((await client.reviews(identity, signal())).map(entry => entry.id), [1, 2, 3]);
  assert.equal(api.sent.length, 7, 'a first page without a next link ends the read');
});

test('pacing slows below 40%, pauses background below 15% until reset and always admits user reads and writes', async () => {
  let now = 1_000_000; resetRequestBudgets({ now: () => now, sleep: async ms => { now += ms; } }); useValidatorStore();
  let remaining = 3000; const reset = () => String(Math.floor((1_000_000 + 3_600_000) / 1000));
  const api = server(path => path.includes('/comments') ? { status: 201, body: { id: 9, body: 'Thanks', user: { login: 'fixture-developer' }, created_at: '2026-09-30', updated_at: '2026-09-30' } }
    : { body: { ...pull, updated_at: String(remaining) }, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': reset(), 'x-ratelimit-resource': 'core' } });
  const transport = githubCommentTransport('paced-reader', credentials, api.fetcher), client = new GitHubClient(transport, () => now), budget = requestBudget('github', 'paced-reader');
  await inBackground(() => client.pull(identity, signal()));
  assert.equal(budget.level(), 'normal'); assert.equal(budget.backgroundFactor(), 1);
  remaining = 1500; await inBackground(() => client.pull(identity, signal()));
  assert.equal(budget.level(), 'slowed'); assert.equal(budget.backgroundFactor(), 2); assert.equal(budgetLine(budget.status()), 'GitHub · 1,500/5,000 left · background slowed');
  const before = now; await inBackground(() => client.pull(identity, signal()));
  assert.ok(now - before >= 1000, 'slowed background requests keep a wider spacing');
  remaining = 500; await inBackground(() => client.pull(identity, signal()));
  assert.equal(budget.level(), 'paused'); assert.equal(budget.backgroundFactor(), Infinity);
  const sent = api.sent.length;
  await assert.rejects(inBackground(() => client.pull(identity, signal())), (error: Error & { retryAt?: number; code?: string }) => error.code === 'PROVIDER_BUDGET_PAUSED' && error.retryAt === 4_600_000);
  assert.equal(api.sent.length, sent, 'a paused background read sends nothing');
  await client.pull(identity, signal()); assert.equal(api.sent.length, sent + 1, 'a user read still goes out');
  assert.equal((await inBackground(() => transport.postComment!('/repos/fixture/billing/issues/42/comments', 'Thanks', signal()))).status, 201, 'writes are never throttled');
  now = 4_600_001; remaining = 5000;
  assert.equal(budget.level(), 'normal', 'the window reset lifts the pause');
  await inBackground(() => client.pull(identity, signal()));
});

test('background requests of one account run one at a time, spaced, and yield to user requests', async () => {
  let now = 0; const order = [] as string[];
  resetRequestBudgets({ now: () => now, sleep: async ms => { now += ms; await new Promise(resolve => setImmediate(resolve)); } });
  const budget = requestBudget('github', 'queue-reader');
  const user = await budget.acquire('core', signal());
  const first = inBackground(() => budget.acquire('core', signal())).then(release => { order.push(`first@${now}`); return release; });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.length, 0, 'background waits while a user request is in flight');
  user(); const releaseFirst = await first;
  const second = inBackground(() => budget.acquire('core', signal())).then(release => { order.push(`second@${now}`); return release; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(order.length, 1, 'only one background request per account at a time');
  releaseFirst(); (await second)();
  const [firstAt, secondAt] = order.map(entry => Number(entry.split('@')[1]));
  assert.ok(secondAt - firstAt >= 250, 'background requests keep a minimum spacing');
});

test('search stays within GitHub’s 30 a minute, leaving user headroom over background refreshes', async () => {
  let now = 0; resetRequestBudgets({ now: () => now, sleep: async ms => { now += ms; } });
  const budget = requestBudget('github', 'search-reader');
  for (let index = 0; index < 24; index++) (await inBackground(() => budget.acquire('search', signal())))();
  await assert.rejects(inBackground(() => budget.acquire('search', signal())), /30 requests a minute/);
  for (let index = 0; index < 6; index++) (await budget.acquire('search', signal()))();
  await assert.rejects(budget.acquire('search', signal()), (error: Error & { retryAt?: number }) => error.retryAt === 60_000);
  now = 70_000; (await inBackground(() => budget.acquire('search', signal())))();
});

test('Linear reads report their request window to the account budget and pause in the background near the limit', async () => {
  let now = 1_000_000; resetRequestBudgets({ now: () => now, sleep: async ms => { now += ms; } });
  const budget = requestBudget('linear', 'fixture-workspace'); let remaining = 1400, sent = 0;
  const transport = linearTransport('fixture-linear-token', async () => { sent++; return new Response(JSON.stringify({ data: linearFixture().data }), { headers: { 'x-ratelimit-requests-limit': '1500', 'x-ratelimit-requests-remaining': String(remaining), 'x-ratelimit-requests-reset': String(now + 3_600_000) } }); }, budget);
  await inBackground(() => transport.read('viewer', {}, signal()));
  assert.equal(budgetLine(budget.status()), 'Linear · 1,400/1,500 left');
  remaining = 100; await transport.read('viewer', {}, signal());
  assert.equal(budget.level(), 'paused');
  await assert.rejects(inBackground(() => transport.read('viewer', {}, signal())), /Linear background updates are paused/); assert.equal(sent, 2);
  await transport.read('viewer', {}, signal()); assert.equal(sent, 3, 'a person’s read still goes out');
});

test('Settings shows one budget line per connection, including connections without item sync', () => {
  resetRequestBudgets();
  requestBudget('github', 'Octo-Dev').observe('core', { status: 200, limit: 5000, remaining: 3120, resetAt: Date.now() + 3_600_000 });
  requestBudget('github', 'octo-dev').observe('core', { status: 200, limit: 5000, remaining: 1800, resetAt: Date.now() + 3_600_000 });
  requestBudget('linear', 'workspace/me').observe('core', { status: 200 });
  const connections = [{ id: 'gh', providerId: 'github', account: 'Octo-Dev', enabled: true, isDefault: true }, { id: 'ln', providerId: 'linear', account: 'workspace/me', enabled: true, isDefault: true },
    { id: 'sl', providerId: 'slack', account: 'T1/U1', enabled: true, isDefault: true }, { id: 'off', providerId: 'linear', account: 'other', enabled: false, isDefault: false }];
  const lines = withBudgetLines([{ connectionId: 'gh', providerId: 'github', enabled: true, working: false }], connections);
  assert.deepEqual(lines, [{ connectionId: 'gh', providerId: 'github', enabled: true, working: false, budget: 'GitHub · 1,800/5,000 left · background slowed' },
    { connectionId: 'ln', providerId: 'linear', enabled: true, working: false, budget: 'Linear · 1 request', budgetOnly: true }]);
});
