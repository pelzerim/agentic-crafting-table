import type { SpatialBox } from './spatial.ts';

/** The board every node without one is on; the migration names it Main. */
export const DEFAULT_BOARD = 'main';
export const BOARD_LIMIT = 20;
export interface BoardRecord { id: string; name: string; color?: string }
export const MAIN_BOARD: BoardRecord = { id: DEFAULT_BOARD, name: 'Main' };

/** The boards in tab order; a workspace that never saved one shows Main. */
export function boardList(state: { boards?: readonly BoardRecord[] }): readonly BoardRecord[] {
  return state.boards?.length ? state.boards : [MAIN_BOARD];
}
/** A node's board: members are kept on their project's board by the reducer. */
export const boardOf = (node: { board?: string }) => node.board ?? DEFAULT_BOARD;
/** The board a window shows: its saved one while it exists, else the first. */
export function shownBoard(boards: readonly BoardRecord[], saved: string | undefined): string {
  return boards.some(board => board.id === saved) ? saved! : boards[0]?.id ?? DEFAULT_BOARD;
}
/** A footprint for placement within one board, where derived boxes carry no board either. */
export const boardless = <N>(footprint: (node: N) => SpatialBox) => (node: N): SpatialBox => { const { board: _, ...box } = footprint(node); return box; };
