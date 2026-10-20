import * as z from 'zod/v4';
const id = z.string().trim().min(1).max(200).refine(value => !/[\0\r\n]/.test(value));
export const providerAccountsSchema = z.object({ providerId: id });
export const providerRefreshSchema = z.object({ connectionId: id.optional() });
/** Applies one provider's account choice immediately; omitting `account` disconnects it. */
export const providerSelectSchema = z.object({ providerId: id, account: id.optional(), label: z.string().trim().min(1).max(200).optional() }).strict();
export const providerConnectionSchema = z.object({
  id, providerId: id, account: id, label: z.string().trim().min(1).max(200).optional(), enabled: z.boolean(), isDefault: z.boolean(),
});
export const providerConnectionsSchema = z.array(providerConnectionSchema).max(20).default([]).superRefine((connections, context) => {
  const ids = new Set<string>(), accounts = new Set<string>(), defaults = new Set<string>();
  connections.forEach((connection, index) => {
    const account = JSON.stringify([connection.providerId, connection.account]);
    if (ids.has(connection.id) || accounts.has(account)) context.addIssue({ code: 'custom', path: [index], message: 'Each provider connection and account must appear once' });
    ids.add(connection.id); accounts.add(account);
    if (connection.isDefault) {
      if (!connection.enabled || defaults.has(connection.providerId)) context.addIssue({ code: 'custom', path: [index], message: 'Choose one enabled default account per provider' });
      defaults.add(connection.providerId);
    }
  });
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
/** One setup instruction; `command` is shown as copyable Terminal input. */
export interface ProviderSetupStep { text: string; command?: string }
/** `setupHint` remains the plain-text contract; optional `setupSteps` lets Settings render numbered steps. */
export interface ProviderDescription { id: string; name: string; setupHint: string; setupSteps?: ProviderSetupStep[]; manualAccount?: { label: string; placeholder: string; pattern: string } }
export interface ProviderAccount { id: string; label: string; available: boolean; active: boolean; credentialSource: string }
/** `budget` is the account's request-budget line; `budgetOnly` entries have no item sync. */
export interface ProviderSyncStatus { connectionId: string; providerId: string; enabled: boolean; working: boolean; checkedAt?: number; nextAt?: number; error?: string; budget?: string; budgetOnly?: boolean }

/** Selecting a new default never retargets resources bound to an older account.
 * Disconnect disables this provider's saved bindings; reconnect retains their IDs. */
export function selectProviderAccount(connections: ProviderConnection[], providerId: string, account: string | undefined, newId: string, label?: string): ProviderConnection[] {
  const next = connections.map(connection => connection.providerId !== providerId ? connection : { ...connection, isDefault: false, enabled: account ? connection.enabled : false });
  if (account) {
    const existing = next.find(connection => connection.providerId === providerId && connection.account === account);
    if (existing) { existing.enabled = true; existing.isDefault = true; if (label) existing.label = label; }
    else next.push({ id: newId, providerId, account, ...(label ? { label } : {}), enabled: true, isDefault: true });
  }
  return providerConnectionsSchema.parse(next);
}
