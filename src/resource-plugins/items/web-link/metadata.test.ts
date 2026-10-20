import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createPublicPageTitleReader } from './metadata.ts';

test('metadata redirects are revalidated, bounded and credential-free using real local HTTP responses', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!); assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    if (req.url === '/redirect') { res.writeHead(302, { location: '/title?source=redirect' }); res.end(); }
    else if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/credentials') { res.writeHead(302, { location: 'https://user:pass@example.test/' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (req.url === '/login') { res.writeHead(401); res.end(); }
    else if (req.url === '/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('<title>Not HTML</title>'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<head><title>Current &amp; correct</title></head><body>Ignored</body>'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const read = createPublicPageTitleReader({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    // Only this injected fixture transport routes a checked public URL locally.
    request: (url, options, response) => request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...options, lookup: undefined }, response),
  });
  try {
    const signal = new AbortController().signal;
    assert.equal(await read('https://example.test/redirect', signal), 'Current & correct');
    assert.deepEqual(seen, ['/redirect', '/title?source=redirect']);
    await assert.rejects(read('https://example.test/private', signal), /public address/);
    await assert.rejects(read('https://example.test/credentials', signal), /Invalid page redirect/);
    await assert.rejects(read('https://example.test/loop', signal), /Too many/);
    assert.equal(seen.filter(path => path === '/loop').length, 5);
    assert.equal(await read('https://example.test/login', signal), undefined);
    assert.equal(await read('https://example.test/binary', signal), undefined);
    assert.equal(seen.filter(path => path === '/private').length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a stalled metadata DNS lookup is cancelled without waiting for the resolver', async () => {
  let connected = false;
  const read = createPublicPageTitleReader({ resolve: () => new Promise(() => {}), request: () => { connected = true; throw new Error('Must not connect'); } });
  const controller = new AbortController(), result = read('https://example.test/', controller.signal);
  controller.abort(); await assert.rejects(result, { name: 'AbortError' }); assert.equal(connected, false);
});
