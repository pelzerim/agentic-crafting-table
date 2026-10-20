import { useEffect, useRef, useState } from 'react';

export interface SettingsEntry { id: string; label: string; marker?: 'dirty' | 'invalid'; children?: SettingsEntry[] }
export const settingsPageId = (id: string) => `settings-page-${encodeURIComponent(id)}`;
export const settingsEntryId = (id: string) => `settings-entry-${encodeURIComponent(id)}`;

/** A single-selection tree; arrows move focus, Enter/Space opens a settings page. */
export function SettingsTree({ entries, selected, expanded, select, toggle }: {
  entries: SettingsEntry[]; selected: string; expanded: Set<string>;
  select(id: string): void; toggle(id: string): void;
}) {
  const elements = useRef(new Map<string, HTMLLIElement>());
  const [active, setActive] = useState(selected);
  useEffect(() => setActive(selected), [selected]);
  const search = useRef({ text: '', time: 0 });
  const visible: { entry: SettingsEntry; parent?: string }[] = [];
  const collect = (nodes: SettingsEntry[], parent?: string) => nodes.forEach(entry => {
    visible.push({ entry, parent }); if (expanded.has(entry.id)) collect(entry.children ?? [], entry.id);
  });
  collect(entries);
  const focus = (id: string) => {
    setActive(id);
    const element = elements.current.get(id);
    element?.focus({ preventScroll: true });
    element?.querySelector(':scope > .settings-tree-row')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const tabStop = visible.some(row => row.entry.id === active) ? active : selected;
  const rows = (nodes: SettingsEntry[], level = 1) => nodes.map(entry => {
    const branch = Boolean(entry.children?.length), open = expanded.has(entry.id);
    return <li key={entry.id} role="treeitem" id={settingsEntryId(entry.id)} aria-label={entry.label}
      aria-level={level} aria-selected={selected === entry.id} aria-expanded={branch ? open : undefined}
      aria-controls={settingsPageId(entry.id)} tabIndex={tabStop === entry.id ? 0 : -1}
      ref={element => { if (element) elements.current.set(entry.id, element); else elements.current.delete(entry.id); }}
      onFocus={event => { if (event.target === event.currentTarget) setActive(entry.id); }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
        const index = visible.findIndex(row => row.entry.id === entry.id), parent = visible[index]?.parent;
        const move = (id?: string) => { if (id) focus(id); };
        switch (event.key) {
          case 'ArrowDown': move(visible[Math.min(index + 1, visible.length - 1)]?.entry.id); break;
          case 'ArrowUp': move(visible[Math.max(0, index - 1)]?.entry.id); break;
          case 'Home': move(visible[0]?.entry.id); break;
          case 'End': move(visible.at(-1)?.entry.id); break;
          case 'ArrowRight': if (branch && !open) toggle(entry.id); else if (branch) move(entry.children![0].id); break;
          case 'ArrowLeft': if (branch && open) toggle(entry.id); else move(parent); break;
          case 'Enter': case ' ': select(entry.id); break;
          default: {
            if (event.key.length !== 1 || event.nativeEvent.isComposing) return;
            const now = performance.now(), key = event.key.toLowerCase();
            const previous = now - search.current.time < 700 ? search.current.text : '';
            const text = previous === key ? key : previous + key;
            search.current = { text, time: now };
            const next = [...visible.slice(index + 1), ...visible.slice(0, index + 1)].find(row => row.entry.label.toLowerCase().startsWith(text));
            move(next?.entry.id);
          }
        }
        event.preventDefault(); event.stopPropagation();
      }}>
      <div className="settings-tree-row" style={{ paddingLeft: 8 + (level - 1) * 16 }} onClick={() => { focus(entry.id); select(entry.id); }}>
        <span className="settings-tree-label">{entry.label}</span>{entry.marker && <span className="settings-tree-marker" data-marker={entry.marker} aria-hidden="true" />}
        {branch && <span className="settings-tree-toggle" aria-hidden="true" data-open={open} onClick={event => { event.stopPropagation(); focus(entry.id); toggle(entry.id); }}>
          <svg viewBox="0 0 8 8" width="8" height="8" shapeRendering="crispEdges"><path fill="currentColor" d="M2 0h2v2h2v2h-2v2h-2v-2h2v-2h-2z" /></svg></span>}
      </div>
      {branch && <ul role="group" hidden={!open}>{rows(entry.children!, level + 1)}</ul>}
    </li>;
  });
  return <nav className="settings-sidebar" aria-label="Settings navigation"><ul className="settings-tree" role="tree" aria-label="Settings">{rows(entries)}</ul></nav>;
}
