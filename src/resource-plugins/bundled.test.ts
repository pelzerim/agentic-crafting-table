import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPluginPackageRegistry, createResourcePluginRegistry } from './builtins.ts';
import { bundledRendererModules } from './bundled/renderer.generated.ts';
import { bundledServiceModules } from './bundled/service.generated.ts';
import { createResourceViews } from './catalog.client.ts';
import { createResourcePluginHost } from './catalog.server.ts';

test('generated bundled plugin entry lists match plugins.json and every act-plugin.json', () => {
  const check = spawnSync(process.execPath, [join(import.meta.dirname, '../../scripts/bundled-plugins.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('bundled packages keep every persisted item type id and its registration order', () => {
  const packages = createPluginPackageRegistry();
  assert.deepEqual(createResourcePluginRegistry().list().map(type => type.id), [
    'agent.session', 'terminal.session', 'github.pull-request', 'github.rollout', 'claude.artifact', 'code.review', 'github.review-run',
    'linear.ticket', 'notion.page', 'slack.message', 'web.bookmark', 'web.link', 'workspace.todo', 'workspace.note',
  ]);
  for (const type of packages.types.list()) assert.ok(packages.ownerOf(type.id), `${type.id} has an owning package`);
  for (const { manifest } of packages.list()) {
    assert.equal(Boolean(bundledServiceModules[manifest.id]), Boolean(manifest.entries.service), `${manifest.id} service entry`);
    assert.equal(Boolean(bundledRendererModules[manifest.id]), Boolean(manifest.entries.renderer), `${manifest.id} renderer entry`);
  }
});

test('Types from a separately installed package stay as placeholders until it loads', () => {
  const registry = createResourcePluginRegistry(), box = { id: 'box', pluginId: 'acme.widget', schemaVersion: 1, title: 'Widget', connectionId: 'acme-1', data: { workspaceId: 'saved-binding' } };
  assert.equal(registry.get('acme.widget'), undefined);
  assert.equal(createPluginPackageRegistry().list().some(entry => entry.manifest.contributes.accountTypes.includes('acme')), false);
  assert.deepEqual(registry.resolve(structuredClone(box)), { available: false, resource: box, reason: 'Plugin is not installed' });
});

test('every bundled stylesheet exists and is loaded once', () => {
  const imports = [...readFileSync(join(import.meta.dirname, 'bundled/styles.generated.css'), 'utf8').matchAll(/@import '([^']+)';/g)].map(match => match[1]);
  assert.equal(imports.length, createPluginPackageRegistry().list().flatMap(entry => entry.manifest.contributes.css).length);
  assert.equal(new Set(imports).size, imports.length);
  for (const file of imports) assert.ok(existsSync(join(import.meta.dirname, 'bundled', file)), file);
});

test('one registration path supplies connectors and views for every bundled type that has them', () => {
  const registry = createResourcePluginRegistry(), host = createResourcePluginHost(registry), views = createResourceViews(registry);
  for (const id of ['web.bookmark', 'web.link', 'workspace.todo', 'workspace.note']) assert.equal(host.capabilities(id).load, true, `${id} connector`);
  for (const id of ['github.pull-request', 'linear.ticket']) assert.equal(host.capabilities(id).load, false, `${id} needs connections`);
  const resource = { id: 'r', pluginId: 'web.link', schemaVersion: 1, title: 'Example', data: { url: 'https://example.com' } };
  assert.match(views.identity(resource), /^r:web\.link:1:/);
});
