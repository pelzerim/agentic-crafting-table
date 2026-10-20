import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Viewport } from '@xyflow/react';
import { ATLAS_MAP, ATLAS_OVERVIEW_MAP, atlasBounds, atlasGlyphs, atlasProjectAt, atlasStep, atlasTransform } from '../../../src/graph/atlas.ts';
import type { AtlasDirection, AtlasGlyph, AtlasItem, AtlasProject, AtlasTransform } from '../../../src/graph/atlas.ts';
import { NEIGHBORHOOD_SHADES, neighborhoodFill } from '../../../src/graph/neighborhood-fill.ts';
import { outlineDistance } from '../../../src/graph/neighborhood.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../../src/resource-plugins/pixel-glyphs.ts';
import { NEEDS_ME, attentionCountText, attentionLabel, attentionTierInfo, attentionTiers } from '../../../src/graph/attention.ts';
import type { AttentionTier } from '../../../src/graph/attention.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import './atlas.css';

/** A `muted` project (MAP-25) is drawn dim with a moon and carries no item marks or counts. */
/** `needsMe` is the counted number (Asking me + My turn); the tiers are shown beside it. */
export type AtlasProjectEntry = AtlasProject & { title: string; color: string; working: number; needsMe: number; asking: number; turn: number; finished: number; muted?: boolean };
export type AtlasItemEntry = AtlasItem & { title: string; reason?: string };
export interface AtlasActions { fitProject(id: string): void; locate(id: string): void; centre(point: { x: number; y: number }): void; pan(viewport: Viewport): void; travel?(to: 'map' | 'below'): void }
export interface AtlasProps {
  projects: readonly AtlasProjectEntry[]; items: readonly AtlasItemEntry[]; needsMe: ReadonlyMap<string, AttentionTier>;
  viewport: Viewport; screen: { width: number; height: number }; layer: 'map' | 'below'; highlighted?: readonly string[];
  overview: boolean; setOverview(open: boolean): void; undermapCount?: number; actions: AtlasActions;
}
type Size = { readonly width: number; readonly height: number };
type Blob = { id: string; color: string; muted?: boolean; paths: string[]; min?: { x: number; y: number }; centre: { x: number; y: number } };
interface Model { size: Size; transform?: AtlasTransform; glyphs: AtlasGlyph[]; blobs: Blob[]; projects: readonly AtlasProjectEntry[]; items: Map<string, AtlasItemEntry> }
type Hover = { project: AtlasProjectEntry } | { glyph: AtlasGlyph };

const DIRECTIONS: Record<string, AtlasDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function atlasModel(projects: readonly AtlasProjectEntry[], items: readonly AtlasItemEntry[], needsMe: ReadonlyMap<string, AttentionTier>, size: Size): Model {
  const bounds = atlasBounds(projects, items), lookup = new Map(items.map(item => [item.id, item]));
  if (!bounds) return { size, glyphs: [], blobs: [], projects, items: lookup };
  const transform = atlasTransform(bounds, size), cell = Math.max(24, Math.ceil(2 / transform.scale));
  const blobs = projects.map(project => {
    const small = (project.right - project.left) * transform.scale < 6 || (project.bottom - project.top) * transform.scale < 6;
    return { id: project.id, color: project.color, muted: project.muted, centre: { x: Math.round(project.center.x * transform.scale + transform.x), y: Math.round(project.center.y * transform.scale + transform.y) }, paths: small ? [] : neighborhoodFill(project.points, { pixelSize: cell, fade: cell * 1.5, scatter: 0 }).paths,
      min: small ? { x: Math.round(project.center.x * transform.scale + transform.x), y: Math.round(project.center.y * transform.scale + transform.y) } : undefined };
  });
  return { size, transform, blobs, projects, items: lookup, glyphs: atlasGlyphs(items, needsMe, transform, projects.length, new Set(projects.filter(project => project.muted).map(project => project.id))) };
}

const at = (glyph: AtlasGlyph) => ({ x: Math.round(glyph.x), y: Math.round(glyph.y) });
const WORKING_GLYPH = glyphPath(PIXEL_GLYPHS[8].working), MOON_GLYPH = glyphPath(PIXEL_GLYPHS[8].moon), BANG_GLYPH = glyphPath(PIXEL_GLYPHS[8].bang);
/** The 8×8 tier shapes, drawn 1:1 around an item's point. */
const tierShape = (tier: AttentionTier, { x, y }: { x: number; y: number }) => PIXEL_GLYPHS[8][attentionTierInfo[tier].glyph].flatMap((row, dy) => [...row].flatMap((cell, dx) => cell === 'X' ? [`M${x - 4 + dx},${y - 4 + dy}h1v1h-1z`] : [])).join('');
const shapes = {
  idle: ({ x, y }: { x: number; y: number }) => `M${x - 1},${y - 1}h2v2h-2z`,
  /** The 6×6 reduction of the working spark, one outline per item. */
  working: ({ x, y }: { x: number; y: number }) => `M${x},${y - 3}h1v2h1v1h1v1h-2v1h-1v1h-1v-2h-1v-1h-1v-1h2v-1h1z`,
  pixel: ({ x, y }: { x: number; y: number }) => `M${x - 2},${y - 2}h4v4h-4z`,
};
/** Past this many projects the corner marks Needs me with a plain pixel; counts move to the footer and overview. */
const PIXEL_BADGE_PROJECTS = 12;

/** Camera-independent layer: a few paths per project plus one path per glyph kind. */
const AtlasLayer = memo(function AtlasLayer({ model, highlighted, labels }: { model: Model; highlighted?: readonly string[]; labels: boolean }) {
  const t = model.transform;
  if (!t) return null;
  const pixels = !labels && model.projects.length > PIXEL_BADGE_PROJECTS;
  const path = (kind: 'idle' | 'working') => model.glyphs.filter(glyph => glyph.kind === kind).map(glyph => shapes[kind](at(glyph))).join('');
  const badges = model.glyphs.filter(glyph => glyph.kind === 'needs');
  const marked = new Set(highlighted ?? []);
  const brackets = [...marked].flatMap(id => {
    const glyph = model.glyphs.find(glyph => glyph.ids.includes(id)), item = model.items.get(id);
    const point = glyph ? at(glyph) : item ? { x: Math.round(item.x * t.scale + t.x), y: Math.round(item.y * t.scale + t.y) } : undefined;
    return point ? [`M${point.x - 7},${point.y - 3}v-4h4M${point.x + 3},${point.y - 7}h4v4M${point.x + 7},${point.y + 3}v4h-4M${point.x - 3},${point.y + 7}h-4v-4`] : [];
  });
  return <g>
    <g transform={`translate(${t.x} ${t.y}) scale(${t.scale})`}>{model.blobs.map(blob => <g key={blob.id} data-atlas-project={blob.id} data-muted={blob.muted || undefined} fill={blob.muted ? undefined : blob.color}>
      {blob.paths.map((d, i) => d && <path key={i} d={d} fillOpacity={NEIGHBORHOOD_SHADES[i]} />)}</g>)}</g>
    {model.blobs.filter(blob => blob.min).map(blob => <rect key={blob.id} data-atlas-project={blob.id} data-muted={blob.muted || undefined} x={blob.min!.x - 3} y={blob.min!.y - 3} width="6" height="6" fill={blob.muted ? undefined : blob.color} />)}
    {model.blobs.filter(blob => blob.muted && !blob.min).map(blob => <path key={blob.id} className="atlas-moon" data-atlas-muted={blob.id} transform={`translate(${blob.centre.x - 4} ${blob.centre.y - 4})`} d={MOON_GLYPH} />)}
    {labels && <AtlasLabels model={model} />}
    <path className="atlas-idle" d={path('idle')} />
    <path className="atlas-working" d={path('working')} />
    {attentionTiers.map(tier => { const marks = badges.filter(glyph => glyph.tier === tier && !(pixels && tier === 'finished'));
      return marks.length > 0 && <path key={tier} className={pixels ? 'atlas-pixel' : 'atlas-badge'} data-tier={tier} d={marks.map(glyph => pixels ? shapes.pixel(at(glyph)) : tierShape(tier, at(glyph))).join('')} />; })}
    {!pixels && badges.filter(glyph => glyph.count > 1).map(glyph => <text key={glyph.ids[0]} className="atlas-count" data-tier={glyph.tier} x={at(glyph).x + 6} y={at(glyph).y + 3}>{glyph.count}</text>)}
    {badges.map(glyph => <rect key={glyph.ids.join()} className="atlas-badge-target" data-atlas-badge={model.glyphs.indexOf(glyph)} data-locator-id={glyph.ids.length === 1 ? glyph.ids[0] : undefined}
      data-locator-ids={glyph.ids.join(' ')} data-highlighted={glyph.ids.some(id => marked.has(id)) || undefined} x={at(glyph).x - 8} y={at(glyph).y - 8} width={glyph.count > 1 && !pixels ? 22 : 16} height="16" />)}
    {brackets.length > 0 && <path className="locator-highlight" d={brackets.join('')} />}
  </g>;
});

/** Names on blobs in the overview. Greedy placement: the busiest projects win; the
 * list beside the map names every project, so a crowded label is skipped. */
function AtlasLabels({ model }: { model: Model }) {
  const t = model.transform!, placed: { x: number; y: number; width: number }[] = [];
  const ordered = [...model.projects].sort(byUrgency);
  return <g className="atlas-labels">{ordered.flatMap(project => {
    const text = project.title.length > 18 ? `${project.title.slice(0, 17)}…` : project.title, width = text.length * 6.4 + 6;
    const x = Math.max(width / 2 + 2, Math.min(model.size.width - width / 2 - 2, project.center.x * t.scale + t.x));
    const candidates = [Math.max(9, project.top * t.scale + t.y + 9), project.center.y * t.scale + t.y];
    const y = candidates.find(y => !placed.some(other => Math.abs(other.x - x) < (other.width + width) / 2 && Math.abs(other.y - y) < 13));
    if (y === undefined) return [];
    placed.push({ x, y, width });
    return [<text key={project.id} data-atlas-label={project.id} x={x} y={y}>{text !== project.title && <title>{project.title}</title>}{text}</text>];
  })}</g>;
}

function where(project: AtlasProject, viewport: Viewport, screen: { width: number; height: number }) {
  const left = -viewport.x / viewport.zoom, top = -viewport.y / viewport.zoom, right = left + screen.width / viewport.zoom, bottom = top + screen.height / viewport.zoom;
  const sides = [project.bottom < top && 'above', project.top > bottom && 'below', project.right < left && 'left', project.left > right && 'right'].filter(Boolean);
  return sides.length ? `off-screen ${sides.join(' and ')}` : 'on screen';
}
export function describeProject(project: AtlasProjectEntry, viewport: Viewport, screen: { width: number; height: number }) {
  if (project.muted) return `${project.title}, muted, ${where(project, viewport, screen)}`;
  return `${project.title}, ${attentionCountText(project, ', ') || 'nothing needs me'}, ${project.working} working, ${where(project, viewport, screen)}`;
}

/** The projects list's column heads: the working spark and the Needs me umbrella mark. */
function Glyph({ kind }: { kind: 'working' | 'needs' }) {
  return <span className="atlas-count-chip" data-kind={kind}><svg viewBox="0 0 8 8" aria-hidden="true" shapeRendering="crispEdges"><path d={kind === 'working' ? WORKING_GLYPH : BANG_GLYPH} /></svg></span>;
}
/** Most urgent first: who asks, then the counted number, then who works. */
const byUrgency = (a: AtlasProjectEntry, b: AtlasProjectEntry) => b.asking - a.asking || b.needsMe - a.needsMe || b.finished - a.finished || b.working - a.working || a.title.localeCompare(b.title);
const topTier = (project: AtlasProjectEntry) => attentionTiers.find(tier => project[tier] > 0);

/** The interactive map shared by the corner Atlas and the overview. */
function AtlasMap({ model, viewport, screen, actions, highlighted, labels, cursor, onHover, onChosen }: {
  model: Model; viewport: Viewport; screen: { width: number; height: number }; actions: AtlasActions; highlighted?: readonly string[]; labels: boolean;
  cursor?: string; onHover(hover: Hover | undefined): void; onChosen?(): void;
}) {
  const { size, transform: t } = model;
  const press = useRef<{ x: number; y: number; viewport: Viewport; moved: boolean; badge?: number; pointerId: number }>(undefined);
  const [panning, setPanning] = useState(false);
  const local = (event: React.PointerEvent) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - rect.left) * size.width / rect.width, y: (event.clientY - rect.top) * size.height / rect.height }; };
  const badgeAt = (target: EventTarget) => { const value = (target as Element).closest?.('[data-atlas-badge]')?.getAttribute('data-atlas-badge'); return value === null || value === undefined ? undefined : Number(value); };
  const projectAt = (point: { x: number; y: number }) => {
    if (!t) return undefined;
    const world = { x: (point.x - t.x) / t.scale, y: (point.y - t.y) / t.scale }, hit = atlasProjectAt(world, model.projects);
    const project = hit && model.projects.find(project => project.id === hit.id)!;
    return project && (hit!.inside || outlineDistance(world, project.points) * t.scale <= 3 || Math.hypot(world.x - project.center.x, world.y - project.center.y) * t.scale <= 4) ? project : undefined;
  };
  const frame = t && (() => {
    const x = -viewport.x / viewport.zoom * t.scale + t.x, y = -viewport.y / viewport.zoom * t.scale + t.y;
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(size.width, Math.round(x + screen.width / viewport.zoom * t.scale)), y1 = Math.min(size.height, Math.round(y + screen.height / viewport.zoom * t.scale));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: x0, y: y0, width: 0, height: 0 };
  })();
  // The 2px corner strokes sit inset by their half width so they stay inside the tile.
  const corner = (outer: NonNullable<typeof frame>) => { const f = { x: outer.x + 1, y: outer.y + 1, width: outer.width - 2, height: outer.height - 2 }, c = Math.min(5, f.width / 2, f.height / 2);
    return `M${f.x},${f.y + c}v${-c}h${c}M${f.x + f.width - c},${f.y}h${c}v${c}M${f.x + f.width},${f.y + f.height - c}v${c}h${-c}M${f.x + c},${f.y + f.height}h${-c}v${-c}`; };
  const focused = cursor ? model.projects.find(project => project.id === cursor) : undefined;
  return <svg className="atlas-map" viewBox={`0 0 ${size.width} ${size.height}`} width={size.width} height={size.height} shapeRendering="crispEdges" data-panning={panning || undefined}
    onPointerDown={event => {
      if (event.button !== 0 || !t) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      press.current = { ...local(event), viewport, moved: false, badge: badgeAt(event.target), pointerId: event.pointerId };
    }}
    onPointerMove={event => {
      const held = press.current, point = local(event);
      if (!held || held.pointerId !== event.pointerId) {
        const badge = badgeAt(event.target), project = badge === undefined ? projectAt(point) : undefined;
        onHover(badge !== undefined ? { glyph: model.glyphs[badge] } : project ? { project } : undefined); return;
      }
      if (!held.moved && Math.hypot(point.x - held.x, point.y - held.y) < 3) return;
      if (!held.moved) { held.moved = true; setPanning(true); onHover(undefined); }
      const zoom = held.viewport.zoom;
      actions.pan({ zoom, x: held.viewport.x - (point.x - held.x) / t!.scale * zoom, y: held.viewport.y - (point.y - held.y) / t!.scale * zoom });
    }}
    onPointerUp={event => {
      const held = press.current; press.current = undefined; setPanning(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!held || held.moved || !t) return;
      const glyph = held.badge !== undefined ? model.glyphs[held.badge] : undefined, point = local(event);
      if (glyph) { if (glyph.ids.length === 1 || !glyph.projectId) actions.locate(glyph.ids[0]); else actions.fitProject(glyph.projectId); onChosen?.(); return; }
      const project = projectAt(point);
      if (project) { actions.fitProject(project.id); onChosen?.(); return; }
      actions.centre({ x: (point.x - t.x) / t.scale, y: (point.y - t.y) / t.scale });
    }}
    onPointerCancel={() => { press.current = undefined; setPanning(false); }}
    onPointerLeave={() => { if (!press.current) onHover(undefined); }}>
    <AtlasLayer model={model} highlighted={highlighted} labels={labels} />
    {frame && <>
      <path className="atlas-dim" fillRule="evenodd" d={`M-2,-2H${size.width + 2}V${size.height + 2}H-2ZM${frame.x},${frame.y}v${frame.height}h${frame.width}v${-frame.height}z`} />
      <rect className="atlas-frame" data-atlas-frame="" x={frame.x + .5} y={frame.y + .5} width={Math.max(0, frame.width - 1)} height={Math.max(0, frame.height - 1)} />
      {frame.width > 4 && frame.height > 4 && <path className="atlas-frame-corners" d={corner(frame)} />}
    </>}
    {focused && t && <rect className="atlas-cursor" x={Math.round(focused.left * t.scale + t.x) - 1.5} y={Math.round(focused.top * t.scale + t.y) - 1.5}
      width={Math.max(6, Math.round((focused.right - focused.left) * t.scale)) + 3} height={Math.max(6, Math.round((focused.bottom - focused.top) * t.scale)) + 3} />}
  </svg>;
}

function tooltip(hover: Hover | undefined, model: Model) {
  if (!hover) return undefined;
  if ('project' in hover) {
    const project = hover.project;
    const items = [...model.items.values()].filter(item => item.projectId === project.id).length;
    if (project.muted) return <><strong>{project.title}</strong><span>Muted · {plural(items, 'item', 'items')}</span><small>Click to fly there</small></>;
    return <><strong>{project.title}</strong><span data-tone={topTier(project) ? 'needs' : undefined} data-tier={topTier(project)}>{[attentionCountText(project), `${project.working} working`, plural(items, 'item', 'items')].filter(Boolean).join(' · ')}</span><small>Click to fly there</small></>;
  }
  const glyph = hover.glyph, item = model.items.get(glyph.ids[0]), project = model.projects.find(project => project.id === glyph.projectId);
  if (glyph.ids.length > 1) return <><strong>{project?.title}</strong><span data-tone="needs" data-tier={glyph.tier}>{NEEDS_ME} · {glyph.count}</span><small>Click to fly there</small></>;
  return <><strong>{item?.title}</strong>{item?.reason && <span data-tone="needs" data-tier={glyph.tier}>{glyph.tier ? attentionLabel(glyph.tier, item.reason) : item.reason}</span>}<small>{project ? `${project.title} · ` : ''}click to go there</small></>;
}

export function Atlas(props: AtlasProps) {
  const { projects, items, needsMe, viewport, screen, layer, actions } = props;
  const model = useMemo(() => atlasModel(projects, items, needsMe, ATLAS_MAP), [projects, items, needsMe]);
  const overviewModel = useMemo(() => props.overview ? atlasModel(projects, items, needsMe, ATLAS_OVERVIEW_MAP) : undefined, [props.overview, projects, items, needsMe]);
  const [hover, setHover] = useState<Hover>(), [cursor, setCursor] = useState<string>(), [announcement, setAnnouncement] = useState('');
  const badgeIndex = useRef(-1), overview = useRef<HTMLElement>(null);
  const centre = { x: (screen.width / 2 - viewport.x) / viewport.zoom, y: (screen.height / 2 - viewport.y) / viewport.zoom };
  const here = atlasProjectAt(centre, projects), current = here && projects.find(project => project.id === here.id);
  // Below, a mirror layout draws only the cards it shows; the count is everything that lies there.
  const below = layer === 'below', resources = below && props.undermapCount !== undefined ? props.undermapCount : items.filter(item => item.resourceId).length;
  const t = model.transform;
  const extent = useMemo(() => atlasBounds(projects, items), [projects, items]);
  const fits = Boolean(extent) && extent!.x * viewport.zoom + viewport.x >= 0 && extent!.y * viewport.zoom + viewport.y >= 0
    && (extent!.x + extent!.width) * viewport.zoom + viewport.x <= screen.width && (extent!.y + extent!.height) * viewport.zoom + viewport.y <= screen.height;
  useEffect(() => { setHover(undefined); if (props.overview) overview.current?.querySelector<HTMLElement>('.atlas-overview-map')?.focus({ preventScroll: true }); }, [props.overview]);
  const choose = (id: string | undefined) => {
    if (!id) return; setCursor(id);
    const project = projects.find(project => project.id === id);
    if (project) setAnnouncement(describeProject(project, viewport, screen));
  };
  const keys = (event: React.KeyboardEvent, close?: () => void) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const direction = DIRECTIONS[event.key];
    if (direction) { event.preventDefault(); event.stopPropagation(); const from = cursor ?? current?.id; choose(from ? atlasStep(projects, from, direction) ?? from : projects[0]?.id); return; }
    if ((event.key === 'Enter' || event.key === ' ') && (cursor ?? current?.id)) { event.preventDefault(); event.stopPropagation(); actions.fitProject((cursor ?? current?.id)!); close?.(); return; }
    if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
      const badges = model.glyphs.filter(glyph => glyph.kind === 'needs');
      if (!badges.length) return;
      event.preventDefault(); event.stopPropagation();
      const glyph = badges[badgeIndex.current = (badgeIndex.current + 1) % badges.length];
      if (glyph.ids.length === 1 || !glyph.projectId) actions.locate(glyph.ids[0]); else actions.fitProject(glyph.projectId);
      const item = model.items.get(glyph.ids[0]); setAnnouncement(`${item?.title ?? ''}${item?.reason ? `: ${item.reason}` : ''}`);
    }
  };
  const tip = tooltip(hover, props.overview && overviewModel ? overviewModel : model);
  const close = () => { props.setOverview(false); setHover(undefined); };
  const ordered = useMemo(() => [...projects].sort(byUrgency), [projects]);
  // The corner stays mounted while the overview is open, so map obstacles keep observing it.
  return <>{props.overview && overviewModel && <section ref={overview} className="atlas-overview" data-layer={layer} aria-label="Map overview" data-owns-escape="">
      <header><h2>{below ? 'Undermap' : 'Map'}</h2>
        <div className="atlas-layers" role="group" aria-label="Layer">
          <button type="button" aria-pressed={!below} onClick={() => { if (below) actions.travel?.('map'); }}>Map</button>
          <button type="button" aria-pressed={below} onClick={() => { if (!below) actions.travel?.('below'); }}>Undermap{props.undermapCount ? ` · ${props.undermapCount}` : ''}</button>
        </div>
        <span className="atlas-hints">Click to fly · drag frame · ←→ projects · M / Esc</span>
        <button type="button" className="atlas-close" aria-label="Close map overview" title="Close (Esc)" onClick={close}>
          <PixelGlyph name="close" size={12} className="" /></button>
      </header>
      <div className="atlas-overview-body">
        <div className="atlas-overview-map" tabIndex={0} role="group" aria-label={`${below ? 'Undermap' : 'Map'} overview${current ? `: ${describeProject(current, viewport, screen)}` : ''}`} onKeyDown={event => keys(event, close)}>
          {overviewModel.transform ? <AtlasMap model={overviewModel} viewport={viewport} screen={screen} actions={actions} highlighted={props.highlighted} labels cursor={cursor} onHover={setHover} onChosen={close} />
            : <p className="atlas-empty">{below ? 'Undermap is empty' : 'Nothing on the map yet'}</p>}
        </div>
        <div className="atlas-projects">
          <h3><span>Projects</span><Glyph kind="working" /><Glyph kind="needs" /></h3>
          <ul aria-label="Projects">{ordered.map(project => <li key={project.id}><button type="button" data-current={project.id === current?.id || undefined}
            data-muted={project.muted || undefined} aria-label={project.muted ? `${project.title}: muted` : `${project.title}: ${project.working} working, ${attentionCountText(project, ', ') || 'nothing needs me'}`} title={project.title}
            onClick={() => { actions.fitProject(project.id); close(); }}>
            <i style={{ background: project.color }} aria-hidden="true" /><span>{project.title}</span><b aria-hidden="true">{project.working || ''}</b>
            <b aria-hidden="true" data-kind={project.muted ? 'muted' : 'needs'}>{project.muted ? <PixelGlyph name="moon" /> : topTier(project) ? <span className="atlas-count-chip" data-kind="needs" data-tier={topTier(project)}><TierMark tier={topTier(project)!} />{project.needsMe || ''}</span> : ''}</b></button></li>)}</ul>
          {!projects.length && <p className="atlas-empty">No projects {below ? 'below' : 'yet'}</p>}
        </div>
      </div>
      <span className="atlas-live" aria-live="polite">{announcement}</span>
    </section>}
    <div className="map-locator atlas" hidden={props.overview} data-layer={layer} data-empty={!t || undefined} data-fits={fits || undefined} tabIndex={0} role="group"
    aria-label={`Map atlas: ${below ? `Undermap, ${plural(resources, 'item', 'items')}` : current ? describeProject(current, viewport, screen) : 'no projects'}. Arrow keys choose a project, Enter flies there, N goes to the next item that needs me, M opens the overview.`}
    aria-keyshortcuts="M" onKeyDown={event => keys(event)} onBlur={() => setCursor(undefined)}>
    {t ? <AtlasMap model={model} viewport={viewport} screen={screen} actions={actions} highlighted={props.highlighted} labels={false} cursor={cursor} onHover={setHover} />
      : <p className="atlas-empty">{below ? 'Undermap is empty' : 'Nothing on the map yet'}</p>}
    <div className="atlas-footer">{below ? <><span className="atlas-place">Undermap</span><span className="atlas-counts">{plural(resources, 'item', 'items')} below</span></>
      : !t ? <span className="atlas-place atlas-hint">Double-click the map to create</span>
      : <><span className="atlas-place"><i style={{ background: current?.color }} aria-hidden="true" /><span>{current ? `${here!.inside ? '' : 'Near '}${current.title}` : 'Floating items'}</span></span>
        {current?.muted ? <span className="atlas-counts atlas-muted"><PixelGlyph name="moon" />Muted</span>
          : current && <TierCounts counts={current} working={current.working} className="atlas-counts" />}</>}</div>
    {t && <button type="button" className="atlas-expand" aria-label="Open map overview (M)" title="Map overview (M)" onClick={() => props.setOverview(true)}>
      <svg viewBox="0 0 10 10" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M1 1h4v2H3v2H1zM5 7h2V5h2v4H5z" /></svg></button>}
    {!props.overview && <span className="atlas-live" aria-live="polite">{announcement}</span>}
  </div>{tip && <div className="atlas-tooltip" data-over={props.overview ? 'overview' : undefined} role="tooltip">{tip}</div>}</>;
}
