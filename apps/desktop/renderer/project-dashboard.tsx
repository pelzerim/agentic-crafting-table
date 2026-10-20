import { memo, useEffect, useRef, useState } from 'react';
import { shortAge } from '../../../src/graph/project-dashboard.ts';
import type { DashboardBlock, DashboardBlockLayout, DashboardLayout, DashboardPreview, DashboardRow, DashboardSection, DashboardTiers, DashboardTodo, ProjectDashboard } from '../../../src/graph/project-dashboard.ts';
import { attentionAge, attentionCountText, attentionLabel, attentionTiers, NEEDS_ME } from '../../../src/graph/attention.ts';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import { activityAge } from '../../../src/graph/project-summary.ts';
import type { PlotColor } from '../../../src/graph/plots.ts';
import type { ResourcePreview } from '../../../src/resource-plugins/types.ts';
import { ItemIcon, StatusGlyph } from './icons.tsx';
import { performanceMetrics } from './performance.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { plotStyle } from './plot-style.ts';
import './project-dashboard.css';

export interface DashboardIcon { icon: string; brand?: string; tint?: boolean }
export interface DashboardActions {
  /** A pointer click passes its click count so a double-click can open the item's web page instead. */
  fly(id: string, clicks?: number): void; go(id: string, clicks?: number): void; project(id: string): void; web(id: string): void;
  /** Saved workspace state for a hover preview; `previewDetail` adds plugin facts from local saved data. */
  preview(id: string): DashboardPreview | undefined; previewDetail(id: string, signal: AbortSignal): Promise<ResourcePreview | undefined>;
  complete(todoId: string, completed: boolean): Promise<void>; openTodo(todo: DashboardTodo): void;
  /** Flies to a plot and selects its items. */
  plot(id: string): void;
}
type PreviewAt = { id: string; x: number; y: number; above: boolean };
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const count = (n: number, name: { singular: string; plural: string }) => `${n} ${n === 1 ? name.singular : name.plural}`;
const ITEMS = { singular: 'item', plural: 'items' };
/** A plot's counts as the Plots row and a block header say them. */
type PlotCounts = { id: string; name: string; color?: PlotColor; items: number; needs: number; working: number; tiers: DashboardTiers };
const plotLabel = (plot: PlotCounts) => `${plot.name}: ${[count(plot.items, ITEMS), attentionCountText(plot.tiers, ', '), plot.working ? `${plot.working} working` : ''].filter(Boolean).join(', ')}`;
const blockCounts = (block: DashboardBlock): PlotCounts => ({ id: block.id, name: block.name, color: block.color, items: block.items, needs: block.needs, working: block.active, tiers: block.tiers });
const topTier = (tiers: DashboardTiers) => attentionTiers.find(tier => tiers[tier] > 0);
/** The first word of a plot name, for a compact chip. */
const shortName = (name: string) => { const word = name.split(/[\s·]+/).find(Boolean) ?? name; return word.length > 12 ? `${word.slice(0, 11)}…` : word; };

/** Owns its minute tick, so ages advance without re-rendering the map. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); if (!active) return; const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, [active]);
  return now;
}

/** A project's far-zoom dashboard (MAP-23). It re-renders when its content or the
 * room it has changes, never for camera movement alone. */
export const DashboardBody = memo(function DashboardBody({ board, neighborhood, layout, icons, highlighted, actions }: { board: ProjectDashboard; /** The project's neighborhood color, which decides its plots' colors. */ neighborhood?: string; layout: DashboardLayout; icons: ReadonlyMap<string, DashboardIcon>; highlighted?: readonly string[]; actions: DashboardActions }) {
  performanceMetrics.record('map.dashboard-render', 1);
  const now = useNow(Boolean(board.lastActivityAt || board.working.length || board.needsYou.some(row => row.since)));
  const [preview, setPreview] = useState<PreviewAt>();
  // Plots this dashboard has already shown; a block for any other is outlined once.
  const seenPlots = useRef<ReadonlySet<string>>(undefined), plotIds = board.plots.map(plot => plot.id).join('\n');
  useEffect(() => { seenPlots.current = new Set(plotIds ? plotIds.split('\n') : []); }, [plotIds]);
  const members = new Set(board.pipelineIds);
  const previewId = (id: string) => `dashboard-preview-${board.id}-${id}`;
  // Hover or focus only; a held button means the map is being panned underneath.
  const show = (id: string) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => { if (!event.buttons) place(id, event.currentTarget); },
    onPointerLeave: () => setPreview(undefined),
    onFocus: (event: React.FocusEvent<HTMLElement>) => place(id, event.currentTarget), onBlur: () => setPreview(undefined),
    'aria-describedby': preview?.id === id ? previewId(id) : undefined,
  });
  const place = (id: string, element: HTMLElement) => {
    const panel = element.closest('.project-dashboard')!.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const above = window.innerHeight - rect.bottom < 240 && rect.top - panel.top > 0;
    setPreview({ id, x: Math.max(0, Math.min(rect.left - panel.left, panel.width - 272)), y: above ? rect.top - panel.top - 6 : rect.bottom - panel.top + 6, above });
  };
  const meta = [activityAge(board.lastActivityAt, now), count(board.items, { singular: 'item', plural: 'items' })].filter(Boolean).join(' · ');
  const icon = (id: string) => { const found = icons.get(id); return <ItemIcon icon={found?.icon} brand={found?.brand} tint={found?.tint} className="dashboard-icon" />; };
  // Marks lead: the tier shape or the working spark, then the title, the reason in words and the age as text.
  const rowOf = (entry: DashboardRow, kind: 'needs' | 'working') => { const age = kind === 'working' ? entry.at ? shortAge(entry.at, now) : '' : attentionAge(entry.since, now); return <li key={entry.id}><button type="button" className="dashboard-row" data-row={entry.id} data-kind={kind} data-tier={kind === 'needs' ? entry.tier : undefined} data-highlighted={highlighted?.includes(entry.id) || undefined}
    aria-label={`${entry.title}: ${[kind === 'working' ? entry.detail || 'working' : entry.tier ? attentionLabel(entry.tier, entry.detail) : entry.detail, age].filter(Boolean).join(', ')}`} title={members.has(entry.id) ? undefined : [entry.title, entry.detail].filter(Boolean).join(' — ')} onClick={event => (kind === 'needs' ? actions.go : actions.fly)(entry.id, event.detail)} onDoubleClick={() => actions.web(entry.id)} {...(members.has(entry.id) ? show(entry.id) : {})}>
    {kind === 'working' ? <StatusGlyph icon="working" tone="mint" /> : entry.tier && <TierMark tier={entry.tier} />}<span className="dashboard-row-title">{entry.title}</span>
    <span className="dashboard-row-detail">{entry.detail}{age && <span className="dashboard-row-age">{entry.detail ? ' · ' : ''}{age}</span>}</span>
  </button></li>; };
  const plotRow = (plot: PlotCounts) => <button type="button" className="dashboard-row" data-kind="plot" data-row={plot.id} data-plot-color={plot.color} style={plotStyle(neighborhood, plot.color)} aria-label={plotLabel(plot)} title={plot.name} onClick={() => actions.plot(plot.id)}>
    <PixelGlyph name="sprout" className="dashboard-icon dashboard-plot-glyph" /><span className="dashboard-row-title">{plot.name}</span><PlotTally plot={plot} />
  </button>;
  const todoRow = (todo: DashboardTodo) => <li key={todo.id} className="dashboard-todo"><TodoCheck todo={todo} actions={actions} />
    <button type="button" className="dashboard-row" data-kind="todo" data-row={todo.id} title={todo.title} onClick={() => actions.openTodo(todo)}><span className="dashboard-row-title">{todo.title}</span></button>
  </li>;
  const title = <button type="button" className="dashboard-title" title={`Go to ${board.title}`} onClick={() => actions.project(board.id)}>{board.title}</button>;
  const needsCount = board.needs > 0 && <TierCounts counts={board.counts} words className="dashboard-needs" />;
  // With the Needs me section off its rows are gone, but the header still says how many wait.
  const header = <header>{title}<small>{!board.needsYou.length && needsCount}{!board.needsYou.length && needsCount && ' · '}{meta}</small></header>;
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && preview) { event.stopPropagation(); setPreview(undefined); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button,input')], index = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
  };
  if (board.muted) return <section className="project-dashboard" data-dashboard={board.id} data-mode="compact" data-muted="" role="group" aria-label={`${board.title} dashboard, muted`} onKeyDown={onKeyDown}>
    <header>{title}</header>
    <p className="dashboard-counts"><span className="dashboard-muted"><PixelGlyph name="moon" />Muted</span><span>{count(board.items, ITEMS)}</span></p>
  </section>;
  if (layout.mode === 'compact') {
    const pipeline = board.pipelines[0], tally = board.tallies[0];
    const ready = pipeline?.groups.filter(group => group.stage === 'ready').reduce((sum, group) => sum + group.count, 0) ?? 0;
    const failing = pipeline?.groups.filter(group => group.stage === 'failing').reduce((sum, group) => sum + group.count, 0) ?? 0;
    return <><section className="project-dashboard" data-dashboard={board.id} data-mode="compact" role="group" aria-label={`${board.title} dashboard`} onKeyDown={onKeyDown} onPointerDown={() => setPreview(undefined)}>
      <header>{title}</header>
      <p className="dashboard-counts">
        <TierCounts counts={board.counts} working={board.working.length} className="dashboard-tiers" />
        {board.todos.open.length > 0 && <span className="dashboard-todo-count"><ItemIcon icon="square-check" />{count(board.todos.open.length, { singular: 'open to-do', plural: 'open to-dos' })}</span>}
        <span>{meta}</span>
      </p>
      {board.blocks && <p className="dashboard-chips" role="group" aria-label="Plots">{board.blocks.filter(block => block.plot).map(block => <button type="button" key={block.id} className="dashboard-chip" data-chip={block.id} data-plot-color={block.color} style={plotStyle(neighborhood, block.color)} aria-label={plotLabel(blockCounts(block))} title={block.name} onClick={() => actions.plot(block.id)}>
        <PixelGlyph name="sprout" className="dashboard-plot-glyph" />{shortName(block.name)}{block.needs > 0 ? <b data-tone="needs" data-tier={topTier(block.tiers)}><TierMark tier={topTier(block.tiers)!} />{block.tiers.asking + block.tiers.turn || ''}</b> : block.active > 0 ? <b data-tone="working"><StatusGlyph icon="working" tone="mint" />{block.active}</b> : null}
      </button>)}</p>}
      {pipeline ? <p className="dashboard-summary">{count(pipeline.total, pipeline.name)}<Strip section={pipeline} actions={actions} show={show} />{ready > 0 && <span data-tone="green">{ready} ready</span>}{failing > 0 && <span data-tone="red">{failing} failing</span>}</p>
        : tally ? <p className="dashboard-summary">{count(tally.total, tally.name)}</p> : null}
    </section>{preview && <PreviewCard key={preview.id} at={preview} id={previewId(preview.id)} actions={actions} icon={icon} now={now} />}</>;
  }
  const tallies = board.tallies.slice(0, layout.tallies).map(section => <div key={section.name.plural} className="dashboard-tally">
    <h4 data-section="tally">{capital(section.name.plural)} · {section.total}</h4><Groups section={section} />
  </div>);
  if (board.blocks && (layout.blocks.length || layout.folded.length)) {
    const byId = new Map(board.blocks.map(block => [block.id, block])), folded = layout.folded.flatMap(id => byId.get(id) ?? []), other = board.otherTodos ?? [];
    const block = (entry: DashboardBlockLayout) => {
      const data = byId.get(entry.id)!, counts = blockCounts(data);
      return <div key={entry.id} className="dashboard-block" data-block={entry.id} data-plot-color={data.color} style={plotStyle(neighborhood, data.color)} data-loose={!data.plot || undefined} data-new={(data.plot && seenPlots.current && !seenPlots.current.has(entry.id)) || undefined}>
        {data.plot ? plotRow(counts) : <p className="dashboard-block-label"><span className="dashboard-row-title">{data.name}</span><PlotTally plot={counts} /></p>}
        {entry.needs + entry.working + entry.todos + entry.more > 0 && <ul>{data.needsYou.slice(0, entry.needs).map(row => rowOf(row, 'needs'))}{data.working.slice(0, entry.working).map(row => rowOf(row, 'working'))}
          {data.todos.slice(0, entry.todos).map(todoRow)}{entry.more > 0 && <li className="dashboard-more">+{entry.more} more</li>}</ul>}
        {data.pipelines.slice(0, entry.pipelines).map(section => <p key={section.name.plural} className="dashboard-summary dashboard-block-pipeline">{count(section.total, section.name)}<Strip section={section} actions={actions} show={show} /><Groups section={section} inline /></p>)}
      </div>;
    };
    return <><section className="project-dashboard" data-dashboard={board.id} data-mode="full" data-split="plots" role="group" aria-label={`${board.title} dashboard`} onKeyDown={onKeyDown} onPointerDown={() => setPreview(undefined)}>
      {header}
      {layout.blocks.filter(entry => byId.get(entry.id)?.plot).map(block)}
      {folded.length > 0 && <p className="dashboard-fold" title={folded.map(entry => entry.name).join(', ')}>+{folded.length} {folded.some(entry => entry.needs || entry.active) ? 'more' : 'quiet'} {folded.length === 1 ? 'plot' : 'plots'} · {folded.map(entry => entry.name).join(', ')}</p>}
      {layout.blocks.filter(entry => !byId.get(entry.id)?.plot).map(block)}
      {layout.todoSection && <><h4 data-section="todos">To-dos · {other.length} open</h4>
        <ul>{other.slice(0, layout.todos).map(todoRow)}{layout.todosMore > 0 && <li className="dashboard-more">+{layout.todosMore} more</li>}</ul></>}
      {tallies}
    </section>{preview && <PreviewCard key={preview.id} at={preview} id={previewId(preview.id)} actions={actions} icon={icon} now={now} />}</>;
  }
  const open = board.todos.open.length;
  return <><section className="project-dashboard" data-dashboard={board.id} data-mode="full" role="group" aria-label={`${board.title} dashboard`} onKeyDown={onKeyDown} onPointerDown={() => setPreview(undefined)}>
    {header}
    {layout.needs + layout.needsMore > 0 && <><h4 data-section="needs">{board.counts.needsMe ? `${NEEDS_ME} · ${board.counts.needsMe}` : `Finished · ${board.counts.finished}`}</h4>
      <ul>{board.needsYou.slice(0, layout.needs).map(entry => rowOf(entry, 'needs'))}{layout.needsMore > 0 && <li className="dashboard-more">+{layout.needsMore} more</li>}</ul></>}
    {layout.working + layout.workingMore > 0 && <><h4 data-section="working">Working · {board.working.length}</h4>
      <ul>{board.working.slice(0, layout.working).map(entry => rowOf(entry, 'working'))}{layout.workingMore > 0 && <li className="dashboard-more">+{layout.workingMore} more</li>}</ul></>}
    {layout.todoSection && <><h4 data-section="todos">To-dos · {open} open{board.todos.done > 0 ? ` · ${board.todos.done} done` : ''}</h4>
      <ul>{board.todos.open.slice(0, layout.todos).map(todoRow)}{layout.todosMore > 0 && <li className="dashboard-more">+{layout.todosMore} more</li>}</ul></>}
    {layout.plots + layout.plotsMore > 0 && <><h4 data-section="plots">Plots · {board.plots.length}</h4>
      <ul>{board.plots.slice(0, layout.plots).map(plot => <li key={plot.id}>{plotRow(plot)}</li>)}{layout.plotsMore > 0 && <li className="dashboard-more">+{layout.plotsMore} more</li>}</ul></>}
    {board.pipelines.slice(0, layout.pipelines).map(section => <div key={section.name.plural} className="dashboard-pipeline">
      <h4 data-section="pipeline">{capital(section.name.plural)} · {section.total}</h4><Strip section={section} actions={actions} show={show} /><Groups section={section} />
    </div>)}
    {tallies}
  </section>{preview && <PreviewCard key={preview.id} at={preview} id={previewId(preview.id)} actions={actions} icon={icon} now={now} />}</>;
}, (previous, next) => previous.board === next.board && previous.layout === next.layout && previous.icons === next.icons && previous.highlighted === next.highlighted && previous.actions === next.actions);

/** One cell per resource in group order, each a button that flies to it and previews it on hover or focus. */
function Strip({ section, actions, show }: { section: DashboardSection; actions: DashboardActions; show(id: string): object }) {
  return <span className="dashboard-strip" role="group" aria-label={count(section.total, section.name)}>{section.cells.map(cell => <button type="button" key={cell.id} data-cell={cell.id} data-tone={cell.tone} data-stage={cell.stage}
    data-blocked={cell.blocked || undefined} aria-label={`${cell.title}: ${cell.label}${cell.blocked ? ', blocked' : ''}`} data-needs-you={cell.needsYou || undefined} onClick={event => (cell.needsYou ? actions.go : actions.fly)(cell.id, event.detail)} {...show(cell.id)} />)}</span>;
}
/** Open to-dos only; checking one completes it with the to-do list's command. The label widens
 * the pointer target and keeps a press on the box from starting a dashboard drag. */
function TodoCheck({ todo, actions }: { todo: DashboardTodo; actions: DashboardActions }) {
  const [pending, setPending] = useState(false);
  return <label className="dashboard-check" title="Mark done" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <input type="checkbox" aria-label={`Complete ${todo.title}`} disabled={pending} defaultChecked={false} onChange={event => {
      const box = event.currentTarget; setPending(true);
      actions.complete(todo.id, box.checked).catch(() => { box.checked = false; }).finally(() => setPending(false));
    }} /></label>;
}
/** A small card beside a hovered or focused PR: saved state at once, plugin facts from local saved data after a short pause. */
function PreviewCard({ at, id, actions, icon, now }: { at: PreviewAt; id: string; actions: DashboardActions; icon(id: string): React.ReactNode; now: number }) {
  const data = actions.preview(at.id), [detail, setDetail] = useState<ResourcePreview>();
  useEffect(() => {
    const controller = new AbortController(), timer = setTimeout(() => { actions.previewDetail(at.id, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }, () => {}); }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [at.id, actions]);
  if (!data) return null;
  const updated = detail?.updatedAt ?? data.activityAt, age = updated ? shortAge(updated, now) : '';
  return <div className="dashboard-preview" id={id} role="tooltip" data-preview={at.id} data-above={at.above || undefined} style={{ left: at.x, top: at.y }}>
    <header>{icon(at.id)}<strong>{data.title}</strong></header>
    {(data.subtitle || detail?.byline) && <p className="dashboard-preview-sub">{[data.subtitle ?? data.typeName, detail?.byline].filter(Boolean).join(' · ')}</p>}
    {data.status && <p className="dashboard-preview-status" data-tone={data.status.tone}><StatusGlyph icon={data.status.icon} tone={data.status.tone} />{data.status.label}</p>}
    {data.blockedBy.length > 0 && <p className="dashboard-preview-blocked"><i aria-hidden="true" />Blocked by {data.blockedBy.join(', ')}</p>}
    {data.attention.length > 0 && <p className="dashboard-preview-attention" data-tier={data.tier}>{data.tier && <TierMark tier={data.tier} />}{data.attention.join(' · ')}</p>}
    <dl>
      {detail?.facts.map(fact => <div key={fact.label} data-tone={fact.tone}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      {data.cues.map(cue => <div key={cue.id} data-tone={cue.tone}><dt>{capital(cue.id.replace(/-/g, ' '))}</dt><dd>{cue.label}</dd></div>)}
      {data.linked.length > 0 && <div><dt>Linked</dt><dd>{data.linked.map(item => `${item.title}${item.typeName ? ` (${item.typeName})` : ''}`).join(', ')}{data.linkedMore > 0 ? ` +${data.linkedMore}` : ''}</dd></div>}
    </dl>
    {age && <small>Updated {age === 'now' ? 'just now' : `${age} ago`}</small>}
  </div>;
}
/** A section's states as glyph + count + label; `inline` puts them on a block's one pipeline line. */
function Groups({ section, inline }: { section: DashboardSection; inline?: boolean }) {
  const Tag = inline ? 'span' : 'p';
  // A tally of only unknown states is a loading gap, not information.
  if (section.groups.every(group => group.label === 'Unknown')) return <Tag className="dashboard-groups" data-unloaded="">Status not loaded</Tag>;
  const text = section.groups.map(group => `${group.count} ${group.label.toLowerCase()}${group.yours ? ` (${group.yours} yours)` : ''}`).join(' · ');
  return <Tag className="dashboard-groups" title={text}>{section.groups.map(group => <span key={group.label} data-tone={group.tone} data-stage={group.stage}>
    <StatusGlyph icon={group.icon} tone={group.tone} />{group.count} {group.label.toLowerCase()}{group.yours > 0 && <em> ({group.yours} yours)</em>}
  </span>)}</Tag>;
}
/** A plot's right-aligned counts: amber needs, mint working, items; zeros omitted. */
function PlotTally({ plot }: { plot: PlotCounts }) {
  return <span className="dashboard-row-detail dashboard-plot-tally"><TierCounts counts={plot.tiers} className="dashboard-plot-needs" />{plot.working > 0 && <span className="dashboard-plot-working"><StatusGlyph icon="working" tone="mint" />{plot.working}</span>}<span>{plot.items}</span></span>;
}
