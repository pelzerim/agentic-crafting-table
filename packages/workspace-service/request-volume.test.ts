import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { ProviderConnections } from '../provider-runtime/connections.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { githubPullRequestConnector } from '../../src/resource-plugins/items/github-pull-request/connector.ts';
import { GitHubClient } from '../provider-runtime/github.ts';
import { githubMergeTransport } from '../provider-runtime/github-transport.ts';
import { resetRequestBudgets, useValidatorStore } from '../provider-runtime/request-budget.ts';
import { pullFixture } from '../../tests/fixtures/github.ts';

const HOUR = 3_600_000, TICK = 15_000;
/** A fake api.github.com: strong ETags over the JSON body, 304 on a matching
 * If-None-Match, and a primary limit that only non-304 responses consume. */
function fakeGitHub(pulls: number, now: () => number) {
  const counts = { total: 0, notModified: 0, graphql: 0 }, comments = new Map<number, unknown[]>();
  let remaining = 5000; const reset = Math.floor((now() + HOUR) / 1000);
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    counts.total++;
    const { pathname, search } = new URL(String(url)), headers = new Headers(init?.headers), number = Number(/\/(?:pulls|issues)\/(\d+)/.exec(pathname)?.[1]);
    const limit = () => ({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': pathname === '/graphql' ? 'graphql' : 'core' });
    if (pathname === '/graphql') { counts.graphql++; remaining--; return Response.json({ data: { repository: { pullRequest: { isInMergeQueue: false, mergeQueueEntry: null } } } }, { headers: limit() }); }
    const body = /\/pulls\/\d+$/.test(pathname) ? { ...structuredClone(pullFixture), id: 1000 + number, number, title: `Fixture pull ${number}`, updated_at: `2026-09-25T11:00:0${(comments.get(number)?.length ?? 0) % 10}Z` }
      : /\/issues\/\d+\/comments$/.test(pathname) ? comments.get(number) ?? [] : [];
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 20)}"`;
    if (headers.get('if-none-match') === etag) { counts.notModified++; return new Response(null, { status: 304, headers: { ...limit(), etag } }); }
    remaining--; void search;
    return Response.json(body, { headers: { ...limit(), etag } });
  }) as typeof fetch;
  const comment = (number: number) => { const list = comments.get(number) ?? []; list.push({ id: 10_000 + counts.total, body: 'New feedback', user: { login: 'fixture-reviewer' }, created_at: '2026-09-26', updated_at: '2026-09-26' }); comments.set(number, list); };
  return { fetcher, counts, comment, get remaining() { return remaining; }, pulls };
}

async function simulate(pulls: number, minutes = 60) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-volume-')); let now = Date.parse('2026-09-30T08:00:00Z');
  const clock = () => now, github = fakeGitHub(pulls, clock), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const accounts = [{ id: 'github-volume', providerId: 'github', account: 'volume-developer', enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'github', name: 'GitHub', setupHint: 'Fixture', accounts: async () => [] }]);
  const credentials = { accounts: async () => [], token: async () => 'fixture-token' };
  const host = new ResourcePluginHost(control.registry);
  host.register('github.pull-request', githubPullRequestConnector(resource => new GitHubClient(githubMergeTransport(connections.resolve('github', resource.connectionId).account, credentials, github.fetcher), clock)));
  const coordinator = new ResourceCoordinator(store, control, host, connections, async () => {}, clock);
  resetRequestBudgets({ now: clock, sleep: async ms => { now += ms; } }); useValidatorStore(store);
  try {
    const ids = Array.from({ length: pulls }, () => randomUUID());
    await control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'volume' }, commands: ids.map((id, index) => (
      { type: 'item.add', id, resourceId: randomUUID(), pluginId: 'github.pull-request', connectionId: 'github-volume', title: `Pull ${index + 1}`, position: { x: index * 300, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: index + 1 } })) });
    const start = github.counts.total, end = now + minutes * 60_000; let nextComment = now + 600_000, commented = 0;
    while (now < end) {
      // One pull request gains a comment every ten minutes; the rest stay unchanged.
      if (now >= nextComment) { github.comment(1 + commented++ % pulls); nextComment += 600_000; }
      await coordinator.poll(); now += TICK;
    }
    const background = { total: github.counts.total - start, notModified: github.counts.notModified, graphql: github.counts.graphql, counted: github.counts.total - start - github.counts.notModified };
    now += 61_000; const before = github.counts.total; await coordinator.read(ids[pulls - 1]); const opened = github.counts.total - before;
    return { background, opened, remaining: github.remaining };
  } finally { useValidatorStore(); await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('10, 20 and 50 open pull requests stay well under GitHub’s hourly limit and an opened item still refreshes at once', async t => {
  // Before conditional requests and adaptive cadence every PR cost five counted requests a minute: 3,000, 6,000 and 15,000 an hour.
  for (const [pulls, bound] of [[10, 600], [20, 1000], [50, 2500]]) {
    const result = await simulate(pulls);
    t.diagnostic(`${pulls} PRs/60 min: ${result.background.total} requests, ${result.background.counted} counted against the limit (${result.background.graphql} GraphQL), ${result.background.notModified} not modified`);
    assert.ok(result.background.counted < bound, `${pulls} PRs: ${result.background.counted} counted requests`);
    assert.ok(result.background.total < bound * 3, `${pulls} PRs: ${result.background.total} requests`);
    assert.equal(result.opened, 5, 'opening an item reads it again right away');
  }
});
