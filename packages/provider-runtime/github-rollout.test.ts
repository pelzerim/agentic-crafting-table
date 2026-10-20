import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRolloutClient, rolloutStatus } from './github-rollout.ts';
import { githubRolloutApprovalTransport, githubRolloutTransport } from './github-transport.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutFixture } from '../../tests/fixtures/rollout.ts';
import { githubRollout } from '../../src/resource-plugins/items/github-rollout/definition.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
const key = { owner: 'fixture', repo: 'web', runId: 101 }, workflow = { owner: 'fixture', repo: 'web', workflow: 'deploy.yml' };
const signal = () => AbortSignal.timeout(10_000);

test('rollout URLs support all workflow names and normalize job/attempt links to one whole run', () => {
  const registry = createResourcePluginRegistry();
  for (const suffix of ['runs/101', 'runs/101/job/123', 'runs/101/attempts/2']) {
    const match = registry.matchInput(`https://github.com/fixture/web/actions/${suffix}`)[0];
    assert.equal(match.pluginId, githubRollout.id); assert.deepEqual(match.data, key);
  }
  for (const name of ['app-apply.yml', 'web-cd.yml', 'api-cd.yml', 'deploy-api.yml', 'app-rollback.yml', 'docs-site-release.yml', 'docs-site-apply.yml', '142']) {
    assert.equal(githubRollout.matchInput!(`https://github.com/fixture/web/actions/workflows/${name}`)?.data.workflow, name);
  }
  assert.equal(githubRollout.matchInput!('https://github.com/fixture/web/actions/workflows/deploy.yml?query=branch%3Arelease%2Fnext')?.data.branch, 'release/next');
  for (const url of ['http://github.com/fixture/web/actions/runs/1', 'https://github.com.evil/fixture/web/actions/runs/1', 'https://user@github.com/fixture/web/actions/runs/1', 'https://github.com/fixture/web/actions/runs/9007199254740993', 'https://github.com/acme/app#deployments', 'https://github.com/fixture/web/actions/workflows/deploy.yml?query=event%3Apush']) assert.equal(githubRollout.matchInput!(url), undefined);
  assert.equal(githubRollout.validateData({ ...key, workflow: 'deploy.yml' }), false);
});

test('whole-run status distinguishes approval, timer, queue, partial progress and final conclusions', async () => {
  const f = rolloutFixture(), observe = () => f.client.observe(key, signal()), state = async () => rolloutStatus(await observe());
  assert.equal((await state()).state, 'ongoing');
  f.run.status = 'queued'; f.jobs[1].status = 'queued'; assert.equal((await state()).state, 'queued');
  f.run.status = 'waiting'; f.gates = [{ environment: { id: 1, name: 'production' }, wait_timer: 0, current_user_can_approve: false, reviewers: [{ type: 'Team' }] }];
  assert.equal((await state()).state, 'approval');
  f.gates[0].reviewers = []; f.gates[0].wait_timer = 30; assert.equal((await state()).state, 'waiting');
  f.gates = []; f.run.status = 'completed'; f.run.conclusion = 'success'; assert.equal((await state()).state, 'unknown');
  f.jobs = f.jobs.map(j => ({ ...j, status: 'completed', conclusion: 'success' })); assert.equal((await state()).state, 'passed');
  for (const [conclusion, expected] of [['failure','failed'],['timed_out','failed'],['action_required','failed'],['cancelled','cancelled'],['skipped','skipped'],['neutral','skipped'],['unexpected','unknown']]) {
    f.run.conclusion = conclusion; assert.equal((await state()).state, expected);
  }
  f.run.status = 'in_progress'; f.run.conclusion = null; f.jobs[1].conclusion = 'failure';
  assert.match((await state()).label, /Failed.*still running/);
});

test('each raised rollout reason carries short Needs me copy, naming a single short gate', async () => {
  const f = rolloutFixture(), state = async () => rolloutStatus(await f.client.observe(key, signal()));
  const gate = (id: number, name: string) => ({ environment: { id, name }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] });
  assert.deepEqual([(await state()).reason, (await state()).note], [null, undefined]);
  f.run.status = 'waiting'; f.gates = [gate(1, 'production')];
  assert.deepEqual([(await state()).reason, (await state()).note], ['input', 'Production needs approval']);
  f.gates = [gate(1, 'production-long-environment-name')]; assert.equal((await state()).note, 'Job needs approval');
  f.gates = [gate(1, 'staging'), gate(2, 'production')]; assert.equal((await state()).note, '2 jobs need approval');
  f.gates = []; f.run.status = 'completed'; f.run.conclusion = 'failure'; assert.deepEqual([(await state()).reason, (await state()).note], ['error', 'Rollout failed']);
  f.jobs = f.jobs.map(j => ({ ...j, status: 'completed', conclusion: 'success' })); f.run.conclusion = 'success';
  assert.deepEqual([(await state()).reason, (await state()).note], ['finished', 'Rollout finished']);
  f.run.conclusion = 'cancelled'; assert.equal((await state()).note, 'Rollout cancelled');
  f.run.conclusion = 'skipped'; assert.equal((await state()).note, 'Rollout skipped');
});

test('running and queued rollouts are working; rollouts waiting on a gate are idle', async () => {
  const f = rolloutFixture(), state = async () => rolloutStatus(await f.client.observe(key, signal()));
  assert.equal((await state()).activity, 'working');
  f.run.status = 'queued'; f.jobs = f.jobs.map(j => ({ ...j, status: 'queued', conclusion: null }));
  assert.deepEqual([(await state()).state, (await state()).activity], ['queued', 'working']);
  f.run.status = 'waiting'; f.gates = [production()];
  assert.deepEqual([(await state()).state, (await state()).activity], ['approval', 'idle']);
  f.gates[0].reviewers = []; f.gates[0].wait_timer = 30; f.gates[0].current_user_can_approve = false;
  assert.deepEqual([(await state()).state, (await state()).activity], ['waiting', 'idle']);
});

test('observer follows latest workflow, supports branch filter/no runs, paginates all regions and pins attempts', async () => {
  const f = rolloutFixture();
  f.jobs = Array.from({ length: 102 }, (_, i) => ({ id: i+1, run_id: 101, name: `Job ${i}`, status: 'completed', conclusion: 'success' }));
  const value = await f.client.observe({ ...workflow, branch: 'main' }, signal());
  assert.equal(value.jobs.length, 102); assert.equal(value.followsLatest, true);
  assert.ok(f.paths.includes('/repos/fixture/web/actions/workflows/9/runs?per_page=1&branch=main'));
  assert.ok(f.paths.includes('/repos/fixture/web/actions/runs/101/attempts/1/jobs?per_page=100&page=2'));
  assert.ok(f.paths.every(path => !path.includes('untrusted')));
  f.noRuns = true; assert.equal(rolloutStatus(await f.client.observe(workflow, signal())).state, 'no-runs');
  f.run.run_attempt = 3; assert.equal((await f.client.observe(key, signal())).run?.run_attempt, 3);
  assert.ok(f.paths.some(path => path.includes('/attempts/3/jobs')));
});

test('incomplete, mismatched, changing and unauthorized observations never report success', async () => {
  const f = rolloutFixture();
  const client = new GitHubRolloutClient({ async get(path, signal) { const result = await f.transport.get(path, signal); if (path.includes('/jobs?')) (result.body as any).total_count++; return result; } });
  await assert.rejects(client.observe(key, signal()), /incomplete/);
  f.jobs[0].run_id = 999; await assert.rejects(f.client.observe(key, signal()), /incomplete/); f.jobs[0].run_id = 101;
  let reads = 0;
  const race = new GitHubRolloutClient({ async get(path, signal) { if (path.endsWith('/runs/101')) f.run.run_attempt = ++reads; return f.transport.get(path, signal); } });
  await assert.rejects(race.observe(key, signal()), /changed during refresh/);
  f.run.repository.full_name = 'other/repo'; await assert.rejects(f.client.observe(key, signal()), /identity changed/); f.run.repository.full_name = 'fixture/web';
  f.fail(404); await assert.rejects(f.client.observe(key, signal()), /Rollout unavailable/);
  f.fail(429, { 'retry-after': '60' }); await assert.rejects(f.client.observe(key, signal()), error => (error as any).retryAt > Date.now());
  f.fail(401); await assert.rejects(f.client.observe(key, signal()), /sign-in/);
  const abort = new AbortController(); abort.abort(); const count = f.paths.length;
  await assert.rejects(f.client.observe(key, abort.signal)); assert.equal(f.paths.length, count);
});

test('rollout transport is GET-only, pins the API host and rejects writes/traversal before credentials', async () => {
  const requests: { url: string; method: string }[] = []; let credentials = 0;
  const transport = githubRolloutTransport('fixture', { accounts: async () => [], token: async () => { credentials++; return 'fixture-token'; } }, (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method }); return new Response('{}'); }) as typeof fetch);
  assert.deepEqual(Object.keys(transport), ['get']);
  for (const path of ['/repos/fixture/web/actions/runs/101', '/repos/fixture/web/actions/runs/101/pending_deployments', '/repos/fixture/web/actions/runs/101/attempts/2/jobs?per_page=100&page=2', '/repos/fixture/web/actions/workflows/deploy.yml', '/repos/fixture/web/actions/workflows/9/runs?per_page=1&branch=release%2Fnext']) await transport.get(path, signal());
  assert.ok(requests.every(r => r.url.startsWith('https://api.github.com/repos/fixture/web/') && r.method === 'GET'));
  const before = credentials;
  for (const path of ['/repos/fixture/web/actions/runs/101/rerun', '/repos/fixture/web/actions/runs/101/cancel', '//evil.invalid/', '/repos/fixture/../actions/runs/1', '/repos/fixture/web/actions/workflows/../runs?per_page=1', '/repos/fixture/web/actions/runs/1?target=evil']) await assert.rejects(transport.get(path, signal()), /Unsupported/);
  assert.equal(credentials, before);
});

const production = (id = 1, name = 'production', canApprove = true) => ({ environment: { id, name }, wait_timer: 0, current_user_can_approve: canApprove, reviewers: [{ type: 'Team' }] });
test('approval re-reads the rollout and approves only the confirmed run, attempt and gates', async () => {
  const f = rolloutFixture();
  f.run.status = 'waiting'; f.gates = [production(1), production(2, 'production-b'), production(3, 'restricted', false)];
  const confirmed = { runId: 101, attempt: 1, environmentIds: [2, 1] };
  await assert.rejects(f.client.approve(key, { ...confirmed, attempt: 2 }, signal()), /another run or attempt/);
  await assert.rejects(f.client.approve(key, { ...confirmed, runId: 102 }, signal()), /another run or attempt/);
  await assert.rejects(f.client.approve(key, { ...confirmed, environmentIds: [1] }, signal()), /environments waiting for approval changed/);
  await assert.rejects(f.client.approve(key, { ...confirmed, environmentIds: [1, 2, 3] }, signal()), /environments waiting for approval changed/);
  assert.equal(f.approvals.length, 0);
  f.replyToApproval(() => ({ status: 422, body: { message: 'Sensitive provider text' } }));
  await assert.rejects(f.client.approve(key, confirmed, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && !error.message.includes('Sensitive') && !error.outcomeUnknown);
  f.replyToApproval(() => ({ status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } }));
  await assert.rejects(f.client.approve(key, confirmed, signal()), (error: any) => error.code === 'GITHUB_RATE_LIMIT');
  f.replyToApproval(() => ({ status: 200, body: { unexpected: true } }));
  await assert.rejects(f.client.approve(key, confirmed, signal()), (error: any) => error.outcomeUnknown === true && /may have approved/.test(error.message));
  f.replyToApproval(() => ({ status: 502, body: null }));
  await assert.rejects(f.client.approve(key, confirmed, signal()), (error: any) => error.outcomeUnknown === true);
  f.replyToApproval(undefined); f.approvals.length = 0;
  await f.client.approve(key, confirmed, signal());
  assert.deepEqual(f.approvals, [{ path: '/repos/fixture/web/actions/runs/101/pending_deployments', environmentIds: [1, 2] }]);
  f.gates = []; f.run.status = 'in_progress';
  await assert.rejects(f.client.approve(key, confirmed, signal()), /Nothing in this rollout is waiting/);
  f.run.status = 'completed'; f.gates = [production(1)];
  await assert.rejects(f.client.approve(key, confirmed, signal()), /Nothing in this rollout is waiting/);
  await assert.rejects(new GitHubRolloutClient({ get: f.transport.get }).approve(key, confirmed, signal()), /unavailable for this connection/);
  assert.equal(f.approvals.length, 1);
});

test('approval transport posts one fixed approval body and nothing else', async () => {
  const requests: { url: string; method: string; body?: string }[] = []; let credentials = 0;
  const fetcher = (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method, body: options.body }); return Response.json([]); }) as typeof fetch;
  const transport = githubRolloutApprovalTransport('fixture', { accounts: async () => [], token: async () => { credentials++; return 'fixture-token'; } }, fetcher);
  await transport.approveDeployments!({ owner: 'fixture', repo: 'web', runId: 101 }, [1, 2], signal());
  assert.deepEqual(requests, [{ url: 'https://api.github.com/repos/fixture/web/actions/runs/101/pending_deployments', method: 'POST', body: JSON.stringify({ environment_ids: [1, 2], state: 'approved', comment: 'Approved in Agentic Crafting Table' }) }]);
  const before = credentials;
  for (const ids of [[], [0], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)]) await assert.rejects(async () => transport.approveDeployments!({ owner: 'fixture', repo: 'web', runId: 101 }, ids, signal()), /valid deployment environments/);
  await assert.rejects(async () => transport.approveDeployments!({ owner: '../x', repo: 'web', runId: 101 }, [1], signal()), /valid GitHub/);
  for (const path of ['/repos/fixture/web/actions/runs/101/rerun', '/repos/fixture/web/actions/runs/101/cancel', '/repos/fixture/web/actions/runs/101/approve']) await assert.rejects(transport.get(path, signal()), /Unsupported/);
  assert.equal(credentials, before);
  await transport.get('/repos/fixture/web/actions/runs/101/pending_deployments', signal());
  assert.equal(requests.at(-1)?.method, 'GET');
  const interrupted = githubRolloutApprovalTransport('fixture', { accounts: async () => [], token: async () => 'fixture-token' }, (async () => { throw new TypeError('socket closed'); }) as typeof fetch);
  await assert.rejects(interrupted.approveDeployments!({ owner: 'fixture', repo: 'web', runId: 101 }, [1], signal()), (error: any) => error.code === 'GITHUB_POST_UNCERTAIN');
});

test('connector offers a bound confirmation and returns the continued rollout after approval', async () => {
  const f = rolloutFixture(), connector = githubRolloutConnector(() => f.client);
  const resource = { id: 'rollout', pluginId: githubRollout.id, schemaVersion: 1, title: 'Rollout', data: key } as any;
  await assert.rejects(connector.execute!(resource, 'rollout.approval.options', signal()), /Nothing in this rollout/);
  f.run.status = 'waiting'; f.gates = [production(1), production(3, 'restricted', false)]; f.jobs[1].status = 'waiting';
  const partial = await connector.execute!(resource, 'rollout.approval.options', signal()) as any;
  assert.equal(partial.context.environmentIds, '1'); assert.equal(partial.prompt, 'Approve production for run #28?');
  f.gates = [production(1)];
  const choices = await connector.execute!(resource, 'rollout.approval.options', signal()) as any;
  assert.deepEqual(choices, { current: '', prompt: 'Approve production for run #28?', context: { runId: '101', attempt: '1', environmentIds: '1', sourceResourceId: 'rollout' }, options: [{ id: 'approve', label: 'Confirm' }] });
  const approve = connector.actions!(resource).find(action => action.id === 'rollout.approve')!;
  assert.equal(approve.humanOnly, true); assert.equal(approve.updatesSnapshot, true);
  await assert.rejects(connector.execute!(resource, 'rollout.approve', signal(), { ...choices.context, value: 'approve', sourceResourceId: 'other', requestId: 'x' }), /another item/);
  await assert.rejects(connector.execute!(resource, 'rollout.approve', signal(), { ...choices.context, environmentIds: '1,abc', value: 'approve', requestId: 'x' }), /incomplete/);
  assert.equal(f.approvals.length, 0);
  const result = await connector.execute!(resource, 'rollout.approve', signal(), { ...choices.context, value: 'approve', requestId: 'x' }) as any;
  assert.equal(f.approvals.length, 1); assert.equal(result.snapshot.detail.state, 'ongoing'); assert.equal(result.snapshot.attentionReason, null);
});

const minute = (value: number) => new Date(Date.UTC(2026, 8, 30, 10, value)).toISOString();
const other = (id: number, status: string, created: number, sha: string, extra: object = {}) => ({ id, name: 'Web / Release', display_title: `Run ${id}`, run_number: id - 70, run_attempt: 1, workflow_id: 9,
  head_branch: 'main', head_sha: sha.repeat(40), status, conclusion: null, updated_at: minute(created + 1), created_at: minute(created), run_started_at: minute(created), actor: { login: `pusher${id}` }, event: 'push', repository: { full_name: 'fixture/web' }, ...extra });
const pulls = (number: number, title: string) => [{ number, title, html_url: `https://github.com/fixture/web/pull/${number}`, merged_at: minute(0), user: { login: `author${number}` } }];
/** Our run 101 queued at 10:30 behind a running 99 (10:10) and a queued 100 (10:20); 102 queued after us. */
function queued(f: ReturnType<typeof rolloutFixture>) {
  f.run = { ...f.run, status: 'queued', created_at: minute(30), run_started_at: minute(30), actor: { login: 'fixture-user' }, event: 'push' }; f.jobs = [];
  f.queue.runs = [other(99, 'in_progress', 10, 'b'), other(100, 'queued', 20, 'c'), other(102, 'queued', 40, 'd'), other(101, 'queued', 30, 'a')];
  f.queue.jobs[99] = Array.from({ length: 8 }, (_, i) => ({ id: 900 + i, run_id: 99, name: `deploy / shard-${i}`, status: i < 5 ? 'completed' : i === 5 ? 'in_progress' : 'queued', conclusion: i < 5 ? 'success' : null, started_at: i <= 5 ? minute(12 + i) : null, completed_at: i < 5 ? minute(13 + i) : null }));
  f.queue.pulls = { ['b'.repeat(40)]: pulls(21, 'Round invoice totals'), ['c'.repeat(40)]: pulls(23, 'Add thumbnail health check'), ['a'.repeat(40)]: pulls(24, 'Detect rollouts on merged PRs') };
  f.queue.merged = { 21: { number: 21, merged_by: { login: 'octo-a' }, merged_at: minute(0) }, 23: { number: 23, merged_by: { login: 'octo-b' }, merged_at: minute(1) }, 24: { number: 24, merged_by: { login: 'fixture-user' }, merged_at: minute(2) } };
  f.queue.successes = [20, 24, 22, 30, 21].map((length, i) => ({ ...other(80 + i, 'completed', 0, 'e', { conclusion: 'success' }), run_started_at: minute(0), updated_at: minute(length) }));
}

test('a queued rollout lists the same-workflow runs ahead of it with their PR, who merged it, progress and a typical duration', async () => {
  const f = rolloutFixture(); queued(f);
  const value = await f.client.observe({ ...workflow, branch: 'main' }, signal());
  assert.equal(rolloutStatus(value).state, 'queued');
  const queue = value.queue!;
  assert.deepEqual(queue.ahead.map(entry => [entry.id, entry.status, entry.pull?.number, entry.pull?.title, entry.pull?.mergedBy]),
    [[99, 'in_progress', 21, 'Round invoice totals', 'octo-a'], [100, 'queued', 23, 'Add thumbnail health check', 'octo-b']]);
  assert.deepEqual(queue.ahead[0].jobs, { done: 5, total: 8, current: 'deploy / shard-5' });
  assert.equal(queue.ahead[0].startedAt, minute(12)); assert.equal(queue.ahead[0].url, 'https://github.com/fixture/web/actions/runs/99');
  assert.equal(queue.ahead[1].jobs, undefined); assert.equal(queue.ahead[0].stuck, undefined);
  assert.deepEqual([queue.you.id, queue.you.pull?.number, queue.you.pull?.mergedBy, queue.you.pull?.url], [101, 24, 'fixture-user', 'https://github.com/fixture/web/pull/24']);
  assert.equal(queue.typicalMs, 22 * 60_000); assert.equal(queue.branch, 'main');
  for (const status of ['in_progress', 'waiting', 'queued', 'pending']) assert.ok(f.paths.includes(`/repos/fixture/web/actions/workflows/9/runs?status=${status}&per_page=10&branch=main`), status);
  assert.ok(f.paths.includes('/repos/fixture/web/actions/workflows/9/runs?status=success&per_page=10&branch=main'));
  const lookups = () => f.paths.filter(path => path.includes('/commits/') || /\/pulls\/\d+$/.test(path) || path.includes('status=success')).length, before = lookups();
  assert.equal(before, 7);
  await f.client.observe({ ...workflow, branch: 'main' }, signal());
  assert.equal(lookups(), before, 'merged PRs and the typical duration are cached');
});

test('a blocker waiting for approval or failing is stuck; a run without a PR names its pusher; too few past runs give no estimate', async () => {
  const f = rolloutFixture(); queued(f);
  f.queue.runs[0] = other(99, 'waiting', 10, 'b', { updated_at: minute(19) });
  f.queue.gates[99] = [{ environment: { id: 1, name: 'production' }, wait_timer: 0, current_user_can_approve: false, reviewers: [{ type: 'Team' }] }];
  f.queue.pulls['c'.repeat(40)] = []; f.queue.successes = f.queue.successes.slice(0, 2);
  const queue = (await f.client.observe(key, signal())).queue!;
  assert.deepEqual(queue.ahead[0].stuck, { reason: 'approval', environment: 'production', since: minute(19) });
  assert.deepEqual([queue.ahead[1].pull, queue.ahead[1].actor], [undefined, 'pusher100']);
  assert.equal(queue.typicalMs, undefined); assert.equal(queue.branch, undefined);
  assert.ok(f.paths.includes('/repos/fixture/web/actions/workflows/9/runs?status=queued&per_page=10'));
  f.queue.runs[0] = other(99, 'in_progress', 10, 'b');
  f.queue.jobs[99][5] = { ...f.queue.jobs[99][5], status: 'completed', conclusion: 'failure', completed_at: minute(21) };
  assert.deepEqual((await f.client.observe(key, signal())).queue!.ahead[0].stuck, { reason: 'failing', since: minute(21) });
});

test('blockers are only read while queued, and failing to read them never fails the observation', async () => {
  const f = rolloutFixture(); queued(f);
  f.run = { ...f.run, status: 'in_progress' }; f.jobs = [{ id: 201, run_id: 101, name: 'deploy', status: 'in_progress', conclusion: null }];
  const running = await f.client.observe(key, signal());
  assert.equal(running.queue, undefined); assert.ok(!f.paths.some(path => path.includes('status=') || path.includes('/commits/')));
  queued(f); f.queue.fail = true;
  const value = await f.client.observe(key, signal());
  assert.equal(rolloutStatus(value).state, 'queued'); assert.equal(value.queue, undefined);
  f.queue.fail = false; f.queue.runs = [other(101, 'queued', 30, 'a')];
  assert.equal((await f.client.observe(key, signal())).queue, undefined, 'nothing ahead leaves no ladder');
});

test('the rollout transport allows only the queue reads it needs', async () => {
  const requests: string[] = [];
  const transport = githubRolloutTransport('fixture', { accounts: async () => [], token: async () => 'fixture-token' }, (async (url: any) => { requests.push(String(url)); return new Response('[]'); }) as typeof fetch);
  for (const path of ['/repos/fixture/web/actions/workflows/9/runs?status=in_progress&per_page=10', '/repos/fixture/web/actions/workflows/9/runs?status=pending&per_page=10&branch=release%2Fnext',
    '/repos/fixture/web/actions/workflows/9/runs?status=success&per_page=10', `/repos/fixture/web/commits/${'a'.repeat(40)}/pulls`, '/repos/fixture/web/pulls/21']) await transport.get(path, signal());
  assert.equal(requests.length, 5);
  for (const path of ['/repos/fixture/web/actions/workflows/9/runs?status=completed&per_page=10', '/repos/fixture/web/actions/workflows/9/runs?status=queued&per_page=100', `/repos/fixture/web/commits/${'a'.repeat(40)}/pulls?x=1`, '/repos/fixture/web/commits/main/pulls'])
    await assert.rejects(transport.get(path, signal()), /Unsupported/);
});

test('a run ships the pull requests merged since the previous successful run of its workflow: from commit messages or GitHub\'s list per commit, newest first, at most 30', async () => {
  const f = rolloutFixture(), sha = (n: number) => n.toString(16).padStart(40, '0');
  f.run = { ...f.run, run_number: 30, created_at: minute(30) };
  f.queue.successes = [{ ...other(101, 'completed', 30, 'a', { conclusion: 'success' }), run_number: 30 }, { ...other(96, 'completed', 25, 'f', { conclusion: 'success' }), run_number: 29, head_branch: 'release' },
    { ...other(95, 'completed', 20, 'c', { conclusion: 'success' }), run_number: 25 }, { ...other(90, 'completed', 10, 'e', { conclusion: 'success' }), run_number: 20 }];
  f.queue.compare = { total_commits: 4, commits: [
    { sha: sha(1), commit: { message: 'Batch billing exports (#12)\n\nDetails' } },
    { sha: sha(2), commit: { message: 'Merge pull request #14 from acme/search-threshold\n\nFix the search threshold' } },
    { sha: sha(3), commit: { message: 'Tidy outputs' } },
    { sha: 'a'.repeat(40), commit: { message: 'Export invoices as CSV (#16)' } } ] };
  f.queue.pulls[sha(3)] = pulls(15, 'Tidy the settings page');
  const shipped = await f.client.shipped(key, f.run, signal());
  assert.deepEqual(shipped.since, { runId: 95, commit: 'c'.repeat(40), url: 'https://github.com/fixture/web/actions/runs/95' });
  assert.deepEqual(shipped.pulls.map(pull => [pull.number, pull.title, pull.url]), [[16, 'Export invoices as CSV', 'https://github.com/fixture/web/pull/16'], [15, 'Tidy the settings page', 'https://github.com/fixture/web/pull/15'],
    [14, 'Fix the search threshold', 'https://github.com/fixture/web/pull/14'], [12, 'Batch billing exports', 'https://github.com/fixture/web/pull/12']]);
  assert.deepEqual([shipped.commits, shipped.truncated], [4, undefined]);
  assert.ok(f.paths.includes('/repos/fixture/web/actions/workflows/9/runs?status=success&per_page=10&branch=main'));
  assert.ok(f.paths.includes(`/repos/fixture/web/compare/${'c'.repeat(40)}...${'a'.repeat(40)}?per_page=100&page=1`));
  assert.deepEqual(f.paths.filter(path => path.includes('/commits/')), [`/repos/fixture/web/commits/${sha(3)}/pulls`], 'only a commit without a number is looked up');
  f.queue.compare = { total_commits: 300, commits: Array.from({ length: 100 }, (_, i) => ({ sha: sha(i + 10), commit: { message: `Change ${i} (#${4000 + i})` } })) };
  const many = await f.client.shipped(key, f.run, signal());
  assert.deepEqual([many.pulls.length, many.pulls[0].number, many.commits, many.truncated], [30, 4099, 300, true]);
  f.queue.successes = [{ ...other(101, 'completed', 30, 'a', { conclusion: 'success' }), run_number: 30 }];
  assert.deepEqual(await f.client.shipped(key, f.run, signal()), { pulls: [], commits: 0 }, 'no earlier successful run');
});

test('the rollout transport allows comparing two commits and nothing wider', async () => {
  const requests: string[] = [];
  const transport = githubRolloutTransport('fixture', { accounts: async () => [], token: async () => 'fixture-token' }, (async (url: any) => { requests.push(String(url)); return new Response('{}'); }) as typeof fetch);
  await transport.get(`/repos/fixture/web/compare/${'c'.repeat(40)}...${'a'.repeat(40)}?per_page=100&page=1`, signal());
  assert.equal(requests.length, 1);
  for (const path of [`/repos/fixture/web/compare/main...${'a'.repeat(40)}?per_page=100&page=1`, `/repos/fixture/web/compare/${'c'.repeat(40)}...${'a'.repeat(40)}`, `/repos/fixture/web/compare/${'c'.repeat(40)}..${'a'.repeat(40)}?per_page=100&page=1`])
    await assert.rejects(transport.get(path, signal()), /Unsupported/);
});

test('the connector reads what a run ships as read-only content for the run it is given', async () => {
  const f = rolloutFixture(), connector = githubRolloutConnector(() => f.client);
  const resource = { id: 'rollout', pluginId: githubRollout.id, schemaVersion: 1, title: 'Rollout', data: key } as any;
  const action = connector.actions!(resource).find(entry => entry.id === 'rollout.shipped')!;
  assert.deepEqual([action.readOnly, action.humanOnly], [true, undefined]);
  f.queue.successes = [{ ...other(95, 'completed', 20, 'c', { conclusion: 'success' }), run_number: 25 }];
  f.queue.compare = { total_commits: 1, commits: [{ sha: 'a'.repeat(40), commit: { message: 'Export invoices as CSV (#16)' } }] };
  const shipped = await connector.execute!(resource, 'rollout.shipped', signal(), { runId: 101, workflowId: 9, runNumber: 28, head: 'a'.repeat(40), branch: 'main' }) as any;
  assert.deepEqual([shipped.since.runId, shipped.pulls.map((pull: any) => pull.number)], [95, [16]]);
  assert.ok(f.paths.includes('/repos/fixture/web/actions/workflows/9/runs?status=success&per_page=10&branch=main'));
});
