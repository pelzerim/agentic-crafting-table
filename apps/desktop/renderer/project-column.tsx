import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { attentionCountText, attentionTierInfo } from '../../../src/graph/attention.ts';
import { columnBaseline, metaText, projectsNewSince } from '../../../src/graph/project-column.ts';
import type { ColumnBaseline, ProjectColumnGroup, ProjectColumnModel, ProjectColumnNeed, ProjectColumnRow } from '../../../src/graph/project-column.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../../src/resource-plugins/pixel-glyphs.ts';
import { plotStyle } from './plot-style.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import './project-column.css';

/** `markSeen` acknowledges as the Needs me sheet's Seen does; `showTodo` opens the to-do list at that to-do. */
export interface ProjectColumnActions { fitProject(id: string): void; locate(id: string): void; fitPlot(id: string): void; markSeen?(id: string): void; showTodo?(id: string): void }
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

function Need({ need, actions }: { need: ProjectColumnNeed; actions: ProjectColumnActions }) {
  return <li className="project-column-entry" data-need-row={need.id} data-tier={need.tier} data-seen={need.seen || undefined}>
    <button type="button" className="project-column-entry-main" data-column-row="" data-need={need.id} aria-label={`${need.title}: ${attentionTierInfo[need.tier].name}, ${need.reason}${need.age ? `, ${need.age}` : ''}. Go to item on map`} onClick={() => actions.locate(need.id)}>
      <TierMark tier={need.tier} /><span className="project-column-entry-text"><span className="project-column-entry-title">{need.title}</span><span className="project-column-reason"> — {need.reason}</span></span>
    </button>
    {actions.markSeen && !need.seen && <button type="button" className="project-column-seen" aria-label={`Mark ${need.title} seen`} title="Mark seen (remove from Needs me)" onClick={() => actions.markSeen!(need.id)}>Seen</button>}
    <small>{need.age}</small>
  </li>;
}

function Group({ group, color, actions }: { group: ProjectColumnGroup; color: string; actions: ProjectColumnActions }) {
  const counts = [attentionCountText(group.tiers, ', '), group.working ? `${group.working} working` : ''].filter(Boolean).join(', ');
  return <div className="project-column-group" data-plot={group.plot || undefined} style={plotStyle(color, group.color)}>
    {group.plot && <button type="button" className="project-column-plot" data-column-row="" data-plot-header={group.id} aria-label={`Plot ${group.name}: ${counts}. Fly there`} onClick={() => actions.fitPlot(group.id)}>
      <i aria-hidden="true" /><span className="project-column-plot-name">{group.name}</span></button>}
    {!group.plot && group.id && <p className="project-column-loose">Loose</p>}
    <ul className="project-column-entries">{group.entries.map(need => <Need key={need.id} need={need} actions={actions} />)}</ul>
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

function ProjectRow({ row, actions }: { row: ProjectColumnRow; actions: ProjectColumnActions }) {
  return <li className="project-column-row" data-project-row={row.id} style={{ '--project-color': row.color } as React.CSSProperties}>
    <div className="project-column-head">
      <span className="project-column-tag" aria-hidden="true">{row.tag}</span>
      <button type="button" className="project-column-name" data-column-row="" aria-label={`${row.title}: ${describe(row)}${row.age ? `, active ${row.age} ago` : ''}. Fly there`} onClick={() => actions.fitProject(row.id)}>{row.title}</button>
      <TierCounts counts={row.tiers} className="project-column-counts" /><small>{row.age}</small>
    </div>
    {row.groups.map(group => <Group key={group.id} group={group} color={row.color} actions={actions} />)}
    {row.next && <Written text={row.next} className="project-column-next" pen />}
    {row.status && <Written text={row.status} className="project-column-status" />}
    <Meta meta={row.meta} projectId={row.id} actions={actions} />
  </li>;
}

/** The bottom-right project column (MAP-22): one tagged icon per project that is not muted, most
 * urgent first, badged only when something waits on the person, edged in copper when something
 * arrived since the list was last unfolded; unfolded, one row per project with what waits on the
 * person, the lines the summary model wrote and what else is open. It re-renders only when its
 * model, its open state or its hover changes. */
export const ProjectColumn = memo(function ProjectColumn({ model, open, setOpen, actions }: { model: ProjectColumnModel; open: boolean; setOpen(open: boolean): void; actions: ProjectColumnActions }) {
  const [hovered, setHovered] = useState<string>(), [quietOpen, setQuietOpen] = useState(false);
  const [baseline, setBaseline] = useState(() => unfoldedBaseline);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { setHovered(undefined); if (open) panel.current?.querySelector<HTMLElement>('[data-column-row]')?.focus({ preventScroll: true }); }, [open]);
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
    {open && <section ref={panel} className="project-column-panel" aria-label="Projects" data-owns-escape="" onKeyDown={moveFocus}>
      <header><h2 title="A row flies there · M or Esc folds">Projects</h2>
        <button type="button" className="project-column-close" aria-label="Fold projects (M)" title="Fold (M)" onClick={() => setOpen(false)}><PixelGlyph name="close" size={12} className="" /></button>
      </header>
      <ul className="project-column-rows">{model.active.map(row => <ProjectRow key={row.id} row={row} actions={actions} />)}</ul>
      {model.quiet.length > 0 && <>
        <button type="button" className="project-column-quiet" data-column-row="" aria-expanded={quietOpen} onClick={() => setQuietOpen(!quietOpen)}>
          {model.quiet.length} quiet {model.quiet.length === 1 ? 'project' : 'projects'}<span aria-hidden="true">{quietOpen ? '‹' : '›'}</span></button>
        {quietOpen && <ul className="project-column-rows" data-quiet="">{model.quiet.map(row => <ProjectRow key={row.id} row={row} actions={actions} />)}</ul>}
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
