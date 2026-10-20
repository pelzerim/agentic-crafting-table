import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl, stateSchema } from '../core/control.ts';
import { StandupReports } from './standup.ts';
import type { ActivitySummaryClient, HelperRequest } from '../../src/agents/activity-summary.ts';
import type { DaySlice } from '../session-runtime/transcripts.ts';
import { GitHubClient, activityPath } from '../provider-runtime/github.ts';
import { STANDUP_ENABLED } from '../core/standup.ts';
import type { StandupStatus } from '../core/standup.ts';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';

// Monday 12 October 2026, 09:00 in UTC; the report's 1 day is Sunday 11 and today.
const NOW = Date.UTC(2026, 9, 12, 9);
const NATIVE = '00000000-0000-4000-8000-000000000013';
const slice = (text: string): DaySlice => ({ prompts: 1, replies: 1, tools: { Bash: 2 }, lines: [`[08:00] Me: ${text}`, '[08:05] Claude: TRANSCRIPT_ONLY_DETAIL found the cause.'] });

async function fixture(run: (context: { store: SqliteStore; control: WorkspaceControl; requests: HelperRequest[]; reports: (options?: Partial<ConstructorParameters<typeof StandupReports>[2]>) => StandupReports; days: Map<string, DaySlice>; reply: { report?: (input: any) => unknown } }) => Promise<void>) {
  const previous = process.env.TZ; process.env.TZ = 'UTC';
  const directory = await mkdtemp(join(tmpdir(), 'act-standup-')), store = new SqliteStore(join(directory, 'workspace.sqlite'), { reminderSeeds: [] }), control = new WorkspaceControl(store);
  const requests: HelperRequest[] = [], days = new Map<string, DaySlice>([['2026-10-11', slice('Why are cart totals off by a cent?')]]), reply: { report?: (input: any) => unknown } = {};
  const client: ActivitySummaryClient = { async complete(request) {
    requests.push(request);
    const input = JSON.parse(request.messages[0].content);
    if (input.standup === 'agent-day') return 'Asked: why cart totals are off by a cent.\nFound: each line was rounded.\nState: fixed.';
    if (input.standup === 'pr-day') return 'What: rounds the cart total once.\nDid: merged it.';
    const ids = [...input.digests.flatMap((digest: { evidence: string[] }) => digest.evidence), ...input.facts.map((fact: { evidence: string }) => fact.evidence)];
    return JSON.stringify(reply.report?.(input) ?? { stories: [{ title: 'Cart totals', state: 'done', bullets: ['Found that each line was rounded.'], evidence: [ids[0]] }], outlook: [] });
  } };
  await store.update(state => stateSchema.parse({ ...state, nodes: [
    { id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { id: 'agent', resourceId: 'agent-r', projectId: 'project', title: 'Claude · cart totals', position: { x: 300, y: 0 } },
  ], resources: [{ id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Claude · cart totals', data: { sessionId: 'pty-1', provider: 'claude', nativeSessionId: NATIVE } }] }));
  const reports = (options: Partial<ConstructorParameters<typeof StandupReports>[2]> = {}) => new StandupReports(store, control, { client, clock: () => NOW, allowed: () => true, connections: () => [],
    transcripts: { find: id => id === NATIVE ? '/fixture/transcript.jsonl' : undefined, read: async (_file, wanted) => new Map([...days].filter(([day]) => wanted.has(day))), modified: () => NOW }, ...options });
  try { await run({ store, control, requests, reports, days, reply }); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}
const settle = async (reports: StandupReports): Promise<StandupStatus> => { await reports.settled(); return reports.status(); };
const setSummaries = (store: SqliteStore, change: object) => { const current = store.readSettings(); store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, ...change } } }); };

test('opening the report digests each conversation day once with Haiku, composes with Sonnet and keeps transcript text in the service', () => fixture(async ({ requests, reports }) => {
  const service = reports();
  assert.equal(service.open({ range: 'day' }).state, 'running');
  const status = await settle(service);
  assert.equal(status.state, 'done', status.error ?? '');
  assert.deepEqual(requests.map(request => [request.model, JSON.parse(request.messages[0].content).standup]), [['haiku', 'agent-day'], ['sonnet', 'report']]);
  const digest = JSON.parse(requests[0].messages[0].content);
  assert.match(digest.conversation, /TRANSCRIPT_ONLY_DETAIL/); assert.equal(digest.day, '2026-10-11');
  const report = status.report!;
  assert.equal(report.mode, 'stories'); assert.deepEqual(report.stories.map(story => [story.title, story.evidence]), [['Cart totals', ['agent:agent-r:2026-10-11']]]);
  assert.deepEqual(report.evidence['agent:agent-r:2026-10-11'], { id: 'agent:agent-r:2026-10-11', kind: 'agent', label: 'Claude · cart totals · Sun 11', nodeId: 'agent' });
  assert.ok(!JSON.stringify(status).includes('TRANSCRIPT_ONLY_DETAIL'), 'no transcript text reaches the renderer');
  assert.ok(!JSON.parse(requests[1].messages[0].content).digests.some((entry: { text: string }) => entry.text.includes('TRANSCRIPT_ONLY_DETAIL')));
  assert.equal(report.read, 'Read 1 conversation and 0 facts');
  assert.ok(requests.every(request => request.budgetUsd && request.resultLimit));
}));

test('unchanged input is never digested or composed again; a changed day and a rewrite instruction are', () => fixture(async ({ requests, reports, days }) => {
  const service = reports();
  service.open({ range: 'day' }); await settle(service);
  service.open({ range: 'day' }); await settle(service);
  assert.equal(requests.length, 2);
  service.open({ range: 'day', instruction: 'shorter' }); const rewritten = await settle(service);
  assert.equal(requests.length, 3); assert.equal(JSON.parse(requests[2].messages[0].content).instruction, 'shorter'); assert.equal(rewritten.request?.instruction, 'shorter');
  days.set('2026-10-12', slice('Ship the fix'));
  service.open({ range: 'day' }); await settle(service);
  assert.deepEqual(requests.slice(3).map(request => JSON.parse(request.messages[0].content).standup), ['agent-day', 'report']);
  assert.equal(JSON.parse(requests[3].messages[0].content).day, '2026-10-12');
}));

test('a composed story citing evidence that was not read is dropped and noted', () => fixture(async ({ reports, reply }) => {
  reply.report = input => ({ stories: [
    { title: 'Grounded', state: 'done', bullets: ['Fixed it.'], evidence: [input.digests[0].evidence[0]] },
    { title: 'Invented', state: 'done', bullets: ['Did something else.'], evidence: ['pr:acme/other/pull/1'] },
  ], outlook: [] });
  const service = reports(); service.open({ range: 'day' });
  const report = (await settle(service)).report!;
  assert.deepEqual(report.stories.map(story => story.title), ['Grounded']);
  assert.deepEqual(report.notes, ['Left out 1 story whose evidence could not be checked.']);
}));

test('with standup digests off the report lists stored facts without any model call, and says why', () => fixture(async ({ store, control, requests, reports }) => {
  setSummaries(store, { standupDigests: false });
  const service = reports(); service.open({ range: 'day' });
  let report = (await settle(service)).report!;
  assert.equal(requests.length, 0); assert.equal(report.mode, 'facts');
  assert.equal(report.reason, 'Standup digests are off in Settings → AI features, so this is the stored facts without a summary.');
  assert.deepEqual(report.outlook, []);
  const apply = async (commands: unknown[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  mock.timers.enable({ apis: ['Date'], now: NOW - 60_000 });
  try { await apply([{ type: 'todo.save', todo: { id: 'open', title: 'Agree the retry limit', completed: false, nodeIds: [] } }, { type: 'todo.save', todo: { id: 'done', title: 'Write the migration', completed: true, nodeIds: [] } }]); } finally { mock.timers.reset(); }
  service.open({ range: 'day' }); report = (await settle(service)).report!;
  assert.deepEqual(report.stories.map(story => [story.title, story.state, story.bullets]), [['Write the migration', 'done', []]]);
  assert.deepEqual(report.outlook.map(story => [story.title, story.state]), [['Agree the retry limit', 'ongoing']]);
  assert.equal(report.evidence[report.outlook[0].evidence[0]].kind, 'todo');
}));

test('a report I ask for has its own allowance: the shared limit for titles and summaries does not stop it', () => fixture(async ({ store, requests, reports }) => {
  setSummaries(store, { requestsPerHour: 1, requestsPerDay: 1 });
  store.reserveAiRequest(store.readSettings().value.summaries, NOW);
  const service = reports(); service.open({ range: 'day' });
  const report = (await settle(service)).report!;
  assert.notEqual(report.mode, 'facts', report.reason ?? ''); assert.ok(requests.length >= 2, 'digests and composition both ran');
}));

test('the report\'s own allowance stops digests and composition; the report falls back to facts and says so', () => fixture(async ({ store, requests, reports }) => {
  setSummaries(store, { standupRequestsPerReport: 1 });
  const service = reports(); service.open({ range: 'day' });
  const report = (await settle(service)).report!;
  assert.equal(requests.length, 1); assert.equal(report.mode, 'facts');
  assert.equal(report.reason, 'The report used its allowance of AI requests (Settings → AI features → Standup report requests), so this is the stored facts without a summary.');
}));

test('in the background only earlier days are digested, one per tick, leaving room for the other helpers', () => fixture(async ({ store, requests, reports, days }) => {
  days.set('2026-10-12', slice('Today is not digested in the background'));
  days.set('2026-10-09', slice('Friday work'));
  const service = reports();
  await service.tick(); await service.tick(); await service.tick();
  assert.deepEqual(requests.map(request => JSON.parse(request.messages[0].content).day), ['2026-10-09', '2026-10-11']);
  assert.ok(store.standupDigest('agent', 'agent-r', '2026-10-09')?.text);
  setSummaries(store, { requestsPerHour: 6 }); days.set('2026-10-08', slice('Thursday work'));
  await service.tick(); assert.equal(requests.length, 2, 'four requests stay free for titles and summaries');
  setSummaries(store, { standupDigests: false, requestsPerHour: 12 }); await service.tick(); assert.equal(requests.length, 2);
}));

test('PRs I authored or reviewed are read from GitHub with GETs only and digested per day they changed', () => fixture(async ({ requests, reports }) => {
  const paths: string[] = [];
  const pull = { id: 1, number: 7, title: 'Round the cart total once', body: 'Cart totals were off by a cent. token=SECRET_VALUE', state: 'closed', draft: false, merged: true, merged_at: '2026-10-12T08:30:00Z', merged_by: { login: 'me' },
    user: { login: 'me' }, head: { ref: 'fix', sha: 'a'.repeat(40), repo: { full_name: 'acme/billing' } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'acme/billing' } }, updated_at: '2026-10-12T08:30:00Z', created_at: '2026-10-11T15:00:00Z',
    additions: 10, deletions: 2, changed_files: 1 };
  const github = new GitHubClient({ async get(path) {
    paths.push(path);
    if (path.startsWith('/search/issues')) return { status: 200, headers: new Headers(), body: { items: path === activityPath('author', '2026-10-11', '2026-10-12') ? [{ number: 7, title: pull.title, html_url: 'https://github.com/acme/billing/pull/7', repository_url: 'https://api.github.com/repos/acme/billing', user: { login: 'me' }, updated_at: pull.updated_at, pull_request: {} }] : [] } };
    if (path.endsWith('/commits?per_page=100&page=1')) return { status: 200, headers: new Headers(), body: [{ sha: 'c'.repeat(40), commit: { message: 'fix: round cart totals', committer: { date: '2026-10-11T16:00:00Z' } } }] };
    if (path.endsWith('/files?per_page=100&page=1')) return { status: 200, headers: new Headers(), body: [{ filename: 'billing/exports.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 }] };
    return { status: 200, headers: new Headers(), body: pull };
  }, async postComment() { throw new Error('no writes'); } });
  const service = reports({ connections: () => [{ id: 'gh', providerId: 'github', account: 'me', enabled: true, isDefault: true }], github: () => github });
  service.open({ range: 'day' }); const status = await settle(service);
  assert.equal(status.state, 'done');
  const pr = requests.filter(request => JSON.parse(request.messages[0].content).standup === 'pr-day').map(request => JSON.parse(request.messages[0].content));
  assert.deepEqual(pr.map(input => input.day), ['2026-10-11', '2026-10-12']);
  assert.deepEqual(pr[0].commitsThatDay, ['fix: round cart totals']); assert.deepEqual(pr[1].commitsThatDay, []);
  assert.ok(!JSON.stringify(pr).includes('SECRET_VALUE'));
  const report = JSON.parse(requests.at(-1)!.messages[0].content);
  assert.ok(report.digests.some((entry: { evidence: string[] }) => entry.evidence.includes('pr:acme/billing/pull/7')));
  assert.ok(paths.every(path => !path.includes('comments')));
  assert.equal(status.report!.read, 'Read 1 conversation, 1 pull request and 0 facts');
}));

test('disabled, the reports refuse to open and the background tick digests nothing', () => fixture(async ({ requests, reports, days }) => {
  days.set('2026-10-09', slice('Friday work'));
  const service = reports({ enabled: false });
  assert.throws(() => service.open({ range: 'day' }), /The standup report is disabled\./);
  assert.deepEqual(service.status(), { state: 'idle' });
  service.start(); await service.tick();
  assert.equal(requests.length, 0);
  await service.close();
}));

test('the service starts a report, reports progress until done and validates the range', { skip: !STANDUP_ENABLED && 'the standup report is disabled' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-standup-service-'));
  const service = await startWorkspaceService(directory, undefined, undefined, {}), client = await connectWorkspace(directory);
  try {
    assert.deepEqual(await client.call('standup.status'), { state: 'idle' });
    assert.equal((await client.call<StandupStatus>('standup.open', { range: 'last-week' })).state, 'running');
    let status: StandupStatus; do status = await client.call<StandupStatus>('standup.status'); while (status.state === 'running');
    assert.equal(status.state, 'done'); assert.equal(status.report!.mode, 'facts'); assert.equal(status.report!.range, 'last-week');
    assert.match(status.report!.reason!, /^Claude could not write the report \(No model configured for this isolated service\)/);
    await assert.rejects(client.call('standup.open', { range: '3 days' }));
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
