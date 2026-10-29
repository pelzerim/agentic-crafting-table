import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export type KeychainProvider = 'linear' | 'slack';
export type KeychainReader = (args: string[], signal: AbortSignal) => Promise<string>;
/** The OS credential store: macOS Keychain, or on Linux the Secret Service keyring through libsecret's `secret-tool`. */
export interface CredentialStore {
  name: string; place: string; tool: string; executable: string;
  readArguments(service: string): string[];
  storeCommand(service: string, label: string): string;
  concealedPrompt(secret: string): string;
}
const macKeychain: CredentialStore = {
  name: 'macOS Keychain', place: 'your Keychain', tool: 'Keychain Access', executable: '/usr/bin/security',
  readArguments: service => ['find-generic-password', '-s', service, '-a', 'default', '-w'],
  storeCommand: service => `security add-generic-password -U -s ${service} -a default -w`,
  concealedPrompt: secret => `Keep -w last and paste the ${secret} at the prompt; the input is hidden.`,
};
const linuxKeyring: CredentialStore = {
  name: 'Linux keyring', place: 'your keyring', tool: 'secret-tool', executable: '/usr/bin/secret-tool',
  readArguments: service => ['lookup', 'service', service, 'account', 'default'],
  storeCommand: (service, label) => `secret-tool store --label '${label}' service ${service} account default`,
  concealedPrompt: secret => `Paste the ${secret} at the Password prompt; the input is hidden.`,
};
export function credentialStore(platform: string = process.platform): CredentialStore { return platform === 'linux' ? linuxKeyring : macKeychain; }
export const credentialService = (provider: KeychainProvider) => `dev.agentcraftingtable.${provider}`;

const nativeRead = (store: CredentialStore): KeychainReader => async (args, signal) => (await promisify(execFile)(store.executable, args, { signal, timeout: 10_000, maxBuffer: 8192, encoding: 'utf8' })).stdout;
/** Read a user-provisioned credential store item. No secret arguments, persistence,
 * credential prompts in the renderer, or fallback to another account. */
export function providerCredential(provider: KeychainProvider, read?: KeychainReader, store = credentialStore()) {
  if (!['linear', 'slack'].includes(provider)) throw new Error('Unsupported credential provider.');
  const reader = read ?? nativeRead(store);
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    try {
      const token = (await reader(store.readArguments(credentialService(provider)), signal)).trim(); signal.throwIfAborted();
      if (!/^[A-Za-z0-9._~-]{10,4096}$/.test(token)) throw new Error(); return token;
    } catch { signal.throwIfAborted(); throw new Error(`${provider === 'linear' ? 'Linear' : 'Slack'} credentials are unavailable in ${store.name}. Complete the documented connection setup, then retry.`); }
  };
}
