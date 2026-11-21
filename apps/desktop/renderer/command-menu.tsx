import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GraphNode } from '../../../src/graph/graph.ts';
import { commandMenuSections } from './command-menu-model.ts';
import type { CommandMenuRow } from './command-menu-model.ts';
import { shortcutKey } from './shortcuts.ts';

interface CommandMenuProps {
  nodes(): readonly GraphNode[];
  recent(): readonly string[];
  /** The text the field starts with, as when Back returns here from a form the menu opened. */
  initialQuery?: string;
  /** On the Undermap, where the creations stay out of the list. */
  below?: boolean;
  /** A line under the field, as when a picked command could not run and the menu came back. */
  notice?: string;
  /** Called after the menu has closed, so the chosen action finds the map as it was, with the query that found the row
   * and where the panel stood, so a form it opens takes the panel's place. */
  pick(row: CommandMenuRow, query: string, panel: DOMRect | undefined): void;
  close(): void;
}

/** ⌘K: one field to jump to an item or project, or run a map or app command (MAP-34). */
export function CommandMenu({ nodes, recent, initialQuery = '', below = false, notice, pick, close }: CommandMenuProps) {
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLElement>(null), list = useId();
  const [query, setQuery] = useState(initialQuery), [active, setActive] = useState(0);
  const sections = useMemo(() => commandMenuSections(nodes(), recent(), query, { below }), [query, below]);
  const rows = sections.flatMap(section => section.rows), current = rows[Math.min(active, rows.length - 1)];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus(); input.current?.select();
    return () => { if (document.activeElement === document.body || !document.activeElement) previous?.focus?.(); };
  }, []);
  useEffect(() => { if (current) document.getElementById(`${list}-${current.id}`)?.scrollIntoView({ block: 'nearest' }); }, [current?.id]);
  const choose = (row: CommandMenuRow | undefined) => { if (!row) return; const panel = dialog.current?.getBoundingClientRect(); close(); requestAnimationFrame(() => pick(row, query, panel)); };
  let index = -1;
  return <div className="command-menu-scrim" onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu" data-shortcuts="off">
      <div className="command-menu-field">
        <input ref={input} type="search" role="combobox" aria-label="Search items, projects and commands" aria-expanded="true" aria-controls={list} aria-autocomplete="list"
          aria-activedescendant={current ? `${list}-${current.id}` : undefined} placeholder="Jump to an item or project, or run a command…" spellCheck={false} autoComplete="off" value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            // Enter and Escape that commit or cancel an IME composition belong to the IME.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const toggle = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey);
            if (event.key === 'Escape' || toggle) { event.preventDefault(); event.stopPropagation(); close(); }
            else if (event.key === 'Enter') { event.preventDefault(); choose(current); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (rows.length) setActive((Math.min(active, rows.length - 1) + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length); }
          }} />
        <kbd aria-hidden="true">{shortcutKey('command.menu')}</kbd>
      </div>
      {notice && <p className="command-menu-notice" role="status">{notice}</p>}
      {rows.length ? <div id={list} className="command-menu-results" role="listbox" aria-label="Results">{sections.map(section => <div key={section.label} role="group" aria-label={section.label}>
        <p className="command-menu-heading" aria-hidden="true">{section.label}</p>
        {section.rows.map(row => { index += 1; const at = index; return <div key={row.id} id={`${list}-${row.id}`} role="option" aria-selected={row === current} data-kind={row.kind}
          onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (active !== at) setActive(at); }} onClick={() => choose(row)}>
          <strong>{row.title}</strong>{row.detail && <span>{row.detail}</span>}{row.hint && <kbd aria-hidden="true">{row.hint}</kbd>}
        </div>; })}
      </div>)}</div>
        : <p className="command-menu-empty" role="status">Nothing matches “{query.trim()}”.</p>}
      <footer aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
    </section>
  </div>;
}
