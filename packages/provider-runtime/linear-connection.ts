import type { ConnectionAdapter } from './connections.ts';
import { credentialService, credentialStore, providerCredential } from './keychain.ts';
import type { CredentialStore } from './keychain.ts';
import { linearAccount, linearTransport } from './linear.ts';
import type { LinearTransport } from './linear.ts';
export function linearSetupHint(store: CredentialStore) {
  return `1. In Linear, open Settings → Security & access. Create a personal API key with read access to the issues you want to connect.

2. Run this command in Terminal:
${store.storeCommand(credentialService('linear'), 'Agentic Crafting Table Linear')}

${store.concealedPrompt('API key')} This stores the key in ${store.place}.

3. Click Connect Linear here and select your account. It connects immediately.

4. On the map, double-click → From URL and paste a Linear issue link. Its title and details load automatically.

Titles, descriptions and statuses sync from Linear. To change status here, the key also needs permission to update those issues. Right-click a ticket → Change status, or click its status in the full view. A read-only key still works for viewing. Browser-based sign-in is not available yet.`;
}
export function linearSetupSteps(store: CredentialStore) {
  return [
    { text: 'In Linear, open Settings → Security & access and create a personal API key with read access to the issues you want to connect.' },
    { text: `Store it in ${store.place}. ${store.concealedPrompt('key')}`, command: store.storeCommand(credentialService('linear'), 'Agentic Crafting Table Linear') },
    { text: 'Click Connect Linear and choose your account. It connects immediately.' },
    { text: 'On the map, double-click → From URL and paste a Linear issue link. Changing status also needs a key that can update those issues.' },
  ];
}
export function linearConnection(credential = providerCredential('linear'), transport: (token: string) => LinearTransport = linearTransport, store = credentialStore()): ConnectionAdapter {
  return { id: 'linear', name: 'Linear', setupHint: linearSetupHint(store), setupSteps: linearSetupSteps(store), async accounts(signal) {
    const account = linearAccount(await transport(await credential(signal)).read('viewer', {}, signal)); signal.throwIfAborted();
    return [{ id: account.id, label: `${account.workspace} · ${account.name}`.slice(0, 200), available: true, active: true, credentialSource: store.name }];
  } };
}
