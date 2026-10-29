import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearClient, LinearWorkflowCache, LINEAR_QUERIES, LINEAR_STATE_MUTATION, LINEAR_TRIAGE_PRIORITIES, LINEAR_TRIAGE_STATE_TYPES, linearTransport } from './linear.ts';
import { credentialStore, providerCredential } from './keychain.ts';
import { linearFixture, linearIssueId } from '../../tests/fixtures/linear.ts';
const signal = () => AbortSignal.timeout(3000);

test('Linear issue reads retain immutable identity, provider title/status and historical workspace/issue aliases', async () => {
  const fixture = linearFixture();
  for (const id of ['BIL-128', 'OLD-42', linearIssueId]) { const issue = await fixture.client.issue(id, 'old-fixture', signal()); assert.equal(issue.id, linearIssueId); assert.equal(issue.title, fixture.data.issue.title); assert.equal(issue.state.name, 'In Progress'); assert.match(issue.description, /<script>/); }
});
test('Linear rejects another workspace/account, mismatched issues, unsafe URLs and incomplete content', async () => {
  const fixture = linearFixture(); await assert.rejects(fixture.client.issue('BIL-128', 'different', signal()), /different Linear workspace/);
  await assert.rejects(new LinearClient(fixture.transport, 'wrong-account').issue('BIL-128', undefined, signal()), /another account/);
  await assert.rejects(fixture.client.issue('MISSING-99', undefined, signal()), /inconsistent/);
  for (const change of [{ url: 'https://evil.example/page' }, { description: 'x'.repeat(200_001) }, { identifier: 'OTHER-9' }, { title: '' }]) { const test = linearFixture(); Object.assign(test.data.issue, change); await assert.rejects(test.client.issue('BIL-128', 'fixture', signal())); }
});
test('Linear transport accepts only fixed read queries, handles GraphQL partial errors and never forwards provider errors', async () => {
  const calls: { url: string; input: RequestInit }[] = [];
  const transport = linearTransport('fixture-linear-token', async (url, input) => { calls.push({ url: String(url), input: input! }); return new Response(JSON.stringify({ data: linearFixture().data })); });
  await transport.read('issue', { id: 'BIL-128' }, signal()); assert.equal(calls[0].url, 'https://api.linear.app/graphql'); assert.equal(calls[0].input.redirect, 'error');
  const body = JSON.parse(String(calls[0].input.body)); assert.equal(body.query, LINEAR_QUERIES.issue); assert.ok(!/\bmutation\b/.test(body.query)); assert.deepEqual(body.variables, { id: 'BIL-128' });
  await assert.rejects(transport.read('mutation' as any, {}, signal()), /Unsupported/); await assert.rejects(transport.read('issue', { id: 'BIL-128) { mutation }' }, signal()), /Unsupported/); assert.equal(calls.length, 1);
  const partial = linearTransport('fixture-linear-token', async () => new Response(JSON.stringify({ data: linearFixture().data, errors: [{ message: 'PRIVATE TOKEN' }] })));
  await assert.rejects(partial.read('viewer', {}, signal()), error => error instanceof Error && error.message.includes('all requested fields') && !error.message.includes('PRIVATE'));
  const rate = linearTransport('fixture-linear-token', async () => new Response('', { status: 429, headers: { 'retry-after': '10' } })); await assert.rejects(rate.read('viewer', {}, signal()), error => (error as any).retryAt > Date.now());
});
test('Keychain reader passes no credentials as arguments and normalizes missing/invalid/aborted reads', async () => {
  const calls: string[][] = [];
  const read = providerCredential('linear', async args => { calls.push(args); return 'private-fixture-token\n'; }, credentialStore('darwin')); assert.equal(await read(signal()), 'private-fixture-token');
  assert.deepEqual(calls, [['find-generic-password', '-s', 'dev.agentcraftingtable.linear', '-a', 'default', '-w']]);
  await providerCredential('slack', async args => { calls.push(args); return 'private-fixture-token'; }, credentialStore('linux'))(signal());
  assert.deepEqual(calls.pop(), ['lookup', 'service', 'dev.agentcraftingtable.slack', 'account', 'default']);
  for (const value of ['bad\nvalue', 'short', '']) await assert.rejects(providerCredential('linear', async () => value)(signal()), /credentials are unavailable/);
  await assert.rejects(providerCredential('slack', async () => { throw new Error('PRIVATE TOKEN'); })(signal()), error => error instanceof Error && !error.message.includes('PRIVATE'));
  await assert.rejects(read(AbortSignal.abort()), { name: 'AbortError' }); assert.equal(calls.length, 1);
});

import { linearConnection } from './linear-connection.ts';
test('Linear discovery returns only observed account metadata from a Keychain credential', async () => {
  const fixture = linearFixture(), credentials: string[] = [];
  const adapter = linearConnection(async signal => { signal.throwIfAborted(); credentials.push('read'); return 'private-fixture-token'; }, token => { assert.equal(token, 'private-fixture-token'); return fixture.transport; });
  const accounts = await adapter.accounts(AbortSignal.timeout(1000)); assert.equal(accounts[0].id, fixture.account.id); assert.equal(accounts[0].label, 'Fixture Team · Fixture Developer'); assert.deepEqual(fixture.calls, ['viewer:']); assert.equal(credentials.length, 1); assert.ok(!JSON.stringify(accounts).includes('private-fixture-token'));
  await assert.rejects(adapter.accounts(AbortSignal.abort()), { name: 'AbortError' });
});

test('Linear state choices come from the issue team and explicit updates preserve issue identity', async () => {
  const fixture = linearFixture();
  fixture.states[2].name = 'Ready for QA';
  const choices = await fixture.client.workflow('BIL-128', 'fixture', signal());
  assert.deepEqual(choices.states.map(state => state.name), ['Todo', 'In Progress', 'Ready for QA', 'Done']);
  assert.equal(fixture.writes.length, 0);
  const input = { value: fixture.states[2].id, expectedStateId: choices.issue.state.id, expectedUpdatedAt: choices.issue.updatedAt };
  const changed = await fixture.client.setState('BIL-128', 'fixture', input, signal());
  assert.equal(changed.state.name, 'Ready for QA'); assert.equal(changed.id, linearIssueId);
  assert.deepEqual(fixture.writes, [{ id: linearIssueId, stateId: fixture.states[2].id }]);
  await fixture.client.setState('BIL-128', 'fixture', input, signal()); // already achieved
  assert.equal(fixture.writes.length, 1);
});

test('status writes reject stale menus, other teams, archived issues and wrong accounts before mutation', async () => {
  const fixture = linearFixture(), old = await fixture.client.issue('BIL-128', 'fixture', signal());
  const input = { value: fixture.states[3].id, expectedStateId: old.state.id, expectedUpdatedAt: old.updatedAt };
  await assert.rejects(fixture.client.setState('BIL-128', 'fixture', { ...input, value: '99999999-9999-4999-8999-999999999999' }, signal()), /current team workflow/);
  fixture.data.issue.updatedAt = '2026-09-28T13:00:00.000Z';
  await assert.rejects(fixture.client.setState('BIL-128', 'fixture', input, signal()), /changed in Linear/);
  fixture.data.issue.archivedAt = '2026-09-28T13:01:00.000Z';
  await assert.rejects(fixture.client.setState('BIL-128', 'fixture', input, signal()), /Restore/);
  fixture.data.issue.archivedAt = null;
  await assert.rejects(new LinearClient(fixture.transport, 'wrong-account').setState('BIL-128', 'fixture', input, signal()), /another account/);
  assert.equal(fixture.writes.length, 0);
});

test('status mutation transport fixes the operation and redacts failures without retries', async () => {
  const calls: RequestInit[] = [], fixture = linearFixture();
  const transport = linearTransport('fixture-linear-token', async (_url, request) => { calls.push(request!); return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: fixture.data.issue } } })); });
  await transport.updateState!(linearIssueId, fixture.states[3].id, signal());
  assert.deepEqual(JSON.parse(String(calls[0].body)), { query: LINEAR_STATE_MUTATION, variables: { id: linearIssueId, stateId: fixture.states[3].id } });
  await assert.rejects(transport.updateState!('BIL-128', fixture.states[3].id, signal()), /Invalid/); assert.equal(calls.length, 1);
  const failing = linearTransport('fixture-linear-token', async () => { throw new Error('PRIVATE TOKEN'); });
  await assert.rejects(failing.updateState!(linearIssueId, fixture.states[3].id, signal()), error => Boolean((error as any).outcomeUnknown) && !String(error).includes('PRIVATE'));
  const denied = linearTransport('fixture-linear-token', async () => new Response('', { status: 403 }));
  await assert.rejects(denied.updateState!(linearIssueId, fixture.states[3].id, signal()), /permission/);
});

test('incomplete workflows and ambiguous mutation responses cannot report a successful status change', async () => {
  for (const edit of [
    (result: any) => { result.team.id = null; },
    (result: any) => { result.team.states.pageInfo.hasNextPage = true; },
    (result: any) => { result.team.states.nodes.push(result.team.states.nodes[0]); },
    (result: any) => { result.team.states.nodes[0].name = ''; },
  ]) {
    const fixture = linearFixture(), original = fixture.transport.read;
    fixture.transport.read = async (...args) => { const result = await original(...args); if (args[0] === 'workflow') edit(result); return result; };
    await assert.rejects(fixture.client.workflow('BIL-128', 'fixture', signal()), /inconsistent/); assert.equal(fixture.writes.length, 0);
  }
  for (const result of [null, { issueUpdate: { success: false, issue: null } }, { issueUpdate: { success: true, issue: { id: 'wrong', state: {} } } }]) {
    const fixture = linearFixture(); fixture.transport.updateState = async () => result;
    await assert.rejects(fixture.client.setState('BIL-128', 'fixture', { value: fixture.states[3].id, expectedStateId: fixture.data.issue.state.id, expectedUpdatedAt: fixture.data.issue.updatedAt }, signal()), error => Boolean((error as any).outcomeUnknown));
  }
});

test('workflow catalogue is reused by different clients and issues while current issue state stays fresh', async () => {
  const fixture = linearFixture(), cache = new LinearWorkflowCache();
  const client = () => new LinearClient(fixture.transport, fixture.account.id, cache);
  const first = await client().workflow('BIL-128', 'fixture', signal());
  first.states[0].name = 'Caller cannot poison cache';
  fixture.data.issue.identifier = 'BIL-129';
  fixture.data.issue.url = 'https://linear.app/fixture/issue/BIL-129';
  fixture.data.issue.state = { ...fixture.states[2] };
  const second = await client().workflow('BIL-129', 'fixture', signal());
  assert.equal(second.issue.state.name, 'In Review');
  assert.equal(second.states[0].name, 'Todo');
  assert.equal(fixture.calls.filter(call => call.startsWith('workflow:')).length, 1);
  assert.equal(fixture.calls.filter(call => call.startsWith('issue:')).length, 2);
  assert.equal(fixture.writes.length, 0);
});

test('workflow cache isolates accounts and teams and refreshes an unknown current state', async () => {
  const fixture = linearFixture(), cache = new LinearWorkflowCache();
  const client = () => new LinearClient(fixture.transport, fixture.account.id, cache);
  await client().workflow('BIL-128', 'fixture', signal());
  fixture.data.issue.team.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await client().workflow('BIL-128', 'fixture', signal());
  fixture.data.issue.state = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Custom', type: 'started' };
  fixture.states.push({ ...fixture.data.issue.state, position: 5 });
  assert.equal((await client().workflow('BIL-128', 'fixture', signal())).states.length, 5);
  const other = linearFixture(); other.data.viewer.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const account = `${other.data.organization.id}/${other.data.viewer.id}`;
  await new LinearClient(other.transport, account, cache).workflow('BIL-128', 'fixture', signal());
  assert.equal(fixture.calls.filter(call => call.startsWith('workflow:')).length, 3);
  assert.equal(other.calls.filter(call => call.startsWith('workflow:')).length, 1);
});

test('status changes validate a fresh workflow even when choices were cached', async () => {
  const fixture = linearFixture(), choices = await fixture.client.workflow('BIL-128', 'fixture', signal());
  const removed = fixture.states.pop()!;
  await assert.rejects(fixture.client.setState('BIL-128', 'fixture', { value: removed.id, expectedStateId: choices.issue.state.id, expectedUpdatedAt: choices.issue.updatedAt }, signal()), /current team workflow/);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.calls.filter(call => call.startsWith('workflow:')).length, 2);
});

test('failed workflow reads are not cached and aborted callers cannot use cached choices', async () => {
  const fixture = linearFixture(), original = fixture.transport.read;
  let fail = true;
  fixture.transport.read = async (...args) => { if (args[0] === 'workflow' && fail) { fail = false; throw new Error('offline'); } return original(...args); };
  await assert.rejects(fixture.client.workflow('BIL-128', 'fixture', signal()), /offline/);
  assert.equal((await fixture.client.workflow('BIL-128', 'fixture', signal())).states.length, 4);
  await assert.rejects(fixture.client.workflow('BIL-128', 'fixture', AbortSignal.abort()), { name: 'AbortError' });
});

const ALL_STATES = ['triage', 'backlog', 'unstarted', 'started'], ANY_PRIORITY = [0, 1, 2, 3, 4];
const state = (type: string, number = 9) => ({ id: `99999999-9999-4999-8999-99999999999${number}`, name: type, type });
test('assigned issues use one fixed read query with a positive state allowlist and follow pages up to the cap', async () => {
  assert.match(LINEAR_QUERIES.assigned, /^query CraftingTableAssigned\(\$after: String, \$states: \[String!\]!, \$priorities: \[Float!\]!\)/); assert.ok(!/\bmutation\b/.test(LINEAR_QUERIES.assigned));
  assert.match(LINEAR_QUERIES.assigned, /assignedIssues\(first: 50, after: \$after, orderBy: updatedAt, filter: \{ state: \{ type: \{ in: \$states \} \}, priority: \{ in: \$priorities \} \}\)/);
  assert.ok(!/\bnin\b|"/.test(LINEAR_QUERIES.assigned), 'no negative filter and no literal in the query text');
  assert.deepEqual([...LINEAR_TRIAGE_STATE_TYPES], ALL_STATES); assert.deepEqual(LINEAR_TRIAGE_PRIORITIES, { any: ANY_PRIORITY, high: [1, 2], medium: [1, 2, 3] });
  const fixture = linearFixture(); fixture.assign(120);
  const all = await fixture.client.assignedIssues(signal());
  assert.equal(all.issues.length, 100); assert.equal(all.truncated, true); assert.deepEqual(fixture.calls, ['assigned:', 'assigned:50']);
  assert.deepEqual(fixture.filters, [{ states: ALL_STATES, priorities: ANY_PRIORITY }, { states: ALL_STATES, priorities: ANY_PRIORITY }], 'every page carries the same filter');
  assert.deepEqual(all.issues[0], { id: fixture.assigned[0].id, identifier: 'BIL-1', title: 'Assigned ticket 1', url: 'https://linear.app/fixture/issue/BIL-1/assigned-ticket-1', updatedAt: '2026-09-26T12:00:00.000Z', priority: 2, team: { id: '55555555-5555-4555-8555-555555555555', key: 'BIL', name: 'Billing team' }, state: { id: '66666666-6666-4666-8666-666666666666', name: 'Todo', type: 'unstarted' } });
  const few = linearFixture(); few.assign(3);
  assert.deepEqual(await few.client.assignedIssues(signal()).then(result => [result.issues.map(issue => issue.identifier), result.truncated]), [['BIL-1', 'BIL-2', 'BIL-3'], false]); assert.deepEqual(few.calls, ['assigned:']);
  const capped = linearFixture(); capped.assign(60);
  assert.deepEqual(await capped.client.assignedIssues(signal(), {}, 50).then(result => [result.issues.length, result.truncated]), [50, true]); assert.deepEqual(capped.calls, ['assigned:']);
});
test('the chosen statuses and priority become query variables from the fixed lists only', async () => {
  const types = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'];
  const make = () => { const fixture = linearFixture(); fixture.assign(7).forEach((issue, index) => { issue.state = state(types[index], index); issue.priority = index % 5; }); return fixture; };
  for (const [stateTypes, expected] of [[undefined, ALL_STATES], [['started', 'triage'], ['triage', 'started']], [['backlog'], ['backlog']], [['unstarted', 'backlog', 'triage'], ['triage', 'backlog', 'unstarted']]] as [string[] | undefined, string[]][]) {
    const fixture = make(), result = await fixture.client.assignedIssues(signal(), { stateTypes: stateTypes as never });
    assert.deepEqual(fixture.filters, [{ states: expected, priorities: ANY_PRIORITY }]);
    assert.deepEqual(result.issues.map(issue => issue.state.type), expected); assert.equal(result.truncated, false);
  }
  for (const [priority, priorities, identifiers] of [['any', ANY_PRIORITY, ['BIL-1', 'BIL-2', 'BIL-3', 'BIL-4']], ['high', [1, 2], ['BIL-2', 'BIL-3']], ['medium', [1, 2, 3], ['BIL-2', 'BIL-3', 'BIL-4']]] as const) {
    const fixture = make(), result = await fixture.client.assignedIssues(signal(), { priority });
    assert.deepEqual(fixture.filters, [{ states: ALL_STATES, priorities }]); assert.deepEqual(result.issues.map(issue => issue.identifier), identifiers);
  }
  const none = make(); assert.deepEqual(await none.client.assignedIssues(signal(), { stateTypes: [] }), { issues: [], truncated: false }); assert.deepEqual(none.calls, [], 'nothing selected reads nothing');
  for (const filter of [{ stateTypes: ['completed'] }, { stateTypes: ['duplicate'] }, { stateTypes: ['canceled', 'started'] }, { stateTypes: ['started", "completed'] }, { stateTypes: ['started', 'started'] }, { stateTypes: 'started' }, { stateTypes: [1] }, { priority: 'low' }, { priority: 'constructor' }, { priority: 1 }]) {
    const fixture = make(); await assert.rejects(fixture.client.assignedIssues(signal(), filter as never), /Unsupported Linear ticket filter/, JSON.stringify(filter)); assert.deepEqual(fixture.calls, []);
  }
});
test('assigned issues drop duplicate, finished and unknown states again locally, reject other accounts and malformed pages, and never report a partial list', async () => {
  for (const unfiltered of [false, true]) {
    const fixture = linearFixture(); fixture.assign(6); fixture.paging.unfiltered = unfiltered;
    fixture.assigned[1].state = { id: '88888888-8888-4888-8888-888888888888', name: 'Done', type: 'completed' };
    fixture.assigned[2].state = { ...state('duplicate', 1), name: 'Duplicate' }; fixture.assigned[3].state = state('canceled', 2); fixture.assigned[4].state = state('paused', 3);
    assert.deepEqual((await fixture.client.assignedIssues(signal())).issues.map(issue => issue.identifier), ['BIL-1', 'BIL-6'], `server filter ${unfiltered ? 'ignored' : 'applied'}`);
    fixture.assigned[0].state = state('backlog', 4); fixture.assigned[5].priority = 4;
    assert.deepEqual((await fixture.client.assignedIssues(signal(), { stateTypes: ['unstarted'], priority: 'medium' })).issues, [], 'a ticket outside the selection never comes back');
  }
  const fixture = linearFixture(); fixture.assign(3);
  await assert.rejects(new LinearClient(fixture.transport, 'wrong-account').assignedIssues(signal()), /another account/);
  for (const change of [{ url: 'https://evil.example/BIL-1' }, { identifier: 'nope' }, { title: '' }, { id: 'not-a-uuid' }, { priority: 'high' }]) {
    const broken = linearFixture(); broken.assign(2); broken.paging.unfiltered = true; Object.assign(broken.assigned[0], change); await assert.rejects(broken.client.assignedIssues(signal()), /incomplete or inconsistent/);
  }
  const looping = linearFixture(); looping.assign(60); looping.paging.size = 10; looping.paging.repeatCursor = true;
  await assert.rejects(looping.client.assignedIssues(signal()), /incomplete or inconsistent/);
  await assert.rejects(fixture.client.assignedIssues(AbortSignal.abort()), { name: 'AbortError' });
});
test('the transport allows the assigned read only with allowlisted statuses and priorities and an optional opaque cursor', async () => {
  const bodies: any[] = [];
  const transport = linearTransport('fixture-linear-token', async (_url, input) => { bodies.push(JSON.parse(String(input!.body))); return new Response(JSON.stringify({ data: {} })); });
  const filter = { states: ['backlog', 'started'], priorities: [1, 2] };
  await transport.read('assigned', filter, signal()); await transport.read('assigned', { ...filter, after: 'b7c1e2aa-0000-4000-8000-000000000001' }, signal()); await transport.read('assigned', { states: ALL_STATES, priorities: ANY_PRIORITY }, signal());
  assert.deepEqual(bodies.map(body => [body.query === LINEAR_QUERIES.assigned, body.variables]), [[true, filter], [true, { ...filter, after: 'b7c1e2aa-0000-4000-8000-000000000001' }], [true, { states: ALL_STATES, priorities: ANY_PRIORITY }]]);
  for (const variables of [{}, { states: ['started'] }, { priorities: [1] }, { ...filter, id: 'BIL-128' }, { ...filter, after: '' }, { ...filter, after: '") { mutation' }, { ...filter, after: 'x'.repeat(201) },
    { ...filter, states: [] }, { ...filter, states: ['completed'] }, { ...filter, states: ['canceled'] }, { ...filter, states: ['duplicate'] }, { ...filter, states: ['started', 'duplicate'] }, { ...filter, states: ['Started'] }, { ...filter, states: ['started"] } } }) { mutation'] },
    { ...filter, states: ['started', 'started'] }, { ...filter, states: 'started' }, { ...filter, states: [['started']] }, { ...filter, states: [...ALL_STATES, 'triage'] },
    { ...filter, priorities: [] }, { ...filter, priorities: [5] }, { ...filter, priorities: [-1] }, { ...filter, priorities: [1.5] }, { ...filter, priorities: ['1'] }, { ...filter, priorities: [1, 1] }, { ...filter, priorities: 1 }])
    await assert.rejects(transport.read('assigned', variables as any, signal()), /Unsupported/, JSON.stringify(variables));
  await assert.rejects(transport.read('viewer', { after: 'cursor' } as any, signal()), /Unsupported/); await assert.rejects(transport.read('issue', { id: 'BIL-128', after: 'cursor' } as any, signal()), /Unsupported/);
  await assert.rejects(transport.read('issue', { id: 'BIL-128', states: ['started'] } as any, signal()), /Unsupported/);
  assert.equal(bodies.length, 3);
});

test('an issue lists the GitHub pull requests attached to it, once each, and ignores every other attachment', async () => {
  const fixture = linearFixture();
  Object.assign(fixture.data.issue, { attachments: { nodes: [
    { url: 'https://github.com/acme/app/pull/42' }, { url: 'https://github.com/Acme/App/pull/42/files' }, { url: 'https://github.com/acme/api/pull/7#discussion' },
    { url: 'https://github.com/acme/app/issues/3' }, { url: 'https://evil.example/acme/app/pull/1' }, { url: 'https://slack.com/archives/C1/p1' }, { url: 42 },
  ] } });
  assert.deepEqual((await fixture.client.issue('BIL-128', undefined, signal())).pulls, [{ owner: 'acme', repo: 'app', number: 42 }, { owner: 'acme', repo: 'api', number: 7 }]);
  const none = linearFixture();
  assert.deepEqual((await none.client.issue('BIL-128', undefined, signal())).pulls, [], 'a read without attachments has none');
  assert.match(LINEAR_QUERIES.issue, /attachments\(first: 50\) \{ nodes \{ url \} \}/);
});
