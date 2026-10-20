import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { parseSlackLink } from './items/slack-message/definition.ts';

const messageUrl = 'https://example.slack.com/archives/C0123456789/p1727172060000002';

test('Slack links retain the selected message independently of its thread root', () => {
  assert.deepEqual(parseSlackLink(messageUrl)?.data, {
    workspaceHost: 'example.slack.com', channelId: 'C0123456789',
    messageTs: '1727172060.000002', scope: 'message',
  });
  const thread = parseSlackLink(`${messageUrl}?thread_ts=1727172000.000001&cid=C0123456789`);
  assert.equal(thread?.title, 'Slack thread');
  assert.equal(thread?.data.scope, 'thread');
  assert.equal(thread?.data.messageTs, '1727172060.000002');
  assert.equal(thread?.data.threadTs, '1727172000.000001');
  // Slack's published permalink example omits a leading zero in the fraction.
  assert.equal(parseSlackLink('https://ghostbusters.slack.com/archives/C1H9RESGL/p135854651700023')?.data.messageTs, '1358546517.000023');
});

test('Slack rejects non-message links, malformed roots and misleading hosts', () => {
  for (const url of [
    messageUrl.replace('https:', 'http:'),
    messageUrl.replace('example.slack.com', 'example.slack.com.evil.test'),
    messageUrl.replace('example.slack.com', 'login@example.slack.com'),
    messageUrl.replace('example.slack.com', 'example.slack.com:8443'),
    'https://app.slack.com/client/T123/C123',
    messageUrl.replace('p1727172060000002', 'pnot-a-timestamp'),
    `${messageUrl}?thread_ts=`, `${messageUrl}?thread_ts=1727172000.00000x`,
    `${messageUrl}?thread_ts=1727172000.000001&thread_ts=1727172000.000002`,
    `${messageUrl}?cid=C999`,
  ]) assert.equal(parseSlackLink(url), undefined, url);
});

test('Slack is discoverable and creates validated compact items through the shared registry', () => {
  const registry = createResourcePluginRegistry();
  const draft = registry.matchInput(`${messageUrl}?thread_ts=1727172000.000001`).find(p => p.pluginId === 'slack.message')!;
  const resource = registry.createRecord('slack.message', 'slack-1', draft);
  assert.equal(resource.data.messageTs, '1727172060.000002');
  assert.equal(resource.data.threadTs, '1727172000.000001');
  assert.equal(registry.get('slack.message')?.creation?.mode, 'url');
  assert.equal(registry.get('slack.message')?.appearance?.size, 'small');
  const { threadTs, ...withoutRoot } = draft.data;
  assert.throws(() => registry.createRecord('slack.message', 'bad', { ...draft, data: withoutRoot }));
  assert.throws(() => registry.createRecord('slack.message', 'bad', { ...draft, data: { ...draft.data, messageTs: 1727172060.000002 } }));
});
