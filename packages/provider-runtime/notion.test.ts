import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient, notionInlineMarkdown } from './notion.ts';
import { allowedNotionRead, notionCredentials, notionTransport } from './notion-transport.ts';
import { notionFixture, notionPageId, notionBotId, notionBlockId, notionCursor, notionComment, notionColleagueId } from '../../tests/fixtures/notion.ts';
const signal = () => AbortSignal.timeout(3000);

test('Notion reads every title/content page and nested block without executing provider text', async () => {
  const fixture = notionFixture(), page = await fixture.client.page(notionPageId, signal());
  assert.equal(page.title, 'Billing experience'); assert.equal(page.blocks.length, 3); assert.equal(page.blocks[1].depth, 1); assert.equal(page.blocks[1].text, '[ ] Keep the current cycle'); assert.match(page.blocks[2].text, /<script>/);
  assert.equal(page.incomplete, false); assert.equal(fixture.calls.filter(path => path === `/v1/pages/${notionPageId}`).length, 2);
});
test('Notion rich text becomes escaped inline Markdown with annotations and links', async () => {
  const text = (plain_text: string, annotations: Record<string, boolean> = {}, href?: string) => ({ type: 'text', plain_text, href: href ?? null, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, ...annotations } });
  assert.equal(notionInlineMarkdown([text('Keep '), text('next_invoice_at', { code: true }), text(' and '), text('the FAQ', { bold: true }, 'https://www.example.com/faq'), text(' '), text('old', { strikethrough: true }), text(' '), text('soon', { italic: true })]),
    'Keep `next_invoice_at` and [**the FAQ**](https://www.example.com/faq) ~~old~~ *soon*');
  assert.equal(notionInlineMarkdown([text('<script>x</script> *not* [a](b) # 1. _x_')]), '&lt;script&gt;x&lt;/script&gt; \\*not\\* \\[a\\](b) \\# 1\\. \\_x\\_');
  assert.equal(notionInlineMarkdown([text('a `tick`', { code: true })]), '`` a `tick` ``');
  assert.equal(notionInlineMarkdown([text('bold ', { bold: true })]), '**bold** ');
  assert.equal(notionInlineMarkdown([text('link', {}, 'javascript:alert(1)')]), 'link');
  const fixture = notionFixture(), page = await fixture.client.page(notionPageId, signal());
  assert.equal(page.blocks[0].markdown, 'Plan requirements'); assert.equal(page.blocks[1].checked, false); assert.equal(page.blocks[1].markdown, 'Keep the current cycle');
  assert.equal(page.blocks[2].markdown, '&lt;script&gt;window.notionInjected=true&lt;/script&gt;');
});
test('Notion rejects repeated cursors, missing nested data, changed revisions and wrong accounts', async () => {
  const root = `/v1/blocks/${notionPageId}/children?page_size=100`, second = root + '&start_cursor=' + notionCursor;
  let fixture = notionFixture(); fixture.responses[second].has_more = true; fixture.responses[second].next_cursor = notionCursor; await assert.rejects(fixture.client.page(notionPageId, signal()), /inconsistent/);
  fixture = notionFixture(); delete fixture.responses[`/v1/blocks/${notionBlockId}/children?page_size=100`]; await assert.rejects(fixture.client.page(notionPageId, signal()), /Fixture path missing/);
  fixture = notionFixture(); let reads = 0; fixture.before(path => { if (path === `/v1/pages/${notionPageId}` && ++reads === 2) fixture.responses[path].last_edited_time = 'changed'; }); await assert.rejects(fixture.client.page(notionPageId, signal()), /changed while reading/);
  fixture = notionFixture(); await assert.rejects(new NotionClient(fixture.transport, 'a'.repeat(32)).page(notionPageId, signal()), /different account/); assert.deepEqual(fixture.calls, ['/v1/users/me']);
});
test('Notion unknown blocks are visibly incomplete, text bounds and cancellation fail explicitly', async () => {
  const fixture = notionFixture(), path = `/v1/blocks/${notionBlockId}/children?page_size=100`;
  fixture.responses[path].results[0] = { object: 'block', id: '7'.repeat(32), type: 'unsupported', unsupported: {}, has_children: false };
  const page = await fixture.client.page(notionPageId, signal()); assert.equal(page.incomplete, true); assert.match(page.blocks[1].text, /open in Notion/);
  const large = notionFixture(); large.responses[path].results[0].to_do.rich_text[0].plain_text = 'a'.repeat(200_001); await assert.rejects(large.client.page(notionPageId, signal()), /text reading limit/);
  const empty = notionFixture(); await assert.rejects(empty.client.page(notionPageId, AbortSignal.abort()), { name: 'AbortError' }); assert.equal(empty.calls.length, 0);
});
test('Notion CLI profiles stay account scoped across switches and token rotation without returning credentials', async () => {
  const config = { current_profile: 'work', profiles: { work: { token: 'fixture-token-1', bot_id: notionBotId, workspace_name: 'Team' }, other: { token: 'fixture-token-2', bot_id: 'a'.repeat(32), workspace_name: 'Other' } } };
  const credentials = notionCredentials(async () => config), accounts = await credentials.accounts(signal()); assert.equal(accounts.length, 2); assert.ok(!JSON.stringify(accounts).includes('fixture-token'));
  const id = accounts.find(account => account.active)!.id; config.current_profile = 'other'; assert.equal((await credentials.token(id, signal())).token, 'fixture-token-1');
  config.profiles.work.token = 'rotated-fixture-token'; assert.equal((await credentials.token(id, signal())).token, 'rotated-fixture-token');
  config.profiles.work.bot_id = 'b'.repeat(32); await assert.rejects(credentials.token(id, signal()), /profile changed/);
});
test('Notion native transport permits GET metadata/content only, preserves cooldown and never exposes provider errors', async () => {
  for (const path of ['https://evil.example/v1/users/me', '//evil.example/v1/users/me', '/v1/search', '/v1/pages', '/v1/users/me?token=secret', `/v1/pages/${notionPageId}/comments`, `/v1/blocks/${notionBlockId}/children?start_cursor=arbitrary`, '/v1/comments', `/v1/comments?block_id=${notionPageId}`, `/v1/comments?block_id=x&page_size=100`, `/v1/comments?block_id=${notionPageId}&page_size=100&block_id=${notionBlockId}`, `/v1/comments?block_id=${notionPageId}&page_size=100&filter=all`]) assert.equal(allowedNotionRead(path), false, path);
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher = async (url: string | URL | Request, options?: RequestInit) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const transport = notionTransport('private-fixture-token', fetcher);
  await transport.get('/v1/users/me', signal()); assert.equal(calls[0].options?.method, 'GET'); assert.equal(calls[0].options?.redirect, 'error'); assert.equal(calls[0].url, 'https://api.notion.com/v1/users/me');
  await assert.rejects(transport.get('/v1/search', signal()), /Unsupported/); assert.equal(calls.length, 1);
  for (const path of [`/v1/comments?block_id=${notionPageId}&page_size=100`, `/v1/comments?block_id=${notionPageId}&page_size=100&start_cursor=${notionCursor}`]) assert.equal(allowedNotionRead(path), true, path);
  await assert.rejects(notionTransport('private-fixture-token', async () => new Response('{}', { status: 403 })).get(`/v1/comments?block_id=${notionPageId}&page_size=100`, signal()), (error: Error & { status?: number }) => error.status === 403);
  for (const code of [401, 403, 404, 429, 500]) await assert.rejects(notionTransport('private-fixture-token', async () => new Response('PRIVATE PROVIDER ERROR', { status: code, headers: { 'retry-after': '20' } })).get('/v1/users/me', signal()), error => error instanceof Error && !error.message.includes('PRIVATE') && (code !== 429 || (error as any).retryAt > Date.now()));
});

test('Notion comments are paginated, normalized to identities and timestamps, and reject repeated cursors', async () => {
  const fixture = notionFixture(), first = `/v1/comments?block_id=${notionPageId}&page_size=100`;
  fixture.responses[first] = { object: 'list', results: [notionComment('a', '2026-09-26T12:00:00.000Z')], has_more: true, next_cursor: notionCursor };
  fixture.responses[`${first}&start_cursor=${notionCursor}`] = { object: 'list', results: [notionComment('b', '2026-09-26T12:01:00.000Z', { author: notionBotId, parent: notionBlockId })], has_more: false, next_cursor: null };
  const comments = await fixture.client.comments(notionPageId, signal());
  assert.deepEqual(comments.map(comment => [comment.id, comment.authorId, comment.parentId, comment.createdAt]), [['a'.repeat(32), notionColleagueId, notionPageId, '2026-09-26T12:00:00.000Z'], ['b'.repeat(32), notionBotId, notionBlockId, '2026-09-26T12:01:00.000Z']]);
  fixture.responses[`${first}&start_cursor=${notionCursor}`].has_more = true; fixture.responses[`${first}&start_cursor=${notionCursor}`].next_cursor = notionCursor;
  await assert.rejects(fixture.client.comments(notionPageId, signal()), /inconsistent/);
});
test('an unchanged Notion page reuses its content in two requests and names the OAuth owner as a viewer', async () => {
  const fixture = notionFixture(), page = await fixture.client.page(notionPageId, signal());
  assert.deepEqual(page.viewers, [notionBotId]);
  fixture.calls.length = 0;
  const again = await fixture.client.page(notionPageId, signal(), page);
  assert.deepEqual(fixture.calls, ['/v1/users/me', `/v1/pages/${notionPageId}`]); assert.deepEqual(again.blocks, page.blocks);
  fixture.responses['/v1/users/me'].bot.owner = { type: 'user', user: { object: 'user', id: notionColleagueId } };
  fixture.responses[`/v1/pages/${notionPageId}`].last_edited_time = '2026-09-27T12:00:00.000Z'; fixture.calls.length = 0;
  const edited = await fixture.client.page(notionPageId, signal(), page);
  assert.ok(fixture.calls.length > 2, 'an edited page is read in full'); assert.deepEqual(edited.viewers, [notionBotId, notionColleagueId]);
});
