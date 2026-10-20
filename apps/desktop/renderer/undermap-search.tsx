import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { UndermapMatch } from '../../../src/graph/undermap.ts';

const LISTED = 8;
export interface UndermapSearchHandle { focus(): void }

/** The find field of the Undermap bar (MAP-18): type, see what matches by title, project or month, and fly to one. */
export const UndermapSearch = forwardRef<UndermapSearchHandle, { shortcut: string; search(query: string): UndermapMatch[]; pick(match: UndermapMatch): void }>(function UndermapSearch({ shortcut, search, pick }, handle) {
  const input = useRef<HTMLInputElement>(null), list = useId();
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), [open, setOpen] = useState(false);
  useImperativeHandle(handle, () => ({ focus: () => { input.current?.focus(); input.current?.select(); } }), []);
  const matches = useMemo(() => open ? search(query) : [], [open, query, search]), shown = matches.slice(0, LISTED);
  const asked = open && query.trim() !== '';
  const leave = () => { setQuery(''); setOpen(false); setActive(0); input.current?.blur(); };
  const choose = (match: UndermapMatch | undefined) => { if (!match) return; pick(match); leave(); };
  return <div className="undermap-search" data-shortcuts="off">
    <input ref={input} type="search" role="combobox" aria-label="Find in Undermap" aria-expanded={asked} aria-controls={list} aria-autocomplete="list" aria-activedescendant={asked && shown[active] ? `${list}-${active}` : undefined}
      placeholder="Find below and fly there…" spellCheck={false} autoComplete="off" value={query}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leave(); }
        else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (shown.length) setActive((active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length); }
      }} />
    {!query && <kbd aria-hidden="true">{shortcut}</kbd>}
    {asked && <div className="undermap-search-results">
      {shown.length > 0 ? <ul id={list} role="listbox" aria-label="Items in Undermap">{shown.map((match, index) => <li key={match.id} id={`${list}-${index}`} role="option" aria-selected={index === active}
        onPointerDown={event => event.preventDefault()} onPointerEnter={() => setActive(index)} onClick={() => choose(match)}>
        <strong>{match.title}</strong><span>{match.project} · {match.month}</span></li>)}</ul>
        : <p className="undermap-search-empty">Nothing below matches “{query.trim()}”.</p>}
      {matches.length > shown.length && <p className="undermap-search-count">{shown.length} of {matches.length.toLocaleString('en-US')}</p>}
    </div>}
  </div>;
});
