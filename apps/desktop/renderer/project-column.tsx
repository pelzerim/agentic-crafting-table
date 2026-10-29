import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { attentionCountText, attentionTierInfo } from '../../../src/graph/attention.ts';
import { COLUMN_KINDS, columnBaseline, columnKindNames, metaText, ORDER_LIMIT, projectsNewSince, reorder as reorderSaved } from '../../../src/graph/project-column.ts';
import type { ColumnBaseline, ColumnKind, ProjectColumnGroup, ProjectColumnItem, ProjectColumnItemGroup, ProjectColumnModel, ProjectColumnNeed, ProjectColumnRow } from '../../../src/graph/project-column.ts';
import type { ProjectsPanelState } from '../../../packages/core/control.ts';
import type { DashboardIcon } from './project-dashboard.tsx';
import { ItemIcon } from './icons.tsx';
import { PIXEL_GLYPHS, glyphPath } from '../../../src/resource-plugins/pixel-glyphs.ts';
import { plotStyle } from './plot-style.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import './project-column.css';

/** `markSeen` acknowledges as the Needs me sheet's Seen does; `showTodo` opens the to-do list at that to-do; `openItem` opens an item, closing one already open; `showNeed` locates it, or opens it in place of an open item. */
export interface ProjectColumnActions { fitProject(id: string): void; locate(id: string): void; showNeed?(id: string): void; fitPlot(id: string): void; markSeen?(id: string): void; showTodo?(id: string): void; openItem?(id: string): void }
/** Folded project and plot ids and the fold toggle, shared by every row. */
interface Folds { folded: ReadonlySet<string>; toggle(id: string): void }
type RowKind = 'project' | 'plot';
/** Saves `id` before `before`, or after `last` when `before` is null; `say` announces a keyboard move. */
interface Reorder { move(kind: RowKind, id: string, before: string | null, last: string): boolean; say(text: string, focus: string): void }
/** Pointer travel before a press on a row becomes a drag. */
const DRAG_THRESHOLD = 4;
let cancelDrag: (() => void) | undefined;
// Registered at load so it runs before the capture Escape handlers that forms and pickers add later.
globalThis.window?.addEventListener('keydown', event => { if (event.key === 'Escape' && cancelDrag) { event.preventDefault(); event.stopImmediatePropagation(); cancelDrag(); } }, true);
const PANEL = { min: { width: 260, height: 160 }, max: { width: 900, height: 1000 }, inset: 16, gap: 8, step: 20 } as const;
/** Saved folds kept to the newest; the view schema caps them. */
const FOLD_LIMIT = 500;
/** Screen pixels of the folded column, matched by project-column.css. */
const COLUMN = { pad: 6, icon: 32, gap: 4, more: 20, toggle: 20, inset: 16 } as const;
const PEN_GLYPH = glyphPath(PIXEL_GLYPHS[8].pen);
const NOTHING_NEW: ReadonlySet<string> = new Set();
/** Rows the folded column's tooltip lists before “+N more”. */
const TIP_ROWS = 4;
/** What the column showed when this window last unfolded it; kept for the window's life, never saved. */
let unfoldedBaseline: ColumnBaseline | undefined;

/** The folded column's height in pixels: its icons, the gaps between them and its padding. */
export function projectColumnHeight(model: ProjectColumnModel) {
  const icons = model.icons.length;
  return COLUMN.pad * 2 + COLUMN.toggle + (icons ? icons * (COLUMN.icon + COLUMN.gap) : 0) + (model.more ? COLUMN.more + COLUMN.gap : 0);
}

const describe = (row: ProjectColumnRow) => [attentionCountText(row.tiers, ', ') || 'nothing needs me', row.working ? `${row.working} working` : ''].filter(Boolean).join(', ');
const needText = (need: ProjectColumnNeed) => `${need.title} — ${need.reason}`;

function Mark({ row }: { row: ProjectColumnRow }) {
  if (row.mark === 'idle') return null;
  return <span className="project-icon-mark" data-mark={row.mark}><TierMark tier={row.mark} /><b>{row.count}</b></span>;
}

/** A line the summary model wrote: the pen says so, the title spells it out. */
function Written({ text, className, pen }: { text: string; className: string; pen?: boolean }) {
  return <p className={className} title="Written by the summary model">
    {pen && <svg className="project-column-pen" viewBox="-.5 -.5 9 9" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d={PEN_GLYPH} /></svg>}
    <span>{text}<span className="project-column-hidden"> (written by the summary model)</span></span>
  </p>;
}

/** Up and Down move between the rows of the column or the panel; Enter is the row's own click. */
function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
  if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-column-row]')];
  if (!rows.length) return;
  event.preventDefault(); event.stopPropagation();
  const index = rows.indexOf(document.activeElement as HTMLElement), next = event.key === 'ArrowDown' ? index + 1 : index - 1;
  rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : next))].focus();
}

/** The project rows of the dragged row's list, or the plot groups of its project, with their ids. */
function siblings(element: HTMLElement, kind: RowKind) {
  const self = element.closest<HTMLElement>(kind === 'project' ? '[data-project-row]' : '.project-column-group')!;
  const scope = kind === 'project' ? self.parentElement! : self.closest<HTMLElement>('[data-project-row]')!;
  const rows = () => kind === 'project' ? [...scope.querySelectorAll<HTMLElement>(':scope > [data-project-row]')] : [...scope.querySelectorAll<HTMLElement>('[data-plot-header]')].map(head => head.closest<HTMLElement>('.project-column-group')!);
  const idOf = (row: HTMLElement) => kind === 'project' ? row.dataset.projectRow! : row.querySelector<HTMLElement>('[data-plot-header]')!.dataset.plotHeader!;
  return { self, scope, rows, idOf };
}

/** A press that travels a few pixels drags the row: a line shows where it lands, Escape cancels, a drop outside its list (a plot outside its project) is refused. */
function dragRow(event: React.PointerEvent<HTMLElement>, kind: RowKind, id: string, reorder: Reorder) {
  if (event.button !== 0) return;
  const { self, scope, rows, idOf } = siblings(event.currentTarget, kind), start = { x: event.clientX, y: event.clientY }, grip = event.currentTarget, pointer = event.pointerId;
  let state: 'press' | 'drag' | 'cancel' = 'press', target: { before: string | null; last: string } | undefined;
  const mark = (row?: HTMLElement, where?: 'before' | 'after') => { for (const other of rows()) delete other.dataset.drop; if (row && where) row.dataset.drop = where; };
  const move = (next: PointerEvent) => {
    if (!next.buttons) { abort(); return; }
    if (state === 'cancel' || (state === 'press' && Math.hypot(next.clientX - start.x, next.clientY - start.y) < DRAG_THRESHOLD)) return;
    if (state === 'press') cancelDrag = () => { state = 'cancel'; cancelDrag = undefined; mark(); delete self.dataset.dragging; };
    if (state === 'press' && !grip.hasPointerCapture(pointer)) grip.setPointerCapture(pointer);
    state = 'drag'; self.dataset.dragging = '';
    const box = scope.getBoundingClientRect(), shown = self.closest('.project-column-panel')?.getBoundingClientRect() ?? box, others = rows().filter(row => row !== self);
    const top = Math.max(box.top, shown.top), bottom = Math.min(box.bottom, shown.bottom), left = Math.max(box.left, shown.left), right = Math.min(box.right, shown.right);
    if (!others.length || next.clientY < top || next.clientY > bottom || next.clientX < left || next.clientX > right) { target = undefined; mark(); return; }
    const at = others.find(row => { const rect = row.getBoundingClientRect(); return next.clientY < rect.top + rect.height / 2; });
    target = { before: at ? idOf(at) : null, last: idOf(others.at(-1)!) }; mark(at ?? others.at(-1), at ? 'before' : 'after');
  };
  const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
  const abort = () => { if (state === 'drag') state = 'cancel'; up(); };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', abort);
    cancelDrag = undefined; mark(); delete self.dataset.dragging;
    if (state === 'press') return;
    window.addEventListener('click', swallow, true); setTimeout(() => window.removeEventListener('click', swallow, true));
    if (state === 'drag' && target) reorder.move(kind, id, target.before, target.last);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', abort);
}

/** Alt+Up and Alt+Down move a project row or plot header one place within its list. */
function nudgeRow(event: React.KeyboardEvent<HTMLElement>, kind: RowKind, id: string, name: string, reorder: Reorder) {
  if (!event.altKey || event.metaKey || event.ctrlKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  event.preventDefault(); event.stopPropagation();
  const { rows, idOf } = siblings(event.currentTarget, kind), ids = rows().map(idOf), index = ids.indexOf(id), up = event.key === 'ArrowUp';
  if (up ? index <= 0 : index < 0 || index >= ids.length - 1) return;
  if (!(up ? reorder.move(kind, id, ids[index - 1], '') : reorder.move(kind, id, ids[index + 2] ?? null, ids[index + 1]))) return;
  reorder.say(`${name} moved to place ${index + (up ? 0 : 2)} of ${ids.length}`, kind === 'project' ? `[data-project-row="${CSS.escape(id)}"] .project-column-name` : `[data-plot-header="${CSS.escape(id)}"]`);
}

function Need({ need, actions }: { need: ProjectColumnNeed; actions: ProjectColumnActions }) {
  return <li className="project-column-entry" data-need-row={need.id} data-tier={need.tier} data-seen={need.seen || undefined}>
    <button type="button" className="project-column-entry-main" data-column-row="" data-need={need.id} aria-label={`${need.title}: ${attentionTierInfo[need.tier].name}, ${need.reason}${need.age ? `, ${need.age}` : ''}. Go to item on map`} onClick={() => actions.showNeed ? actions.showNeed(need.id) : actions.locate(need.id)}>
      <TierMark tier={need.tier} /><span className="project-column-entry-text"><span className="project-column-entry-title">{need.title}</span><span className="project-column-reason"> — {need.reason}</span></span>
    </button>
    {actions.markSeen && !need.seen && <button type="button" className="project-column-seen" aria-label={`Mark ${need.title} seen`} title="Mark seen (remove from Needs me)" onClick={() => actions.markSeen!(need.id)}>Seen</button>}
    <small>{need.age}</small>
  </li>;
}

function Fold({ id, name, folds }: { id: string; name: string; folds: Folds }) {
  const folded = folds.folded.has(id);
  return <button type="button" className="project-column-fold" aria-label={`${folded ? 'Unfold' : 'Fold'} ${name}`} aria-expanded={!folded} onClick={() => folds.toggle(id)}>
    <PixelGlyph name={folded ? 'chevron-right' : 'chevron'} /></button>;
}

function PlotHeader({ id, name, label, folds, actions, reorder }: { id: string; name: string; label: string; folds: Folds; actions: ProjectColumnActions; reorder: Reorder }) {
  return <div className="project-column-plot-head" onPointerDown={event => dragRow(event, 'plot', id, reorder)}><Fold id={id} name={name} folds={folds} />
    <button type="button" className="project-column-plot" data-column-row="" data-plot-header={id} aria-label={label} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onClick={() => actions.fitPlot(id)} onKeyDown={event => nudgeRow(event, 'plot', id, name, reorder)}>
      <i aria-hidden="true" /><span className="project-column-plot-name">{name}</span></button></div>;
}

function Group({ group, color, actions, folds, reorder }: { group: ProjectColumnGroup; color: string; actions: ProjectColumnActions; folds: Folds; reorder: Reorder }) {
  const counts = [attentionCountText(group.tiers, ', '), group.working ? `${group.working} working` : ''].filter(Boolean).join(', ');
  if (group.plot && !group.entries.length) return null;
  return <div className="project-column-group" data-plot={group.plot || undefined} style={plotStyle(color, group.color)}>
    {group.plot && <PlotHeader id={group.id} name={group.name} label={`Plot ${group.name}: ${counts}. Fly there`} folds={folds} actions={actions} reorder={reorder} />}
    {!group.plot && group.id && <p className="project-column-loose">Loose</p>}
    {!folds.folded.has(group.id) && <ul className="project-column-entries">{group.entries.map(need => <Need key={need.id} need={need} actions={actions} />)}</ul>}
  </div>;
}

const stateName = (item: ProjectColumnItem) => item.state === 'working' ? 'Working' : item.state ? attentionTierInfo[item.state].name : '';

function Item({ item, icon, actions }: { item: ProjectColumnItem; icon?: DashboardIcon; actions: ProjectColumnActions }) {
  const state = stateName(item);
  return <li className="project-column-entry project-column-item" data-item-row={item.id} data-state={item.state}>
    <button type="button" className="project-column-entry-main" data-column-row="" aria-label={`${item.title}${state ? `: ${state}` : ''}. Open`} onClick={() => actions.openItem ? actions.openItem(item.id) : actions.locate(item.id)}>
      <ItemIcon icon={icon?.icon} brand={icon?.brand} tint={icon?.tint} /><span className="project-column-entry-text"><span className="project-column-entry-title">{item.title}</span></span>
    </button>
    {state && <small className="project-column-state">{state}</small>}
  </li>;
}

function ItemGroup({ group, color, plots, icons, actions, folds, reorder }: { group: ProjectColumnItemGroup; color: string; plots: boolean; icons?: ReadonlyMap<string, DashboardIcon>; actions: ProjectColumnActions; folds: Folds; reorder: Reorder }) {
  return <div className="project-column-group" data-plot={group.plot || undefined} style={plotStyle(color, group.color)}>
    {group.plot && <PlotHeader id={group.id} name={group.name} label={`Plot ${group.name}: ${group.entries.length} ${group.entries.length === 1 ? 'item' : 'items'}. Fly there`} folds={folds} actions={actions} reorder={reorder} />}
    {!group.plot && plots && <p className="project-column-loose">Loose</p>}
    {!folds.folded.has(group.id) && <ul className="project-column-entries">{group.entries.map(item => <Item key={item.id} item={item} icon={icons?.get(item.id)} actions={actions} />)}</ul>}
  </div>;
}

function Meta({ meta, projectId, actions }: { meta: ProjectColumnRow['meta']; projectId: string; actions: ProjectColumnActions }) {
  const open = meta.todos.open, first = meta.todos.first;
  if (!open && !meta.working) return null;
  return <p className="project-column-meta">
    {open > 0 && <button type="button" title={first && actions.showTodo ? 'Open the to-do list' : 'Fly to the project'} onClick={() => first && actions.showTodo ? actions.showTodo(first) : actions.fitProject(projectId)}>{open} {open === 1 ? 'to-do' : 'to-dos'}</button>}
    {open > 0 && meta.working > 0 && ' · '}
    {meta.working > 0 && <span>{meta.working} working</span>}
  </p>;
}

function ProjectRow({ row, actions, folds, icons, reorder }: { row: ProjectColumnRow; actions: ProjectColumnActions; folds: Folds; icons?: ReadonlyMap<string, DashboardIcon>; reorder: Reorder }) {
  const folded = folds.folded.has(row.id), plots = Boolean(row.items?.some(group => group.plot));
  return <li className="project-column-row" data-project-row={row.id} data-folded={folded || undefined} style={{ '--project-color': row.color } as React.CSSProperties}>
    <div className="project-column-head" onPointerDown={event => dragRow(event, 'project', row.id, reorder)}>
      <Fold id={row.id} name={row.title} folds={folds} />
      <span className="project-column-tag" aria-hidden="true">{row.tag}</span>
      <button type="button" className="project-column-name" data-column-row="" aria-label={`${row.title}: ${describe(row)}${row.age ? `, active ${row.age} ago` : ''}. Fly there`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={() => actions.fitProject(row.id)} onKeyDown={event => nudgeRow(event, 'project', row.id, row.title, reorder)}>{row.title}</button>
      <TierCounts counts={row.tiers} className="project-column-counts" /><small>{row.age}</small>
    </div>
    {!folded && <>
      {row.items ? row.items.map(group => <ItemGroup key={group.id} group={group} color={row.color} plots={plots} icons={icons} actions={actions} folds={folds} reorder={reorder} />)
        : row.groups.map(group => <Group key={group.id} group={group} color={row.color} actions={actions} folds={folds} reorder={reorder} />)}
      {!row.items && row.next && <Written text={row.next} className="project-column-next" pen />}
      {!row.items && row.status && <Written text={row.status} className="project-column-status" />}
      {!row.items && <Meta meta={row.meta} projectId={row.id} actions={actions} />}
    </>}
  </li>;
}

/** The bottom-right project column (MAP-22): one tagged icon per project that is not muted, most
 * urgent first, badged only when something waits on the person, edged in copper when something
 * arrived since the list was last unfolded; unfolded, one row per project with what waits on the
 * person, the lines the summary model wrote and what else is open. It re-renders only when its
 * model, its open state or its hover changes. */
export const ProjectColumn = memo(function ProjectColumn({ model, open, setOpen, actions, icons, panel: saved, onPanel }: { model: ProjectColumnModel; open: boolean; setOpen(open: boolean): void; actions: ProjectColumnActions;
  icons?: ReadonlyMap<string, DashboardIcon>; panel?: ProjectsPanelState; onPanel?(patch: Partial<ProjectsPanelState>): boolean | void }) {
  const [hovered, setHovered] = useState<string>(), [quietOpen, setQuietOpen] = useState(false);
  const [baseline, setBaseline] = useState(() => unfoldedBaseline);
  const [draft, setDraft] = useState<{ width: number; height: number }>(), [room, setRoom] = useState<number>();
  const panel = useRef<HTMLElement>(null), pinned = Boolean(saved?.pinned);
  useEffect(() => { setHovered(undefined); if (open && !pinned) panel.current?.querySelector<HTMLElement>('[data-column-row]')?.focus({ preventScroll: true }); }, [open]);
  // An open rail sheet or the Controls card narrows the panel so both stay in view.
  useEffect(() => {
    const element = panel.current, root = element?.closest('.live-workspace') ?? document.body;
    if (!open || !element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const area = (element.offsetParent ?? root).getBoundingClientRect(), own = element.getBoundingClientRect();
      let edge = -Infinity;
      for (const other of root.querySelectorAll('.rail-panel[data-open="true"] .rail-panel-sheet, .controls-card')) {
        const box = other.getBoundingClientRect();
        if (box.width && box.bottom > own.top && box.top < own.bottom) edge = Math.max(edge, box.right);
      }
      setRoom(edge === -Infinity ? undefined : Math.max(PANEL.min.width, Math.floor(area.right - PANEL.inset - PANEL.gap - edge)));
    };
    const later = () => { frame ||= requestAnimationFrame(measure); };
    const observer = new MutationObserver(later);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-open', 'data-resizing', 'data-sized'] });
    window.addEventListener('resize', later); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', later); cancelAnimationFrame(frame); };
  }, [open]);
  const folded = useMemo(() => new Set(saved?.folded ?? []), [saved?.folded]);
  const folds: Folds = { folded, toggle: id => onPanel?.({ folded: (folded.has(id) ? [...folded].filter(entry => entry !== id) : [...folded, id]).slice(-FOLD_LIMIT) }) };
  const [said, setSaid] = useState(''), [full, setFull] = useState(false), refocus = useRef<string>(undefined);
  const reorder: Reorder = {
    move: (kind, id, before, last) => {
      const rows = [...model.active, ...model.quiet], key = kind === 'project' ? 'order' : 'plotOrder', current = saved?.[key] ?? [];
      const shown = kind === 'project' ? rows.map(row => row.id) : rows.find(row => row.plotIds.includes(id))?.plotIds;
      const next = shown && reorderSaved(current, shown, id, before, last);
      if (next && next.join('\n') !== current.join('\n') && onPanel?.({ [key]: next }) === false) { setSaid(`Not moved: the panel keeps the order of at most ${ORDER_LIMIT} ${kind === 'project' ? 'projects' : 'plots'}`); setFull(true); return false; }
      setFull(false); return true;
    },
    say: (text, focus) => { setSaid(text); refocus.current = focus; },
  };
  // A keyboard move can remount the focused row; focus follows it.
  useEffect(() => { const selector = refocus.current; refocus.current = undefined; if (selector) panel.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }); }, [model]);
  const needsMe = saved?.filters?.needsMe !== false, off = new Set(saved?.filters?.off ?? []);
  const filter = (patch: { needsMe?: boolean; off?: ColumnKind[] }) => onPanel?.({ filters: { needsMe, off: [...off], ...patch } });
  const chip = (kind: ColumnKind) => filter({ off: off.has(kind) ? [...off].filter(entry => entry !== kind) : [...off, kind] });
  const size = draft ?? { width: saved?.width, height: saved?.height };
  const resize = (width: number, height: number) => {
    const area = panel.current?.offsetParent?.getBoundingClientRect();
    const clamp = (value: number, min: number, max: number, edge = Infinity) => Math.round(Math.max(min, Math.min(max, edge - PANEL.inset * 2, value)));
    return { width: clamp(width, PANEL.min.width, PANEL.max.width, area?.width), height: clamp(height, PANEL.min.height, PANEL.max.height, area?.height) };
  };
  const grab = (event: React.PointerEvent<HTMLButtonElement>) => {
    const box = panel.current?.getBoundingClientRect();
    if (event.button !== 0 || !box) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, width: box.width, height: box.height };
    let last: { width: number; height: number } | undefined;
    const move = (next: PointerEvent) => { last = resize(start.width + start.x - next.clientX, start.height + start.y - next.clientY); setDraft(last); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); setDraft(undefined); if (last) onPanel?.(last); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const box = panel.current?.getBoundingClientRect(), step = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
    if (event.key === 'Home') { event.preventDefault(); onPanel?.({ width: undefined, height: undefined }); return; }
    if (!box || !step) return;
    event.preventDefault(); event.stopPropagation();
    onPanel?.(resize(box.width + step[0] * PANEL.step, box.height + step[1] * PANEL.step));
  };
  const style = { ...(size.width ? { width: size.width } : {}), ...(size.height ? { height: size.height, maxHeight: `calc(100% - ${PANEL.inset * 2}px)` } : {}), ...(room ? { maxWidth: `min(${room}px, calc(100% - 110px))` } : {}) };
  // Whatever the list shows while open counts as seen; before the first unfold, the first projects do.
  useEffect(() => {
    if (!open && (unfoldedBaseline || !(model.active.length + model.quiet.length))) return;
    unfoldedBaseline = columnBaseline(model); setBaseline(unfoldedBaseline);
  }, [open, model]);
  const fresh = useMemo(() => baseline ? projectsNewSince(model, baseline) : NOTHING_NEW, [model, baseline]);
  const quiet = useMemo(() => new Set(model.quiet.map(row => row.id)), [model]);
  const height = projectColumnHeight(model), index = model.icons.findIndex(row => row.id === hovered), tip = index >= 0 ? model.icons[index] : undefined;
  const waiting = model.active.reduce((sum, row) => sum + row.tiers.asking + row.tiers.turn, 0);
  const tipMeta = tip ? metaText(tip.meta) : '';
  return <>
    {open && <section ref={panel} className="project-column-panel" aria-label="Projects" data-owns-escape="" data-pinned={pinned || undefined} style={style} onKeyDown={moveFocus}>
      <header><button type="button" className="project-column-resize" aria-label="Resize the projects panel" title="Drag to resize · Arrow keys adjust · Home resets" onPointerDown={grab} onKeyDown={nudge} />
        <h2 title={pinned ? 'A row flies there · M folds' : 'A row flies there · M or Esc folds'}>Projects</h2>
        <button type="button" className="project-column-pin" aria-label="Keep the projects panel open" aria-pressed={pinned} title={pinned ? 'Kept open · click to let Esc fold it' : 'Keep open'}
          onClick={() => { setOpen(true); onPanel?.({ pinned: !pinned }); }}><PixelGlyph name="pin" /></button>
        <button type="button" className="project-column-close" aria-label="Fold projects (M)" title="Fold (M)" onClick={() => setOpen(false)}><PixelGlyph name="close" size={12} className="" /></button>
        <div className="project-column-filters" role="group" aria-label="Show">
          <label className="project-column-needs"><input type="checkbox" checked={needsMe} onChange={event => filter({ needsMe: event.target.checked })} />Needs me</label>
          {COLUMN_KINDS.map(kind => <button key={kind} type="button" className="project-column-chip" aria-pressed={!off.has(kind)} onClick={() => chip(kind)}>{columnKindNames[kind]}</button>)}
        </div>
      </header>
      <p className={full ? 'project-column-refused' : 'project-column-hidden'} role="status">{said}</p>
      <ul className="project-column-rows">{model.active.map(row => <ProjectRow key={row.id} row={row} actions={actions} folds={folds} icons={icons} reorder={reorder} />)}</ul>
      {model.quiet.length > 0 && <>
        <button type="button" className="project-column-quiet" data-column-row="" aria-expanded={quietOpen} onClick={() => setQuietOpen(!quietOpen)}>
          {model.quiet.length} quiet {model.quiet.length === 1 ? 'project' : 'projects'}<span aria-hidden="true">{quietOpen ? '‹' : '›'}</span></button>
        {quietOpen && <ul className="project-column-rows" data-quiet="">{model.quiet.map(row => <ProjectRow key={row.id} row={row} actions={actions} folds={folds} icons={icons} reorder={reorder} />)}</ul>}
      </>}
      {!model.active.length && !model.quiet.length && <p className="project-column-empty">No projects yet</p>}
    </section>}
    <div className="map-locator project-column" hidden={open} role="group" aria-keyshortcuts="M" style={{ height }} onKeyDown={moveFocus} onMouseLeave={() => setHovered(undefined)}
      aria-label={`Projects: ${model.icons.length + model.more}${waiting ? `, ${waiting} waiting on me` : ''}. Up and Down choose a project, Enter flies there, M unfolds the list.`}>
      {model.icons.map(row => <button key={row.id} type="button" className="project-icon" data-column-row="" data-project-icon={row.id} data-mark={row.mark} data-new={fresh.has(row.id) ? '' : undefined} data-quiet={quiet.has(row.id) ? '' : undefined}
        style={{ '--project-color': row.color } as React.CSSProperties} aria-label={`${row.title}: ${describe(row)}${fresh.has(row.id) ? ', new since the list was last open' : ''}${row.next ? `. Next: ${row.next}` : ''}`}
        onMouseEnter={() => setHovered(row.id)} onFocus={() => setHovered(row.id)} onBlur={() => setHovered(undefined)} onClick={() => actions.fitProject(row.id)}>
        <span className="project-icon-tag" aria-hidden="true">{row.tag}</span><Mark row={row} /></button>)}
      {model.more > 0 && <button type="button" className="project-column-more" data-column-row="" aria-label={`${model.more} more projects. Unfold the list`} onClick={() => setOpen(true)}>+{model.more}</button>}
      <button type="button" className="project-column-toggle" aria-label="Unfold projects (M)" title="Projects (M)" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 10 10" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M1 1h4v2H3v2H1zM5 7h2V5h2v4H5z" /></svg></button>
    </div>
    {tip && !open && <div className="project-column-tooltip" role="tooltip" style={{ bottom: COLUMN.inset + height - COLUMN.pad - index * (COLUMN.icon + COLUMN.gap) - COLUMN.icon }}>
      <p className="project-column-tip-head"><strong>{tip.title}</strong><TierCounts counts={tip.tiers} className="project-column-counts" /><small>{tip.age}</small></p>
      {tip.needs.slice(0, TIP_ROWS).map(need => <p key={need.id} className="project-column-tip-row" data-seen={need.seen || undefined}><TierMark tier={need.tier} />{needText(need)}</p>)}
      {tip.needs.length > TIP_ROWS && <p className="project-column-tip-more">+{tip.needs.length - TIP_ROWS} more</p>}
      {tip.next && <Written text={tip.next} className="project-column-tip-next" pen />}
      {tipMeta && <p className="project-column-tip-meta">{tipMeta}</p>}
      {!tip.needs.length && !tip.next && !tipMeta && <p className="project-column-tip-meta">Nothing open</p>}
    </div>}
  </>;
});
