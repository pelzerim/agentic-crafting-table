import { memo, useEffect, useRef, useState } from 'react';
import { attentionCountText, attentionTierInfo } from '../../../src/graph/attention.ts';
import type { ProjectColumnModel, ProjectColumnRow } from '../../../src/graph/project-column.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../../src/resource-plugins/pixel-glyphs.ts';
import { StatusGlyph } from './icons.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import './project-column.css';

export interface ProjectColumnActions { fitProject(id: string): void; locate(id: string): void }
/** Screen pixels of the folded column, matched by project-column.css. */
const COLUMN = { pad: 6, icon: 32, gap: 4, more: 20, toggle: 20, inset: 16 } as const;
const PEN_GLYPH = glyphPath(PIXEL_GLYPHS[8].pen);

/** The folded column's height in pixels: its icons, the gaps between them and its padding. */
export function projectColumnHeight(model: ProjectColumnModel) {
  const icons = model.icons.length;
  return COLUMN.pad * 2 + COLUMN.toggle + (icons ? icons * (COLUMN.icon + COLUMN.gap) : 0) + (model.more ? COLUMN.more + COLUMN.gap : 0);
}

const describe = (row: ProjectColumnRow) => [attentionCountText(row.tiers, ', ') || 'nothing needs me', row.working ? `${row.working} working` : ''].filter(Boolean).join(', ');

function Mark({ row }: { row: ProjectColumnRow }) {
  return <span className="project-icon-mark" data-mark={row.mark}>
    {row.mark === 'working' ? <StatusGlyph icon="working" tone="mint" /> : row.mark === 'idle' ? <i className="project-icon-dot" /> : <TierMark tier={row.mark} />}
    {row.count > 0 && <b>{row.count}</b>}
  </span>;
}

function Summary({ row }: { row: ProjectColumnRow }) {
  return <p className="project-column-line" data-generated={row.generated || undefined} title={row.generated ? 'Written by the summary model' : undefined}>
    {row.generated && <svg className="project-column-pen" viewBox="-.5 -.5 9 9" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d={PEN_GLYPH} /></svg>}
    {row.line}{row.generated && <span className="project-column-hidden"> (written by the summary model)</span>}
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

function ProjectRow({ row, actions }: { row: ProjectColumnRow; actions: ProjectColumnActions }) {
  return <li className="project-column-row" data-project-row={row.id}>
    <button type="button" className="project-column-head" data-column-row="" aria-label={`${row.title}: ${describe(row)}${row.age ? `, active ${row.age} ago` : ''}. Fly there`} onClick={() => actions.fitProject(row.id)}>
      <i style={{ background: row.color }} aria-hidden="true" /><span className="project-column-name">{row.title}</span>
      <TierCounts counts={row.tiers} working={row.working} className="project-column-counts" />{row.age && <small>{row.age}</small>}
    </button>
    <Summary row={row} />
    {row.needs.length > 0 && <ul className="project-column-needs">{row.needs.map(need => <li key={need.id}>
      <button type="button" data-column-row="" data-need={need.id} data-tier={need.tier} aria-label={`${need.title}: ${attentionTierInfo[need.tier].name}, ${need.reason}${need.age ? `, ${need.age}` : ''}. Go to item on map`} onClick={() => actions.locate(need.id)}>
        <TierMark tier={need.tier} /><span className="project-column-need-title">{need.title}</span><span className="project-column-reason">{need.reason}</span>{need.age && <small>{need.age}</small>}
      </button></li>)}</ul>}
  </li>;
}

/** The bottom-right project column (MAP-22): one icon per project that is not muted, most
 * urgent first; unfolded, one row per project with its summary line and its Needs me rows.
 * It re-renders only when its model, its open state or its hover changes. */
export const ProjectColumn = memo(function ProjectColumn({ model, open, setOpen, actions }: { model: ProjectColumnModel; open: boolean; setOpen(open: boolean): void; actions: ProjectColumnActions }) {
  const [hovered, setHovered] = useState<string>(), [quietOpen, setQuietOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { setHovered(undefined); if (open) panel.current?.querySelector<HTMLElement>('[data-column-row]')?.focus({ preventScroll: true }); }, [open]);
  const height = projectColumnHeight(model), index = model.icons.findIndex(row => row.id === hovered), tip = index >= 0 ? model.icons[index] : undefined;
  const waiting = model.active.reduce((sum, row) => sum + row.tiers.asking + row.tiers.turn, 0);
  return <>
    {open && <section ref={panel} className="project-column-panel" aria-label="Projects" data-owns-escape="" onKeyDown={moveFocus}>
      <header><h2>Projects</h2><span className="project-column-hint">Click to fly · M / Esc</span>
        <button type="button" className="project-column-close" aria-label="Fold projects (M)" title="Fold (M)" onClick={() => setOpen(false)}><PixelGlyph name="close" size={12} className="" /></button>
      </header>
      <ul className="project-column-rows">{model.active.map(row => <ProjectRow key={row.id} row={row} actions={actions} />)}</ul>
      {model.quiet.length > 0 && <>
        <button type="button" className="project-column-quiet" data-column-row="" aria-expanded={quietOpen} onClick={() => setQuietOpen(!quietOpen)}>
          <i aria-hidden="true" />{model.quiet.length} quiet {model.quiet.length === 1 ? 'project' : 'projects'}<span aria-hidden="true">{quietOpen ? '‹' : '›'}</span></button>
        {quietOpen && <ul className="project-column-rows" data-quiet="">{model.quiet.map(row => <ProjectRow key={row.id} row={row} actions={actions} />)}</ul>}
      </>}
      {!model.active.length && !model.quiet.length && <p className="project-column-empty">No projects yet</p>}
    </section>}
    <div className="map-locator project-column" hidden={open} role="group" aria-keyshortcuts="M" style={{ height }} onKeyDown={moveFocus} onMouseLeave={() => setHovered(undefined)}
      aria-label={`Projects: ${model.icons.length + model.more}${waiting ? `, ${waiting} waiting on me` : ''}. Up and Down choose a project, Enter flies there, M unfolds the list.`}>
      {model.icons.map(row => <button key={row.id} type="button" className="project-icon" data-column-row="" data-project-icon={row.id} data-mark={row.mark} style={{ '--project-color': row.color } as React.CSSProperties}
        aria-label={`${row.title}: ${describe(row)}. ${row.line}`} onMouseEnter={() => setHovered(row.id)} onFocus={() => setHovered(row.id)} onBlur={() => setHovered(undefined)} onClick={() => actions.fitProject(row.id)}><Mark row={row} /></button>)}
      {model.more > 0 && <button type="button" className="project-column-more" data-column-row="" aria-label={`${model.more} more projects. Unfold the list`} onClick={() => setOpen(true)}>+{model.more}</button>}
      <button type="button" className="project-column-toggle" aria-label="Unfold projects (M)" title="Projects (M)" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 10 10" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M1 1h4v2H3v2H1zM5 7h2V5h2v4H5z" /></svg></button>
    </div>
    {tip && !open && <div className="project-column-tooltip" role="tooltip" style={{ bottom: COLUMN.inset + height - COLUMN.pad - index * (COLUMN.icon + COLUMN.gap) - COLUMN.icon }}>
      <strong>{tip.title}</strong><Summary row={tip} /></div>}
  </>;
});
