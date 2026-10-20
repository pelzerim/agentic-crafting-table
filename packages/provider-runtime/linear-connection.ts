import type { ConnectionAdapter } from './connections.ts';
import { providerCredential } from './keychain.ts';
import { linearAccount, linearTransport } from './linear.ts';
import type { LinearTransport } from './linear.ts';
export const linearSetupHint = `1. In Linear, open Settings → Security & access. Create a personal API key with read access to the issues you want to connect.

2. Run this command in Terminal:
security add-generic-password -U -s dev.agentcraftingtable.linear -a default -w

Keep -w last. Paste your API key at the password prompt; the input is hidden. This stores the key in your Mac’s Keychain.

3. Click Connect Linear here and select your account. It connects immediately.

4. On the map, double-click → From URL and paste a Linear issue link. Its title and details load automatically.

Titles, descriptions and statuses sync from Linear. To change status here, the key also needs permission to update those issues. Right-click a ticket → Change status, or click its status in the full view. A read-only key still works for viewing. Browser-based sign-in is not available yet.`;
export const linearSetupSteps = [
  { text: 'In Linear, open Settings → Security & access and create a personal API key with read access to the issues you want to connect.' },
  { text: 'Store it in your Keychain. Keep -w last and paste the key at the prompt; the input is hidden.', command: 'security add-generic-password -U -s dev.agentcraftingtable.linear -a default -w' },
  { text: 'Click Connect Linear and choose your account. It connects immediately.' },
  { text: 'On the map, double-click → From URL and paste a Linear issue link. Changing status also needs a key that can update those issues.' },
];
export function linearConnection(credential = providerCredential('linear'), transport: (token: string) => LinearTransport = linearTransport): ConnectionAdapter {
  return { id: 'linear', name: 'Linear', setupHint: linearSetupHint, setupSteps: linearSetupSteps, async accounts(signal) {
    const account = linearAccount(await transport(await credential(signal)).read('viewer', {}, signal)); signal.throwIfAborted();
    return [{ id: account.id, label: `${account.workspace} · ${account.name}`.slice(0, 200), available: true, active: true, credentialSource: 'macOS Keychain' }];
  } };
}
