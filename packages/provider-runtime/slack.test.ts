import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlackClient, SlackReadError, slackTransport } from './slack.ts';
import type { SlackTransport } from './slack.ts';
import { slackFixture, slackInput, slackRoot, slackSelected, slackUrl } from '../../tests/fixtures/slack.ts';

test('Slack reads a paginated thread with exact timestamps, selected reply, safe text and attributed authors', async () => {
  const fixture = slackFixture(), thread = await fixture.client.thread(slackInput, AbortSignal.timeout(1000));
  assert.equal(thread.threadTs, slackRoot); assert.equal(thread.selectedTs, slackSelected); assert.equal(thread.url, slackUrl); assert.deepEqual(thread.messages.map(message => message.author), ['Alex', 'Sam']); assert.deepEqual(thread.messages.map(message => message.selected), [false, true]); assert.match(thread.messages[1].text, /<script>/);
  assert.ok(fixture.calls.every(call => ['auth.test', 'conversations.info', 'conversations.replies', 'users.info'].includes(call.method)));
  assert.ok(fixture.calls.filter(call => call.method === 'conversations.replies').every(call => call.args.ts === slackRoot));
  const selected = await fixture.client.thread({ ...slackInput, scope: 'message', threadTs: undefined }, AbortSignal.timeout(1000)); assert.equal(selected.scope, 'message'); assert.equal(selected.threadTs, slackRoot);
});

test('Slack account/workspace checks precede content reads and a mismatched/deleted selected message fails', async () => {
  const fixture = slackFixture();
  await assert.rejects(new SlackClient(fixture.transport, 'other').thread(slackInput, AbortSignal.timeout(1000)), /another account/); assert.deepEqual(fixture.calls.map(call => call.method), ['auth.test']);
  await assert.rejects(fixture.client.thread({ ...slackInput, workspaceHost: 'other.slack.com' }, AbortSignal.timeout(1000)), /another Slack workspace/);
  await assert.rejects(fixture.client.thread({ ...slackInput, threadTs: '1790000000.000009' }, AbortSignal.timeout(1000)), /inconsistent/);
  fixture.pages[1].messages[0].ts = '1790000000.000003'; await assert.rejects(fixture.client.thread(slackInput, AbortSignal.timeout(1000)), /selected Slack message/);
  fixture.pages[1].messages[0].ts = slackSelected; Object.assign(fixture.pages[1].messages[0], { subtype: 'message_deleted' }); await assert.rejects(fixture.client.thread(slackInput, AbortSignal.timeout(1000)), /inconsistent/);
});

test('Slack pagination rejects missing/repeated cursors, duplicate/out-of-order messages and excessive content', async () => {
  const missing = slackFixture(); missing.pages[0].response_metadata.next_cursor = ''; await assert.rejects(missing.client.thread(slackInput, AbortSignal.timeout(1000)), /inconsistent/);
  const cycle = slackFixture(); cycle.pages[1].has_more = true; cycle.pages[1].response_metadata.next_cursor = 'next-page'; await assert.rejects(cycle.client.thread(slackInput, AbortSignal.timeout(1000)), /inconsistent/);
  const duplicate = slackFixture(); duplicate.pages[1].messages.push(structuredClone(duplicate.pages[1].messages[0]) as never); await assert.rejects(duplicate.client.thread(slackInput, AbortSignal.timeout(1000)), /inconsistent/);
  const large = slackFixture(); large.pages[1].messages[0].text = 'x'.repeat(40_001); await assert.rejects(large.client.thread(slackInput, AbortSignal.timeout(1000)), /inconsistent/);
});

test('Slack attribution falls back to exact user IDs for missing profile scope but never hides rate limits or cancellation', async () => {
  const fixture = slackFixture(); fixture.before(method => { if (method === 'users.info') throw new SlackReadError('No profile scope', 'MISSING_SCOPE'); });
  const value = await fixture.client.thread(slackInput, AbortSignal.timeout(1000)); assert.deepEqual(value.messages.map(message => message.author), ['U12345', 'U67890']);
  fixture.before(method => { if (method === 'users.info') throw new SlackReadError('Cooldown', 'RATE_LIMITED'); }); await assert.rejects(fixture.client.thread(slackInput, AbortSignal.timeout(1000)), /Cooldown/);
  await assert.rejects(fixture.client.thread(slackInput, AbortSignal.abort()), { name: 'AbortError' });
});

test('Slack transport permits only fixed read methods, keeps tokens out of URLs and normalizes errors and cooldown', async () => {
  const requests: { url: string; init?: RequestInit }[] = []; let response = () => Response.json({ ok: true });
  const transport = slackTransport('xoxp-fixture-private-token', async (url, init) => { requests.push({ url: String(url), init }); return response(); }); // public-safety: fake
  await transport.read('auth.test', {}, AbortSignal.timeout(1000)); assert.equal(requests[0].init?.method, 'POST'); assert.equal(requests[0].url, 'https://slack.com/api/auth.test');
  await transport.read('conversations.replies', { channel: 'C12345', ts: slackRoot, limit: '15', cursor: 'next+page=' }, AbortSignal.timeout(1000)); assert.equal(requests[1].init?.method, 'GET'); assert.equal(new URL(requests[1].url).searchParams.get('cursor'), 'next+page='); assert.ok(!requests[1].url.includes('private-token'));
  await assert.rejects(transport.read('chat.postMessage' as never, {}, AbortSignal.timeout(1000)), /Unsupported/); await assert.rejects(transport.read('auth.test', { token: 'extra' }, AbortSignal.timeout(1000)), /Unsupported/); assert.equal(requests.length, 2);
  response = () => Response.json({ ok: false, error: 'private-provider-error-with-secret' }); await assert.rejects(transport.read('auth.test', {}, AbortSignal.timeout(1000)), error => /could not return/.test((error as Error).message) && !String(error).includes('secret'));
  response = () => Response.json({}, { status: 429, headers: { 'retry-after': '60' } }); await assert.rejects(transport.read('auth.test', {}, AbortSignal.timeout(1000)), error => (error as { retryAt: number }).retryAt >= Date.now() + 59_000);
});

import { slackConnection } from './slack-connection.ts';
test('Slack connection discovery returns account metadata without exposing its token', async () => {
  const fixture = slackFixture();
  const adapter = slackConnection(async signal => { signal.throwIfAborted(); return 'xoxp-private-fixture-token'; }, token => { assert.equal(token, 'xoxp-private-fixture-token'); return fixture.transport; }); // public-safety: fake
  const accounts = await adapter.accounts(AbortSignal.timeout(1000)); assert.equal(accounts[0].id, fixture.account.id); assert.equal(accounts[0].label, 'Fixture workspace · developer'); assert.ok(!JSON.stringify(accounts).includes('private-fixture-token')); assert.deepEqual(fixture.calls.map(call => call.method), ['auth.test']);
  await assert.rejects(adapter.accounts(AbortSignal.abort()), { name: 'AbortError' });
});

test('Slack repeats the thread root at the top of every page; the repeat is skipped, not treated as a duplicate', async () => {
  const fixture = slackFixture(); fixture.pages[1].messages.unshift(structuredClone(fixture.pages[0].messages[0]) as never);
  const thread = await fixture.client.thread(slackInput, AbortSignal.timeout(1000));
  assert.deepEqual(thread.messages.map(message => message.ts), [slackRoot, slackSelected]);
  const repeated = slackFixture(); repeated.pages[1].messages.push(structuredClone(repeated.pages[1].messages[0]) as never);
  await assert.rejects(repeated.client.thread(slackInput, AbortSignal.timeout(1000)), /inconsistent/);
});

test('a link to a reply without its thread timestamp is read through the thread the reply names', async () => {
  const fixture = slackFixture(), reply = fixture.pages[1].messages[0], asked: string[] = [];
  const transport: SlackTransport = { async read(method, args, signal) {
    if (method !== 'conversations.replies') return fixture.transport.read(method, args, signal);
    asked.push(args.ts);
    return args.ts === slackSelected ? { ok: true, messages: [structuredClone(reply)], has_more: false } : fixture.transport.read(method, args, signal);
  } };
  const thread = await new SlackClient(transport, fixture.account.id).thread({ ...slackInput, scope: 'message', threadTs: undefined }, AbortSignal.timeout(1000));
  assert.equal(thread.threadTs, slackRoot); assert.equal(thread.selectedTs, slackSelected); assert.equal(thread.scope, 'message');
  assert.deepEqual(thread.messages.map(message => message.selected), [false, true]);
  assert.deepEqual(asked, [slackSelected, slackRoot, slackRoot]);
});

test('a message Slack attributes to no member or bot is shown under its posted name instead of failing the thread', async () => {
  const named = slackFixture(); Object.assign(named.pages[1].messages[0], { user: undefined, bot_id: undefined, subtype: 'bot_message', username: 'Release workflow' });
  assert.deepEqual((await named.client.thread(slackInput, AbortSignal.timeout(1000))).messages.map(message => message.author), ['Alex', 'Release workflow']);
  const anonymous = slackFixture(); Object.assign(anonymous.pages[1].messages[0], { user: undefined, bot_id: undefined });
  const thread = await anonymous.client.thread(slackInput, AbortSignal.timeout(1000));
  assert.equal(thread.messages[1].author, 'Unknown sender'); assert.equal(thread.messages[1].userId, '');
});

test('an inconsistent Slack read names the failed check without quoting conversation content', async () => {
  const repeated = slackFixture(); repeated.pages[1].messages.push(structuredClone(repeated.pages[1].messages[0]) as never);
  await assert.rejects(repeated.client.thread(slackInput, AbortSignal.timeout(1000)), { message: 'Slack returned incomplete or inconsistent conversation data (repeated message).' });
  const cycle = slackFixture(); cycle.pages[1].has_more = true; cycle.pages[1].response_metadata.next_cursor = 'next-page';
  await assert.rejects(cycle.client.thread(slackInput, AbortSignal.timeout(1000)), { message: 'Slack returned incomplete or inconsistent conversation data (repeated page).' });
});

test('a page may carry the thread root on top of the requested replies; only an absurd page is rejected', async () => {
  const ts = (index: number) => `1790000001.${String(index).padStart(6, '0')}`;
  const fixture = slackFixture(), root = fixture.pages[0].messages[0], reply = fixture.pages[1].messages[0];
  const replies = Array.from({ length: 14 }, (_, index) => ({ ...structuredClone(reply), ts: ts(index), text: `reply ${index}` }));
  fixture.pages[0].messages = [root, structuredClone(reply), ...replies] as never;
  fixture.pages[0].has_more = false; fixture.pages[0].response_metadata.next_cursor = '';
  assert.equal(fixture.pages[0].messages.length, 16);
  const thread = await fixture.client.thread(slackInput, AbortSignal.timeout(1000));
  assert.equal(thread.messages.length, 16); assert.equal(thread.messages[1].selected, true);
  const flood = slackFixture();
  flood.pages[0].messages = [root, ...Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(reply), ts: ts(index) }))] as never;
  await assert.rejects(flood.client.thread(slackInput, AbortSignal.timeout(1000)), { message: 'Slack returned incomplete or inconsistent conversation data (oversized reply page).' });
  const empty = slackFixture(); empty.pages[0].messages = [];
  await assert.rejects(empty.client.thread(slackInput, AbortSignal.timeout(1000)), { message: 'Slack returned incomplete or inconsistent conversation data (empty reply page).' });
});

test('Slack pages a long thread newest replies first, each page led by the root; the thread reads oldest first', async () => {
  const ts = (index: number) => `1790000001.${String(index).padStart(6, '0')}`;
  const fixture = slackFixture(), root = fixture.pages[0].messages[0], reply = fixture.pages[1].messages[0];
  const replies = Array.from({ length: 25 }, (_, index) => ({ ...structuredClone(reply), ts: ts(index), text: `reply ${index}` }));
  fixture.pages[0].messages = [root, ...replies.slice(10)] as never;
  fixture.pages[1].messages = [structuredClone(root), ...replies.slice(0, 10)] as never;
  const thread = await fixture.client.thread({ ...slackInput, messageTs: ts(3) }, AbortSignal.timeout(1000));
  assert.deepEqual(thread.messages.map(message => message.ts), [slackRoot, ...replies.map(message => message.ts)]);
  assert.deepEqual(thread.messages.filter(message => message.selected).map(message => message.text), ['reply 3']);
  const twice = slackFixture(); twice.pages[0].messages = [root, ...replies.slice(10)] as never; twice.pages[1].messages = [structuredClone(root), ...replies.slice(0, 11)] as never;
  await assert.rejects(twice.client.thread(slackInput, AbortSignal.timeout(1000)), { message: 'Slack returned incomplete or inconsistent conversation data (repeated message).' });
});
