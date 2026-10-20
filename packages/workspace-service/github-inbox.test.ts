import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { GitHubInbox, INBOX_REFRESH_MS } from './github-inbox.ts';
import type { GitHubClient, InboxPull } from '../provider-runtime/github.ts';
import { GitHubError } from '../provider-runtime/github.ts';

const pull = (repo: string, number: number, reasons: InboxPull['reasons'] = ['review']): InboxPull => {
  const [owner, name] = repo.split('/');
  return { key: `${owner}/${name}/pull/${number}`, owner, repo: name, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, author: 'author', updatedAt: '2026-09-29T10:00:00Z', draft: false, comments: 0, reasons };
};

test('the inbox caches per account, refreshes at most once a minute, keeps the last list on errors and places PRs by repository', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-inbox-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  let now = Date.parse('2026-09-29T12:00:00Z'), calls = 0, failure: Error | undefined, items = [pull('acme/app', 1), pull('acme/app', 2, ['assigned']), pull('acme/new', 9, ['authored'])];
  const client = { async inbox() { calls++; if (failure) throw failure; return items; } } as unknown as GitHubClient;
  const connection = { id: 'github-main', providerId: 'github', account: 'me', enabled: true, isDefault: true };
  const inbox = new GitHubInbox(store, control, () => [connection, { ...connection, id: 'off', enabled: false }], () => client, () => now);
  try {
    await apply([{ type: 'project.create', id: 'project', title: 'App', summary: '', position: { x: 800, y: 400 } },
      { type: 'item.add', id: 'existing', resourceId: 'existing-r', pluginId: 'github.pull-request', title: 'PR 1', projectId: 'project', position: { x: 820, y: 420 }, data: { owner: 'acme', repo: 'app', number: 1 } }]);
    await inbox.refresh();
    let read = await inbox.read();
    assert.equal(read.accounts.length, 1, 'only enabled GitHub accounts');
    assert.deepEqual(read.accounts[0].items.map(item => [item.number, item.nodeId]), [[1, 'existing'], [2, undefined], [9, undefined]]);
    await inbox.refresh(); assert.equal(calls, 1, 'no second read within a minute');
    now += INBOX_REFRESH_MS; failure = new GitHubError('GITHUB_RATE_LIMIT', 'GitHub rate limit reached.', now + 120_000);
    await inbox.refresh(); read = await inbox.read();
    assert.equal(read.accounts[0].items.length, 3, 'the last complete list stays'); assert.match(read.accounts[0].error!, /rate limit/);
    now += INBOX_REFRESH_MS; await inbox.refresh(); assert.equal(calls, 2, 'rate-limit backoff is honored');
    failure = undefined; now += 120_000; await inbox.refresh(true); assert.equal(calls, 3);
    assert.equal((await inbox.read()).accounts[0].error, undefined);
    assert.deepEqual(await inbox.showOnMap({ connectionId: 'github-main', key: 'acme/app/pull/1', position: { x: 0, y: 0 } }), { nodeId: 'existing', created: false });
    const shown = await inbox.showOnMap({ connectionId: 'github-main', key: 'acme/app/pull/2', position: { x: 0, y: 0 } });
    let state = await control.read(), node = state.nodes.find(candidate => candidate.id === shown.nodeId)!;
    assert.equal(node.projectId, 'project', 'joins the project that already holds this repository'); assert.equal(state.resources.find(resource => resource.id === node.resourceId)?.connectionId, 'github-main');
    const floating = await inbox.showOnMap({ connectionId: 'github-main', key: 'acme/new/pull/9', position: { x: 50, y: 60 } });
    state = await control.read(); node = state.nodes.find(candidate => candidate.id === floating.nodeId)!;
    assert.equal(node.projectId, undefined); assert.equal(state.resources.find(resource => resource.id === node.resourceId)?.data.number, 9);
    assert.deepEqual(await inbox.showOnMap({ connectionId: 'github-main', key: 'acme/new/pull/9', position: { x: 0, y: 0 } }), { nodeId: floating.nodeId, created: false });
    await assert.rejects(inbox.showOnMap({ connectionId: 'github-main', key: 'acme/app/pull/404', position: { x: 0, y: 0 } }), /no longer in your inbox/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the inbox list survives other cache writes and restarts, and hidden pull requests never come back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-inbox-')), file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store), calls = 0;
  const now = () => Date.parse('2026-09-29T12:00:00Z');
  const client = { async inbox() { calls++; return [pull('acme/app', 1), pull('acme/app', 2), pull('acme/web', 3)]; } } as unknown as GitHubClient;
  const connection = { id: 'github-main', providerId: 'github', account: 'me', enabled: true, isDefault: true };
  let inbox = new GitHubInbox(store, control, () => [connection], () => client, now);
  try {
    await inbox.refresh();
    // Caching any map resource used to prune the inbox's rows as orphans.
    store.cacheResource('some-other-resource', 'snapshot', 'x', { any: true }, now());
    assert.deepEqual((await inbox.read()).accounts[0].items.map(item => item.number), [1, 2, 3]);
    assert.equal(calls, 1, 'the list is still cached, not refetched');
    await inbox.hide({ key: 'acme/app/pull/2' });
    assert.deepEqual((await inbox.read()).accounts[0].items.map(item => item.number), [1, 3]);
    await assert.rejects(inbox.hide({ key: '../../etc' }), /Invalid/);
    store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store);
    inbox = new GitHubInbox(store, control, () => [connection], () => client, now);
    const read = await inbox.read();
    assert.deepEqual(read.accounts[0].items.map(item => item.number), [1, 3], 'cached list and hidden set survive a restart');
    assert.equal(calls, 1, 'no refetch needed to show the list');
    await inbox.refresh(true);
    assert.deepEqual((await inbox.read()).accounts[0].items.map(item => item.number), [1, 3], 'a fresh GitHub read keeps it hidden');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a seen pull request leaves the inbox until it has new activity, and seen rows go when it leaves the list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-inbox-seen-')), file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store), now = Date.parse('2026-09-29T12:00:00Z');
  let items = [pull('acme/app', 1), pull('acme/app', 2, ['assigned']), pull('acme/web', 3, ['authored'])];
  const client = { async inbox() { return items; } } as unknown as GitHubClient;
  const connection = { id: 'github-main', providerId: 'github', account: 'me', enabled: true, isDefault: true };
  let inbox = new GitHubInbox(store, control, () => [connection], () => client, () => now);
  const seen = async () => (await inbox.read()).accounts[0].items.filter(item => item.seen).map(item => item.number);
  const refetch = async () => { now += INBOX_REFRESH_MS; await inbox.refresh(true); };
  try {
    await inbox.refresh();
    assert.deepEqual(await seen(), [], 'new pull requests start in the inbox');
    assert.deepEqual(await inbox.seen({ key: 'acme/app/pull/2', seen: true }), { seen: true });
    assert.deepEqual(await seen(), [2]);
    assert.deepEqual(store.seenInboxPulls().get('acme/app/pull/2'), { updatedAt: '2026-09-29T10:00:00Z', reasons: ['assigned'] }, 'the activity stamp at the moment it was seen');
    await inbox.seen({ key: 'acme/app/pull/2', seen: false });
    assert.deepEqual(await seen(), [], 'Back to inbox');
    assert.equal(store.seenInboxPulls().size, 0);

    await inbox.seen({ key: 'acme/app/pull/2', seen: true }); await inbox.seen({ key: 'acme/web/pull/3', seen: true });
    store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store);
    inbox = new GitHubInbox(store, control, () => [connection], () => client, () => now);
    assert.deepEqual(await seen(), [2, 3], 'seen survives a restart');

    items = [pull('acme/app', 1), { ...pull('acme/app', 2, ['assigned']), updatedAt: '2026-09-29T11:00:00Z' }, pull('acme/web', 3, ['authored'])];
    await refetch(); assert.deepEqual(await seen(), [3], 'a newer update brings it back');
    await inbox.seen({ key: 'acme/app/pull/2', seen: true });
    items = [pull('acme/app', 1), { ...pull('acme/app', 2, ['assigned', 'review']), updatedAt: '2026-09-29T11:00:00Z' }, pull('acme/web', 3, ['authored'])];
    await refetch(); assert.deepEqual(await seen(), [3], 'a new review request brings it back');
    await inbox.seen({ key: 'acme/app/pull/2', seen: true });
    items = [pull('acme/app', 1), { ...pull('acme/app', 2, ['review']), updatedAt: '2026-09-29T11:00:00Z' }, pull('acme/web', 3, ['authored'])];
    await refetch(); assert.deepEqual(await seen(), [2, 3], 'losing a reason is not new activity');

    items = [pull('acme/app', 1), pull('acme/web', 3, ['authored'])];
    await refetch();
    assert.deepEqual([...store.seenInboxPulls().keys()], ['acme/web/pull/3'], 'a pull request that leaves the list loses its seen row');
    items = [pull('acme/app', 1), { ...pull('acme/app', 2, ['review']), updatedAt: '2026-09-29T11:00:00Z' }, pull('acme/web', 3, ['authored'])];
    await refetch(); assert.deepEqual(await seen(), [3], 'and comes back into the inbox');

    await inbox.hide({ key: 'acme/web/pull/3' });
    assert.equal(store.seenInboxPulls().size, 0, 'hiding drops the seen row');
    await assert.rejects(inbox.seen({ key: 'acme/app/pull/404', seen: true }), /no longer in your inbox/);
    await assert.rejects(inbox.seen({ key: '../../etc', seen: true }), /Invalid/);
  } finally { await inbox.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('seen rows are kept while another account has not finished its first read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-inbox-seen-accounts-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let now = Date.parse('2026-09-29T12:00:00Z');
  const work = { id: 'github-work', providerId: 'github', account: 'work', enabled: true, isDefault: false };
  const main = { id: 'github-main', providerId: 'github', account: 'me', enabled: true, isDefault: true };
  let failing = true;
  const clients = { me: { async inbox() { return [pull('acme/app', 1)]; } }, work: { async inbox() { if (failing) throw new Error('offline'); return [pull('acme/work', 5)]; } } } as unknown as Record<string, GitHubClient>;
  const inbox = new GitHubInbox(store, control, () => [main, work], connection => clients[connection.account], () => now);
  try {
    store.seeInboxPull('acme/work/pull/5', { updatedAt: '2026-09-29T10:00:00Z', reasons: ['review'] }, now);
    await inbox.refresh(true);
    assert.ok(store.seenInboxPulls().has('acme/work/pull/5'), 'an account without a complete list prunes nothing');
    failing = false; now += 60_000; await inbox.refresh(true);
    assert.equal((await inbox.read()).accounts[1].items[0].seen, true);
  } finally { await inbox.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('closing the inbox waits for an in-flight refresh and never writes to a closed store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-inbox-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let release!: (items: InboxPull[]) => void;
  const client = { inbox: () => new Promise<InboxPull[]>(resolve => { release = resolve; }) } as unknown as GitHubClient;
  const connection = { id: 'github-main', providerId: 'github', account: 'me', enabled: true, isDefault: true };
  const inbox = new GitHubInbox(store, control, () => [connection], () => client);
  try {
    const running = inbox.refresh(); await new Promise(resolve => setImmediate(resolve));
    const closing = inbox.close(); release([pull('acme/app', 1)]);
    await closing; store.close();
    await running;
    await inbox.refresh(true); // A closed inbox starts no new read; this client would never resolve.
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unchanged inbox backs off 1 → 2 → 5 → 10 minutes and opening the panel snaps it back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-inbox-cadence-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let now = Date.parse('2026-09-29T12:00:00Z'), items = [pull('acme/app', 1)]; const reads: number[] = [], start = now;
  const client = { async inbox() { reads.push((now - start) / 60_000); return items; } } as unknown as GitHubClient;
  const connection = { id: 'github-main', providerId: 'github', account: 'me', enabled: true, isDefault: true };
  const inbox = new GitHubInbox(store, control, () => [connection], () => client, () => now);
  const minutes = async (count: number) => { for (let minute = 0; minute < count; minute++) { await inbox.refresh(); now += 60_000; } };
  try {
    await minutes(31);
    assert.deepEqual(reads, [0, 1, 2, 4, 9, 19, 29]);
    items = [pull('acme/app', 1), pull('acme/app', 2)]; await minutes(12);
    assert.deepEqual(reads.slice(7), [39, 40, 41], 'a changed list polls every minute again');
    await minutes(8); assert.deepEqual(reads.slice(10), [43, 48], 'and backs off again');
    reads.length = 0; await minutes(3); assert.deepEqual(reads, []);
    await inbox.opened(); assert.deepEqual(reads, [54], 'opening the panel reads a list older than a minute at once');
    await minutes(3); assert.deepEqual(reads, [54, 55, 56]);
  } finally { await inbox.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
