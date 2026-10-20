import { SlackClient, slackTransport } from '../../../../packages/provider-runtime/slack.ts';
import { providerCredential } from '../../../../packages/provider-runtime/keychain.ts';
import { slackMessageConnector } from './connector.ts';
import { slackConnection } from '../../../../packages/provider-runtime/slack-connection.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { slackMessage } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.connectionProvider({ ...slackConnection(), order: 50 });
    const connections = host.connections;
    if (!connections) return;
    const credential = providerCredential('slack');
    host.connector(slackMessage.id, slackMessageConnector(async (resource, signal) => {
      if (!resource.connectionId) throw new Error('Open this item to bind it to a Slack account first.');
      const selected = connections.resolve('slack', resource.connectionId);
      return new SlackClient(slackTransport(await credential(signal)), selected.account);
    }));
  },
};
export default service;
