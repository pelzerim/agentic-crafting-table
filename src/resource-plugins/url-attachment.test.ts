import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { ResourcePluginHost } from './host.ts';
import type { ResourceSnapshot } from './types.ts';

test('provider links yield identities without guessing titles from slugs', () => {
  const registry = createResourcePluginRegistry();
  const notion = registry.matchInput('https://www.notion.so/Old-title-0123456789abcdef0123456789abcdef?pvs=4').find(p => p.pluginId === 'notion.page');
  assert.deepEqual(notion?.data, { pageId: '0123456789abcdef0123456789abcdef' });
  assert.equal(notion?.title, 'Notion page');
  for (const link of ['https://app.notion.com/p/acme/Launch-plan-0123456789abcdef0123456789abcdef', 'https://www.notion.com/acme/Launch-plan-0123456789abcdef0123456789abcdef?pvs=4', 'https://acme.notion.site/Launch-plan-0123456789abcdef0123456789abcdef'])
    assert.deepEqual(registry.matchInput(link).find(p => p.pluginId === 'notion.page')?.data, { pageId: '0123456789abcdef0123456789abcdef' }, link);
  const linear = registry.matchInput('https://linear.app/acme/issue/BIL-128/stale-url-title').find(p => p.pluginId === 'linear.ticket');
  assert.deepEqual(linear?.data, { issueId: 'BIL-128', workspaceKey: 'acme' });
  assert.equal(linear?.title, 'BIL-128');
  for (const [id, input] of [
    ['linear.ticket', 'https://linear.app.evil.test/acme/issue/BIL-128/title'],
    ['notion.page', 'https://evil.test/page-0123456789abcdef0123456789abcdef'],
    ['notion.page', 'https://app.notion.com.evil.test/p/acme/page-0123456789abcdef0123456789abcdef'],
    ['notion.page', 'https://notnotion.com/p/acme/page-0123456789abcdef0123456789abcdef'],
    ['github.pull-request', 'http://github.com/acme/app/pull/48'],
  ]) assert.equal(registry.matchInput(input).some(p => p.pluginId === id), false);
});

test('URL-only import waits for the provider title and keeps provider status separate', async () => {
  const registry = createResourcePluginRegistry(), host = new ResourcePluginHost(registry);
  const snapshot: ResourceSnapshot = { title: 'Current plan-change behavior', activity: 'idle', attention: 'review', connection: 'connected', label: 'In progress', observedAt: '2026-09-24T12:00:00Z' };
  host.register('linear.ticket', { async load(resource) { assert.equal(resource.data.issueId, 'BIL-128'); return snapshot; } });
  const result = await host.resolveUrl('linear.ticket', 'ticket-1', 'https://linear.app/acme/issue/BIL-128/outdated-title', new AbortController().signal);
  assert.equal(result.resource.title, snapshot.title);
  assert.equal(result.snapshot.label, 'In progress');
  assert.equal(registry.get('linear.ticket')?.creation?.mode, 'url');
  delete snapshot.title;
  await assert.rejects(host.resolveUrl('linear.ticket', 'ticket-2', 'https://linear.app/acme/issue/BIL-128/title', new AbortController().signal), /could not resolve/);
  await assert.rejects(host.resolveUrl('notion.page', 'page-1', 'https://www.notion.so/0123456789abcdef0123456789abcdef', new AbortController().signal), /not connected/);
});

test('cancelled metadata lookup cannot return an attachable record', async () => {
  const host = new ResourcePluginHost(createResourcePluginRegistry()), controller = new AbortController();
  host.register('github.pull-request', { async load() { controller.abort(); return { title: 'Real title', activity: 'idle', attention: 'none', connection: 'connected', label: 'Open', observedAt: '' }; } });
  await assert.rejects(host.resolveUrl('github.pull-request', 'pr-1', 'https://github.com/acme/app/pull/48', controller.signal), { name: 'AbortError' });
});

test('unified URL discovery prefers exact provider matches and preserves generic web fallback', () => {
  const registry = createResourcePluginRegistry();
  for (const [url, type] of [
    ['https://github.com/acme/app/pull/48', 'github.pull-request'],
    ['https://www.notion.so/Old-title-0123456789abcdef0123456789abcdef?pvs=4', 'notion.page'],
    ['https://linear.app/acme/issue/BIL-128/title', 'linear.ticket'],
    ['https://fixture.slack.com/archives/C0123456789/p1727172000000001', 'slack.message'],
    ['https://example.com/a?q=1#section', 'web.link'],
    ['https://github.com/acme/app', 'web.link'],
    ['https://github.com.evil.test/acme/app/pull/48', 'web.link'],
  ]) assert.deepEqual(registry.matchUrl(` ${url} `).map(candidate => candidate.pluginId), [type]);
  for (const url of ['bad URL', 'javascript:alert(1)', 'file:///tmp/page', 'https://name:secret@example.com', 'https://example.com/' + 'x'.repeat(8192)]) assert.deepEqual(registry.matchUrl(url), []);
  // Legacy discovery stays compatible; the preferred candidates are additive.
  assert.equal(registry.matchInput('https://github.com/acme/app/pull/48').length, 2);
});

test('new URL plugins need no provider branches and equally specific matches remain selectable', async () => {
  const { defineResourcePlugin } = await import('./define.ts');
  const registry = createResourcePluginRegistry();
  for (const id of ['fixture.docs', 'fixture.alternate']) registry.register(defineResourcePlugin({ id, name: id, apiVersion: 1, schemaVersion: 1, icon: 'file', preferredView: 'focus', fields: {}, creation: { label: 'Attach', mode: 'url' }, matchInput: input => new URL(input).hostname === 'docs.example.com' ? { title: 'Document', data: {} } : undefined }));
  assert.deepEqual(registry.matchUrl('https://docs.example.com/page').map(candidate => candidate.pluginId), ['fixture.docs', 'fixture.alternate']);
});
