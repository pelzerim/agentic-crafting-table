import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { UndermapMatch } from '../../../src/graph/undermap.ts';

const LISTED = 8;
export interface UndermapSearchHandle { focus(): void }
export interface FindMatch { id: string; title: string; detail?: string }
interface FindFieldProps {
  label: string; listLabel: string; placeholder: string; empty(query: string): string; shortcut: string; className?: string;
  search(query: string): FindMatch[]; pick(id: string): void;
  /** What the field lists before anything is typed, under its own name. */
  idle?: { label: string; matches(): FindMatch[] };
  /** Focused when it mounts, and closed (rather than only emptied) when Escape, a pick or a blur leaves it. */
  transient?: { close(): void };
}

/** A find field over a list of items: type, see what matches, arrows and Enter or a click pick one. */
export const FindField = forwardRef<UndermapSearchHandle, FindFieldProps>(function FindField({ label, listLabel, placeholder, empty, shortcut, className, search, pick, idle, transient }, handle) {
  const input = useRef<HTMLInputElement>(null), list = useId();
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), [open, setOpen] = useState(false);
  useImperativeHandle(handle, () => ({ focus: () => { input.current?.focus(); input.current?.select(); } }), []);
  useEffect(() => { if (transient) input.current?.focus(); }, []);
  const typed = query.trim() !== '', resting = open && !typed && idle;
  const matches = useMemo(() => !open ? [] : typed ? search(query) : idle?.matches() ?? [], [open, typed, query, search, idle]), shown = matches.slice(0, LISTED);
  const asked = open && (typed || shown.length > 0);
  const leave = () => { setQuery(''); setOpen(false); setActive(0); input.current?.blur(); transient?.close(); };
  const choose = (match: FindMatch | undefined) => { if (!match) return; pick(match.id); leave(); };
  return <div className={['undermap-search', className].filter(Boolean).join(' ')} data-shortcuts="off">
    <input ref={input} type="search" role="combobox" aria-label={label} aria-expanded={asked} aria-controls={list} aria-autocomplete="list" aria-activedescendant={asked && shown[active] ? `${list}-${active}` : undefined}
      placeholder={placeholder} spellCheck={false} autoComplete="off" value={query}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); transient?.close(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leave(); }
        else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (shown.length) setActive((active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length); }
      }} />
    {!query && <kbd aria-hidden="true">{shortcut}</kbd>}
    {asked && <div className="undermap-search-results">
      {resting && <p className="undermap-search-heading" aria-hidden="true">{idle.label}</p>}
      {shown.length > 0 ? <ul id={list} role="listbox" aria-label={resting ? idle.label : listLabel}>{shown.map((match, index) => <li key={match.id} id={`${list}-${index}`} role="option" aria-selected={index === active}
        onPointerDown={event => event.preventDefault()} onPointerEnter={() => setActive(index)} onClick={() => choose(match)}>
        <strong>{match.title}</strong>{match.detail && <span>{match.detail}</span>}</li>)}</ul>
        : <p className="undermap-search-empty">{empty(query.trim())}</p>}
      {matches.length > shown.length && <p className="undermap-search-count">{shown.length} of {matches.length.toLocaleString('en-US')}</p>}
    </div>}
  </div>;
});

/** The find field of the Undermap bar (MAP-18): type, see what matches by title, project or month, and fly to one. */
export const UndermapSearch = forwardRef<UndermapSearchHandle, { shortcut: string; search(query: string): UndermapMatch[]; pick(match: UndermapMatch): void }>(function UndermapSearch({ shortcut, search, pick }, handle) {
  const found = useRef(new Map<string, UndermapMatch>());
  const find = useCallback((query: string) => {
    const matches = search(query); found.current = new Map(matches.map(match => [match.id, match]));
    return matches.map(match => ({ id: match.id, title: match.title, detail: `${match.project} · ${match.month}` }));
  }, [search]);
  return <FindField ref={handle} label="Find in Undermap" listLabel="Items in Undermap" placeholder="Find below and fly there…" empty={query => `Nothing below matches “${query}”.`}
    shortcut={shortcut} search={find} pick={id => { const match = found.current.get(id); if (match) pick(match); }} />;
});
