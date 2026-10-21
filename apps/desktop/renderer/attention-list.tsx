import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceState } from '../../../packages/core/control.ts';
import type { AttentionHistoryEntry } from '../../../packages/workspace-service/sqlite-store.ts';
import { NEEDS_ME, attentionAge, attentionCounts, attentionLabel, attentionReasons, attentionTierInfo, attentionTiers, needsMeButton } from '../../../src/graph/attention.ts';
import type { AttentionCounting, AttentionItem } from '../../../src/graph/attention.ts';
import { isArchived, isBelow } from '../../../src/graph/archive.ts';
import { RailPanel } from './rail-panel.tsx';
import type { PanelSize } from './rail-panel.tsx';
import { useRailTool } from './rail-state.ts';
import { shortcutKey, useWorkspaceShortcuts } from './shortcuts.ts';
import { ItemIcon } from './icons.tsx';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { Button } from './ui/button.tsx';

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Time of day today, weekday and time this week, otherwise the date. */
const short = (at: number) => {
  const date = new Date(at), now = new Date(), days = (now.setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000;
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return days <= 0 ? time : days < 7 ? `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}` : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const PAGE = 10;
const PANEL_WIDTH = 400;
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}#]+/gu) ?? [];
/** The summary without the parts that only repeat the reason shown above it. */
const freshSummary = (summary: string, reasons: string[]) => {
  const said = new Set(reasons.flatMap(words));
  return summary.split(' · ').filter(part => !words(part).every(word => said.has(word))).join(' · ');
};
const FOCUSABLE = 'button:not(:disabled),[href],[tabindex]:not([tabindex="-1"])';
/** Groups the person folded in Needs me, remembered on this Mac only. */
const FOLDED_KEY = 'craft.needsMe.folded';
const readFolded = (): string[] => { try { const value = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]'); return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : []; } catch { return []; } };
function useFolded() {
  const [folded, setFolded] = useState(() => new Set(readFolded()));
  const toggle = (group: string) => setFolded(old => {
    const next = new Set(old); if (!next.delete(group)) next.add(group);
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])); } catch { /* the fold lasts for this window */ }
    return next;
  });
  return { folded, toggle };
}
/** Keys typed into text or a terminal belong there, Escape included. */
const TYPING = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.terminal-surface,.xterm';
const covers = (panel: DOMRect, card: DOMRect) => {
  const width = Math.min(panel.right, card.right) - Math.max(panel.left, card.left), height = Math.min(panel.bottom, card.bottom) - Math.max(panel.top, card.top);
  return width > 0 && height > 0 && width * height > card.width * card.height / 4;
};

/** Seen Needs me cycles, newest first; scrolling to the end loads the next page. */
function useAttentionHistory(refresh: string) {
  const [history, setHistory] = useState<{ entries: AttentionHistoryEntry[]; more: boolean }>({ entries: [], more: false });
  const [failed, setFailed] = useState<{ offset: number; limit: number }>();
  const loaded = useRef(0), request = useRef(0);
  const load = useCallback(async (offset: number, limit: number) => {
    const token = ++request.current; setFailed(undefined);
    const page = await window.craftingTable.attentionHistory(offset, limit).catch(() => undefined);
    if (token !== request.current) return;
    if (!page) { setFailed({ offset, limit }); return; }
    setHistory(old => { const entries = offset ? [...old.entries.slice(0, offset), ...page.entries] : page.entries; loaded.current = entries.length; return { entries, more: page.more }; });
  }, []);
  useEffect(() => { void load(0, Math.max(PAGE, loaded.current)); }, [refresh, load]);
  return { ...history, failed: Boolean(failed), retry: () => { if (failed) void load(failed.offset, failed.limit); },
    next: () => { if (history.more && !failed) void load(history.entries.length, PAGE); } };
}

interface AttentionRowsProps { items: AttentionItem[]; muted?: AttentionItem[];
  /** Whether Finished joins the number (Settings → Notifications); it is always listed. */
  counting?: AttentionCounting; state: WorkspaceState; reveal(id: string): void; locate(id: string): void; highlight(id: string | undefined): void; dismiss(id: string): void; openWeb?(id: string): boolean; unavailable(message: string): void }

/** Needs me as the rail's top tool: the slot takes the shape of the highest tier present and counts
 * Asking me and My turn. It is amber-filled while one of those waits, quiet with a dim dot when only
 * Finished remains, and a plain "!" at zero. Its sheet follows the rail's rules: rest to peek, click or N to keep open. */
export function NeedsMeTool({ size, onSize, ...rows }: AttentionRowsProps & { size: PanelSize; onSize(size: PanelSize): void }) {
  const { rail, open, pinned } = useRailTool('attention'), counts = attentionCounts(rows.items, rows.counting), count = counts.needsMe, button = needsMeButton(counts);
  // The slot is filled for the highest tier that is counted; uncounted Finished work only tints it.
  const filled = counts.top && (counts.top !== 'finished' || count > 0);
  const root = useRef<HTMLElement>(null), closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined), takeFocus = useRef(false);
  const [draft, setDraft] = useState<PanelSize>(), [resizing, setResizing] = useState(false), [occluded, setOccluded] = useState(false);
  const sheet = () => root.current?.querySelector<HTMLElement>('.rail-panel-sheet');
  const close = () => {
    clearTimeout(closeTimer.current);
    if (sheet()?.contains(document.activeElement)) root.current?.querySelector<HTMLElement>('.rail-panel-toggle')?.focus({ preventScroll: true });
    rail.unpin('attention'); rail.close('attention');
  };
  const slotClick = () => { clearTimeout(closeTimer.current); if (open && pinned) close(); else { takeFocus.current = true; rail.pin('attention'); } };
  useWorkspaceShortcuts({ 'rail.attention': slotClick, 'attention.toggle': slotClick });
  // Keeping it open moves focus to the first row; a peek leaves focus where it was.
  useLayoutEffect(() => {
    if (!open || !takeFocus.current) return;
    takeFocus.current = false;
    const items = [...sheet()?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []];
    (items.find(item => item.matches('.attention-entry')) ?? items.find(item => !item.closest('.rail-panel-header,.rail-panel-resize')) ?? items[0])?.focus({ preventScroll: true });
  }, [open, pinned]);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof Element && event.target.closest(TYPING))) return;
      closeRef.current();
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const leave = () => { clearTimeout(closeTimer.current); if (!pinned && !resizing) closeTimer.current = setTimeout(() => rail.close('attention'), 240); };
  const shownSize = draft ?? size;
  return <RailPanel slot="attention" label="Needs me" className="needs-me-tool" role="dialog" rootRef={root} open={open} close={close} closeLabel="Close needs me" size={shownSize} defaultWidth={PANEL_WIDTH}
    sheetClassName="attention-list" sheetData={{ 'data-occluded': occluded || undefined }} data={{ 'data-pinned': pinned || undefined }}
    onSize={next => { if (resizing) setDraft(next); else onSize(next); }} onResizing={active => { setResizing(active); if (active) { clearTimeout(closeTimer.current); setDraft(size); } else { if (draft) onSize(draft); setDraft(undefined); } }}
    onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}
    onKeyDownCapture={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }}
    toggle={{ label: button.label, title: button.title, pressed: pinned, className: `${filled ? 'needs-me-button' : 'needs-me-quiet'}${counts.top ? ` needs-me-tier-${counts.top}` : ''}`,
      shortcut: `${shortcutKey('rail.attention')} ${shortcutKey('attention.toggle')}`, onClick: slotClick, onDwell: () => { clearTimeout(closeTimer.current); rail.open('attention'); },
      icon: counts.top ? <TierMark tier={counts.top} className="needs-me-shape" /> : <ItemIcon icon="bang" />, badge: count > 0 && <span className="needs-me-count" aria-hidden="true">{count}</span> }}
    heading={<><h2 className="needs-me-title">{NEEDS_ME}</h2>{counts.top && <span className="needs-me-tiers"><TierCounts counts={counts} /></span>}</>}>
    <AttentionRows {...rows} close={close} occluded={setOccluded} />
  </RailPanel>;
}

/** `muted` are the rows of muted projects (MAP-25): never counted, kept behind one collapsed line. */
function AttentionRows({ items, muted = [], counting, state, reveal, locate, highlight, dismiss, openWeb, unavailable, close, occluded: setOccluded }: AttentionRowsProps & { close(): void; occluded(value: boolean): void }) {
  const [hovered, setHovered] = useState<string>(), [focused, setFocused] = useState<string>(), [mutedOpen, setMutedOpen] = useState(false), { folded, toggle } = useFolded();
  const nodes = useMemo(() => new Map(state.nodes.map(node => [node.id, node])), [state.nodes]);
  const history = useAttentionHistory([...items, ...muted].map(item => item.identity).join('\n')), end = useRef<HTMLDivElement>(null), next = useRef(history.next); next.current = history.next;
  useEffect(() => {
    if (!end.current || !history.more || history.failed) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) next.current(); });
    observer.observe(end.current); return () => observer.disconnect();
  }, [history.more, history.entries.length, history.failed]);
  const earlier = (entry: AttentionHistoryEntry) => {
    const node = nodes.get(entry.nodeId) ?? (entry.resourceId ? state.nodes.find(node => node.resourceId === entry.resourceId && !isArchived(node, state.nodes)) ?? state.nodes.find(node => node.resourceId === entry.resourceId) : undefined);
    return { node, status: !node ? 'Deleted · no longer on your table' : isArchived(node, state.nodes) ? 'Archived' : isBelow(node, state.nodes) ? 'In Undermap' : undefined };
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  // What the agent last said wins over its status summary; either drops the parts that only repeat the reason.
  const summaries = new Map([...items, ...muted].map(item => { const node = nodes.get(item.node.id); return [item.identity, node?.lastLine ?? freshSummary(node?.summary.trim() ?? '', item.details)]; }));
  const inspected = [...items, ...(mutedOpen ? muted : [])].filter(item => !folded.has(item.tier)).find(item => item.identity === (hovered ?? focused))?.node.id;
  useEffect(() => { highlight(inspected); return () => highlight(undefined); }, [inspected, highlight]);
  useEffect(() => {
    const card = inspected && document.querySelector(`[data-item-id="${CSS.escape(inspected)}"]`);
    const panel = document.querySelector('.attention-list');
    setOccluded(Boolean(card && panel && covers(panel.getBoundingClientRect(), card.getBoundingClientRect())));
    return () => setOccluded(false);
  }, [inspected, setOccluded]);
  useEffect(() => {
    const clear = () => { setHovered(undefined); setFocused(undefined); };
    window.addEventListener('blur', clear); return () => window.removeEventListener('blur', clear);
  }, []);
  const row = (item: AttentionItem) => <div key={item.identity} className="attention-row" data-tier={item.tier}
      onPointerEnter={() => { setHovered(item.identity); setFocused(undefined); }} onPointerLeave={() => setHovered(undefined)}
      onPointerDown={() => setFocused(undefined)}
      onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={event => { if (event.button !== 1) return; event.preventDefault(); openWeb?.(item.node.id); dismiss(item.node.id); }}
      onFocusCapture={event => { if (event.target.matches(':focus-visible')) setFocused(item.identity); }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
    <button className="attention-entry" aria-label={`Open ${item.node.title}`} aria-description={attentionLabel(item.tier, item.details.join(' · '))} onClick={() => { reveal(item.node.id); close(); }}>
      <strong>{item.node.title}</strong><span className="attention-reason" data-tier={item.tier}><TierMark tier={item.tier} />{item.details.join(' · ')}{attentionAge(item.since, now) && <span className="attention-age"> · {attentionAge(item.since, now)}</span>}</span>
      {summaries.get(item.identity) && <span className="attention-summary" data-said={nodes.get(item.node.id)?.lastLine ? true : undefined} title={summaries.get(item.identity)}>{summaries.get(item.identity)}</span>}
      <small>{[...new Set(item.aliases.map(alias => nodes.get(alias.projectId ?? '')?.title ?? 'Floating item'))].join(' · ')}{item.node.completedAt ? ' · Marked done' : ''}</small>
    </button><div className="attention-actions">
      <Button size="sm" className="attention-dismiss" aria-label={`Dismiss ${item.node.title} from Needs me`} title="Mark as seen" onClick={() => dismiss(item.node.id)}><PixelGlyph name="check" />Seen</Button>
      <Button size="sm" className="attention-locate" aria-label={`Go to ${item.node.title} on map`} title="Show on map" onClick={() => locate(item.node.id)}><PixelGlyph name="crosshair" />Map</Button>
    </div></div>;
  return <>
    {!items.length && <p>Nothing needs me.</p>}
    {attentionTiers.map(tier => { const group = items.filter(item => item.tier === tier), info = attentionTierInfo[tier], open = !folded.has(tier);
      return group.length > 0 && <div key={tier} className="attention-tier" role="group" aria-label={info.name} data-tier={tier} data-folded={open ? undefined : true}>
        <h3><button type="button" className="attention-fold" aria-expanded={open} title={open ? `Collapse ${info.name}` : `Expand ${info.name}`} onClick={() => toggle(tier)}>
          <TierMark tier={tier} /><span>{info.name} · {group.length}</span>{tier === 'finished' && !counting?.countFinished && <small>not counted</small>}<PixelGlyph name="chevron" /></button></h3>{open && group.map(row)}</div>; })}
    {muted.length > 0 && <div className="attention-muted" role="group" aria-label="Muted projects">
      <button type="button" className="attention-muted-toggle" aria-expanded={mutedOpen} title="In muted projects; not counted anywhere and not announced" onClick={() => setMutedOpen(open => !open)}>
        <PixelGlyph name="moon" /><span>Muted · {muted.length}</span><PixelGlyph name="chevron" /></button>
      {mutedOpen && muted.map(row)}
    </div>}
    {(history.entries.length > 0 || history.failed) && <div className="attention-earlier" role="group" aria-label="Earlier" data-folded={folded.has('earlier') || undefined}>
      <h3><button type="button" className="attention-fold" aria-expanded={!folded.has('earlier')} title={folded.has('earlier') ? 'Expand Earlier' : 'Collapse Earlier'} onClick={() => toggle('earlier')}>
        <span>Earlier</span><PixelGlyph name="chevron" /></button></h3>
      {!folded.has('earlier') && history.entries.map(entry => { const { node, status } = earlier(entry), open = () => { if (!node) return; if (isArchived(node, state.nodes)) { unavailable('This item is archived or unavailable. Restore it from Archive to show it on the map.'); return; } reveal(node.id); close(); };
        const seen = `${entry.outcome === 'seen' ? 'Seen' : 'Cleared'} ${short(entry.seenAt)}`;
        return <div key={entry.key} className="attention-row" data-gone={!node || undefined}>
          <button className="attention-entry" aria-label={`Open earlier ${entry.title}`} disabled={!node} onClick={open}
            title={[entry.project, entry.raisedAt ? `Raised ${when(entry.raisedAt)}` : '', `${entry.outcome === 'seen' ? 'Seen' : 'Cleared'} ${when(entry.seenAt)}`].filter(Boolean).join(' · ')}>
            <strong>{entry.title}</strong><span>· {(entry.notes?.length ? entry.notes : entry.reasons.map(reason => attentionReasons[reason])).join(' · ')}{status ? ` · ${status}` : ''}</span>
            <small className="attention-time">{seen}</small>
          </button>
          {node && !isArchived(node, state.nodes) && <div className="attention-actions"><Button size="sm" className="attention-locate" aria-label={`Go to earlier ${entry.title} on map`} title="Show on map" onClick={() => locate(node.id)}><PixelGlyph name="crosshair" /></Button></div>}
        </div>; })}
      {folded.has('earlier') ? null : history.failed ? <p className="attention-more-error" role="alert">Couldn't load earlier<Button size="sm" onClick={history.retry}>Retry</Button></p>
        : history.more && <div ref={end} className="attention-more" role="status"><i aria-hidden="true" />Loading earlier…</div>}
    </div>}
  </>;
}
