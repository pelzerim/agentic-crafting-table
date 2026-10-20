import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from './github.ts';
import { githubCommentTransport, githubMergeTransport, githubRolloutApprovalTransport, githubTransport, githubWorkflowTransport, titleUpdate } from './github-transport.ts';
import { githubFixture, pullFixture } from '../../tests/fixtures/github.ts';
import { githubPullRequestConnector } from '../../src/resource-plugins/items/github-pull-request/connector.ts';
import { showShipChoices, taggedTitle, titleProblem, titleTag } from '../../src/resource-plugins/items/github-pull-request/show-ship.ts';

const signal = () => AbortSignal.timeout(10_000), key = { owner: 'fixture', repo: 'billing', number: 42 }, base = pullFixture.title;

test('title tags are recognised at either end, switched in place and never stacked', () => {
  assert.deepEqual(titleTag(base), { tag: '', base });
  assert.deepEqual(titleTag(`[Ship] ${base}`), { tag: 'ship', base });
  assert.deepEqual(titleTag(`${base} [SHOW]`), { tag: 'show', base });
  assert.deepEqual(titleTag(`[ship]${base}`), { tag: 'ship', base });
  assert.equal(titleTag(`[ask] ${base}`).tag, '');
  assert.equal(titleTag(`Fix [ship] parsing`).tag, '');
  assert.equal(taggedTitle(base, 'ship'), `[ship] ${base}`);
  assert.equal(taggedTitle(`[ship] ${base}`, 'show'), `[show] ${base}`);
  assert.equal(taggedTitle(`${base} [Ship]`, 'show'), `[show] ${base}`);
  assert.equal(taggedTitle(`[SHIP] ${base} [show]`, 'ship'), `[ship] ${base}`);
  assert.equal(taggedTitle(`[ship] ${base}`, ''), base);
  assert.deepEqual(titleTag(`[show] [ship] ${base} [ship]`), { tag: 'show', base });
  assert.equal(taggedTitle(`[show] [ship] ${base}`, 'ship'), `[ship] ${base}`);
  assert.deepEqual(titleTag('[ship]'), { tag: 'ship', base: '' });
  assert.match(titleProblem(taggedTitle('[ship]', '')) ?? '', /would be empty/);
  assert.equal(titleProblem(taggedTitle('x'.repeat(249), 'ship')), undefined);
  assert.match(titleProblem(taggedTitle('x'.repeat(250), 'ship')) ?? '', /256-character limit/);
});

test('choices mark the current tag, offer the other and Remove tag, and only warn for closed PRs', () => {
  const open = { number: 42, title: base, state: 'open', merged: false };
  assert.deepEqual(showShipChoices(open), { current: '', prompt: `Retitle #42 “${base}” on GitHub?`, options: [
    { id: 'show', label: '[show]', description: `Becomes “[show] ${base}”` }, { id: 'ship', label: '[ship]', description: `Becomes “[ship] ${base}”` }] });
  const shipped = showShipChoices({ ...open, title: `[ship] ${base}` }) as { current: string; options: { id: string; description: string }[] };
  assert.equal(shipped.current, 'ship');
  assert.deepEqual(shipped.options.map(option => [option.id, option.description]), [['show', `Becomes “[show] ${base}”`], ['ship', 'Current tag'], ['none', `Becomes “${base}”`]]);
  const long = showShipChoices({ ...open, title: 'x'.repeat(250) }) as { options: { id: string; disabled?: boolean }[] };
  assert.deepEqual(long.options.map(option => option.disabled), [true, true]);
  for (const [pull, warning] of [[{ ...open, state: 'closed' }, 'GitHub reports it is closed.'], [{ ...open, state: 'closed', merged: true }, 'GitHub reports it is merged.']] as const)
    assert.deepEqual(showShipChoices(pull), { ...showShipChoices(open), prompt: `Retitle #42 “${base}” on GitHub? ${warning}` });
});

test('title transport sends exactly one PATCH of { title } and nothing else', async () => {
  const requests: { url: string; method: string; body: string }[] = []; let credentials = 0;
  const fetcher = (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method, body: options.body }); return Response.json({}); }) as typeof fetch;
  const auth = { accounts: async () => [], token: async () => { credentials++; return 'fixture-token'; } };
  const transport = githubMergeTransport('fixture', auth, fetcher);
  await transport.setTitle!(key, '[ship] Tag me', signal());
  assert.deepEqual(requests.map(r => [r.url, r.method, JSON.parse(r.body)]), [['https://api.github.com/repos/fixture/billing/pulls/42', 'PATCH', { title: '[ship] Tag me' }]]);
  const before = credentials;
  for (const title of ['', '   ', 'x'.repeat(257)]) await assert.rejects(transport.setTitle!(key, title, signal()), /Unsupported/);
  await assert.rejects(async () => transport.setTitle!({ owner: '../x', repo: 'billing', number: 42 }, 'x', signal()), /valid GitHub/);
  for (const path of ['/repos/fixture/billing/pulls/42', '/repos/fixture/billing/issues/42']) await assert.rejects(transport.postComment!(path, 'x', signal()), /Unsupported/);
  assert.equal(credentials, before);
  for (const reader of [githubTransport('fixture', auth, fetcher), githubCommentTransport('fixture', auth, fetcher), githubRolloutApprovalTransport('fixture', auth, fetcher)]) assert.equal(reader.setTitle, undefined);
  assert.equal((githubWorkflowTransport('fixture', auth, fetcher) as { setTitle?: unknown }).setTitle, undefined);
  let sent = 0; const interrupted = githubMergeTransport('fixture', auth, (async () => { sent++; throw new TypeError('socket closed'); }) as typeof fetch);
  await assert.rejects(interrupted.setTitle!(key, '[ship] x', signal()), (error: any) => error.code === 'GITHUB_POST_UNCERTAIN');
  assert.equal(sent, 1);
});

test('the PATCH allowlist accepts only a PR path with exactly { title }', () => {
  assert.equal(titleUpdate('/repos/fixture/billing/pulls/42', { title: '[ship] x' }), true);
  assert.equal(titleUpdate('/repos/fixture/billing/pulls/42', { title: 'x'.repeat(256) }), true);
  for (const [path, payload] of [
    ['/repos/fixture/billing/pulls/42', { title: '[ship] x', body: 'x' }], ['/repos/fixture/billing/pulls/42', { title: '[ship] x', state: 'closed' }], ['/repos/fixture/billing/pulls/42', { state: 'closed' }],
    ['/repos/fixture/billing/pulls/42', { base: 'main' }], ['/repos/fixture/billing/pulls/42', { title: 42 }], ['/repos/fixture/billing/pulls/42', { title: ' ' }], ['/repos/fixture/billing/pulls/42', { title: 'x'.repeat(257) }], ['/repos/fixture/billing/pulls/42', {}],
    ['/repos/fixture/billing/issues/42', { title: 'x' }], ['/repos/fixture/billing/pulls/42/merge', { title: 'x' }], ['/repos/fixture/billing/pulls/42?x=1', { title: 'x' }], ['/repos/fixture/billing', { title: 'x' }],
    ['/repos/fixture/../pulls/42', { title: 'x' }], ['/repos/fixture/billing/pulls/0', { title: 'x' }], ['https://evil.example/repos/fixture/billing/pulls/42', { title: 'x' }], ['/graphql', { title: 'x' }],
  ] as const) assert.equal(titleUpdate(path, payload), false, `${path} ${JSON.stringify(payload)}`);
});

test('retitle sends the PATCH without judging GitHub state first, writes once and reports uncertain replies', async () => {
  const f = githubFixture();
  await assert.rejects(f.client.retitle(key, '', signal()), /1–256/);
  await assert.rejects(f.client.retitle(key, 'x'.repeat(257), signal()), /1–256/);
  assert.equal(f.titles.length, 0);
  f.delay(async () => { throw new Error('a title change must not read first'); });
  f.pull = { ...f.pull, state: 'closed', title: 'Renamed by someone else' }; await f.client.retitle(key, `[ship] ${base}`, signal());
  assert.deepEqual(f.titles, [`[ship] ${base}`]); f.titles.length = 0; f.delay(undefined);
  f.pull = { ...f.pull, state: 'open' };
  assert.equal(f.titles.length, 0);
  const reply = (status: number, body: unknown) => f.replyToTitle(() => ({ status, body, headers: new Headers() }));
  reply(422, { message: 'Validation Failed' }); await assert.rejects(f.client.retitle(key, `[ship] ${base}`, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && !error.outcomeUnknown);
  reply(403, {}); await assert.rejects(f.client.retitle(key, `[ship] ${base}`, signal()), (error: any) => error.code === 'GITHUB_FORBIDDEN');
  for (const [status, body] of [[502, null], [200, { ...pullFixture, title: 'Renamed by someone else' }], [200, { unexpected: true }], [201, { ...pullFixture, title: `[ship] ${base}` }]] as const) {
    reply(status, body); await assert.rejects(f.client.retitle(key, `[ship] ${base}`, signal()), (error: any) => error.outcomeUnknown === true && error.message === 'GitHub may have renamed it. Check the PR before trying again.');
  }
  f.replyToTitle(() => { throw Object.assign(new Error('interrupted'), { code: 'GITHUB_POST_UNCERTAIN' }); });
  await assert.rejects(f.client.retitle(key, `[ship] ${base}`, signal()), (error: any) => error.outcomeUnknown === true);
  const writes = f.titles.length; assert.equal(writes, 7);
  f.replyToTitle(undefined); await f.client.retitle(key, `[ship] ${base}`, signal());
  assert.deepEqual(f.titles.at(-1), `[ship] ${base}`); assert.equal(f.pull.title, `[ship] ${base}`);
  await assert.rejects(new GitHubClient({ get: async () => { throw new Error('unused'); } }).retitle(key, 'x', signal()), /unavailable for this connection/);
});

test('connector binds options to this PR title, switches or removes the tag and returns the refreshed snapshot', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client);
  const resource = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: key } as any;
  const action = connector.actions!(resource).find(action => action.id === 'pr.showShip')!;
  assert.equal(action.humanOnly, true); assert.equal(action.updatesSnapshot, true);
  assert.equal(connector.actions!(resource).find(action => action.id === 'pr.showShip.options')?.readOnly, true);
  const choices = await connector.execute!(resource, 'pr.showShip.options', signal()) as any;
  assert.deepEqual(choices.context, { sourceResourceId: 'pr', expectedTitle: base }); assert.equal(choices.current, '');
  await assert.rejects(connector.execute!(resource, 'pr.showShip', signal(), { ...choices.context, value: 'ship', sourceResourceId: 'other', requestId: 'x' }), /another item/);
  await assert.rejects(connector.execute!(resource, 'pr.showShip', signal(), { ...choices.context, value: 'ask', requestId: 'x' }), /incomplete/);
  assert.equal(f.titles.length, 0);
  const shipped = await connector.execute!(resource, 'pr.showShip', signal(), { ...choices.context, value: 'ship', requestId: 'x' }) as any;
  assert.deepEqual(f.titles, [`[ship] ${base}`]); assert.equal(shipped.snapshot.title, `[ship] ${base}`);
  const again = await connector.execute!(resource, 'pr.showShip.options', signal()) as any;
  assert.equal(again.current, 'ship'); assert.deepEqual(again.options.map((option: any) => option.id), ['show', 'ship', 'none']);
  const noop = await connector.execute!(resource, 'pr.showShip', signal(), { ...again.context, value: 'ship', requestId: 'x' }) as any;
  assert.equal(f.titles.length, 1); assert.equal(noop.snapshot.title, `[ship] ${base}`);
  const shown = await connector.execute!(resource, 'pr.showShip', signal(), { ...again.context, value: 'show', requestId: 'x' }) as any;
  assert.equal(shown.snapshot.title, `[show] ${base}`);
  const removed = await connector.execute!(resource, 'pr.showShip', signal(), { sourceResourceId: 'pr', expectedTitle: `[show] ${base}`, value: 'none', requestId: 'x' }) as any;
  assert.equal(removed.snapshot.title, base); assert.deepEqual(f.titles, [`[ship] ${base}`, `[show] ${base}`, base]);
  f.pull = { ...f.pull, merged: true, state: 'closed' };
  const merged = await connector.execute!(resource, 'pr.showShip.options', signal()) as any;
  assert.equal(merged.prompt, `Retitle #42 “${base}” on GitHub? GitHub reports it is merged.`);
  await connector.execute!(resource, 'pr.showShip', signal(), { ...merged.context, value: 'ship', requestId: 'x' });
  assert.equal(f.titles.at(-1), `[ship] ${base}`);

  const r = githubFixture(), refreshing = githubPullRequestConnector(() => r.client);
  r.delay(async () => { if (r.titles.length) throw new Error('offline'); });
  await assert.rejects(refreshing.execute!(resource, 'pr.showShip', signal(), { sourceResourceId: 'pr', expectedTitle: base, value: 'show', requestId: 'x' }), (error: any) => error.outcomeUnknown === true && /Title updated, but refresh failed/.test(error.message));
  assert.equal(r.titles.length, 1);
});
