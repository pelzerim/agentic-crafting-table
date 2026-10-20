import { useEffect, useRef, useState } from 'react';
import type { PluginCandidate } from '../../../packages/workspace-service/plugin-store.ts';
import type { InstalledPluginStatus, PluginStatuses } from '../../../packages/workspace-service/plugin-status.ts';
import { rendererFailures } from '../../../src/resource-plugins/installed.client.ts';
import { AdvancedDisclosure, Chip, EmptyState, InlineConfirm, ListItem, Note, SettingRow, SettingsList, SettingsPage, SettingsSection, TextField } from './settings-ui.tsx';
import type { RowStatus } from './settings-ui.tsx';
import type { InstallLinkRequest } from '../install-link.ts';

/** An install link to show in the add-from-git form; `id` changes for every link that arrives. */
export interface PluginInstallRequest { id: number; link: InstallLinkRequest }

const short = (commit: string) => commit === 'dev' ? 'development build' : commit.slice(0, 12);
const sourceText = (plugin: Pick<InstalledPluginStatus, 'source'>) => plugin.source.kind === 'git' ? `${plugin.source.url} @ ${plugin.source.ref}` : plugin.source.path;

function statusChip(plugin: InstalledPluginStatus, failedWindow?: string) {
  if (plugin.removed) return <Chip tone="neutral">Removed</Chip>;
  if (plugin.failure) return <Chip tone="error">Failed</Chip>;
  if (!plugin.enabled) return <Chip tone="neutral">Turned off</Chip>;
  if (!plugin.running || plugin.running.commit !== plugin.commit) return <Chip tone="pending">Reload to apply</Chip>;
  if (plugin.paused) return <Chip tone="error">Paused</Chip>;
  if (failedWindow) return <Chip tone="error">Window code failed</Chip>;
  return <Chip tone="ok">Running</Chip>;
}

/** What the user is asked to trust: the exact build, where it came from and everything it adds. */
function PluginReview({ candidate, busy, cancel, approve }: { candidate: PluginCandidate; busy: boolean; cancel(): void; approve(): void }) {
  const update = candidate.installed && !candidate.installed.removed;
  const action = candidate.dev ? 'Trust and load from folder' : update ? `Trust and update to ${short(candidate.commit)}` : `Trust and install ${short(candidate.commit)}`;
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { keep.current?.focus(); }, []);
  return <div className="settings-card plugin-review" role="group" aria-label={`Review ${candidate.name}`}>
    <p><b>{candidate.name}</b> {candidate.version}{candidate.dev && <> <Chip tone="pending">Development</Chip></>}</p>
    {candidate.description && <p>{candidate.description}</p>}
    <dl className="plugin-facts">
      <dt>Package</dt><dd>{candidate.id}</dd>
      <dt>{candidate.dev ? 'Folder' : 'Commit'}</dt><dd><code>{candidate.dev && candidate.source.kind === 'folder' ? candidate.source.path : candidate.commit}</code></dd>
      {candidate.source.kind === 'git' && <><dt>Source</dt><dd>{candidate.source.url} @ {candidate.source.ref}</dd></>}
      <dt>Plugin API</dt><dd>{candidate.apiRange}</dd>
      {update && <><dt>Replaces</dt><dd>{candidate.installed!.version} · {short(candidate.installed!.commit)}</dd></>}
    </dl>
    {candidate.offline && <Note>The repository could not be reached, so this uses the copy fetched earlier. {candidate.offline}</Note>}
    <p className="plugin-review-heading">{update ? 'Changes to what it adds' : 'What it adds'}</p>
    {update && !candidate.changes.added.length && !candidate.changes.removed.length ? <p>Same contributions; its code changed.</p> : <ul className="plugin-contributions">
      {candidate.changes.added.map(line => <li key={`+${line}`} data-change={update ? 'added' : undefined}>{update ? 'Adds ' : ''}{line}</li>)}
      {candidate.changes.removed.map(line => <li key={`-${line}`} data-change="removed">Removes {line}</li>)}
    </ul>}
    <Note><b>Plugins are trusted code.</b> This one runs with the same access as the app, including your provider accounts, terminals, files and agents. Install only code you trust{candidate.dev ? '' : `; this approval covers commit ${short(candidate.commit)} only and every update asks again`}.</Note>
    <span className="settings-confirm-actions">
      <button type="button" ref={keep} disabled={busy} onClick={cancel}>Cancel</button>
      <button type="button" data-solid disabled={busy} aria-busy={busy || undefined} onClick={approve}>{busy ? 'Installing…' : action}</button>
    </span>
  </div>;
}

/** Settings → Plugins: bundled and installed packages, installing from git, updates, rollback and
 * removal. Every change is applied by restarting the workspace service and reloading the window. */
export function PluginsPage({ hidden, installRequest }: { hidden: boolean; installRequest?: PluginInstallRequest }) {
  const [state, setState] = useState<PluginStatuses>(), [error, setError] = useState('');
  const [url, setUrl] = useState(''), [ref, setRef] = useState('');
  const [fetchStatus, setFetchStatus] = useState<RowStatus>(), [candidate, setCandidate] = useState<PluginCandidate>();
  const [busy, setBusy] = useState(''), [confirm, setConfirm] = useState<{ id: string; kind: 'remove' | 'rollback'; commit?: string }>();
  const [developer, setDeveloper] = useState(false);
  const failedWindows = rendererFailures();
  useEffect(() => {
    if (hidden) return;
    let mounted = true;
    window.craftingTable.pluginsInstalled().then(next => { if (mounted) setState(next); }).catch(failure => { if (mounted) setError((failure as Error).message); });
    return () => { mounted = false; };
  }, [hidden]);
  /** Applies a change: the service restarts and the window reloads with the new plugin set. */
  const apply = async (label: string, change: () => Promise<PluginStatuses>) => {
    setBusy(label); setError('');
    try { setState(await change()); setBusy('Reloading…'); await window.craftingTable.pluginsReload(); }
    catch (failure) { setError((failure as Error).message); setBusy(''); }
  };
  const fetchSource = async (prepare: () => Promise<PluginCandidate>, pending: string) => {
    setCandidate(undefined); setFetchStatus({ tone: 'pending', text: pending });
    try {
      const next = await prepare();
      if (next.installed && !next.installed.removed && next.installed.commit === next.commit) { setFetchStatus({ tone: 'ok', text: `${next.name} is up to date at ${next.version} · ${short(next.commit)}.` }); return; }
      setCandidate(next); setFetchStatus({ tone: 'ok', text: `Fetched ${next.name} ${next.version}. Review it below.` });
    }
    catch (failure) { setFetchStatus({ tone: 'error', text: (failure as Error).message }); }
  };
  /** An install link only fills the form and fetches for review; approving stays with the person. */
  useEffect(() => {
    if (!installRequest) return;
    const { link } = installRequest;
    setCandidate(undefined); setFetchStatus(undefined);
    if ('error' in link) { setError(`The install link was not used. ${link.error}`); return; }
    setError(''); setUrl(link.source); setRef(link.ref ?? '');
    void fetchSource(() => window.craftingTable.pluginsPrepare(link.source, link.ref), 'Fetching from the install link…');
  }, [installRequest?.id]);
  const review = candidate && <PluginReview candidate={candidate} busy={Boolean(busy)} cancel={() => { setCandidate(undefined); setFetchStatus(undefined); }}
    approve={() => { void apply('Installing…', () => window.craftingTable.pluginsInstall(candidate.id, candidate.commit)); }} />;
  const row = (plugin: InstalledPluginStatus) => <ListItem key={plugin.id} data-plugin-id={plugin.id} icon="◇" title={plugin.name}
    chip={<>{statusChip(plugin, failedWindows[plugin.id])}{plugin.dev && <Chip tone="pending">Development</Chip>}</>}
    meta={<small>{plugin.id} · {plugin.version} · {short(plugin.commit)} · {sourceText(plugin)}
      {plugin.failure && <><br />{plugin.failure.reason}</>}
      {plugin.paused && <><br />Paused after repeated failures{plugin.paused.reason ? `: ${plugin.paused.reason}` : ''}</>}
      {failedWindows[plugin.id] && <><br />Window code: {failedWindows[plugin.id]}</>}</small>}
    actions={confirm?.id !== plugin.id && <>
      {plugin.removed && plugin.source.kind === 'git' && <button type="button" disabled={Boolean(busy)} onClick={() => { const source = plugin.source as { url: string; ref: string }; void fetchSource(() => window.craftingTable.pluginsPrepare(source.url, source.ref), `Fetching ${plugin.name}…`); }}>Reinstall…</button>}
      {!plugin.removed && plugin.source.kind === 'git' && <button type="button" disabled={Boolean(busy)} onClick={() => { const source = plugin.source as { url: string; ref: string }; void fetchSource(() => window.craftingTable.pluginsPrepare(source.url, source.ref), `Checking ${plugin.name} for updates…`); }}>Check for update</button>}
      {!plugin.removed && <button type="button" disabled={Boolean(busy)} onClick={() => { void apply('Saving…', () => window.craftingTable.pluginsEnable(plugin.id, !plugin.enabled)); }}>{plugin.enabled ? 'Turn off' : 'Turn on'}</button>}
      {!plugin.removed && plugin.previous[0] && <button type="button" disabled={Boolean(busy)} onClick={() => setConfirm({ id: plugin.id, kind: 'rollback', commit: plugin.previous[0].commit })}>Roll back…</button>}
      {!plugin.removed && <button type="button" className="settings-danger" disabled={Boolean(busy)} onClick={() => setConfirm({ id: plugin.id, kind: 'remove' })}>Remove…</button>}
    </>}>
    {confirm?.id === plugin.id && confirm.kind === 'remove' && <InlineConfirm confirmLabel="Remove plugin" busy={Boolean(busy)} cancel={() => setConfirm(undefined)}
      message={`Remove ${plugin.name}? Its code is deleted. Its items, links and settings stay on the map as placeholders and come back if you reinstall it.`}
      confirm={() => { void apply('Removing…', () => window.craftingTable.pluginsRemove(plugin.id)); }} />}
    {confirm?.id === plugin.id && confirm.kind === 'rollback' && (() => {
      const target = plugin.previous.find(release => release.commit === confirm.commit)!;
      return <InlineConfirm confirmLabel="Roll back" busy={Boolean(busy)} cancel={() => setConfirm(undefined)}
        message={<>Roll back to {target.version} · {short(target.commit)}, approved {new Date(target.approvedAt).toLocaleDateString()}? It loads from the copy kept on this Mac.
          {plugin.previous.length > 1 && <select aria-label="Version to roll back to" value={confirm.commit} onChange={event => setConfirm({ ...confirm, commit: event.target.value })}>
            {plugin.previous.map(release => <option key={release.commit} value={release.commit}>{release.version} · {short(release.commit)}</option>)}</select>}</>}
        confirm={() => { void apply('Rolling back…', () => window.craftingTable.pluginsRollback(plugin.id, confirm.commit!)); }} />;
    })()}
  </ListItem>;
  return <SettingsPage id="Plugins" title="Plugins" hidden={hidden}
    description="Item types and features from plugin packages. Install your own trusted plugins from git; each is pinned to the commit you approve."
    note={busy ? <span role="status">{busy}</span> : state?.restartRequired ? <>Some changes apply after a reload. <button type="button" className="settings-quiet" onClick={() => { setBusy('Reloading…'); void window.craftingTable.pluginsReload(); }}>Reload plugins</button></> : undefined}>
    {error && <p role="alert">{error}</p>}
    <SettingsSection label="Installed" bare description="Removing a plugin keeps its items as placeholders. Agents cannot install, update or turn on plugins.">
      <SettingsList label="Installed plugins">
        {!state && <EmptyState title="Reading plugins…" />}
        {state && !state.installed.length && <EmptyState title="No plugins installed">Install one from git below.</EmptyState>}
        {state?.installed.map(row)}
      </SettingsList>
    </SettingsSection>
    <SettingsSection label="Install from git" description="Uses your own git, SSH keys and credential helper. The release must contain act-plugin.json, act-plugin.integrity.json and a built dist/ folder.">
      <SettingRow label="Repository" stack><TextField aria-label="Repository URL" placeholder="git@github.com:example/my-plugin-pack.git" value={url} spellCheck={false} onChange={event => setUrl(event.target.value)} /></SettingRow>
      <SettingRow label="Tag, branch or commit" meta="Default branch when empty" status={fetchStatus}>
        <TextField aria-label="Tag, branch or commit" placeholder="v1.0.0" value={ref} spellCheck={false} onChange={event => setRef(event.target.value)} />
        <button type="button" disabled={!url.trim() || fetchStatus?.tone === 'pending' || Boolean(busy)} onClick={() => { void fetchSource(() => window.craftingTable.pluginsPrepare(url.trim(), ref.trim() || undefined), 'Fetching…'); }}>Fetch</button>
      </SettingRow>
    </SettingsSection>
    {review}
    <AdvancedDisclosure open={developer} toggle={() => setDeveloper(open => !open)} count={2}>
      <SettingsSection label="Plugin development">
        <SettingRow label="Load from folder" immediate description="Loads an unpacked build in place, without an integrity check, after you approve it. Shown as Development.">
          <button type="button" disabled={Boolean(busy)} onClick={async () => { const path = await window.craftingTable.chooseDirectory(); if (path) await fetchSource(() => window.craftingTable.pluginsPrepareFolder(path), 'Reading folder…'); }}>Load from folder…</button>
        </SettingRow>
        <SettingRow label="Reload plugins" immediate description="Restarts the workspace service and reloads this window to pick up rebuilt plugin code. Running sessions continue.">
          <button type="button" disabled={Boolean(busy)} onClick={() => { setBusy('Reloading…'); void window.craftingTable.pluginsReload(); }}>Reload plugins</button>
        </SettingRow>
      </SettingsSection>
    </AdvancedDisclosure>
    {state && <SettingsSection label="Built in" bare description="Bundled with the app.">
      <SettingsList label="Built-in plugins">{state.bundled.map(plugin => <ListItem key={plugin.id} title={plugin.name} meta={<small>{plugin.id} · {plugin.version}</small>} />)}</SettingsList>
    </SettingsSection>}
  </SettingsPage>;
}
