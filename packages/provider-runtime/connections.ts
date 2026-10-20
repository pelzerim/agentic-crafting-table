import type { ProviderAccount, ProviderConnection, ProviderDescription } from '../core/connections.ts';
import { githubCredentials } from './github-transport.ts';

/** `order` places the provider in Settings (lower first, default 100); it is not described. */
export interface ConnectionAdapter extends ProviderDescription { order?: number; accounts(signal: AbortSignal): Promise<ProviderAccount[]> }
export class ProviderConnections {
  private adapters = new Map<string, ConnectionAdapter>();
  private read: () => ProviderConnection[];
  constructor(read: () => ProviderConnection[], adapters: ConnectionAdapter[]) {
    this.read = read;
    for (const adapter of adapters) this.register(adapter);
  }
  register(adapter: ConnectionAdapter) {
    if (this.adapters.has(adapter.id)) throw new Error('Provider is already registered');
    this.adapters.set(adapter.id, adapter);
  }
  describe(): ProviderDescription[] { return [...this.adapters.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)).map(({ id, name, setupHint, setupSteps, manualAccount }) => ({ id, name, setupHint, ...(setupSteps ? { setupSteps } : {}), ...(manualAccount ? { manualAccount } : {}) })); }
  async accounts(providerId: string, signal: AbortSignal) {
    const adapter = this.adapters.get(providerId); if (!adapter) throw new Error('Provider is not installed');
    signal.throwIfAborted(); const result = await adapter.accounts(signal); signal.throwIfAborted(); return result;
  }
  resolve(providerId: string, connectionId?: string) {
    if (!this.adapters.has(providerId)) throw new Error('Provider is not installed');
    const connection = this.read().find(item => item.providerId === providerId && (connectionId ? item.id === connectionId : item.isDefault));
    if (!connection?.enabled) throw Object.assign(new Error(`Connect ${this.adapters.get(providerId)!.name} in Settings to load this item.`), { code: 'PROVIDER_DISCONNECTED' });
    return connection;
  }
}
/** The host's own account type; item packages register theirs through ServiceHost.connectionProvider. */
export function nativeProviderConnections(read: () => ProviderConnection[]) {
  const credentials = githubCredentials();
  return new ProviderConnections(read, [{ id: 'github', name: 'GitHub', order: 10, setupHint: 'Uses accounts signed in with GitHub CLI and its existing credential store. To add an account, run gh auth login.',
    setupSteps: [{ text: 'Sign in with GitHub CLI in Terminal. ACT uses its existing accounts and credential store.', command: 'gh auth login' }, { text: 'Click Connect GitHub and choose the account.' }],
    accounts: async signal => (await credentials.accounts(signal)).map(account => ({ id: account.login, label: account.login, available: account.available, active: account.active, credentialSource: account.credentialSource })),
  }]);
}
