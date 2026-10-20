import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubWorkflowClient, workflowContract } from './github-workflow.ts';
import { githubTransport, githubWorkflowTransport } from './github-transport.ts';
import { GitHubError } from './github.ts';
import { timedWorkflowYaml, workflowFixture, workflowYaml } from '../../tests/fixtures/workflow.ts';
const identity = { owner: 'fixture', repo: 'billing', number: 42 }, at = '2026-09-25T12:00:00Z';
const signal = () => AbortSignal.timeout(3000);

test('workflow capability tiers: exact run-name contract, timed comment trigger, otherwise unsupported with a reason', async () => {
  for (const yaml of [workflowYaml, workflowYaml.replace('    types: [created]\n', ''), workflowYaml.replace('    types: [created]\n', '').replace('issue_comment:', 'issue_comment: null'),
    workflowYaml.replace('types: [created]', 'types: created')]) assert.deepEqual(workflowContract(yaml), { tracking: 'exact' }, yaml);
  const timed = [timedWorkflowYaml, workflowYaml.replace('ACT review comment {0}', 'Review {0}'), workflowYaml.replace(/run-name:[^\n]*\n[^\n]*\n/, ''),
    timedWorkflowYaml.replace('  review:\n', '  pr-review:\n    name: review\n')];
  for (const yaml of timed) assert.deepEqual(workflowContract(yaml), { tracking: 'timed' }, yaml);
  const unsupported = [workflowYaml + '\nrun-name: fake', workflowYaml.replace('created', 'edited'), workflowYaml.replace('  review:', '  another-job:'),
    workflowYaml.replace('steps:', 'name: other\n    steps:'), timedWorkflowYaml.replace(/issue_comment:\n {4}types: \[created\]\n/, ''),
    timedWorkflowYaml.replace(/ {4}steps:\n {6}- uses: actions\/checkout@v4\n {6}- uses: anthropics\/claude-code-action@v1\n$/, '    uses: ./.github/workflows/review.yml\n'),
    timedWorkflowYaml.replace('  claude:\n', '  claude:\n    name: review\n'), 'x: !!js/function function(){}', 'x'.repeat(300_000), '- a list', ''];
  for (const yaml of unsupported) { const contract = workflowContract(yaml); assert.equal(contract.tracking, undefined, yaml.slice(0, 200)); assert.ok(contract.reason, yaml.slice(0, 200)); }
  assert.match(workflowContract(workflowYaml.replace('created', 'edited')).reason!, /issue_comment/);
  assert.match(workflowContract(workflowYaml.replace('  review:', '  another-job:')).reason!, /exactly one review job/);
  const f = workflowFixture(); assert.deepEqual(await f.client.capability(identity, signal()), { supported: true, tracking: 'exact', workflowSha: 'c'.repeat(40), workflowId: 3 });
  f.yaml = timedWorkflowYaml; assert.deepEqual(await f.client.capability(identity, signal()), { supported: true, tracking: 'timed', workflowSha: 'c'.repeat(40), workflowId: 3 });
  f.yaml = 'name: old'; const missing = await f.client.capability(identity, signal()); assert.equal(missing.supported, false); assert.equal(missing.tracking, undefined); assert.match(missing.reason!, /issue_comment/);
  f.yaml = workflowYaml; f.status = 404; assert.equal((await f.client.capability(identity, signal())).supported, false);
  f.status = 403; await assert.rejects(f.client.capability(identity, signal()), { code: 'GITHUB_FORBIDDEN' });
  assert.equal(f.posts, 0);
});

test('preflight freezes actor, comment IDs and workflow identity; uncertain writes require explicit reconciliation', async () => {
  const f = workflowFixture(), preflight = await f.client.preflight(identity, signal());
  assert.deepEqual(preflight, { author: 'fixture-developer', knownCommentIds: [], workflowSha: 'c'.repeat(40), workflowId: 3, tracking: 'exact' });
  f.yaml = timedWorkflowYaml; assert.equal((await f.client.preflight(identity, signal())).tracking, 'timed'); f.yaml = workflowYaml;
  f.postFailure = new GitHubError('GITHUB_POST_UNCERTAIN', 'fixture timeout');
  await assert.rejects(f.client.post(identity, preflight.author, signal()), { code: 'GITHUB_POST_UNCERTAIN' });
  assert.deepEqual(await f.client.candidates(identity, preflight, at, signal()), [101]); assert.equal(f.posts, 1);
  assert.deepEqual(await f.client.candidateDetails(identity, preflight, at, signal()), [{ id: 101, author: 'fixture-developer', createdAt: f.comments[0].created_at, body: '/review' }]);
  f.yaml = 'name: old'; await assert.rejects(f.client.preflight(identity, signal()), { code: 'WORKFLOW_UNSUPPORTED' }); assert.equal(f.posts, 1);
});

test('workflow observation pins exact trigger, run, job, bot comment and completed report', async () => {
  const f = workflowFixture(); f.complete();
  const result = await f.client.observe(identity, 101, at, signal());
  assert.equal(result.status, 'complete'); assert.equal(result.runId, 200); assert.equal(result.jobId, 300); assert.equal(result.resultCommentId, 400); assert.match(result.report!, /Fixture findings/);
  assert.equal((await f.client.observe(identity, 102, at, signal())).status, 'not-observed');
  assert.equal((await f.client.observe(identity, 102, at, signal(), undefined, true)).status, 'timed-out');
  f.runs.push({ ...f.runs[0], id: 201 }); assert.equal((await f.client.observe(identity, 101, at, signal())).status, 'ambiguous');
  f.runs.pop(); f.runs[0].run_attempt = 2; assert.equal((await f.client.observe(identity, 101, at, signal())).status, 'ambiguous');
});

test('green without report waits, cancellation/failure propagate, multiple or changed identities are never adopted', async () => {
  const f = workflowFixture(); f.complete();
  f.comments[0].body = '[Run](https://github.com/fixture/billing/actions/runs/200) Preparing…';
  assert.equal((await f.client.observe(identity, 101, at, signal())).status, 'awaiting-result');
  assert.equal((await f.client.observe(identity, 101, at, signal(), undefined, true)).status, 'timed-out');
  f.jobs[0].conclusion = 'cancelled'; assert.equal((await f.client.observe(identity, 101, at, signal())).status, 'cancelled');
  f.jobs[0].conclusion = 'failure'; assert.equal((await f.client.observe(identity, 101, at, signal())).status, 'failed');
  assert.equal((await f.client.observe(identity, 101, at, signal(), { jobId: 301 })).status, 'ambiguous');
  assert.equal((await f.client.observe(identity, 101, at, signal(), { resultCommentId: 401 })).status, 'ambiguous');
  f.comments.push({ ...f.comments[0], id: 402 }); assert.equal((await f.client.observe(identity, 101, at, signal())).status, 'ambiguous');
});

async function timedFixture(now = Date.parse('2026-09-25T12:10:00Z')) {
  const f = workflowFixture(); f.yaml = timedWorkflowYaml;
  const preflight = await f.client.preflight(identity, signal()); await f.client.post(identity, preflight.author, signal());
  const client = new GitHubWorkflowClient(f, () => now);
  const observe = (pinned?: { runId?: number; jobId?: number; resultCommentId?: number }, deadline = false) => client.observe(identity, 101, at, signal(), pinned, deadline, preflight.workflowId, preflight.tracking);
  const run = (id: number, seconds: number, review: { status: string; conclusion: string | null } | undefined, status = 'in_progress') => {
    f.runs.push({ ...f.runs[0] ?? { workflow_id: 3, path: '.github/workflows/review.yml@main', event: 'issue_comment', display_title: 'Claude Code', run_attempt: 1, conclusion: null, repository: { full_name: 'fixture/billing' } }, id, created_at: f.later(at, seconds), status });
    if (review) f.jobs.push({ id: id + 1000, run_id: id, name: 'review', ...review });
  };
  return { f, preflight, client, observe, run, setNow(value: number) { now = value; } };
}

test('timed tracking adopts the single review run near the trigger comment and its bot result without a run-name', async () => {
  const { f, preflight, observe } = await timedFixture();
  assert.equal(preflight.tracking, 'timed');
  assert.deepEqual(await observe(), { status: 'not-observed' });
  assert.equal((await observe(undefined, true)).status, 'timed-out');
  f.complete(101, 'Claude Code');
  const result = await observe();
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(result.runId, 200); assert.equal(result.jobId, 300); assert.equal(result.resultCommentId, 400);
  assert.equal(result.runUrl, 'https://github.com/fixture/billing/actions/runs/200'); assert.match(result.report!, /Fixture findings/);
  assert.ok(f.paths.some(path => path.includes('/runs?event=issue_comment&created=2026-09-25T11%3A59%3A50.000Z..2026-09-25T12%3A03%3A00.000Z&')), f.paths.join('\n'));
  f.runs[0].created_at = f.later(at, -6); assert.equal((await observe()).status, 'complete', 'small clock skew before the comment');
  f.runs[0].created_at = f.later(at, 181); assert.equal((await observe()).status, 'not-observed', 'after the window');
  f.runs[0].created_at = f.later(at, -11); assert.equal((await observe()).status, 'not-observed', 'before the window');
});

test('timed tracking ignores skipped runs, waits for undecided ones and never guesses between candidates', async () => {
  const { f, observe, run } = await timedFixture();
  f.complete(101, 'Claude Code');
  run(201, 20, { status: 'completed', conclusion: 'skipped' }, 'completed'); run(202, 30, undefined, 'completed');
  assert.equal((await observe()).status, 'complete', 'comment runs that skipped the review job are not candidates');
  run(203, 40, undefined, 'queued');
  assert.equal((await observe()).status, 'not-observed', 'a run that has not decided its review job yet blocks adoption');
  f.jobs.push({ id: 1203, run_id: 203, name: 'review', status: 'queued', conclusion: null });
  assert.equal((await observe()).status, 'not-observed', 'a queued review job may still be skipped');
  f.jobs.at(-1)!.status = 'in_progress';
  const ambiguous = await observe();
  assert.equal(ambiguous.status, 'ambiguous'); assert.match(ambiguous.reason!, /more than one/i);
  assert.equal(ambiguous.runsUrl, 'https://github.com/fixture/billing/actions/workflows/review.yml'); assert.equal(ambiguous.runId, undefined);
});

test('timed tracking refuses another /review on the pull request within the window', async () => {
  const { f, observe } = await timedFixture();
  f.complete(101, 'Claude Code');
  f.comments.push({ id: 102, body: '/review', user: { login: 'someone-else' }, created_at: f.later(at, 45), updated_at: f.later(at, 45) });
  const result = await observe();
  assert.equal(result.status, 'ambiguous'); assert.match(result.reason!, /another \/review/i); assert.equal(result.runsUrl, 'https://github.com/fixture/billing/actions/workflows/review.yml');
  f.comments.at(-1)!.created_at = f.later(at, -600); assert.equal((await observe()).status, 'complete');
});

test('timed tracking finds the result comment by run URL after the trigger and keeps pinned identities', async () => {
  const { f, observe, run } = await timedFixture();
  f.complete(101, 'Claude Code');
  const report = f.comments.find(comment => comment.id === 400)!;
  report.created_at = f.later(at, -60); assert.equal((await observe()).status, 'awaiting-result', 'a bot comment older than the trigger is not this result');
  report.created_at = f.later(at, 3); report.user.login = 'someone-else'; assert.equal((await observe()).status, 'awaiting-result');
  report.user.login = 'github-actions[bot]'; report.body = report.body.replace('/runs/200', '/runs/299'); assert.equal((await observe()).status, 'awaiting-result');
  report.body = report.body.replace('/runs/299', '/runs/200');
  assert.equal((await observe({ runId: 200, jobId: 300, resultCommentId: 400 })).status, 'complete');
  assert.equal((await observe({ runId: 199 })).status, 'ambiguous');
  f.runs[0].run_attempt = 2; assert.equal((await observe()).status, 'ambiguous'); f.runs[0].run_attempt = 1;
  for (let id = 500; id < 521; id++) run(id, 10 + id - 500, { status: 'completed', conclusion: 'skipped' }, 'completed');
  assert.match((await observe()).reason ?? '', /too many/i);
});

test('timed tracking holds a finished report until no other /review can share its window', async () => {
  const { f, observe, setNow } = await timedFixture(Date.parse(at) + 60_000);
  f.complete(101, 'Claude Code');
  const early = await observe(); assert.equal(early.status, 'awaiting-result'); assert.equal(early.report, undefined); assert.equal(early.runId, 200);
  setNow(Date.parse(at) + 3 * 60_000 + 1000); assert.equal((await observe()).status, 'complete');
});

test('a trigger comment missing from the listing is not observed yet', async () => {
  const { f, observe } = await timedFixture();
  f.complete(101, 'Claude Code'); f.comments.splice(f.comments.findIndex(comment => comment.id === 101), 1);
  assert.equal((await observe()).status, 'not-observed'); assert.equal((await observe(undefined, true)).status, 'timed-out');
});

test('workflow transport is account-scoped, posts only the exact body, blocks redirects and never retries interrupted POST', async () => {
  const calls: RequestInit[] = [], tokens: string[] = [];
  const credentials = { accounts: async () => [], token: async (login: string) => { tokens.push(login); return 'fixture-secret'; } };
  const fetcher = (async (_url, options) => { calls.push(options!); throw new Error('accepted then disconnected'); }) as typeof fetch;
  const api = githubWorkflowTransport('fixture-developer', credentials, fetcher);
  await assert.rejects(api.postReview(identity, signal()), { code: 'GITHUB_POST_UNCERTAIN' });
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body, '{"body":"/review"}'); assert.equal(calls[0].redirect, 'error'); assert.deepEqual(tokens, ['fixture-developer']);
  for (const path of ['https://evil.test', '/repos/fixture/billing/contents/secret', '/repos/fixture/../contents/.github/workflows/review.yml', '/repos/fixture/billing/actions/runs/1/cancel']) await assert.rejects(api.get(path, signal()), { code: 'GITHUB_INVALID_PATH' });
  await assert.rejects(githubTransport('fixture-developer', credentials, fetcher).get('/repos/fixture/billing/actions/workflows/review.yml', signal()), { code: 'GITHUB_INVALID_PATH' });
  assert.equal(calls.length, 1);
});

test('malformed accepted replies and 5xx are uncertain; definite auth rejection cannot be reported as success', async () => {
  for (const status of [201, 502]) {
    const api = new GitHubWorkflowClient({ get: async () => { throw new Error('unused'); }, postReview: async () => ({ status, body: {}, headers: new Headers() }) });
    await assert.rejects(api.post(identity, 'fixture-developer', signal()), { code: 'GITHUB_POST_UNCERTAIN' });
  }
  const api = new GitHubWorkflowClient({ get: async () => { throw new Error('unused'); }, postReview: async () => ({ status: 401, body: {}, headers: new Headers() }) });
  await assert.rejects(api.post(identity, 'fixture-developer', signal()), { code: 'GITHUB_AUTH' });
});

test('workflow pagination is bounded, validates all pages and never follows server-provided URLs', async () => {
  const paths: string[] = [];
  const api = new GitHubWorkflowClient({ async get(path) { paths.push(path); return { status: 200, headers: new Headers({ link: '<https://evil.test>; rel="next"' }), body: { workflow_runs: [] } }; }, postReview: async () => { throw new Error('writes forbidden'); } });
  await assert.rejects(api.observe(identity, 101, at, signal()), { code: 'GITHUB_CONTENT_LIMIT' });
  assert.equal(paths.length, 10); assert.ok(paths.every(path => path.startsWith('/repos/fixture/billing/actions/workflows/review.yml/runs?')));
});

test('a configured contract reads its own workflow file and review job through the native reader', async () => {
  const fixture = workflowFixture(); fixture.yaml = workflowYaml.replace('  review:\n', '  agent-review:\n'); fixture.complete();
  fixture.runs = fixture.runs.map(run => ({ ...run, path: '.github/workflows/agent.yml@main' })); fixture.jobs = fixture.jobs.map(job => ({ ...job, name: 'agent-review' }));
  const transport = githubWorkflowTransport('fixture-developer', { accounts: async () => [], token: async () => 'fixture-token' }, (async (url, options) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const response = path.endsWith('/actions/workflows/agent.yml') ? { status: 200, headers: new Headers(), body: { id: 3, state: 'active', path: '.github/workflows/agent.yml' } } : await fixture.get(path, options!.signal!);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
  }) as typeof fetch);
  const contract = { workflowPath: '.github/workflows/agent.yml', jobName: 'agent-review', failureText: '' };
  const client = new GitHubWorkflowClient(transport, Date.now, contract);
  assert.deepEqual(await client.capability(identity, signal()), { supported: true, tracking: 'exact', workflowSha: 'c'.repeat(40), workflowId: 3 });
  assert.ok(fixture.paths.includes('/repos/fixture/billing/contents/.github/workflows/agent.yml'));
  assert.equal((await client.observe(identity, 101, at, signal(), undefined, false, 3)).status, 'complete');
  assert.match((await new GitHubWorkflowClient(transport).capability(identity, signal())).reason!, /\.github\/workflows\/review\.yml/, 'the default contract does not accept another workflow');
  assert.match(workflowContract(fixture.yaml).reason!, /exactly one review job/);
});

test('native workflow reader allows the pinned workflow and attempt endpoints without sending a write', async () => {
  const fixture = workflowFixture(); fixture.complete();
  const methods: string[] = [];
  const transport = githubWorkflowTransport('fixture-developer', { accounts: async () => [], token: async () => 'fixture-token' }, (async (url, options) => {
    methods.push(options!.method!); assert.equal(new URL(String(url)).origin, 'https://api.github.com');
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const response = await fixture.get(path, options!.signal!);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
  }) as typeof fetch);
  const client = new GitHubWorkflowClient(transport);
  const preflight = await client.preflight(identity, signal());
  assert.equal((await client.observe(identity, 101, at, signal(), undefined, false, preflight.workflowId)).status, 'complete');
  fixture.yaml = timedWorkflowYaml; fixture.complete(101, 'Claude Code');
  fixture.comments.push({ id: 101, body: '/review', user: { login: 'fixture-developer' }, created_at: at, updated_at: at });
  const timed = await client.preflight(identity, signal());
  assert.equal((await client.observe(identity, 101, at, signal(), undefined, false, timed.workflowId, timed.tracking)).status, 'complete');
  assert.ok(methods.every(method => method === 'GET'));
});
