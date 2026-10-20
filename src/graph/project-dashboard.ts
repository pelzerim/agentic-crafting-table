import { isArchived } from './archive.ts';
import { attentionCounts, attentionDetails, attentionItems, attentionTier, memberAttentionCounts, nodeAttentionReasons } from './attention.ts';
import type { AttentionCounting, AttentionCounts, AttentionTier } from './attention.ts';
import { intersects } from './label-placement.ts';
import type { ScreenRect } from './label-placement.ts';
import type { GraphLink, GraphNode } from './graph.ts';
import type { PipelineName } from './project-summary.ts';
import type { TodoEntry } from './todos.ts';
import { blockedBy, blockerName, blockingState } from './blocking.ts';
import type { ResourceIndicator } from '../resource-plugins/indicators.ts';
import { plotColor } from './plots.ts';
import type { PlotColor, PlotView } from './plots.ts';

type DashboardNode = GraphNode & { activity?: string; attention?: string; summary?: string };
/** A Needs me row carries its `tier` and, when recorded, `since` when it was raised; a Working row `at`. */
export interface DashboardRow { id: string; title: string; detail: string; at?: string; tier?: AttentionTier; since?: string }
/** How many entries each Needs me tier has. */
export type DashboardTiers = Pick<AttentionCounts, AttentionTier>;
const NO_TIERS: DashboardTiers = { asking: 0, turn: 0, finished: 0 };
export interface DashboardGroup { label: string; tone: ResourceIndicator['tone']; icon: string; stage?: ResourceIndicator['stage']; count: number; yours: number }
export interface DashboardCell { id: string; title: string; label: string; tone: ResourceIndicator['tone']; stage?: ResourceIndicator['stage']; blocked?: boolean; needsYou?: boolean }
export interface DashboardSection { name: PipelineName; total: number; groups: DashboardGroup[]; cells: DashboardCell[] }
export interface DashboardTodo { id: string; title: string; nodeId?: string; nodeIds: string[] }
/** A plot row (MAP-24): its name and how many of its items need you, are working, or exist. */
export interface DashboardPlot { id: string; name: string; color: PlotColor; items: number; needs: number; working: number; tiers: DashboardTiers }
/** One plot's part of a split dashboard (MAP-23), or the Loose block of items in no shown plot.
 * `needs` and `active` count its Needs you and Working rows, also when those sections are off. */
export interface DashboardBlock { id: string; plot: boolean; name: string; color?: PlotColor; items: number; needs: number; active: number; tiers: DashboardTiers; needsYou: DashboardRow[]; working: DashboardRow[]; todos: DashboardTodo[]; pipelines: DashboardSection[] }
/** `blocks` and `otherTodos` are present only when two or more plots are shown. `needs` counts
 * Needs you entries even when that section is off; `pipelineIds` lists items in any pipeline,
 * also when pipeline lines are off, so their rows keep the hover preview. */
export interface ProjectDashboard { id: string; title: string; items: number; needs: number;
  /** Tier counts of every Needs me entry, also with that section off; `needsMe` is the counted number (Asking me + My turn). */
  counts: AttentionCounts; needsYou: DashboardRow[]; working: DashboardRow[]; pipelines: DashboardSection[]; pipelineIds: string[]; tallies: DashboardSection[]; todos: { open: DashboardTodo[]; done: number }; plots: DashboardPlot[]; lastActivityAt?: string; blocks?: DashboardBlock[]; otherTodos?: DashboardTodo[];
  /** A muted project (MAP-25) keeps its name and item count and lists nothing else. */
  muted?: true }
export const LOOSE_BLOCK = 'loose';
/** Map rows (world px) that count as the same height when ordering blocks by position. */
const BLOCK_BAND = 120;
export type DashboardPlacement = 'center' | 'top';
/** The parts a dashboard can show. Pipelines and tallies are the plugin-named strip and
 * count lines (PRs and tickets today). */
export const DASHBOARD_SECTION_KEYS = ['needsYou', 'working', 'todos', 'plots', 'pipelines', 'tallies'] as const;
export type DashboardSections = Record<typeof DASHBOARD_SECTION_KEYS[number], boolean>;
/** PR and ticket lines are off by default: they repeat what the cards show and crowd out rows. */
export const DEFAULT_DASHBOARD_SECTIONS: DashboardSections = { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false };
export interface MapDashboards { enabled: boolean; belowZoom: number; placement: DashboardPlacement; sections: DashboardSections }

/** Cards would turn into title-less icons below this zoom; a project reads better as a dashboard there. */
export const DEFAULT_MAP_DASHBOARDS: MapDashboards = { enabled: true, belowZoom: .65, placement: 'center', sections: DEFAULT_DASHBOARD_SECTIONS };
/** The default before 0.65; a saved copy of it is treated as never chosen. */
export const FORMER_DASHBOARD_ZOOM = .45;
export const DASHBOARD_ZOOM_RANGE = { min: .25, max: .65 } as const;
const HYSTERESIS = .01;
const STAGE_ORDER = { failing: 0, open: 1, ready: 2, done: 3 } as const;

/** What a project's far-zoom dashboard lists. Pipelines (a strip per resource) and
 * tallies (counts per state) are named by plugins; nothing depends on an item type.
 * `paused` omits Needs you and Working where background work and Needs me pause (Undermap).
 * `sections` that are off are left empty (every section shows without it); plots off also
 * means no split. Blocks are still ranked by their Needs you and Working rows. */
export function projectDashboard(projectId: string, nodes: readonly DashboardNode[], sources: { pipelineOf?(node: DashboardNode): PipelineName | undefined; tallyOf?(node: DashboardNode): PipelineName | undefined; paused?: boolean; todos?: readonly TodoEntry[]; links?: readonly GraphLink[]; plots?: readonly PlotView[]; sections?: DashboardSections; counting?: AttentionCounting } = {}): ProjectDashboard {
  const project = nodes.find(node => node.id === projectId);
  const board: ProjectDashboard = { id: projectId, title: project?.title ?? '', items: 0, needs: 0, counts: attentionCounts([]), needsYou: [], working: [], pipelines: [], pipelineIds: [], tallies: [], todos: { open: [], done: 0 }, plots: [], lastActivityAt: undefined };
  if (!project || project.archivedAt) return board;
  for (const entry of sources.todos ?? []) {
    if (entry.projectId !== projectId) continue;
    if (entry.completed) board.todos.done++;
    else board.todos.open.push({ id: entry.id, title: entry.title, ...(entry.nodeId ? { nodeId: entry.nodeId } : {}), nodeIds: [...entry.nodeIds] });
  }
  const identities = new Set<string>(), working = new Map<string, DashboardNode>(), counted: DashboardNode[] = [];
  const pipelines = new Map<string, { name: PipelineName; members: DashboardNode[] }>(), tallies = new Map<string, { name: PipelineName; members: DashboardNode[] }>();
  const collect = (target: typeof pipelines, name: PipelineName | undefined, node: DashboardNode) => {
    if (!name) return;
    const key = `${name.singular}\u0000${name.plural}`, entry = target.get(key) ?? { name, members: [] };
    entry.members.push(node); target.set(key, entry);
  };
  for (const node of nodes) {
    if (node.projectId !== projectId || !node.resourceId || isArchived(node, nodes)) continue;
    if (node.activityAt && (!board.lastActivityAt || node.activityAt > board.lastActivityAt)) board.lastActivityAt = node.activityAt;
    const identity = node.resourceId;
    if (identities.has(identity)) continue;
    identities.add(identity); counted.push(node);
    if (node.activity === 'working' && !sources.paused) working.set(identity, node);
    collect(pipelines, sources.pipelineOf?.(node), node); collect(tallies, sources.tallyOf?.(node), node);
  }
  board.items = identities.size;
  // Undermap already pauses Needs me and draws no cover, so a muted project there is an ordinary paused board.
  if (project.mutedAt && !sources.paused) return { ...board, muted: true, todos: { open: [], done: 0 }, lastActivityAt: undefined };
  const entries = sources.paused ? [] : attentionItems(nodes, projectId);
  board.needsYou = entries.map(item => ({ id: item.node.id, title: item.node.title, detail: item.details[0], tier: item.tier, ...(item.since ? { since: item.since } : {}) }));
  board.counts = attentionCounts(entries, sources.counting);
  board.working = [...working.values()].sort((a, b) => (b.activityAt ?? '').localeCompare(a.activityAt ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map(node => ({ id: node.id, title: node.title, detail: node.summary?.trim() ?? '', ...(node.activityAt ? { at: node.activityAt } : {}) }));
  const blocked = sources.links?.length ? blockingState(nodes, sources.links).blocked : undefined;
  board.pipelines = [...pipelines.values()].map(entry => section(entry.name, entry.members, !sources.paused, blocked));
  board.pipelineIds = board.pipelines.flatMap(section => section.cells.map(cell => cell.id));
  board.tallies = [...tallies.values()].map(entry => section(entry.name, entry.members, !sources.paused));
  board.needs = board.needsYou.length;
  const shown = sources.sections ?? { needsYou: true, working: true, todos: true, plots: true, pipelines: true, tallies: true };
  if (!shown.plots) { omit(board, shown); return board; }
  const byId = new Map(nodes.map(node => [node.id, node]));
  board.plots = (sources.plots ?? []).filter(plot => plot.projectId === projectId).map(plot => {
    const members = plot.memberIds.flatMap(id => byId.get(id) ?? []).filter(node => node.projectId === projectId && !isArchived(node, nodes));
    return { id: plot.id, name: plot.name, color: plotColor(plot), items: members.length, needs: sources.paused ? 0 : members.filter(node => nodeAttentionReasons(node).length).length, tiers: sources.paused ? NO_TIERS : tiersOf(memberAttentionCounts(members)), working: sources.paused ? 0 : members.filter(node => node.activity === 'working').length };
  }).filter(plot => plot.items).sort((a, b) => b.needs - a.needs || b.working - a.working || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (board.plots.length >= 2) splitByPlot(board, counted, sources.plots!, (name, members) => section(name, members, !sources.paused, blocked), shown.pipelines ? sources.pipelineOf : undefined);
  omit(board, shown);
  return board;
}

const tiersOf = ({ asking, turn, finished }: DashboardTiers): DashboardTiers => ({ asking, turn, finished });
/** Empties the sections that are off, in the board and its blocks. */
function omit(board: ProjectDashboard, shown: DashboardSections) {
  if (!shown.needsYou) board.needsYou = [];
  if (!shown.working) board.working = [];
  if (!shown.todos) { board.todos = { open: [], done: 0 }; if (board.otherTodos) board.otherTodos = []; }
  if (!shown.plots) board.plots = [];
  if (!shown.pipelines) board.pipelines = [];
  if (!shown.tallies) board.tallies = [];
  for (const block of board.blocks ?? []) {
    if (!shown.needsYou) block.needsYou = [];
    if (!shown.working) block.working = [];
    if (!shown.todos) block.todos = [];
  }
}

/** Splits a dashboard with two or more shown plots into one block per plot and a
 * last Loose block. Blocks rank by their highest Needs me row, then their latest
 * working agent, then their place on the map (top band, then left); never by name,
 * so a rename only changes text. */
function splitByPlot(board: ProjectDashboard, counted: readonly DashboardNode[], plots: readonly PlotView[], sectionOf: (name: PipelineName, members: DashboardNode[]) => DashboardSection, pipelineOf?: (node: DashboardNode) => PipelineName | undefined) {
  const shown = new Map(board.plots.map(plot => [plot.id, plot])), blockOf = new Map<string, string>();
  for (const plot of plots) if (shown.has(plot.id)) for (const id of plot.memberIds) if (!blockOf.has(id)) blockOf.set(id, plot.id);
  const of = (id: string) => blockOf.get(id) ?? LOOSE_BLOCK;
  const blocks = new Map<string, DashboardBlock>([...board.plots.map(plot => plot.id), LOOSE_BLOCK].map(id => [id,
    { id, plot: id !== LOOSE_BLOCK, name: shown.get(id)?.name ?? 'Loose', ...(shown.has(id) ? { color: shown.get(id)!.color } : {}), items: 0, needs: 0, active: 0, tiers: { ...NO_TIERS }, needsYou: [], working: [], todos: [], pipelines: [] }]));
  const members = new Map<string, DashboardNode[]>();
  for (const node of counted) { const id = of(node.id); blocks.get(id)!.items++; members.set(id, [...members.get(id) ?? [], node]); }
  for (const row of board.needsYou) { const block = blocks.get(of(row.id))!; block.needsYou.push(row); block.needs++; if (row.tier) block.tiers[row.tier]++; }
  for (const row of board.working) { const block = blocks.get(of(row.id))!; block.working.push(row); block.active++; }
  board.otherTodos = [];
  for (const todo of board.todos.open) {
    const homes = new Set((todo.nodeId ? [todo.nodeId] : todo.nodeIds).map(of));
    if (homes.size === 1) blocks.get([...homes][0])!.todos.push(todo); else board.otherTodos.push(todo);
  }
  const needsRank = new Map(board.needsYou.map((row, index) => [row.id, index])), ranks = new Map<string, { needs: number; working: string; band: number; left: number }>();
  for (const block of blocks.values()) {
    const grouped = new Map<string, { name: PipelineName; members: DashboardNode[] }>(), placed = members.get(block.id) ?? [];
    for (const node of placed) {
      const name = pipelineOf?.(node); if (!name) continue;
      const key = `${name.singular}\u0000${name.plural}`, entry = grouped.get(key) ?? { name, members: [] };
      entry.members.push(node); grouped.set(key, entry);
    }
    block.pipelines = [...grouped.values()].map(entry => sectionOf(entry.name, entry.members));
    ranks.set(block.id, { needs: Math.min(Infinity, ...block.needsYou.map(row => needsRank.get(row.id)!)), working: block.working.reduce((latest, row) => (row.at ?? '') > latest ? row.at! : latest, ''),
      band: Math.floor(Math.min(Infinity, ...placed.map(node => node.position.y)) / BLOCK_BAND), left: Math.min(Infinity, ...placed.map(node => node.position.x)) });
  }
  const order = (a: DashboardBlock, b: DashboardBlock) => {
    const x = ranks.get(a.id)!, y = ranks.get(b.id)!;
    return (x.needs - y.needs || 0) || Number(!x.working) - Number(!y.working) || y.working.localeCompare(x.working) || (x.band - y.band || 0) || (x.left - y.left || 0) || a.id.localeCompare(b.id);
  };
  const loose = blocks.get(LOOSE_BLOCK)!;
  board.blocks = [...[...blocks.values()].filter(block => block.plot).sort(order), ...(loose.items || loose.todos.length ? [loose] : [])];
}

/** Members grouped by their first indicator: failing, open, ready, then finished; larger groups first. */
function section(name: PipelineName, members: readonly DashboardNode[], attention: boolean, blocked?: ReadonlyMap<string, unknown>): DashboardSection {
  const groups = new Map<string, DashboardGroup>(), grouped = new Map<string, DashboardNode[]>();
  for (const node of members) {
    const cue = node.indicators?.[0], label = cue?.label ?? 'Unknown';
    const group = groups.get(label) ?? { label, tone: cue?.tone ?? 'neutral', icon: cue?.icon ?? 'clock', ...(cue?.stage ? { stage: cue.stage } : {}), count: 0, yours: 0 };
    group.count++; if (attention && nodeAttentionReasons(node).length) group.yours++;
    groups.set(label, group); grouped.set(label, [...grouped.get(label) ?? [], node]);
  }
  const ordered = [...groups.values()].sort((a, b) => STAGE_ORDER[a.stage ?? 'open'] - STAGE_ORDER[b.stage ?? 'open'] || b.count - a.count || a.label.localeCompare(b.label));
  return { name, total: members.length, groups: ordered,
    cells: ordered.flatMap(group => grouped.get(group.label)!.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .map(node => ({ id: node.id, title: node.title, label: group.label, tone: group.tone, ...(group.stage ? { stage: group.stage } : {}), ...(blocked?.has(node.id) ? { blocked: true } : {}), ...(attention && nodeAttentionReasons(node).length ? { needsYou: true } : {}) }))) };
}

/** Dashboards replace a project's items below the threshold. The band around it
 * keeps a zoom that rests near the threshold from flickering between the two. */
export function dashboardsShown(zoom: number, setting: MapDashboards, shown: boolean) {
  if (!setting.enabled) return false;
  return zoom < setting.belowZoom + (shown ? HYSTERESIS : -HYSTERESIS);
}

/** Screen pixels, matched by the dashboard's CSS. A groups line wraps to at most two lines. */
export const DASHBOARD_METRICS = { pad: 12, header: 36, gap: 10, title: 20, row: 24, strip: 20, line: 18, fullWidth: 300, maxWidth: 480, compactWidth: 180, compactMaxWidth: 320, compactHeight: 78, block: 8, chips: 20 } as const;
const MAX_LINES = { needs: 5, working: 4, todos: 4, plots: 4 } as const;
/** A shown block of a split dashboard: rows of each kind from the front of its lists, a “+N more” count and its pipeline lines. */
export interface DashboardBlockLayout { id: string; needs: number; working: number; todos: number; more: number; pipelines: number }
/** `blocks` and `folded` (quiet plots summed up in one line) are used only by a split dashboard. */
export type DashboardLayout =
  | { mode: 'full'; width: number; height: number; needs: number; needsMore: number; working: number; workingMore: number; todos: number; todosMore: number; todoSection: boolean; plots: number; plotsMore: number; pipelines: number; tallies: number; blocks: DashboardBlockLayout[]; folded: string[] }
  | { mode: 'compact'; width: number; height: number; needs: 0; needsMore: 0; working: 0; workingMore: 0; todos: 0; todosMore: 0; todoSection: false; plots: 0; plotsMore: 0; pipelines: 0; tallies: 0; blocks: []; folded: [] };

/** How many lines a groups line takes, from an average 11 px glyph width; at most two. */
function groupLines(section: DashboardSection, width: number) {
  let lines = 1, used = 0;
  for (const group of section.groups) {
    const span = 23 + 6.2 * `${group.count} ${group.label}${group.yours ? ` (${group.yours} yours)` : ''}`.length;
    if (used && used + span > width) { lines++; used = 0; }
    used += span;
  }
  return Math.min(lines, 2);
}

/** Chooses what fits the room a neighbourhood has on screen. Needs you always gets
 * rows first, then Working and To-dos (people's own next steps) and Plots ahead of
 * the aggregate PR and ticket lines; lists longer than their room end with “+N more”. */
export function dashboardLayout(room: { width: number; height: number }, board: ProjectDashboard): DashboardLayout {
  const m = DASHBOARD_METRICS;
  const compact: DashboardLayout = { mode: 'compact', width: Math.min(m.compactMaxWidth, Math.max(m.compactWidth, Math.floor(room.width))), height: m.compactHeight + (board.blocks ? m.chips : 0), needs: 0, needsMore: 0, working: 0, workingMore: 0, todos: 0, todosMore: 0, todoSection: false, plots: 0, plotsMore: 0, pipelines: 0, tallies: 0, blocks: [], folded: [] };
  if (room.width < m.fullWidth || board.muted) return compact;
  const width = Math.min(m.maxWidth, Math.floor(room.width)), inner = width - m.pad * 2;
  if (board.blocks) return splitLayout(room, board, board.blocks, width, inner) ?? compact;
  let height = m.pad * 2 + m.header;
  const fits = (cost: number) => height + cost <= room.height, sectionCost = (lines: number) => m.gap + m.title + lines * m.row;
  const lines = { needs: 0, working: 0, todos: 0, plots: 0 }, counts = { pipelines: 0, tallies: 0 }, open = board.todos.open.length;
  let todoSection = false;
  if (board.needsYou.length) {
    const wanted = [3, 2, 1].map(n => Math.min(board.needsYou.length, n)).find(n => fits(sectionCost(n)) && (n === board.needsYou.length || n >= 2));
    if (!wanted) return compact;
    height += sectionCost(wanted); lines.needs = wanted;
  }
  if (board.working.length && fits(sectionCost(Math.min(board.working.length, 2)))) { lines.working = Math.min(board.working.length, 2); height += sectionCost(lines.working); }
  if ((open || board.todos.done) && fits(sectionCost(Math.min(open, 2)))) { lines.todos = Math.min(open, 2); height += sectionCost(lines.todos); todoSection = true; }
  if (board.plots.length && fits(sectionCost(Math.min(board.plots.length, 2)))) { lines.plots = Math.min(board.plots.length, 2); height += sectionCost(lines.plots); }
  for (const section of board.pipelines) { const cost = m.gap + m.title + m.strip + groupLines(section, inner) * m.line; if (!fits(cost)) break; height += cost; counts.pipelines++; }
  for (const section of board.tallies) { const cost = m.gap + m.title + groupLines(section, inner) * m.line; if (!fits(cost)) break; height += cost; counts.tallies++; }
  if (!lines.needs && !lines.working && !todoSection && !lines.plots && !counts.pipelines && !counts.tallies && (board.working.length || open || board.todos.done || board.plots.length || board.pipelines.length || board.tallies.length)) return compact;
  for (const key of ['needs', 'working', 'todos', 'plots'] as const) {
    const total = key === 'needs' ? board.needsYou.length : key === 'working' ? board.working.length : key === 'todos' ? open : board.plots.length;
    while (lines[key] && lines[key] < Math.min(total, MAX_LINES[key]) && fits(m.row)) { lines[key]++; height += m.row; }
  }
  const shown = (total: number, available: number) => total <= available ? total : available - 1;
  const needs = shown(board.needsYou.length, lines.needs), working = shown(board.working.length, lines.working), todos = shown(open, lines.todos), plots = shown(board.plots.length, lines.plots);
  return { mode: 'full', width, height, needs, needsMore: lines.needs ? board.needsYou.length - needs : 0, working, workingMore: lines.working ? board.working.length - working : 0,
    todos, todosMore: lines.todos ? open - todos : 0, todoSection, plots, plotsMore: lines.plots ? board.plots.length - plots : 0, ...counts, blocks: [], folded: [] };
}

/** Room for a split dashboard, handed out in the unsplit order: Needs you rows
 * (up to five across all blocks) and the Loose header, then the first Working and
 * to-do rows, then headers of the other plots, which fold into one “+N quiet plots”
 * line when they do not fit, then pipeline lines and tallies, then more rows. A block
 * that gets a row also gets its header. Undefined (compact) when fewer than two
 * Needs you rows, or nothing at all, fit. */
function splitLayout(room: { height: number }, board: ProjectDashboard, blocks: readonly DashboardBlock[], width: number, inner: number): DashboardLayout | undefined {
  const m = DASHBOARD_METRICS, header = m.block + m.row;
  let height = m.pad * 2 + m.header;
  const shown = new Map<string, DashboardBlockLayout>(), folded: string[] = [];
  // After Needs you, room stays for the fold line while any plot has neither a header nor a fold.
  let reserving = false;
  const fits = (cost: number, opening?: DashboardBlock) => height + cost + (reserving && !folded.length && blocks.some(block => block.plot && block !== opening && !shown.has(block.id)) ? m.row : 0) <= room.height;
  const open = (block: DashboardBlock) => shown.has(block.id) || folded.includes(block.id) ? 0 : header;
  const show = (block: DashboardBlock) => { if (!shown.has(block.id)) shown.set(block.id, { id: block.id, needs: 0, working: 0, todos: 0, more: 0, pipelines: 0 }); return shown.get(block.id)!; };
  const other = board.otherTodos ?? [];
  let otherRows = 0, otherSection = false;
  type Kind = 'needs' | 'working' | 'todos';
  const listOf = (block: DashboardBlock, kind: Kind) => kind === 'needs' ? block.needsYou : kind === 'working' ? block.working : block.todos;
  const add = (kind: Kind, limit: number) => {
    let given = blocks.reduce((sum, block) => sum + (shown.get(block.id)?.[kind] ?? 0), 0) + (kind === 'todos' ? otherRows : 0);
    const order = kind === 'todos' ? board.todos.open.map(todo => todo.id) : (kind === 'needs' ? board.needsYou : board.working).map(row => row.id);
    for (const id of order) {
      if (given >= limit) return;
      const block = blocks.find(block => listOf(block, kind).some(entry => entry.id === id));
      if (!block) {
        if (kind !== 'todos' || !other.some(todo => todo.id === id)) continue;
        const index = other.findIndex(todo => todo.id === id);
        if (index < otherRows) continue;
        const cost = m.row + (otherSection ? 0 : m.gap + m.title);
        if (!fits(cost)) return;
        height += cost; otherRows++; otherSection = true; given++; continue;
      }
      if (folded.includes(block.id)) continue;
      const index = listOf(block, kind).findIndex(entry => entry.id === id), state = shown.get(block.id);
      if (index < (state?.[kind] ?? 0)) continue;
      const cost = m.row + open(block);
      if (!fits(cost, block)) return;
      height += cost; show(block)[kind]++; given++;
    }
  };
  add('needs', MAX_LINES.needs);
  if (blocks.reduce((sum, block) => sum + (shown.get(block.id)?.needs ?? 0), 0) < Math.min(2, board.needsYou.length)) return undefined;
  reserving = true;
  const loose = blocks.find(block => !block.plot);
  if (loose && !shown.has(loose.id) && fits(header)) { height += header; show(loose); }
  add('working', 2); add('todos', 2);
  if (other.length && !otherSection && fits(m.gap + m.title)) { height += m.gap + m.title; otherSection = true; }
  const waiting = blocks.filter(block => block.plot && !shown.has(block.id));
  waiting.forEach((block, index) => {
    if (folded.length) { folded.push(block.id); return; }
    if (fits(header, block)) { height += header; show(block); return; }
    folded.push(block.id); height += m.row;
  });
  const lines = () => { for (const block of blocks) { const state = shown.get(block.id); if (!state) continue; while (state.pipelines < block.pipelines.length && fits(m.strip)) { height += m.strip; state.pipelines++; } } };
  lines();
  let tallies = 0;
  for (const section of board.tallies) { const cost = m.gap + m.title + groupLines(section, inner) * m.line; if (!fits(cost)) break; height += cost; tallies++; }
  add('working', MAX_LINES.working); add('todos', MAX_LINES.todos); lines();
  for (const block of blocks) {
    const state = shown.get(block.id); if (!state) continue;
    const rows = state.needs + state.working + state.todos, hidden = block.needsYou.length + block.working.length + block.todos.length - rows;
    if (!rows || !hidden) continue;
    if (fits(m.row)) { height += m.row; state.more = hidden; continue; }
    if (rows < 2) continue;
    const last = state.todos ? 'todos' : state.working ? 'working' : 'needs';
    state[last]--; state.more = hidden + 1;
  }
  if (!shown.size && !folded.length && !otherSection && !tallies) return undefined;
  const todos = other.length <= otherRows ? otherRows : Math.max(0, otherRows - 1);
  return { mode: 'full', width, height, needs: 0, needsMore: 0, working: 0, workingMore: 0, todos, todosMore: otherRows ? other.length - todos : 0, todoSection: otherSection, plots: 0, plotsMore: 0, pipelines: 0, tallies,
    blocks: blocks.flatMap(block => shown.get(block.id) ?? []), folded };
}

/** The screen room for a dashboard: the neighbourhood's bounds inset, clipped to the
 * canvas and cut away from fixed controls, keeping the largest remaining part. */
export function dashboardArea(bounds: ScreenRect, canvas: { width: number; height: number }, obstacles: readonly ScreenRect[], inset = 16, margin = 12): ScreenRect | undefined {
  const left = Math.max(bounds.x + inset, margin), top = Math.max(bounds.y + inset, margin);
  const right = Math.min(bounds.x + bounds.width - inset, canvas.width - margin), bottom = Math.min(bounds.y + bounds.height - inset, canvas.height - margin);
  if (right - left < 1 || bottom - top < 1) return undefined;
  let area: ScreenRect = { x: left, y: top, width: right - left, height: bottom - top };
  const gap = 8;
  for (const obstacle of obstacles) {
    if (!intersects(area, obstacle, gap)) continue;
    const r = area, candidates: ScreenRect[] = [
      { x: r.x, y: r.y, width: obstacle.x - gap - r.x, height: r.height },
      { x: obstacle.x + obstacle.width + gap, y: r.y, width: r.x + r.width - (obstacle.x + obstacle.width + gap), height: r.height },
      { x: r.x, y: r.y, width: r.width, height: obstacle.y - gap - r.y },
      { x: r.x, y: obstacle.y + obstacle.height + gap, width: r.width, height: r.y + r.height - (obstacle.y + obstacle.height + gap) },
    ].filter(c => c.width >= 1 && c.height >= 1);
    if (!candidates.length) return undefined;
    area = candidates.reduce((best, c) => c.width * c.height > best.width * best.height ? c : best);
  }
  return area;
}

export interface DashboardPreview { id: string; title: string; typeName?: string; subtitle?: string; status?: ResourceIndicator; cues: ResourceIndicator[]; attention: string[]; tier?: AttentionTier; activityAt?: string; linked: { id: string; title: string; typeName: string }[]; linkedMore: number; blockedBy: string[] }
/** What a hover preview of a dashboard cell or row says: the item's own state, its
 * unread reasons and its connected items. Only saved workspace state; no provider reads. */
export function dashboardPreview(id: string, nodes: readonly DashboardNode[], links: readonly GraphLink[], describe: (node: DashboardNode) => { typeName: string; subtitle?: string; reference?: string } | undefined): DashboardPreview | undefined {
  const node = nodes.find(node => node.id === id);
  if (!node || isArchived(node, nodes)) return undefined;
  const about = describe(node), [status, ...cues] = node.indicators ?? [];
  const linked = [...new Map(links.filter(link => link.sourceId === id || link.targetId === id).map(link => nodes.find(other => other.id === (link.sourceId === id ? link.targetId : link.sourceId)))
    .filter((other): other is DashboardNode => Boolean(other?.resourceId && !isArchived(other, nodes))).map(other => [other.id, { id: other.id, title: other.title, typeName: describe(other)?.typeName ?? '' }])).values()]
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return { id, title: node.title, ...(about?.typeName ? { typeName: about.typeName } : {}), ...(about?.subtitle ? { subtitle: about.subtitle } : {}), ...(status ? { status } : {}), cues,
    attention: attentionDetails([node]).details.filter(text => text !== status?.label), ...(attentionTier(nodeAttentionReasons(node)) ? { tier: attentionTier(nodeAttentionReasons(node)) } : {}), ...(node.activityAt ? { activityAt: node.activityAt } : {}), linked: linked.slice(0, 3), linkedMore: Math.max(0, linked.length - 3),
    blockedBy: blockedBy(id, nodes, links).map(blocker => blockerName(blocker.title, describe(blocker)?.reference)) };
}

export function shortAge(at: string | undefined, now: number) {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
