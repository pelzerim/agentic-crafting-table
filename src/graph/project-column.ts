import { attentionAge } from './attention.ts';
import type { AttentionTier } from './attention.ts';
import { LOOSE_BLOCK } from './project-dashboard.ts';
import type { DashboardBlock, DashboardRow, DashboardTiers, ProjectDashboard } from './project-dashboard.ts';
import type { GraphNode } from './graph.ts';
import type { PlotColor, PlotView } from './plots.ts';

/** Icons the folded column shows before the rest become one “+N”. */
export const COLUMN_ICON_LIMIT = 10;
/** A project without Needs me or working items and without activity for this long is quiet. */
export const QUIET_AFTER_MS = 24 * 3_600_000;
/** Map rows (world px) that count as the same height when ordering plots by position. */
const PLOT_BAND = 120;
/** The icon's badge: the highest tier that waits on the person, or nothing. */
export type ColumnMark = 'asking' | 'turn' | 'idle';
/** The project's two summary lines, as the service delivers them. */
export interface ProjectSummaryLines { next?: string; status?: string }
/** `plotOrder` lists the project's plot ids in map order; plots it leaves out follow in dashboard order. */
export interface ProjectColumnSource { id: string; title: string; color: string; muted?: boolean; board: ProjectDashboard; summary?: ProjectSummaryLines; plotOrder?: readonly string[] }
/** `key` is the item id with its attention version, so a raised-again row is a new row. */
export interface ProjectColumnNeed { id: string; title: string; reason: string; tier: AttentionTier; age: string; key: string; /** The alert was seen, but the item still waits on the person. */ seen?: boolean }
/** One plot's Needs me rows; a single group with an empty `id` and no header unless two or more plots have rows. */
export interface ProjectColumnGroup { id: string; plot: boolean; name: string; color?: PlotColor | string; tiers: DashboardTiers; working: number; entries: ProjectColumnNeed[] }
/** What a person still acts on besides the rows: open to-dos (`first` opens the list there) and how many agents work. */
export interface ProjectColumnMeta { todos: { open: number; first?: string }; working: number }
/** `count` belongs to `mark`; `next` and `status` exist only when the summary model wrote them. */
export interface ProjectColumnRow { id: string; title: string; tag: string; color: string; mark: ColumnMark; count: number; tiers: DashboardTiers; working: number; todos: number; age: string; lastActivityAt?: string;
  next?: string; status?: string; needs: ProjectColumnNeed[]; groups: ProjectColumnGroup[]; meta: ProjectColumnMeta; plots: string[] }
export interface ProjectColumnModel { icons: ProjectColumnRow[]; more: number; active: ProjectColumnRow[]; quiet: ProjectColumnRow[] }

/** The initials of a name of two or more words (at most three), else its first three letters; upper case. */
export function projectTag(title: string) {
  const words = title.trim().split(/\s+/).map(word => word.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  const tag = words.length > 1 ? words.slice(0, 3).map(word => [...word][0]).join('') : [...(words[0] ?? '')].slice(0, 3).join('');
  return tag.toUpperCase() || '?';
}

/** Each project's tag; tags that clash get a trailing digit, numbered by project id so a project keeps its digit when the order changes. */
export function projectTags(projects: readonly { id: string; title: string }[]) {
  const byTag = new Map<string, string[]>();
  for (const project of projects) { const tag = projectTag(project.title); byTag.set(tag, [...byTag.get(tag) ?? [], project.id]); }
  const tags = new Map<string, string>();
  for (const project of projects) {
    const tag = projectTag(project.title), ids = byTag.get(tag)!;
    tags.set(project.id, ids.length > 1 ? `${tag}${[...ids].sort().indexOf(project.id) + 1}` : tag);
  }
  return tags;
}

/** Plot ids in map order: the band of their topmost member first, then their leftmost member. */
export function plotMapOrder(plots: readonly Pick<PlotView, 'id' | 'memberIds'>[], nodes: readonly Pick<GraphNode, 'id' | 'position'>[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const places = plots.map(plot => {
    const members = plot.memberIds.flatMap(id => byId.get(id) ?? []);
    return { id: plot.id, band: Math.floor(Math.min(Infinity, ...members.map(node => node.position.y)) / PLOT_BAND), left: Math.min(Infinity, ...members.map(node => node.position.x)) };
  });
  return places.sort((a, b) => (a.band - b.band || 0) || (a.left - b.left || 0) || a.id.localeCompare(b.id)).map(place => place.id);
}

/** A plot's name without the “· N items” a local name ends in, since the header counts its items itself. */
const plotName = (name: string) => name.replace(/\s*·\s*\d+ items?$/, '') || name;
const rank = (row: ProjectColumnRow) => row.tiers.asking ? 0 : row.tiers.turn ? 1 : row.working ? 2 : 3;
const needOf = (row: DashboardRow, now: number, seen = false): ProjectColumnNeed => ({ id: row.id, title: row.title, reason: row.detail, tier: row.tier ?? 'turn', age: attentionAge(row.since, now), key: `${row.id}:${row.version ?? 0}`, ...(seen ? { seen } : {}) });
/** Unseen alerts first, then items still waiting after their alert was seen. */
const needRows = (needs: readonly DashboardRow[], waiting: readonly DashboardRow[], now: number) => [...needs.map(row => needOf(row, now)), ...waiting.map(row => needOf(row, now, true))];

/** A split board's plot blocks in `order`; blocks it leaves out keep their dashboard order after it. */
function plotBlocks(blocks: readonly DashboardBlock[], order: readonly string[]) {
  const place = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
  return blocks.filter(block => block.plot).map((block, index) => ({ block, index })).sort((a, b) => place(a.block.id) - place(b.block.id) || a.index - b.index).map(entry => entry.block);
}

/** Groups split a project's rows by plot only when two or more plots have rows; otherwise one group without a header holds them all. */
function groupsOf(board: ProjectDashboard, order: readonly string[], now: number): ProjectColumnGroup[] {
  const whole: ProjectColumnGroup = { id: '', plot: false, name: '', tiers: { asking: board.counts.asking, turn: board.counts.turn, finished: board.counts.finished }, working: board.working.length, entries: needRows(board.needsYou, board.waiting, now) };
  if (!board.blocks) return [whole];
  const groups = [...plotBlocks(board.blocks, order), ...board.blocks.filter(block => block.id === LOOSE_BLOCK)]
    .map(block => ({ id: block.id, plot: block.plot, name: block.plot ? plotName(block.name) : block.name, ...(block.color ? { color: block.color } : {}), tiers: block.tiers, working: block.active, entries: needRows(block.needsYou, block.waiting, now) }))
    .filter(group => group.entries.length);
  return groups.filter(group => group.plot).length >= 2 ? groups : [whole];
}

const metaOf = (board: ProjectDashboard): ProjectColumnMeta => ({ todos: { open: board.todos.open.length, ...(board.todos.open.length ? { first: board.todos.open[0].id } : {}) }, working: board.working.length });

/** “2 to-dos · 1 working”, zeros left out; empty when nothing is open and nothing works. */
export function metaText(meta: ProjectColumnMeta) {
  return [meta.todos.open ? `${meta.todos.open} ${meta.todos.open === 1 ? 'to-do' : 'to-dos'}` : '', meta.working ? `${meta.working} working` : ''].filter(Boolean).join(' · ');
}

/** The corner's project column (MAP-22): every project that is not muted, most urgent first. */
export function projectColumn(sources: readonly ProjectColumnSource[], now: number): ProjectColumnModel {
  const rows: { row: ProjectColumnRow; at: string; quiet: boolean }[] = [];
  const shown = sources.filter(source => !source.muted && !source.board.muted), tags = projectTags(shown);
  for (const source of shown) {
    const board = source.board;
    const tiers = { asking: board.counts.asking, turn: board.counts.turn, finished: board.counts.finished }, working = board.working.length;
    const mark: ColumnMark = tiers.asking ? 'asking' : tiers.turn ? 'turn' : 'idle';
    const count = mark === 'idle' ? 0 : tiers[mark];
    const next = source.summary?.next?.trim(), status = source.summary?.status?.trim();
    const row: ProjectColumnRow = { id: source.id, title: source.title, tag: tags.get(source.id)!, color: source.color, mark, count, tiers, working, todos: board.todos.open.length, age: attentionAge(board.lastActivityAt, now),
      ...(board.lastActivityAt ? { lastActivityAt: board.lastActivityAt } : {}),
      ...(next ? { next } : {}), ...(status ? { status } : {}),
      needs: needRows(board.needsYou, board.waiting, now), groups: groupsOf(board, source.plotOrder ?? [], now), meta: metaOf(board),
      plots: (board.blocks ? plotBlocks(board.blocks, source.plotOrder ?? []) : board.plots).map(plot => plotName(plot.name)) };
    const last = Date.parse(board.lastActivityAt ?? '');
    rows.push({ row, at: board.lastActivityAt ?? '', quiet: !board.needsYou.length && !working && !(now - last < QUIET_AFTER_MS) });
  }
  rows.sort((a, b) => Number(a.quiet) - Number(b.quiet) || rank(a.row) - rank(b.row) || b.at.localeCompare(a.at) || a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id));
  const ordered = rows.map(entry => entry.row);
  return { icons: ordered.slice(0, COLUMN_ICON_LIMIT), more: Math.max(0, ordered.length - COLUMN_ICON_LIMIT),
    active: rows.filter(entry => !entry.quiet).map(entry => entry.row), quiet: rows.filter(entry => entry.quiet).map(entry => entry.row) };
}

/** What the column showed when it was last unfolded: its Needs me rows and each project's last activity. */
export interface ColumnBaseline { needs: ReadonlySet<string>; activity: ReadonlyMap<string, string> }
const allRows = (model: ProjectColumnModel) => [...model.active, ...model.quiet];
export function columnBaseline(model: ProjectColumnModel): ColumnBaseline {
  const rows = allRows(model);
  return { needs: new Set(rows.flatMap(row => row.needs.map(need => need.key))), activity: new Map(rows.flatMap(row => row.lastActivityAt ? [[row.id, row.lastActivityAt] as const] : [])) };
}

/** Projects with a Needs me row (item and attention version) or activity that arrived after the baseline. */
export function projectsNewSince(model: ProjectColumnModel, baseline: ColumnBaseline) {
  return new Set(allRows(model).filter(row => row.needs.some(need => !baseline.needs.has(need.key)) || (row.lastActivityAt !== undefined && row.lastActivityAt > (baseline.activity.get(row.id) ?? ''))).map(row => row.id));
}
