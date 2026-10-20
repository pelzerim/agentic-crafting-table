import { useEffect, useRef, useState } from 'react';
import type { SavedSessionOption, SavedSessionPage } from '../../../src/resource-plugins/types.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

export function SessionPicker({ pluginId, provider, mode, changeMode, selected, choose }: { pluginId: string; provider?: string; mode: 'new' | 'continue'; changeMode(mode: 'new' | 'continue'): void; selected?: SavedSessionOption; choose(session: SavedSessionOption): void }) {
  const generation = useRef(0);
  const [query, setQuery] = useState(''), [page, setPage] = useState<SavedSessionPage>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (mode !== 'continue') return;
    let cancelled = false; generation.current++;
    setPage(undefined); setLoading(true); setError('');
    const timer = setTimeout(() => {
      void window.craftingTable.resourceSessions(pluginId, query, 0, { provider }).then(result => { if (!cancelled) setPage(result); })
        .catch(error => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 150 : 0);
    return () => { cancelled = true; generation.current++; clearTimeout(timer); };
  }, [pluginId, provider, mode, query, refresh]);
  const more = async () => {
    if (!page || page.nextOffset === undefined && !page.nextCursor) return;
    setLoading(true); const current = generation.current;
    try { const next = await window.craftingTable.resourceSessions(pluginId, query, page.nextOffset, { provider, cursor: page.nextCursor }); if (current === generation.current) setPage({ ...next, sessions: [...page.sessions, ...next.sessions] }); }
    catch (error) { if (current === generation.current) setError((error as Error).message); } finally { if (current === generation.current) setLoading(false); }
  };
  return <div className="session-picker">
    <div className="session-mode" role="group" aria-label="Session mode">
      <button type="button" aria-pressed={mode === 'new'} onClick={() => { if (mode !== 'new') changeMode('new'); }}>New session</button>
      <button type="button" aria-pressed={mode === 'continue'} onClick={() => { if (mode !== 'continue') changeMode('continue'); }}>Continue session</button>
    </div>
    {mode === 'continue' && <>
    <div className="saved-sessions-heading"><span>Previous sessions on this computer{page?.total !== undefined ? ` · ${page.total}` : ''}</span><button type="button" aria-label="Refresh saved sessions" onClick={() => setRefresh(value => value + 1)}><PixelGlyph name="refresh" /></button></div>
    <input aria-label="Find a saved session" type="search" placeholder="Search saved sessions…" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="saved-session-list" role="listbox" aria-label="Saved sessions" aria-busy={loading}>
      {page?.sessions.map(session => <button type="button" role="option" aria-selected={selected?.id === session.id} disabled={Boolean(session.unavailable)} title={session.unavailable ?? session.cwd} key={session.id} onClick={() => choose(session)}>
        <strong>{session.title}</strong><small>{session.projectTitle ? `On table · ${session.projectTitle}` : session.nodeId ? 'On table' : session.cwd || 'Folder unavailable'}</small>
        <small>{session.modifiedAt ? new Date(session.modifiedAt).toLocaleDateString() : 'Saved in this workspace'}{session.branch ? ` · ${session.branch}` : ''}</small>
      </button>)}
      {!loading && page?.sessions.length === 0 && <small>No saved sessions{query ? ' match your search' : ' yet'}.</small>}
      {loading && <small>Loading sessions…</small>}
    </div>
    {(page?.nextOffset !== undefined || page?.nextCursor) && <button type="button" disabled={loading} onClick={() => { void more(); }}>Load more</button>}
    {error && <p role="alert">{error}</p>}
    {selected && <p className="resume-selection">Resume <strong>{selected.title}</strong><small>{selected.cwd}</small></p>}
    </>}
  </div>;
}
