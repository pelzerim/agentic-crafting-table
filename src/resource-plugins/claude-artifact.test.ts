import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { ResourcePluginHost } from './host.ts';
import { parseClaudeArtifactUrl, defaultArtifactTitle } from './items/claude-artifact/url.ts';
import { claudeArtifactConnector } from './items/claude-artifact/connector.ts';
import type { ResourceRecord } from './types.ts';

const CODE_ID = '00000000-0000-4000-8000-000000000042';
const CODE_URL = `https://claude.ai/code/artifact/${CODE_ID}`;
const CHAT_URL = 'https://claude.ai/artifact/aB3_x-9Zq';

test('Claude artifact URLs are recognised only on https://claude.ai with a validated id', () => {
  assert.deepEqual(parseClaudeArtifactUrl(CODE_URL), { kind: 'code', id: CODE_ID, url: CODE_URL });
  assert.deepEqual(parseClaudeArtifactUrl(` ${CODE_URL.toUpperCase().replace('HTTPS://CLAUDE.AI/CODE/ARTIFACT/', 'https://CLAUDE.ai/code/artifact/')}/?ref=x#top `),
    { kind: 'code', id: CODE_ID, url: CODE_URL });
  assert.deepEqual(parseClaudeArtifactUrl(CHAT_URL), { kind: 'chat', id: 'aB3_x-9Zq', url: CHAT_URL });
  for (const rejected of [
    `http://claude.ai/code/artifact/${CODE_ID}`,
    `https://claude.ai.example.com/code/artifact/${CODE_ID}`,
    `https://evilclaude.ai/code/artifact/${CODE_ID}`,
    `https://www.claude.ai/code/artifact/${CODE_ID}`,
    `https://claude.ai:8443/code/artifact/${CODE_ID}`,
    `https://user:secret@claude.ai/code/artifact/${CODE_ID}`,
    `https://claude.ai/code/artifact/not-a-uuid`,
    `https://claude.ai/code/artifact/${CODE_ID}/assets/logo.png`,
    'https://claude.ai/artifact/',
    'https://claude.ai/artifact/has%20space',
    `https://claude.ai/artifact/${'a'.repeat(129)}`,
    'https://claude.ai/chat/abcdef12',
    'javascript:alert(1)', 'not a url', '',
  ]) assert.equal(parseClaudeArtifactUrl(rejected), undefined, rejected);
  assert.equal(defaultArtifactTitle(CODE_ID), 'Claude artifact · 00000000');
});

test('From URL offers the artifact type before the generic web link and creates a valid record', () => {
  const registry = createResourcePluginRegistry();
  assert.deepEqual(registry.matchInput(CODE_URL).map(candidate => candidate.pluginId), ['claude.artifact', 'web.link']);
  const draft = registry.matchInput(CODE_URL).find(candidate => candidate.pluginId === 'claude.artifact')!;
  assert.deepEqual(draft.data, { url: CODE_URL, artifactId: CODE_ID });
  assert.equal(draft.title, 'Claude artifact · 00000000');
  assert.equal(registry.get('claude.artifact')?.creation?.mode, 'url');
  assert.equal(registry.matchInput('https://claude.ai.example.com/artifact/abc').some(candidate => candidate.pluginId === 'claude.artifact'), false);
});

test('provenance is optional, and a saved URL must agree with its artifact id', () => {
  const registry = createResourcePluginRegistry();
  const base: ResourceRecord = { id: 'a', pluginId: 'claude.artifact', schemaVersion: 2, title: 'Flow', data: { url: CODE_URL, artifactId: CODE_ID } };
  assert.equal(registry.resolve(base).available, true);
  assert.equal(registry.resolve({ ...base, data: { ...base.data, sourcePrId: 'pr', headSha: 'a'.repeat(40), sessionId: 'agent' } }).available, true);
  assert.equal(registry.resolve({ ...base, data: { ...base.data, artifactId: 'other' } }).available, false);
  assert.equal(registry.resolve({ ...base, data: { ...base.data, url: 'https://example.com/artifact' } }).available, false);
  assert.equal(registry.resolve({ ...base, data: { url: CODE_URL } }).available, false);
});

test('saved version-1 artifacts upgrade without changing their data or identity', () => {
  const registry = createResourcePluginRegistry();
  const legacy: ResourceRecord = { id: 'artifact-1', pluginId: 'claude.artifact', schemaVersion: 1, title: 'PR architecture', data: { artifactId: 'artifact-1', sourcePrId: 'PR_1', headSha: 'head-one', sessionId: 'claude-1' } };
  assert.equal(registry.resolve(legacy).available, false);
  const upgraded = registry.migrate(legacy);
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.data, legacy.data);
  assert.equal(registry.resolve(upgraded).available, true);
});

test('the same artifact URL has one provider identity across spellings; different artifacts differ', () => {
  const registry = createResourcePluginRegistry();
  const record = (url: string, id: string): ResourceRecord => ({ id, pluginId: 'claude.artifact', schemaVersion: 2, title: 'x', data: { url, artifactId: parseClaudeArtifactUrl(url)!.id } });
  assert.equal(registry.identity(record(CODE_URL, 'one')), registry.identity(record(`${CODE_URL}/?utm=1`, 'two')));
  assert.notEqual(registry.identity(record(CODE_URL, 'one')), registry.identity(record(CHAT_URL, 'three')));
  assert.ok(registry.identity(record(CODE_URL, 'one')));
});

test('attaching never fetches the authenticated page and keeps the local title', async () => {
  const registry = createResourcePluginRegistry(), host = new ResourcePluginHost(registry);
  host.register('claude.artifact', claudeArtifactConnector);
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('Artifact pages must not be fetched'); }) as typeof fetch;
  try {
    const result = await host.resolveUrl('claude.artifact', 'artifact', CODE_URL, new AbortController().signal);
    assert.equal(result.resource.title, 'Claude artifact · 00000000');
    assert.deepEqual(result.resource.data, { url: CODE_URL, artifactId: CODE_ID });
    const context = await claudeArtifactConnector.getContext!(result.resource, new AbortController().signal);
    assert.equal(context.sourceUrl, CODE_URL);
  } finally { globalThis.fetch = original; }
});
