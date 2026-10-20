import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { ResourcePluginHost } from './host.ts';
import { createWebLinkConnector } from './items/web-link/connector.ts';
import { extractPageTitle, isPublicAddress, readPublicPageTitle } from './items/web-link/metadata.ts';

test('Web link is URL-only, keeps deep-link parameters and does not replace provider suggestions', () => {
  const registry = createResourcePluginRegistry();
  const url = 'https://example.com/docs?view=flow#architecture';
  const draft = registry.matchInput(url).find(p => p.pluginId === 'web.link')!;
  assert.deepEqual(draft.data, { url });
  assert.equal(draft.title, 'example.com');
  assert.equal(registry.get('web.link')?.creation?.mode, 'url');
  assert.deepEqual(registry.get('web.link')?.activation, { kind: 'browser', urlField: 'url' });
  assert.deepEqual(registry.matchInput('https://github.com/acme/app/pull/48').map(p => p.pluginId), ['github.pull-request', 'web.link']);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'https://user:pass@example.com', 'not a URL']) {
    assert.equal(registry.matchInput(url).some(p => p.pluginId === 'web.link'), false);
    assert.throws(() => registry.createRecord('web.link', 'invalid', { title: 'Link', data: { url } }));
  }
});

test('page metadata supplies the automatic title, while failures keep a usable domain title', async () => {
  const registry = createResourcePluginRegistry(), host = new ResourcePluginHost(registry);
  host.register('web.link', createWebLinkConnector(async url => { assert.equal(url, 'https://example.com/outdated-slug'); return 'Current architecture'; }));
  const signal = new AbortController().signal;
  const result = await host.resolveUrl('web.link', 'link', 'https://example.com/outdated-slug', signal);
  assert.equal(result.resource.title, 'Current architecture');
  const failing = new ResourcePluginHost(registry);
  failing.register('web.link', createWebLinkConnector(async () => { throw new Error('Page requires login'); }));
  const fallback = await failing.resolveUrl('web.link', 'fallback', 'https://example.com/private', signal);
  assert.equal(fallback.resource.title, 'example.com');
  assert.match(fallback.snapshot.label, /title unavailable/);
  const controller = new AbortController();
  const cancelled = createWebLinkConnector(async () => { controller.abort(); return 'Late result'; });
  await assert.rejects(cancelled.load(result.resource, controller.signal), { name: 'AbortError' });
});

test('title extraction ignores scripts and comments, decodes text, and falls back to social metadata', () => {
  assert.equal(extractPageTitle('<!-- <title>Fake</title> --><script>"<title>Fake</title>"</script><title>  Plans &amp; billing &#8212; Docs\n </title>'), 'Plans & billing — Docs');
  assert.equal(extractPageTitle('<meta content="Flow &amp; overview" property="og:title">'), 'Flow & overview');
  assert.equal(extractPageTitle('<title> </title><meta name="twitter:title" content="Overview">'), 'Overview');
  assert.equal(extractPageTitle('<head></head><body><title>Not the page title</title>'), undefined);
  assert.equal(extractPageTitle('<title>' + 'a'.repeat(700) + '</title>')?.length, 500);
});

test('automatic metadata reads reject local and special-use addresses before connecting', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700::1111'), true);
  await assert.rejects(readPublicPageTitle('http://127.0.0.1/', new AbortController().signal), /public address/);
  await assert.rejects(readPublicPageTitle('https://example.com:8443/', new AbortController().signal), /standard web ports/);
});
