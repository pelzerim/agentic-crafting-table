import type { ConnectionAdapter } from './connections.ts';
import { credentialService, credentialStore, providerCredential } from './keychain.ts';
import { slackAccount, slackTransport } from './slack.ts';
import type { SlackTransport } from './slack.ts';
export function slackConnection(credential = providerCredential('slack'), transport: (token: string) => SlackTransport = slackTransport, store = credentialStore()): ConnectionAdapter {
  return { id: 'slack', name: 'Slack', setupHint: `Uses an API token in ${store.name} (service ${credentialService('slack')}, account default). Add it through ${store.tool}, then choose Connect Slack. The token needs read access to the linked conversation.`,
    setupSteps: [{ text: 'Create a Slack API token with read access to the conversations you link.' }, { text: `Store it in ${store.place}. ${store.concealedPrompt('token')}`, command: store.storeCommand(credentialService('slack'), 'Agentic Crafting Table Slack') }, { text: 'Click Connect Slack and choose the account.' }], async accounts(signal) {
    const account = slackAccount(await transport(await credential(signal)).read('auth.test', {}, signal)); signal.throwIfAborted();
    return [{ id: account.id, label: `${account.team} · ${account.user}`.slice(0, 200), available: true, active: true, credentialSource: store.name }];
  } };
}
