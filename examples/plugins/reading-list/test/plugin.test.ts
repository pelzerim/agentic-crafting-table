import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginPackageContract, resourceConnectorContract } from '@agent-crafting-table/plugin-sdk/testing.ts';
import { parsePluginManifest } from '@agent-crafting-table/plugin-sdk/index.ts';
import type { JsonObject, JsonValue, PluginRecord, PluginStorage, ResourceRecord, RuntimeOperationContext, WorkspaceServices } from '@agent-crafting-table/plugin-sdk/index.ts';
import { WorkspaceControl, MemoryStore } from '@agent-crafting-table/core/control.ts';
import { agentRuntimeRefusal } from '@agent-crafting-table/core/runtime.ts';
import { createResourcePluginRegistry } from '@agent-crafting-table/plugins/builtins.ts';
import manifest from '../act-plugin.json' with { type: 'json' };
import plugin from '../src/plugin.ts';
import { parseTags, readingLink, READ_STATE } from '../src/definition.ts';
import { isPrivateAddress, pageTitle } from '../src/check.ts';
import type { CheckResult, PageCheck } from '../src/check.ts';
import { CHECK_REUSE_MS, linkRecord, readingLinkConnector } from '../src/connector.ts';
import { readState, unreadLinks } from '../src/service.ts';

/** In-memory PluginStorage with the same JSON round trip as the app's plugin_records table. */
function memoryStorage(): PluginStorage {
  const rows = new Map<string, PluginRecord>();
  return {
    get: (collection, key) => rows.get(`${collection}/${key}`),
    put: (collection, key, value: JsonValue) => { const row = { key, value: JSON.parse(JSON.stringify(value)), updatedAt: Date.now() }; rows.set(`${collection}/${key}`, row); return row; },
    delete: (collection, key) => rows.delete(`${collection}/${key}`),
    list: collection => [...rows.entries()].filter(([id]) => id.startsWith(`${collection}/`)).map(([, row]) => row),
    transaction: work => work(),
  };
}
const fixedCheck = (result: Omit<CheckResult, 'checkedAt'>): PageCheck & { calls: number } => {
  const check = Object.assign(async () => { check.calls++; return { ...result, checkedAt: new Date().toISOString() }; }, { calls: 0 });
  return check;
};
const link = (data: JsonObject = { url: 'https://example.com/article' }): ResourceRecord => ({ id: 'link-1', pluginId: readingLink.id, schemaVersion: 1, title: 'An article', data });

// 1. The package contract: manifest ↔ registrations, serializable descriptions, the definition's
//    create/update/archive/restore/missing-plugin behaviour with valid and invalid data.
pluginPackageContract({ manifest, module: plugin }, {
  fixtures: { [readingLink.id]: { valid: { url: 'https://example.com/a', note: 'Read before Friday', tags: 'design, long-read' }, invalid: [{ url: 'http://example.com/a' }, { url: 'https://example.com', tags: 'a,b,c,d,e,f' }, { note: 'no url' }] } },
});

// 2. The connector contract, with a fixture check: never the network in tests.
resourceConnectorContract(readingLink, { valid: { url: 'https://example.com/a' }, connector: () => readingLinkConnector({ check: fixedCheck({ state: 'ok', status: 200, pageTitle: 'Example' }), storage: memoryStorage, settings: () => ({ checkLinks: true }) }) });

test('the manifest parses against this app and owns every identifier it declares', () => {
  const parsed = parsePluginManifest(manifest);
  assert.deepEqual(parsed.contributes.itemTypes, [readingLink.id]);
  assert.deepEqual(parsed.contributes.mcpTools, ['reading_list_unread']);
});

test('tags are normalised and limited', () => {
  assert.deepEqual(parseTags(' Design, Long Read ,,design'), ['design', 'long-read']);
  assert.equal(readingLink.validateData({ url: 'https://example.com', tags: 'one, two' }), true);
  assert.equal(readingLink.validateData({ url: 'https://example.com', tags: 'a,b,c,d,e,f' }), false);
  assert.equal(readingLink.validateData({ url: 'https://example.com', tags: 'not/a/tag' }), false);
});

test('a broken link raises Needs me with a short reason and clears it when the link works again', async () => {
  const storage = memoryStorage(); let result: Omit<CheckResult, 'checkedAt'> = { state: 'broken', status: 404 }, now = Date.now();
  const connector = readingLinkConnector({ check: async () => ({ ...result, checkedAt: new Date(now).toISOString() }), storage: () => storage, settings: () => ({}), now: () => now });
  const broken = await connector.load(link(), AbortSignal.timeout(1000));
  assert.equal(broken.attentionReason, 'error'); assert.equal(broken.attentionNote, 'Link is broken'); assert.equal(broken.label, 'Link is broken');
  assert.ok(broken.attentionNote!.split(' ').length <= 5 && !broken.attentionNote!.endsWith('.'), 'Needs me reasons are 2–5 words, no trailing period');
  result = { state: 'ok', status: 200 }; now += CHECK_REUSE_MS + 1;
  const fixed = await connector.load(link(), AbortSignal.timeout(1000));
  assert.equal(fixed.attentionReason, null); assert.equal(fixed.attentionNote, undefined); assert.equal(fixed.label, 'Unread · example.com');
});

test('checks are reused for a minute, skipped for read links in the background and never made when turned off', async () => {
  const storage = memoryStorage(), check = fixedCheck({ state: 'ok', status: 200 }); let checkLinks = true;
  const connector = readingLinkConnector({ check, storage: () => storage, settings: () => ({ checkLinks }) });
  await connector.load(link(), AbortSignal.timeout(1000)); await connector.load(link(), AbortSignal.timeout(1000));
  assert.equal(check.calls, 1, 'a second read within a minute reuses the saved check');
  const old = linkRecord(storage, 'link-1').lastCheck!;
  storage.put('links', 'link-1', { readAt: new Date().toISOString(), lastCheck: { ...old, checkedAt: new Date(0).toISOString() } } as JsonObject);
  await connector.load(link(), AbortSignal.timeout(1000), { background: true });
  assert.equal(check.calls, 1, 'background polls skip links already read');
  checkLinks = false;
  const off = await connector.load(link(), AbortSignal.timeout(1000));
  assert.equal(check.calls, 1); assert.equal(off.detail?.checks, 'off'); assert.equal(off.attentionReason, null);
});

test('marking read is for people only; agents may only list the choices', () => {
  const operations = plugin.runtimeOperations!;
  assert.match(agentRuntimeRefusal({ action: READ_STATE, arguments: { operation: 'set', value: 'read' } }, operations) ?? '', /needs a person/);
  assert.equal(agentRuntimeRefusal({ action: READ_STATE, arguments: { operation: 'options' } }, operations), undefined);
  assert.equal(agentRuntimeRefusal({ action: 'reading-list.unread', arguments: {} }, operations), undefined);
});

test('read state lives in plugin_records and the unread list and MCP tool read it', async () => {
  const registry = createResourcePluginRegistry([readingLink]), control = new WorkspaceControl(new MemoryStore(), registry), storage = memoryStorage(), reads: string[] = [];
  await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'project.create', id: 'project', title: 'Research', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'one', resourceId: 'link-1', pluginId: readingLink.id, title: 'An article', data: { url: 'https://example.com/a', tags: 'design' }, projectId: 'project', position: { x: 300, y: 0 } },
    { type: 'item.add', id: 'two', resourceId: 'link-2', pluginId: readingLink.id, title: 'A paper', data: { url: 'https://example.org/b' }, position: { x: 600, y: 0 } },
  ] });
  const workspace = { control, storage, resources: { read: async (nodeId: string) => { reads.push(nodeId); } } } as unknown as WorkspaceServices;
  const state = await control.read(), resource = state.resources.find(record => record.id === 'link-1')!;
  const context = (args: JsonObject): RuntimeOperationContext => ({ nodeId: 'one', resource, arguments: args, signal: AbortSignal.timeout(1000), execute: work => work() });
  assert.deepEqual((await readState(context({ operation: 'options' }), workspace) as { current: string }).current, 'unread');
  await readState(context({ operation: 'set', value: 'read' }), workspace);
  assert.match(linkRecord(storage, 'link-1').readAt!, /^\d{4}-/); assert.deepEqual(reads, ['one']);
  assert.deepEqual((await unreadLinks({}, workspace)).links.map(item => item.nodeId), ['two']);
  assert.deepEqual((await unreadLinks({ projectId: 'project' }, workspace)).links, []);
  await assert.rejects(readState(context({ operation: 'set', value: 'maybe' }), workspace), /Choose Read or Unread/);
  const tool = plugin.mcpTools![0];
  assert.deepEqual(tool.request({ limit: 5 }, { projectId: 'project' }), { action: 'reading-list.unread', nodeId: 'project', arguments: { limit: 5 } });
  assert.equal(tool.inputSchema.safeParse({ limit: 500 }).success, false);
});

test('page checks read the title and refuse local addresses', () => {
  assert.equal(pageTitle('<html><title>\n Hello &amp; welcome </title>'), 'Hello & welcome');
  assert.equal(pageTitle('<p>no title</p>'), undefined);
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['93.184.216.34', '2606:2800:220:1::1']) assert.equal(isPrivateAddress(address), false, address);
});

test('the stylesheet uses design tokens only', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [], []);
});
