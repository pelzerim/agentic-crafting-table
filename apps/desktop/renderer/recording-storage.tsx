import { useEffect, useRef, useState } from 'react';
import type { RecordingPage } from '../../../packages/session-runtime/protocol.ts';
import { Chip, EmptyState, InlineConfirm, ListItem, SettingsList, SettingsSection } from './settings-ui.tsx';

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Settings lists recordings without deletion; Archive → Recordings deletes with an inline confirm. */
export function RecordingStorage({ archive = false }: { archive?: boolean }) {
  const [page, setPage] = useState<RecordingPage>();
  const [titles, setTitles] = useState(new Map<string, string>()), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async (before?: number) => {
    const current = ++generation.current; setBusy(true); setError(''); setConfirm('');
    try {
      const [next, workspace] = await Promise.all([window.craftingTable.recordingsList(before), window.craftingTable.workspaceRead()]);
      if (current !== generation.current) return;
      setTitles(new Map(workspace.state.nodes.map(node => [node.id, node.title])));
      setPage(previous => ({ ...next, recordings: before ? [...(previous?.recordings ?? []), ...next.recordings] : next.recordings }));
    } catch (error) { if (current === generation.current) setError((error as Error).message); }
    finally { if (current === generation.current) setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const remove = async (id: string) => {
    setBusy(true); setError('');
    try {
      const result = await window.craftingTable.recordingDelete(id, 'delete-recording');
      await load();
      if (result.cleanupPending) setError('Recording cleared. Local cache cleanup could not finish; retry cleanup.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const entries = page?.recordings.filter(entry => !archive || entry.archivedAt || entry.removedAt);
  const list = <>
    {error && <p role="alert">{error}</p>}
    <SettingsList label={archive ? 'Archived session recordings' : 'Terminal recordings'}>
      {page && <ListItem title="Recording database" meta={<small>{size(page.allocatedBytes)} · {size(page.reusableBytes)} reusable</small>}>{null}</ListItem>}
      {!page && busy && <EmptyState title="Reading local storage…" />}
      {entries?.length === 0 && <EmptyState title={archive ? 'No archived recordings on this page' : 'No recorded sessions'} />}
      {entries?.map(entry => {
        const running = ['starting', 'running'].includes(entry.state);
        return <ListItem key={entry.id} data-recording-id={entry.id} icon=">_" title={titles.get(entry.nodeId) ?? 'Session · not on the map'}
          chip={entry.deletedAt ? <Chip tone="neutral">Recording deleted{entry.cleanupPending ? ' · cache cleanup pending' : ''}</Chip> : undefined}
          meta={<small>{entry.state} · {new Date(entry.createdAt).toLocaleString()} · {entry.id.slice(0, 8)}{archive && running && !entry.deletedAt ? ' · Stop the session before deleting its recording' : ''}</small>}
          actions={archive && confirm !== entry.id && (!entry.deletedAt || entry.cleanupPending) && <button type="button" className="settings-danger" disabled={busy || running || (!entry.hasOutput && !entry.cleanupPending)} onClick={() => setConfirm(entry.id)}>{entry.cleanupPending ? 'Retry cleanup' : 'Delete recording'}</button>}>
          {confirm === entry.id && <InlineConfirm confirmLabel="Confirm deletion" keepLabel="Keep recording" busy={busy} message="Delete this recording? This cannot be undone in the app. Its native conversation, map item and project files stay available." cancel={() => setConfirm('')} confirm={() => { void remove(entry.id); }} />}
        </ListItem>;
      })}
    </SettingsList>
    {page?.nextBefore && <button type="button" disabled={busy} onClick={() => { void load(page.nextBefore); }}>More recordings</button>}
  </>;
  if (!archive) return <SettingsSection label="Terminal recordings" bare className="settings-section recording-storage" action={<button type="button" className="settings-quiet" disabled={busy} onClick={() => { void load(); }}>Refresh recordings</button>}
    description="Complete history is kept; archiving or stopping a session keeps its recording. To delete one, archive its session and open Archive → Recordings. Deleting makes database space reusable; files and older backups do not shrink.">{list}</SettingsSection>;
  return <div className="recording-storage">
    <p className="setting-hint">Deleting makes database space reusable. Database files and older backups do not automatically shrink or disappear.</p>{list}
  </div>;
}
