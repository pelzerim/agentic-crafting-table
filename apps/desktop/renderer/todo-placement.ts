import type { TodoEntry, TodoHorizon, TodoList } from '../../../src/graph/todos.ts';

/** Where a moved row shows before its save lands: before a row, last, or at its saved place in a horizon it never left. */
export type Placement = { id: string; group: 'done' } | { id: string; group: TodoHorizon; at: { before: string } | 'end' | 'saved' };

const GROUPS = ['inbox', 'next', 'later', 'done'] as const;
const order = (entry: TodoEntry) => entry.todoOrder ?? Infinity;

/** The placement of `todo.move` {group, index}, filed the way the save files it; `index` counts the group's rows without this one. */
export function placementFor(list: TodoList, entry: TodoEntry, group: TodoHorizon | 'done', index?: number): Placement {
  if (group === 'done') return { id: entry.id, group };
  if (index === undefined) return { id: entry.id, group, at: entry.horizon === group ? 'saved' : 'end' };
  const before = list[group].filter(row => row.id !== entry.id)[index];
  return { id: entry.id, group, at: before ? { before: before.id } : 'end' };
}

/** The list with moves still being saved already made. Applying a move that has landed again changes nothing. */
export function placeRows(list: TodoList, placements: readonly Placement[]): TodoList {
  let rows: TodoList = list;
  for (const placement of placements) {
    const entry = GROUPS.flatMap(group => rows[group]).find(row => row.id === placement.id);
    if (!entry) continue;
    const next = Object.fromEntries(GROUPS.map(group => [group, rows[group].filter(row => row.id !== entry.id)])) as TodoList;
    if (placement.group === 'done') {
      next.done.unshift(entry.completed ? entry : { ...entry, completed: true, horizon: entry.horizon === 'inbox' ? 'next' : entry.horizon });
    } else {
      const moved: TodoEntry = { ...entry, completed: false, horizon: placement.group }, target = next[placement.group];
      if (placement.at === 'saved') {
        const at = target.findIndex(row => order(row) > order(moved));
        target.splice(at < 0 ? target.length : at, 0, moved);
      } else {
        const at = placement.at === 'end' ? -1 : target.findIndex(row => row.id === (placement.at as { before: string }).before);
        target.splice(at < 0 ? target.length : at, 0, moved);
      }
    }
    rows = next;
  }
  return rows;
}
