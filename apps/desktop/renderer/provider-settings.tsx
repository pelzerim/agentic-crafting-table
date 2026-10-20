import { useEffect, useState } from 'react';
import type { ProviderAccount, ProviderConnection, ProviderDescription, ProviderSyncStatus } from '../../../packages/core/connections.ts';
import type { SettingsSnapshot } from '../../../packages/core/settings.ts';
import { Chip, EmptyState, InlineConfirm, ListItem, SettingsList, SettingsPage, SettingsSection, SetupSteps } from './settings-ui.tsx';
import { providerSetupSteps } from './setup-steps.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

/** Account choices apply immediately through `connections.select`; they are not part of the Settings draft. */
export function ProviderSettings({ providers, connections, applied, hidden }: { providers: ProviderDescription[]; connections: ProviderConnection[]; applied(snapshot: SettingsSnapshot): void; hidden: boolean }) {
  const [accounts, setAccounts] = useState<Record<string, ProviderAccount[]>>({}), [loading, setLoading] = useState(''), [errors, setErrors] = useState<Record<string, string>>({});
  const [manual, setManual] = useState<Record<string, string>>({}), [open, setOpen] = useState(''), [steps, setSteps] = useState(''), [confirm, setConfirm] = useState('');
  const [sync, setSync] = useState<ProviderSyncStatus[]>([]);
  useEffect(() => { let active = true; const read = () => { void window.craftingTable.providerStatus().then(value => { if (active) setSync(value); }).catch(() => {}); }; read(); const timer = setInterval(read, 5000); return () => { active = false; clearInterval(timer); }; }, []);
  const fail = (id: string, message: string) => setErrors(previous => ({ ...previous, [id]: message }));
  return <SettingsPage id="Connections" title="Connections" description="Accounts ACT reads items from, using CLIs already signed in on this Mac. Connecting and disconnecting apply immediately." hidden={hidden}>
    <SettingsSection label="Providers" bare><SettingsList label="Providers">{providers.length === 0 && <EmptyState title="No providers available" />}{providers.map(provider => {
      const current = connections.find(connection => connection.providerId === provider.id && connection.isDefault && connection.enabled), choices = accounts[provider.id];
      const status = current && sync.find(status => status.connectionId === current.id), error = errors[provider.id] || status?.error, busy = loading === provider.id;
      const choose = async (account?: string) => {
        setLoading(provider.id); fail(provider.id, ''); setConfirm('');
        try { applied(await window.craftingTable.providerSelect(provider.id, account, choices?.find(choice => choice.id === account)?.label)); if (account) setAccounts(previous => { const next = { ...previous }; delete next[provider.id]; return next; }); setOpen(''); }
        catch (error) { fail(provider.id, (error as Error).message); } finally { setLoading(''); }
      };
      const read = async () => {
        setLoading(provider.id); fail(provider.id, ''); setOpen('');
        try { setAccounts(previous => ({ ...previous, [provider.id]: [] })); const available = await window.craftingTable.providerAccounts(provider.id); setAccounts(previous => ({ ...previous, [provider.id]: available })); }
        catch (error) { fail(provider.id, (error as Error).message); } finally { setLoading(''); }
      };
      const syncState = status && !status.budgetOnly ? status.working ? 'syncing…' : status.checkedAt ? `synced ${new Date(status.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'awaiting first sync' : undefined;
      const meta = current ? [current.label ?? current.account, syncState, status?.budget].filter(Boolean).join(' · ') : undefined;
      return <ListItem key={provider.id} data-provider={provider.id} icon={provider.name[0]} title={provider.name}
        chip={error ? <Chip tone="error">Not connected</Chip> : current ? <Chip tone="ok">Connected</Chip> : undefined}
        meta={<>{meta ?? <>Not connected · <button type="button" className="settings-quiet" aria-expanded={steps === provider.id} onClick={() => setSteps(steps === provider.id ? '' : provider.id)}>{steps === provider.id ? 'Hide steps' : 'How to connect'}</button></>}
          {error && <span className="settings-error" role="alert"><br />{error}</span>}</>}
        actions={<>
          {provider.manualAccount ? <><input className="settings-text" aria-label={provider.manualAccount.label} placeholder={provider.manualAccount.placeholder} value={manual[provider.id] ?? current?.account ?? ''} onChange={event => setManual(previous => ({ ...previous, [provider.id]: event.target.value }))} />
            <button type="button" disabled={busy} onClick={() => { const account = (manual[provider.id] ?? current?.account ?? '').trim(); if (!new RegExp(provider.manualAccount!.pattern).test(account)) fail(provider.id, `Enter a valid ${provider.manualAccount!.label.toLowerCase()}.`); else void choose(account); }}>{busy ? 'Connecting…' : 'Use host'}</button></>
            : current && !choices ? !status?.budgetOnly && status && <button type="button" disabled={!!loading || status.working} onClick={async () => { setLoading(provider.id); fail(provider.id, ''); try { setSync(await window.craftingTable.providerRefresh(current.id)); } catch (error) { fail(provider.id, (error as Error).message); } finally { setLoading(''); } }}>Sync now</button>
              : <button type="button" disabled={!!loading} onClick={() => { void read(); }}>{busy ? 'Reading accounts…' : choices ? 'Refresh accounts' : `Connect ${provider.name}`}</button>}
          {current && <button type="button" className="settings-more" aria-label={`More ${provider.name} actions`} aria-expanded={open === provider.id} onClick={() => setOpen(open === provider.id ? '' : provider.id)}><PixelGlyph name="more" /></button>}
        </>}>
        {open === provider.id && <div className="settings-list-menu">
          {current && !provider.manualAccount && <button type="button" disabled={!!loading} onClick={() => { void read(); }}>Change account</button>}
          {current && <button type="button" className="settings-danger" onClick={() => { setOpen(''); setConfirm(provider.id); }}>Disconnect {provider.name}</button>}
          <button type="button" className="settings-quiet" aria-expanded={steps === provider.id} onClick={() => setSteps(steps === provider.id ? '' : provider.id)}>{steps === provider.id ? 'Hide steps' : 'How to connect'}</button>
        </div>}
        {confirm === provider.id && <InlineConfirm confirmLabel={`Disconnect ${provider.name}`} busy={busy} message={`Disconnect ${current?.label ?? current?.account}? Items keep their saved content; syncing stops until you reconnect.`} cancel={() => setConfirm('')} confirm={() => { void choose(); }} />}
        {choices && <label className="settings-account">{provider.name} account<select aria-label={`${provider.name} account`} value={current?.account ?? ''} disabled={busy} onChange={event => { if (event.target.value) void choose(event.target.value); }}>
          <option value="" disabled>{choices.length || busy ? 'Choose an account' : 'No signed-in accounts found'}</option>
          {current && !choices.some(account => account.id === current.account) && <option value={current.account} disabled>{current.label ?? current.account} · unavailable</option>}
          {choices.map(account => <option key={account.id} value={account.id} disabled={!account.available}>{account.label}{!account.available ? ' · sign-in required' : ''}</option>)}
        </select></label>}
        {steps === provider.id && <SetupSteps steps={providerSetupSteps(provider)} />}
      </ListItem>;
    })}</SettingsList></SettingsSection>
  </SettingsPage>;
}
