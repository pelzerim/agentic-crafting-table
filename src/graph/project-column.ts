import { attentionAge, attentionCountText } from './attention.ts';
import type { AttentionTier } from './attention.ts';
import type { DashboardTiers, ProjectDashboard } from './project-dashboard.ts';

/** Icons the folded column shows before the rest become one “+N”. */
export const COLUMN_ICON_LIMIT = 10;
/** A project without Needs me or working items and without activity for this long is quiet. */
export const QUIET_AFTER_MS = 24 * 3_600_000;
/** The icon's shape: the highest Needs me tier, a working spark, or an idle dot. */
export type ColumnMark = AttentionTier | 'working' | 'idle';
export interface ProjectColumnSource { id: string; title: string; color: string; muted?: boolean; board: ProjectDashboard; summary?: string }
export interface ProjectColumnNeed { id: string; title: string; reason: string; tier: AttentionTier; age: string }
/** `line` is the project's summary when `generated`, otherwise its counts. `count` belongs to `mark`. */
export interface ProjectColumnRow { id: string; title: string; color: string; mark: ColumnMark; count: number; tiers: DashboardTiers; working: number; todos: number; age: string; line: string; generated: boolean; needs: ProjectColumnNeed[] }
export interface ProjectColumnModel { icons: ProjectColumnRow[]; more: number; active: ProjectColumnRow[]; quiet: ProjectColumnRow[] }

function activeAgo(at: string | undefined, now: number) {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return minutes < 1 ? 'active just now' : minutes < 60 ? `active ${minutes} min ago` : minutes < 1440 ? `active ${Math.floor(minutes / 60)} h ago` : `active ${Math.floor(minutes / 1440)} d ago`;
}

/** “2 asking · 1 working · 4 to-dos · active 3 h ago”: tiers, working, open to-dos and the last activity, zeros left out. */
export function projectCountsLine(board: ProjectDashboard, now: number) {
  const open = board.todos.open.length;
  const parts = [attentionCountText(board.counts), board.working.length ? `${board.working.length} working` : '', open ? `${open} ${open === 1 ? 'to-do' : 'to-dos'}` : '', activeAgo(board.lastActivityAt, now)].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing open';
}

const rank = (row: ProjectColumnRow) => row.tiers.asking ? 0 : row.tiers.turn ? 1 : row.working ? 2 : 3;

/** The corner's project column (MAP-22): every project that is not muted, most urgent first. */
export function projectColumn(sources: readonly ProjectColumnSource[], now: number): ProjectColumnModel {
  const rows: { row: ProjectColumnRow; at: string; quiet: boolean }[] = [];
  for (const source of sources) {
    const board = source.board;
    if (source.muted || board.muted) continue;
    const tiers = { asking: board.counts.asking, turn: board.counts.turn, finished: board.counts.finished }, working = board.working.length;
    const mark: ColumnMark = tiers.asking ? 'asking' : tiers.turn ? 'turn' : working ? 'working' : tiers.finished ? 'finished' : 'idle';
    const count = mark === 'idle' ? 0 : mark === 'working' ? working : tiers[mark];
    const summary = source.summary?.trim();
    const row: ProjectColumnRow = { id: source.id, title: source.title, color: source.color, mark, count, tiers, working, todos: board.todos.open.length, age: attentionAge(board.lastActivityAt, now),
      line: summary || projectCountsLine(board, now), generated: Boolean(summary),
      needs: board.needsYou.map(need => ({ id: need.id, title: need.title, reason: need.detail, tier: need.tier ?? 'turn', age: attentionAge(need.since, now) })) };
    const last = Date.parse(board.lastActivityAt ?? '');
    rows.push({ row, at: board.lastActivityAt ?? '', quiet: !board.needsYou.length && !working && !(now - last < QUIET_AFTER_MS) });
  }
  rows.sort((a, b) => Number(a.quiet) - Number(b.quiet) || rank(a.row) - rank(b.row) || b.at.localeCompare(a.at) || a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id));
  const ordered = rows.map(entry => entry.row);
  return { icons: ordered.slice(0, COLUMN_ICON_LIMIT), more: Math.max(0, ordered.length - COLUMN_ICON_LIMIT),
    active: rows.filter(entry => !entry.quiet).map(entry => entry.row), quiet: rows.filter(entry => entry.quiet).map(entry => entry.row) };
}
