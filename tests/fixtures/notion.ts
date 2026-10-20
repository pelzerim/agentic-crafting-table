import { NotionClient } from '../../packages/provider-runtime/notion.ts';
import { NotionReadError } from '../../packages/provider-runtime/notion-transport.ts';
export const notionPageId = '11111111111111111111111111111111', notionBotId = '22222222222222222222222222222222';
export const notionBlockId = '33333333333333333333333333333333', notionNestedId = '44444444444444444444444444444444', notionCursor = '55555555-5555-5555-5555-555555555555';
/** A person in the fixture workspace other than the signed-in one. */
export const notionColleagueId = '77777777777777777777777777777777';
/** A sanitized Notion comment; `id` digits are repeated to a 32-hex identity. */
export function notionComment(id: string, createdAt: string, options: { author?: string; parent?: string } = {}) {
  const parent = options.parent ?? notionPageId, identity = id.repeat(32 / id.length);
  return { object: 'comment', id: identity, discussion_id: identity.split('').reverse().join(''), parent: parent === notionPageId ? { type: 'page_id', page_id: parent } : { type: 'block_id', block_id: parent },
    created_time: createdAt, last_edited_time: createdAt, created_by: { object: 'user', id: options.author ?? notionColleagueId }, rich_text: [rich('Fixture comment')] };
}
const rich = (plain_text: string) => ({ type: 'text', plain_text, text: { content: plain_text } });
const list = (results: unknown[], next_cursor: string | null = null) => ({ object: 'list', results, has_more: Boolean(next_cursor), next_cursor });
export function notionFixture() {
  const calls: string[] = [];
  const responses: Record<string, any> = {
    '/v1/users/me': { object: 'user', id: notionBotId, type: 'bot', bot: { owner: { type: 'workspace', workspace: true }, workspace_name: 'Fixture' } },
    [`/v1/pages/${notionPageId}`]: { object: 'page', id: notionPageId, archived: false, last_edited_time: '2026-09-26T12:00:00.000Z', properties: { Name: { id: 'title', type: 'title', title: [rich('Truncated title')] } } },
    [`/v1/pages/${notionPageId}/properties/title?page_size=100`]: list([{ object: 'property_item', type: 'title', title: rich('Billing ') }], notionCursor),
    [`/v1/pages/${notionPageId}/properties/title?page_size=100&start_cursor=${notionCursor}`]: list([{ object: 'property_item', type: 'title', title: rich('experience') }]),
    [`/v1/blocks/${notionPageId}/children?page_size=100`]: list([{ object: 'block', id: notionBlockId, type: 'toggle', has_children: true, toggle: { rich_text: [rich('Plan requirements')] } }], notionCursor),
    [`/v1/blocks/${notionPageId}/children?page_size=100&start_cursor=${notionCursor}`]: list([{ object: 'block', id: '66666666666666666666666666666666', type: 'paragraph', has_children: false, paragraph: { rich_text: [rich('<script>window.notionInjected=true</script>')] } }]),
    [`/v1/blocks/${notionBlockId}/children?page_size=100`]: list([{ object: 'block', id: notionNestedId, type: 'to_do', has_children: false, to_do: { checked: false, rich_text: [rich('Keep the current cycle')] } }]),
  };
  /** Open comments by block (or page) id; served unless `responses` has the exact path. */
  const comments: Record<string, unknown[]> = {}, access = { comments: true };
  let before: ((path: string) => void) | undefined;
  const transport = { async get(path: string, signal: AbortSignal) {
    signal.throwIfAborted(); calls.push(path); before?.(path);
    if (responses[path]) return structuredClone(responses[path]);
    const block = /^\/v1\/comments\?block_id=([a-f0-9]{32})&page_size=100$/.exec(path)?.[1];
    if (block) { if (!access.comments) throw new NotionReadError('This Notion page is unavailable or has not been shared with the selected integration.', 403); return structuredClone(list(comments[block] ?? [])); }
    throw new Error('Fixture path missing');
  } };
  return { responses, comments, access, calls, transport, client: new NotionClient(transport, notionBotId), before(callback: typeof before) { before = callback; } };
}

import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { notionPageConnector } from '../../src/resource-plugins/items/notion-page/connector.ts';
import { notionPagePresentation } from '../../src/resource-plugins/items/notion-page/presentation.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
export function notionProviders() {
  const fixture = notionFixture(), accounts = [{ id: 'notion-fixture', providerId: 'notion', account: 'fixture-notion-bot', enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'notion', name: 'Notion', setupHint: 'Local fixture only', accounts: async () => [{ id: accounts[0].account, label: 'Fixture workspace', active: true, available: true, credentialSource: 'Fixture' }] }]);
  /** Identities the person configured as theirs in Settings. */
  const me: string[] = [];
  return { ...fixture, accounts, connections, me, host(registry: ResourcePluginRegistry, now?: () => number) {
    const host = new ResourcePluginHost(registry); host.register('notion.page', notionPageConnector(async resource => { connections.resolve('notion', resource.connectionId); return fixture.client; }, { now }));
    host.present('notion.page', notionPagePresentation(() => me)); return host;
  } };
}
