import type { ConnectionAdapter } from './connections.ts';
import { providerCredential } from './keychain.ts';
import { slackAccount, slackTransport } from './slack.ts';
import type { SlackTransport } from './slack.ts';
export function slackConnection(credential = providerCredential('slack'), transport: (token: string) => SlackTransport = slackTransport): ConnectionAdapter {
  return { id: 'slack', name: 'Slack', setupHint: 'Uses an API token in macOS Keychain (service dev.agentcraftingtable.slack, account default). Add it through Keychain Access, then choose Connect Slack. The token needs read access to the linked conversation.',
    setupSteps: [{ text: 'Create a Slack API token with read access to the conversations you link.' }, { text: 'Store it in your Keychain. Paste the token at the prompt; the input is hidden.', command: 'security add-generic-password -U -s dev.agentcraftingtable.slack -a default -w' }, { text: 'Click Connect Slack and choose the account.' }], async accounts(signal) {
    const account = slackAccount(await transport(await credential(signal)).read('auth.test', {}, signal)); signal.throwIfAborted();
    return [{ id: account.id, label: `${account.team} · ${account.user}`.slice(0, 200), available: true, active: true, credentialSource: 'macOS Keychain' }];
  } };
}
