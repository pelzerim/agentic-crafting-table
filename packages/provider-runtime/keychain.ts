import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export type KeychainProvider = 'linear' | 'slack';
export type KeychainReader = (args: string[], signal: AbortSignal) => Promise<string>;
const nativeRead: KeychainReader = async (args, signal) => (await promisify(execFile)('/usr/bin/security', args, { signal, timeout: 10_000, maxBuffer: 8192, encoding: 'utf8' })).stdout;
/** Read a user-provisioned Keychain item. No secret arguments, persistence,
 * credential prompts in the renderer, or fallback to another account. */
export function providerCredential(provider: KeychainProvider, read: KeychainReader = nativeRead) {
  if (!['linear', 'slack'].includes(provider)) throw new Error('Unsupported credential provider.');
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    try {
      const token = (await read(['find-generic-password', '-s', `dev.agentcraftingtable.${provider}`, '-a', 'default', '-w'], signal)).trim(); signal.throwIfAborted();
      if (!/^[A-Za-z0-9._~-]{10,4096}$/.test(token)) throw new Error(); return token;
    } catch { signal.throwIfAborted(); throw new Error(`${provider === 'linear' ? 'Linear' : 'Slack'} credentials are unavailable in macOS Keychain. Complete the documented connection setup, then retry.`); }
  };
}
