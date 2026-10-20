import { NotionClient } from '../../../../packages/provider-runtime/notion.ts';
import { notionCredentials, notionTransport } from '../../../../packages/provider-runtime/notion-transport.ts';
import { notionPageConnector } from './connector.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { notionPage } from './definition.ts';
import { notionPagePresentation, unreadComments } from './presentation.ts';
import { configuredIdentities, savedComments } from './comments.ts';

const service: ServiceModule = {
  activate(host) {
    const me = () => configuredIdentities(host.settings().myUserIds);
    host.presentation(notionPage.id, notionPagePresentation(me));
    host.onWorkspace(workspace => {
      host.runtimeOperation('notion.page.comments', async context => {
        if (context.resource?.pluginId !== notionPage.id) throw new Error('This is not a Notion page.');
        const snapshot = await workspace.resources.cached(context.nodeId), saved = savedComments(snapshot?.detail?.comments);
        if (!snapshot || !saved) return { available: false, unread: 0 };
        if (!saved.available) return { available: false, reason: saved.reason, unread: 0 };
        return { available: true, unread: unreadComments(context.resource, snapshot, workspace.store, me())?.length ?? 0, blocks: saved.blocks };
      });
    });
    const credentials = notionCredentials();
    host.connectionProvider({ id: 'notion', name: 'Notion', order: 20, setupHint: 'Uses your existing Notion CLI profiles without changing the active account. Sign in with notion auth login and share the page with that integration.',
      setupSteps: [{ text: 'Sign in with the Notion CLI in Terminal. ACT uses its profiles without changing the active one.', command: 'notion auth login' }, { text: 'Share each page you want on the map with that integration.' }, { text: 'Click Connect Notion and choose the profile.' }], accounts: signal => credentials.accounts(signal) });
    const connections = host.connections;
    if (!connections) return;
    host.connector(notionPage.id, notionPageConnector(async (resource, signal) => {
      if (!resource.connectionId) throw new Error('Open this item to bind it to a Notion account first.');
      const selected = connections.resolve('notion', resource.connectionId), credential = await credentials.token(selected.account, signal);
      return new NotionClient(notionTransport(credential.token), credential.botId);
    }));
  },
};
export default service;
