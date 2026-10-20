import test from 'node:test';
import assert from 'node:assert/strict';
import { githubTransport } from './github-transport.ts';

const credentials = { async accounts() { return []; }, async token() { return 'fake'; } };
const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));

test('a caller that gives up on time hears that GitHub was slow, not a bare abort', async () => {
  const transport = githubTransport('timeouts', credentials, hang);
  await assert.rejects(transport.get('/repos/acme/web/pulls/7', AbortSignal.timeout(20)), { code: 'GITHUB_TIMEOUT', message: 'GitHub took too long to answer. Try again.' });
});

test('a caller that cancels still sees its own cancellation', async () => {
  const transport = githubTransport('cancels', credentials, hang), controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(transport.get('/repos/acme/web/pulls/7', controller.signal), { name: 'AbortError' });
});
