import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentId, isImageData, isSignedImageUrl, signedImage } from './github-media.ts';
import { GitHubClient } from './github.ts';
import type { GitHubResponse } from './github.ts';
import { githubImage, githubMergeTransport } from './github-transport.ts';

const id = '1eca903e-7316-4cc3-80c9-dd2fc4b1c717', attachment = `https://github.com/user-attachments/assets/${id}`;
const signed = `https://private-user-images.githubusercontent.com/1/2-${id}.png?jwt=fixture.token`;
const html = `<p>Before:</p><a href="${signed.replace('&', '&amp;')}"><img alt="image" src="${signed}&amp;x=1"></a>`;
const identity = { owner: 'fixture', repo: 'billing', number: 42 }, signal = () => AbortSignal.timeout(1000);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('only GitHub attachment addresses are recognised as inline images', () => {
  assert.equal(attachmentId(attachment), id);
  assert.equal(attachmentId(`https://github.com/fixture/billing/assets/12/${id.toUpperCase()}`), id);
  for (const other of [`http://github.com/user-attachments/assets/${id}`, `https://github.com.example/user-attachments/assets/${id}`, `https://github.com/user-attachments/assets/${id}/../x`,
    'https://images.example.test/tracker.png', `https://github.com/user-attachments/files/${id}`, 'javascript:alert(1)']) assert.equal(attachmentId(other), undefined, other);
});

test('the signed copy is found by attachment id in the rendered body, decoded and on a GitHub image host', () => {
  assert.equal(signedImage(html, id), `${signed}&x=1`);
  assert.equal(signedImage(html, '00000000-0000-0000-0000-000000000000'), undefined);
  assert.equal(signedImage(`<img src="https://images.example.test/${id}.png">`, id), undefined);
  assert.equal(isSignedImageUrl(signed), true);
  assert.equal(isSignedImageUrl(`http://private-user-images.githubusercontent.com/${id}.png`), false);
  assert.equal(isSignedImageUrl(`https://camo.githubusercontent.com/${id}`), false);
});

test('image data is a base64 data URL of an allowed raster type only', () => {
  assert.equal(isImageData('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isImageData('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(isImageData('https://example.com/image.png'), false);
});

test('the client reads the rendered body of the one comment and returns the image as data', async () => {
  const reads: string[] = [], images: string[] = [];
  const client = new GitHubClient({ async get() { throw new Error('not used'); },
    async html(path) { reads.push(path); return { status: 200, headers: new Headers(), body: { body_html: html, issue_url: 'https://api.github.com/repos/fixture/billing/issues/42' } }; },
    async image(url) { images.push(url); return { type: 'image/png', bytes: png }; } });
  assert.equal(await client.attachment(identity, { kind: 'discussion', id: 5 }, attachment, signal()), `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  await client.attachment(identity, { kind: 'inline', id: 6 }, attachment, signal());
  await client.attachment(identity, { kind: 'review', id: 7 }, attachment, signal());
  await client.attachment(identity, { kind: 'description' }, attachment, signal());
  assert.deepEqual(reads, ['/repos/fixture/billing/issues/comments/5', '/repos/fixture/billing/pulls/comments/6', '/repos/fixture/billing/pulls/42/reviews/7', '/repos/fixture/billing/pulls/42']);
  assert.deepEqual(images, Array(4).fill(`${signed}&x=1`));
  await assert.rejects(client.attachment(identity, { kind: 'discussion', id: 5 }, 'https://images.example.test/tracker.png', signal()), /Only GitHub attachments/);
  await assert.rejects(client.attachment(identity, { kind: 'discussion' }, attachment, signal()), /comment/);
  await assert.rejects(client.attachment(identity, { kind: 'discussion', id: 5 }, `https://github.com/user-attachments/assets/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, signal()), /no longer lists/);
  assert.equal(reads.length, 5);
});

test('a comment from another issue or pull request is refused', async () => {
  const reply = (body: object): GitHubResponse => ({ status: 200, headers: new Headers(), body: { body_html: html, ...body } });
  let next = reply({ issue_url: 'https://api.github.com/repos/fixture/billing/issues/7' });
  const client = new GitHubClient({ async get() { throw new Error('not used'); }, async html() { return next; }, async image() { return { type: 'image/png', bytes: png }; } });
  await assert.rejects(client.attachment(identity, { kind: 'discussion', id: 5 }, attachment, signal()), /another/);
  next = reply({ pull_request_url: 'https://api.github.com/repos/fixture/billing/pulls/7' });
  await assert.rejects(client.attachment(identity, { kind: 'inline', id: 6 }, attachment, signal()), /another/);
});

test('the transport reads rendered HTML for exactly the comment paths and never reuses a cached body', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const transport = githubMergeTransport('fixture', { token: async () => 'fixture-token', accounts: async () => [] }, async (url, init) => {
    requests.push({ url: String(url), init: init! }); return new Response(JSON.stringify({ body_html: html }), { status: 200, headers: { etag: '"fixture"' } });
  });
  for (const path of ['/repos/fixture/billing/issues/comments/5', '/repos/fixture/billing/pulls/comments/6', '/repos/fixture/billing/pulls/42/reviews/7', '/repos/fixture/billing/pulls/42']) await transport.html!(path, signal());
  await transport.html!('/repos/fixture/billing/issues/comments/5', signal());
  assert.equal(requests.length, 5);
  for (const request of requests) {
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers.Accept, 'application/vnd.github.html+json'); assert.equal(headers['If-None-Match'], undefined); assert.equal(request.init.method, 'GET');
  }
  for (const path of ['/repos/fixture/billing/pulls/42/files', '/repos/fixture/billing/issues/comments/5/reactions', '/user', '/repos/fixture/billing/issues/comments/../5']) await assert.rejects(transport.html!(path, signal()), /Unsupported/, path);
  assert.equal(requests.length, 5);
});

test('images are fetched without credentials from GitHub image hosts, as a bounded raster image', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let reply = () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => { requests.push({ url: String(url), init: init! }); return reply(); };
  const image = await githubImage(signed, signal(), fetcher);
  assert.equal(image.type, 'image/png'); assert.deepEqual([...image.bytes], [...png]);
  assert.equal(requests[0].init.redirect, 'error'); assert.equal((requests[0].init.headers as Record<string, string>).Authorization, undefined);
  await assert.rejects(githubImage('https://images.example.test/tracker.png', signal(), fetcher), /Unsupported/);
  assert.equal(requests.length, 1);
  reply = () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  await assert.rejects(githubImage(signed, signal(), fetcher), /not an image/);
  reply = () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/png' } });
  await assert.rejects(githubImage(signed, signal(), fetcher), /too large/);
  reply = () => new Response('', { status: 403 });
  await assert.rejects(githubImage(signed, signal(), fetcher), /no longer serves/);
});
