import { useEffect, useState } from 'react';
import type { SessionPage, SessionPageView } from '../../../packages/session-runtime/protocol.ts';
import { Chip, EmptyState, InlineConfirm, ListItem, Segmented, SettingsList, SettingsSection } from './settings-ui.tsx';

type View = SessionPageView;
const pageSize = 50;
const views: Record<View, { label: string; name: string; empty: string; hint: string }> = {
  current: { label: 'Current', name: 'Current sessions', empty: 'No current sessions', hint: 'Terminals and agents appear here while they start or run.' },
  ended: { label: 'Ended', name: 'Ended sessions', empty: 'No ended sessions', hint: 'Stopped, exited, failed and lost sessions appear here, newest first.' },
  archived: { label: 'Archived', name: 'Archived sessions', empty: 'No archived sessions', hint: 'Archive a session from its item or from Current or Ended.' },
};
const time = (value: string) => new Date(value).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Mounted (and polling) only while Data & diagnostics or Archive → Sessions is visible.
 * Each poll reads only the visible view's page (plus counts) from the supervisor.
 * `archivedOnly` is the Archive's view: archived entries without the view switch. */
export function SessionManager({ nodeTitles, initialView = 'current', archivedOnly = false }: { nodeTitles: Map<string, string>; initialView?: View | 'active'; archivedOnly?: boolean }) {
  const [page, setPage] = useState<SessionPage & { view: View }>(), [error, setError] = useState('');
  const [view, setView] = useState<View>(archivedOnly ? 'archived' : initialView === 'active' ? 'current' : initialView), [limit, setLimit] = useState(pageSize);
  const [refreshId, refresh] = useState(0), [pending, setPending] = useState(''), [confirm, setConfirm] = useState('');
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await window.craftingTable.sessionsPage(view, 0, limit); if (!cancelled) { setPage({ ...next, view }); setError(''); } } catch (error) { if (!cancelled) setError((error as Error).message); }
      if (!cancelled) timer = setTimeout(() => { void load(); }, 1000);
    };
    void load(); return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshId, view, limit]);
  const manage = async (id: string, action: 'archive' | 'restore' | 'remove' | 'stop') => {
    setPending(id); setError('');
    try { if (action === 'stop') await window.craftingTable.sessionStop(id); else await window.craftingTable.sessionManage(id, action); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(''); setConfirm(''); refresh(value => value + 1); }
  };
  const shown = page?.view === view ? page.sessions : [], total = page?.view === view ? page.total : 0;
  return <SettingsSection label="Sessions" bare className="settings-section session-manager" description="Local processes, including sessions without a map item. Stopping or archiving keeps the conversation and recording.">
    {!archivedOnly && <div className="settings-listbar"><Segmented label="Session views" value={view} change={value => { setConfirm(''); setLimit(pageSize); setView(value); }}
      options={(Object.keys(views) as View[]).map(value => ({ value, label: views[value].label, name: views[value].name, count: page?.counts[value] ?? 0 }))} /></div>}
    {error && <p role="alert">{error}</p>}
    <SettingsList label={views[view].name}>
      {page?.view === view && !shown.length && <EmptyState title={views[view].empty}>{views[view].hint}</EmptyState>}
      {shown.map(session => {
        const running = ['starting', 'running'].includes(session.state), busy = !!pending;
        return <ListItem key={session.id} data-session-id={session.id} icon=">_" title={nodeTitles.get(session.nodeId) ?? 'Session · not on the map'}
          chip={<Chip tone={running ? 'ok' : session.state === 'failed' || session.state === 'lost' ? 'error' : 'neutral'}>{session.stopRequestedAt && running ? 'stopping' : session.state}</Chip>}
          meta={<small>{session.cwd} · {time(session.createdAt)}</small>}
          actions={confirm !== session.id && <>
            <button type="button" disabled={busy || !running || !!session.stopRequestedAt} onClick={() => { void manage(session.id, 'stop'); }}>Stop</button>
            <button type="button" disabled={busy} onClick={() => { void manage(session.id, session.archivedAt ? 'restore' : 'archive'); }}>{session.archivedAt ? 'Restore' : 'Archive'}</button>
            {view === 'archived' && session.archivedAt && <button type="button" className="settings-danger" disabled={busy || running} title={running ? 'Stop the session before deleting its entry' : undefined} onClick={() => setConfirm(session.id)}>Delete entry</button>}
          </>}>
          {confirm === session.id && <InlineConfirm confirmLabel="Delete" busy={busy} message="Delete this entry? Its conversation, recording and files stay available." cancel={() => setConfirm('')} confirm={() => { void manage(session.id, 'remove'); }} />}
        </ListItem>;
      })}
    </SettingsList>
    {shown.length < total && <button type="button" className="session-manager-more" onClick={() => setLimit(value => value + pageSize)}>Show more</button>}
  </SettingsSection>;
}
