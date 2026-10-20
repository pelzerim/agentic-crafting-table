import { SlackClient, slackAccount } from '../../packages/provider-runtime/slack.ts';
import type { SlackTransport } from '../../packages/provider-runtime/slack.ts';
export const slackRoot = '1790000000.000001', slackSelected = '1790000000.000002', slackChannel = 'C12345';
export const slackUrl = `https://fixture.slack.com/archives/${slackChannel}/p${slackSelected.replace('.', '')}?thread_ts=${slackRoot}&cid=${slackChannel}`;
export const slackInput = { workspaceHost: 'fixture.slack.com', channelId: slackChannel, messageTs: slackSelected, threadTs: slackRoot, scope: 'thread' as const };
export function slackFixture() {
  const auth = { ok: true, url: 'https://fixture.slack.com/', team: 'Fixture workspace', user: 'developer', team_id: 'T12345', user_id: 'U12345' };
  const pages = [{ ok: true, messages: [{ type: 'message', ts: slackRoot, thread_ts: slackRoot, user: 'U12345', text: 'How should we handle plan changes for <@U67890>? See <https://www.example.com/plans|the *plans* page> and `plan_switch_v2`.', reply_count: 1 }], has_more: true, response_metadata: { next_cursor: 'next-page' } }, { ok: true, messages: [{ type: 'message', ts: slackSelected, thread_ts: slackRoot, user: 'U67890', text: 'Keep the current billing cycle.\n<script>window.slackInjected=true</script>', reply_count: 0 }], has_more: false, response_metadata: { next_cursor: '' } }];
  const calls: { method: string; args: Record<string, string> }[] = [];
  let before: ((method: string, args: Record<string, string>) => void) | undefined;
  const transport: SlackTransport = { async read(method, args, signal) {
    signal.throwIfAborted(); calls.push({ method, args: structuredClone(args) }); before?.(method, args);
    if (method === 'auth.test') return structuredClone(auth);
    if (method === 'conversations.info') return { ok: true, channel: { id: slackChannel, name: 'billing', is_private: true } };
    if (method === 'users.info') return { ok: true, user: { id: args.user, profile: { display_name: args.user === 'U12345' ? 'Alex' : 'Sam' } } };
    if (method === 'conversations.replies') return structuredClone(pages[args.cursor ? 1 : 0]);
    throw new Error('Unallowlisted fixture operation');
  } };
  const account = slackAccount(auth);
  return { auth, pages, calls, transport, account, client: new SlackClient(transport, account.id), before(callback: typeof before) { before = callback; } };
}

import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { slackMessageConnector } from '../../src/resource-plugins/items/slack-message/connector.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
export function slackProviders() {
  const fixture = slackFixture(), accounts = [{ id: 'slack-fixture', providerId: 'slack', account: fixture.account.id, enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'slack', name: 'Slack', setupHint: 'Local fixture only', accounts: async () => [{ id: accounts[0].account, label: 'Fixture workspace · developer', active: true, available: true, credentialSource: 'Fixture' }] }]);
  return { ...fixture, accounts, connections, host(registry: ResourcePluginRegistry) {
    const host = new ResourcePluginHost(registry); host.register('slack.message', slackMessageConnector(async resource => { const connection = connections.resolve('slack', resource.connectionId); return new SlackClient(fixture.transport, connection.account); })); return host;
  } };
}
