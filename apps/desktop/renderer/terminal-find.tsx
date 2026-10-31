import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { ItemIcon } from './icons.tsx';
import { useColorScheme } from './color-scheme.ts';
import { FIND_DECORATIONS } from './terminal-theme.ts';

export interface TerminalFindRequest { query: string; request: number }

/** ⌘F inside a terminal: every match is highlighted, the active one stands out. */
export function TerminalFind({ terminal, search, find, setQuery, close }: { terminal: Terminal; search: SearchAddon; find: TerminalFindRequest; setQuery(query: string): void; close(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<{ index: number; count: number }>();
  const scheme = useColorScheme(), SEARCH: ISearchOptions = { caseSensitive: false, decorations: FIND_DECORATIONS[scheme] };
  useEffect(() => { const listener = search.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount })); return () => listener.dispose(); }, [search]);
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, [find.request]);
  useEffect(() => {
    if (find.query) search.findNext(find.query, { ...SEARCH, incremental: true });
    else { search.clearDecorations(); terminal.clearSelection(); setResults(undefined); }
  }, [terminal, search, find.query, scheme]);
  const step = (back: boolean) => { if (find.query) back ? search.findPrevious(find.query, SEARCH) : search.findNext(find.query, SEARCH); };
  const count = !find.query || !results ? '' : !results.count ? 'No results' : results.index < 0 ? `${results.count}+ matches` : `${results.index + 1} of ${results.count}`;
  return <div className="terminal-find" role="search" aria-label="Find in terminal" data-owns-escape=""
    onKeyDown={event => {
      const key = event.key.toLowerCase(), plain = !event.ctrlKey && !event.altKey;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Enter' && plain && !event.metaKey && event.target === input.current || key === 'g' && plain && event.metaKey) { event.preventDefault(); event.stopPropagation(); step(event.shiftKey); }
      else if (key === 'f' && plain && event.metaKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); input.current?.focus(); input.current?.select(); }
    }}>
    <input ref={input} type="search" aria-label="Find in terminal" placeholder="Find" spellCheck={false} autoComplete="off" value={find.query}
      onChange={event => setQuery(event.target.value)} />
    <output aria-live="polite">{count}</output>
    <button type="button" aria-label="Previous match" title="Previous match (⇧↵)" disabled={!results?.count} onClick={() => step(true)}>↑</button>
    <button type="button" aria-label="Next match" title="Next match (↵)" disabled={!results?.count} onClick={() => step(false)}>↓</button>
    <button type="button" aria-label="Close find" title="Close (esc)" onClick={close}><ItemIcon icon="x" /></button>
  </div>;
}
