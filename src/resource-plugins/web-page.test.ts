import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { resourceWebPage } from './web-page.ts';
import type { ResourceRecord } from './types.ts';

const registry = createResourcePluginRegistry();
const record = (id: string, pluginId: string, data: ResourceRecord['data']): ResourceRecord => ({ id, pluginId, schemaVersion: 1, title: id, data });
const pull = record('pr-r', 'github.pull-request', { owner: 'acme', repo: 'web', number: 42 });
const page = (resource: ResourceRecord) => resourceWebPage(resource, registry, nodeId => nodeId === 'pr' ? pull : undefined);

test('a template still gives the page of its own item', () => {
  assert.deepEqual(page(pull), { label: 'Open on GitHub', url: 'https://github.com/acme/web/pull/42' });
});

test('a Slack message and a thread reply link to their Slack permalinks', () => {
  const message = record('m', 'slack.message', { workspaceHost: 'acme.slack.com', channelId: 'C024BE91L', messageTs: '1730190000.123456', scope: 'message' });
  assert.equal(page(message)?.url, 'https://acme.slack.com/archives/C024BE91L/p1730190000123456');
  const reply = record('r', 'slack.message', { workspaceHost: 'acme.slack.com', channelId: 'C024BE91L', messageTs: '1730190100.000200', scope: 'thread', threadTs: '1730190000.123456' });
  assert.equal(page(reply)?.url, 'https://acme.slack.com/archives/C024BE91L/p1730190100000200?thread_ts=1730190000.123456&cid=C024BE91L');
});

test('a code review and a review run link to the pull request they were made from', () => {
  for (const pluginId of ['code.review', 'github.review-run']) assert.deepEqual(page(record('x', pluginId, { sourcePrId: 'pr' })), { label: 'Open pull request', url: 'https://github.com/acme/web/pull/42' }, pluginId);
  assert.equal(page(record('x', 'code.review', { sourcePrId: 'gone' })), undefined);
});

test('items with no page of their own have none', () => {
  for (const pluginId of ['agent.session', 'workspace.note', 'terminal.session']) assert.equal(page(record('x', pluginId, {})), undefined, pluginId);
});
