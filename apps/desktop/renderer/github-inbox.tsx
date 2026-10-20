import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxAccount } from '../../../packages/workspace-service/github-inbox.ts';
import type { InboxReason } from '../../../packages/provider-runtime/github.ts';
import { RailPanel } from './rail-panel.tsx';
import { Chip } from './ui/chip.tsx';
import { useRailTool } from './rail-state.ts';
import { shortcutKey, useWorkspaceShortcuts } from './shortcuts.ts';
import type { PanelSize } from './rail-panel.tsx';
import { ItemIcon } from './icons.tsx';
import { Button } from './ui/button.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

type Filter = 'inbox' | InboxReason;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'review', label: 'Needs review' }, { id: 'assigned', label: 'Assigned' }, { id: 'authored', label: 'Yours' }, { id: 'mentioned', label: 'Mentioned' },
];
const REASON_LABELS: Record<InboxReason, string> = { review: 'Review requested', assigned: 'Assigned', authored: 'Yours', mentioned: 'Mentioned' };
const ago = (iso?: string) => {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
};

// The last list survives the tool remounting, so it never flashes empty.
let lastAccounts: InboxAccount[] | undefined;

/** GitHub's PR inbox as a rail tool: hover to peek, click to keep it open. */
export function GitHubInboxTool({ mapCenter, reveal, openConnections, size, onSize }: { mapCenter(): { x: number; y: number }; reveal(nodeId: string): void; openConnections(): void; size: PanelSize; onSize(size: PanelSize): void }) {
  const [accounts, setAccountsState] = useState<InboxAccount[] | undefined>(lastAccounts), { rail, open, pinned } = useRailTool('inbox');
  const setAccounts = (value: InboxAccount[]) => { lastAccounts = value; setAccountsState(value); };
  const setOpen = (value: boolean) => { if (value) rail.open('inbox'); else rail.close('inbox'); };
  const [filter, setFilter] = useState<Filter>('inbox'), [busy, setBusy] = useState<string>(), [error, setError] = useState('');
  const root = useRef<HTMLElement>(null), closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined), [draft, setDraft] = useState<PanelSize>(), [resizing, setResizing] = useState(false);
  const load = useCallback(async (refresh = false, opened = false) => {
    try { setAccounts((await window.craftingTable.githubInbox(refresh, opened)).accounts); setError(''); } catch (failure) { setError((failure as Error).message); }
  }, []);
  // The service refreshes GitHub every one to ten minutes; the panel re-reads that cache.
  const waiting = accounts?.some(account => !account.refreshedAt && !account.error) ?? true;
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, waiting ? 2_000 : 20_000); return () => clearInterval(timer); }, [load, waiting]);
  useEffect(() => { if (open) void load(false, true); }, [open]);
  const close = () => {
    clearTimeout(closeTimer.current);
    if (root.current?.querySelector('.rail-panel-sheet')?.contains(document.activeElement)) root.current.querySelector<HTMLElement>('.rail-panel-toggle')?.focus();
    rail.unpin('inbox'); setOpen(false);
  };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeRef.current();
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open]);
  const slotClick = () => { clearTimeout(closeTimer.current); if (open && pinned) close(); else rail.pin('inbox'); };
  useWorkspaceShortcuts({ 'rail.inbox': slotClick });
  const leave = () => { clearTimeout(closeTimer.current); if (!pinned && !resizing) closeTimer.current = setTimeout(() => setOpen(false), 240); };
  const items = (accounts ?? []).flatMap(account => account.items.map(item => ({ ...item, account })));
  // Pull requests you authored show under Yours only: the Inbox tab and the badge are other people's.
  const own = (item: (typeof items)[number]) => item.reasons.includes('authored');
  const unseen = items.filter(item => !item.seen && !own(item));
  const shown = filter === 'inbox' ? unseen : items.filter(item => item.reasons.includes(filter));
  const reviews = unseen.filter(item => item.reasons.includes('review')).length;
  const refreshedAt = accounts?.map(account => account.refreshedAt).filter(Boolean).sort().at(-1);
  const accountError = accounts?.find(account => account.error)?.error;
  const failure = error || accountError, connected = !accounts || accounts.length > 0;
  const loading = !failure && (!accounts || (accounts.length > 0 && !items.length && accounts.every(account => !account.refreshedAt)));
  const show = async (item: (typeof items)[number]) => {
    if (item.nodeId) { reveal(item.nodeId); return; }
    setBusy(item.key);
    try { const result = await window.craftingTable.githubInboxShow({ connectionId: item.account.connectionId, key: item.key, position: mapCenter() }); await load(); reveal(result.nodeId); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(undefined); }
  };
  const hide = async (item: (typeof items)[number]) => {
    setBusy(item.key);
    // Drop it right away; the service keeps it hidden for good.
    if (accounts) setAccounts(accounts.map(account => ({ ...account, items: account.items.filter(candidate => candidate.key !== item.key) })));
    try { await window.craftingTable.githubInboxHide(item.key); } catch (failure) { setError((failure as Error).message); await load(); } finally { setBusy(undefined); }
  };
  const markSeen = async (item: (typeof items)[number], seen: boolean) => {
    setBusy(item.key);
    if (accounts) setAccounts(accounts.map(account => ({ ...account, items: account.items.map(candidate => candidate.key === item.key ? { ...candidate, seen } : candidate) })));
    try { await window.craftingTable.githubInboxSeen(item.key, seen); await load(); } catch (failure) { setError((failure as Error).message); await load(); } finally { setBusy(undefined); }
  };
  // Resizing previews locally and saves once the drag ends.
  const shownSize = draft ?? size;
  return <RailPanel slot="inbox" label="GitHub inbox" className="github-inbox" role="dialog" rootRef={root} open={open} close={close} closeLabel="Close inbox" size={shownSize} defaultWidth={460}
    onSize={next => { if (resizing) setDraft(next); else onSize(next); }} onResizing={active => { setResizing(active); if (active) { clearTimeout(closeTimer.current); setDraft(size); } else { if (draft) onSize(draft); setDraft(undefined); } }}
    onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}
    toggle={{ label: open && pinned ? 'Close GitHub inbox' : `GitHub inbox${unseen.length ? `: ${unseen.length} new${reviews ? `, ${reviews} ${reviews === 1 ? 'review' : 'reviews'} requested` : ''}` : ''}`, title: 'GitHub inbox · pull requests that involve you', pressed: pinned, className: 'github-inbox-toggle',
      shortcut: shortcutKey('rail.inbox'), onClick: slotClick, onDwell: () => { clearTimeout(closeTimer.current); setOpen(true); },
      icon: <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>,
      badge: unseen.length > 0 && <span className="github-inbox-count" aria-hidden="true">{unseen.length}</span> }}
    heading={<><strong>Inbox</strong>
      {connected && <Button variant="icon" className="github-inbox-refresh" onClick={() => { void load(true); }} aria-label="Refresh GitHub inbox" title={refreshedAt ? `Updated ${ago(refreshedAt)} · refreshes every minute` : 'Refresh'}><ItemIcon icon="refresh" /></Button>}</>}>
      {!connected && <div className="github-inbox-connect"><ItemIcon icon="inbox" /><p>Connect GitHub to see pull requests that involve you.</p>
        <Button variant="primary" size="sm" onClick={openConnections}>Open Connections</Button></div>}
      {failure && <div className="github-inbox-error" role="alert"><PixelGlyph name="alert" /><span>Couldn't refresh · {failure}</span>
        <Button size="sm" onClick={() => { setError(''); void load(true); }}>Retry</Button></div>}
      {loading && <><p className="github-inbox-loading" role="status">Loading pull requests…</p>
        <ul className="github-inbox-skeleton" aria-hidden="true">{[0, 1, 2].map(row => <li key={row}><i /><i /><b /></li>)}</ul></>}
      {connected && !loading && <div className="github-inbox-filters" role="tablist" aria-label="Inbox filter">{FILTERS.map(option => {
        const count = option.id === 'inbox' ? unseen.length : items.filter(item => item.reasons.includes(option.id as InboxReason)).length;
        return <button key={option.id} type="button" role="tab" aria-selected={filter === option.id} onClick={() => setFilter(option.id)}>{option.label} <span>{count}</span></button>;
      })}</div>}
      {connected && !loading && accounts && !shown.length && <p className="github-inbox-empty">{filter === 'inbox' ? 'Nothing new' : items.length ? 'Nothing matches this filter.' : 'Nothing needs me on GitHub right now.'}</p>}
      <ul className="github-inbox-list">{shown.map(item => <li key={`${item.account.connectionId}:${item.key}`} data-key={item.key} data-seen={item.seen && !own(item) ? 'true' : undefined}
        onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={event => { if (event.button !== 1) return; event.preventDefault(); void window.craftingTable.openUrl(item.url); if (!item.seen && !own(item)) void markSeen(item, true); }}>
        <div className="github-inbox-main">
          <small>{item.owner}/{item.repo} #{item.number}{accounts && accounts.length > 1 ? ` · ${item.account.login}` : ''}</small>
          <a href={item.url} onClick={event => { event.preventDefault(); void window.craftingTable.openUrl(item.url); }}>{item.title}</a>
          <small>{item.author} · updated {ago(item.updatedAt)}{item.comments ? ` · ${item.comments} comments` : ''}</small>
          <span className="github-inbox-reasons">{item.draft && <Chip tone="info" variant="outline">Draft</Chip>}{item.reasons.map(reason => <Chip key={reason} tone={reason === 'review' ? 'pending' : 'neutral'} data-reason={reason}>{REASON_LABELS[reason]}</Chip>)}</span>
        </div>
        <div className="github-inbox-actions">
          <button type="button" disabled={busy === item.key} onClick={() => { void show(item); }}>{item.nodeId ? item.below ? 'Open in Undermap' : 'Open on map' : busy === item.key ? 'Adding…' : 'Show on map'}</button>
          {own(item) ? null : item.seen
            ? <button type="button" className="github-inbox-seen" disabled={busy === item.key} title="Show it in the Inbox again" onClick={() => { void markSeen(item, false); }}>Back to inbox</button>
            : <button type="button" className="github-inbox-seen" disabled={busy === item.key} aria-label={`Mark ${item.owner}/${item.repo} #${item.number} seen`} title="Leaves the Inbox until it has new activity" onClick={() => { void markSeen(item, true); }}>Seen</button>}
          <button type="button" className="github-inbox-hide" disabled={busy === item.key} aria-label={`Hide ${item.owner}/${item.repo} #${item.number} from the inbox`} title="Hide from the inbox for good" onClick={() => { void hide(item); }}>Hide</button>
        </div>
      </li>)}</ul>
  </RailPanel>;
}
