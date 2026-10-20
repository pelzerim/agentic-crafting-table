import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addMenuSeparator, canHideMenuEntry, isCustomMenu, itemMenuCustom, itemMenuEntries, moveMenuRow, removeMenuSeparator, resetItemMenu, saveItemMenu, setMenuEntryHidden } from '../../../packages/core/context-menu.ts';
import type { AppSettings } from '../../../packages/core/settings.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import { SettingRow, SettingsSection, useRowControl } from './settings-ui.tsx';

type Menus = AppSettings['menus'];
const DRAG_SCROLL_EDGE = 40, DRAG_SCROLL_STEP = 8;

function TypeSelect({ types, value, custom, change }: { types: PluginDescription[]; value: string; custom(type: PluginDescription): boolean; change(id: string): void }) {
  return <select {...useRowControl()} value={value} onChange={event => change(event.target.value)}>
    {types.map(type => <option key={type.id} value={type.id}>{custom(type) ? `${type.name} · custom menu` : type.name}</option>)}
  </select>;
}

/** The one place that arranges the right-click menu of every item type, including types loaded from plugins. */
export function MenuOrderSettings({ plugins, value, change }: { plugins: PluginDescription[]; value: Menus; change(value: Menus): void }) {
  const types = [...plugins].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const [chosen, setChosen] = useState<string>(), type = types.find(candidate => candidate.id === chosen) ?? types[0];
  const defaults = (candidate: PluginDescription) => itemMenuEntries(candidate).map(entry => entry.id);
  const custom = (candidate: PluginDescription) => isCustomMenu(defaults(candidate), itemMenuCustom(value, candidate.id));
  const rows = type ? itemMenuEntries(type, itemMenuCustom(value, type.id)) : [], layout = rows.map(row => row.id);
  const hidden = type ? value.hidden[type.id] ?? [] : [];
  const list = useRef<HTMLDivElement>(null), refocus = useRef<number | undefined>(undefined);
  // The row last focused is where Add separator puts the new one; no such row means the end.
  const lastRow = useRef<number | undefined>(undefined);
  // The dragged row is known by its place, which each move changes. Pointer moves can arrive faster than this
  // section renders, so the rows and that place are also kept here, current after every move.
  const live = useRef<{ layout: string[]; dragged?: number }>({ layout }); live.current.layout = layout;
  const [dragging, setDragging] = useState<number>(), [moved, setMoved] = useState(''), [refused, setRefused] = useState(false);
  const show = (id: string, label: string, shown: boolean) => {
    if (!type) return;
    const blocked = !shown && !canHideMenuEntry(layout, hidden, id);
    setRefused(blocked); setMoved(blocked ? '' : `${label} is ${shown ? 'shown in' : 'hidden from'} the menu`);
    if (!blocked) change(saveItemMenu(value, type.id, defaults(type), layout, setMenuEntryHidden(layout, hidden, id, !shown)));
  };
  const move = (from: number, index: number) => {
    const current = live.current.layout, to = Math.max(0, Math.min(index, current.length - 1));
    if (!type || from === to) return;
    live.current.layout = moveMenuRow(current, from, to);
    if (live.current.dragged !== undefined) { live.current.dragged = to; setDragging(to); }
    if (lastRow.current === from) lastRow.current = to;
    setMoved(`${rows.find(row => row.id === current[from])?.label} is ${to + 1} of ${current.length}`);
    change(saveItemMenu(value, type.id, defaults(type), live.current.layout));
  };
  const addSeparator = () => {
    if (!type) return;
    const after = lastRow.current !== undefined && lastRow.current < rows.length ? lastRow.current : undefined, at = after === undefined ? rows.length : after + 1;
    refocus.current = at; setMoved(`Separator added, ${at + 1} of ${rows.length + 1}`);
    change(saveItemMenu(value, type.id, defaults(type), addMenuSeparator(layout, after)));
  };
  const removeSeparator = (index: number) => {
    if (!type) return;
    refocus.current = Math.min(index, rows.length - 2); lastRow.current = undefined; setMoved('Separator removed');
    change(saveItemMenu(value, type.id, defaults(type), removeMenuSeparator(layout, index)));
  };
  const latest = useRef(move); latest.current = move;
  const active = dragging !== undefined;
  useEffect(() => {
    if (!active) return;
    let pointer: number | undefined, frame = 0, scroller = list.current!.parentElement;
    while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    // Rows share one height, so the pointer's row is the dragged row's new place.
    const place = () => {
      const all = [...list.current!.querySelectorAll<HTMLElement>('[data-menu-entry]')], index = all.findIndex(row => pointer! < row.getBoundingClientRect().bottom);
      if (live.current.dragged !== undefined) latest.current(live.current.dragged, index < 0 ? all.length - 1 : index);
    };
    const over = (event: PointerEvent) => { pointer = event.clientY; place(); };
    // A list taller than the page scrolls while the pointer rests near an edge, until that end of the list shows.
    const scroll = () => {
      frame = requestAnimationFrame(scroll);
      if (pointer === undefined || !scroller) return;
      const page = scroller.getBoundingClientRect(), rows = list.current!.getBoundingClientRect();
      const step = pointer > page.bottom - DRAG_SCROLL_EDGE && rows.bottom > page.bottom ? DRAG_SCROLL_STEP : pointer < page.top + DRAG_SCROLL_EDGE && rows.top < page.top ? -DRAG_SCROLL_STEP : 0;
      if (!step) return;
      const before = scroller.scrollTop; scroller.scrollTop += step;
      if (scroller.scrollTop !== before) place();
    };
    frame = requestAnimationFrame(scroll);
    const end = () => { live.current.dragged = undefined; setDragging(undefined); };
    window.addEventListener('pointermove', over); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('pointermove', over); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end); };
  }, [active]);
  useLayoutEffect(() => {
    if (refocus.current !== undefined) list.current?.querySelectorAll<HTMLElement>('.menu-order-grip')[refocus.current]?.focus();
    refocus.current = undefined;
  });
  if (!type) return null;
  let separators = 0;
  return <SettingsSection label="Right-click menus" className="settings-section menu-order-settings"
    description="Arrange each item type’s menu. Drag an entry or a separator by its grip, or focus the grip and press ↑ or ↓. Add separator puts a line after the row you last used; × removes it. Untick an entry to leave it out of this menu: it keeps its place, and selections, projects and Undermap still offer it. The menu never shows two lines in a row, or one at its top or bottom. Submenus keep their own order."
    action={<button type="button" className="settings-quiet" disabled={!custom(type)} onClick={() => { setRefused(false); setMoved(`${type.name} menu is back to its default`); change(resetItemMenu(value, type.id)); }}>Reset this menu</button>}>
    <SettingRow label="Item type" description="Each type has its own menu."><TypeSelect types={types} value={type.id} custom={custom} change={id => { setChosen(id); setMoved(''); setRefused(false); lastRow.current = undefined; }} /></SettingRow>
    <div ref={list} role="list" aria-label={`${type.name} menu entries`} className="menu-order-list" data-dragging={active || undefined}>
      {rows.map((row, index) => <div key={row.separator ? `separator ${separators++}` : row.id} role="listitem" className="settings-choice menu-order-row" data-menu-entry={row.id} data-separator={row.separator} data-hidden={row.hidden} data-dragging={dragging === index || undefined} onFocus={() => { lastRow.current = index; }}>
        <button type="button" className="menu-order-grip" aria-label={`Reorder ${row.label}`} title="Drag to reorder · ↑/↓ when focused"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); live.current.dragged = index; setDragging(index); }}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const to = Math.max(0, Math.min(index + (event.key === 'ArrowUp' ? -1 : 1), rows.length - 1));
            event.preventDefault(); event.stopPropagation(); refocus.current = to; move(index, to);
          }}>⠿</button>
        {row.separator ? <><span className="menu-order-line" aria-hidden="true" /><button type="button" className="menu-order-remove" aria-label="Remove separator" title="Remove separator" onClick={() => removeSeparator(index)}>×</button></>
          : <label><input type="checkbox" aria-label={`Show ${row.label} in the menu`} checked={!row.hidden} onChange={event => show(row.id, row.label, event.target.checked)} /><span className="menu-order-label">{row.label}</span></label>}
      </div>)}
    </div>
    <div className="settings-choice menu-order-add"><button type="button" className="settings-quiet" title="After the row you last used, or at the end" onClick={addSeparator}>Add separator</button></div>
    {refused && <p role="alert" className="settings-choice menu-order-hint">At least one entry stays in the menu. Show another entry first.</p>}
    <p role="status" className="menu-order-status">{moved}</p>
  </SettingsSection>;
}
