import type { WorkspaceState } from '../core/control.ts';
import { todoEntries } from '../../src/graph/todos.ts';
import type { TodoEntry } from '../../src/graph/todos.ts';

/** Schema 25 (TODO-12): a workspace saved before horizons. Every open to-do goes to Next in the order the
 * project-grouped list showed it (Triage first, then projects in list order, then No project). An import
 * still exactly as imported (`imported` holds the title its ledger gave it) waits in the inbox instead.
 * Done rows count their wait for Archive from `at`, and every to-do is touched at `at`. Nothing is removed. */
export function migrateTodoHorizons(input: WorkspaceState, imported: ReadonlyMap<string, string>, at: string): WorkspaceState {
  const state = structuredClone(input), entries = todoEntries(state);
  const rank = (entry: TodoEntry) => entry.todoOrder ?? Infinity;
  const projects = state.nodes.filter(node => !node.resourceId && !node.projectId).sort((a, b) => (a.todoOrder ?? Infinity) - (b.todoOrder ?? Infinity));
  const grouped = [entries.filter(entry => entry.triage), ...[...projects.map(project => project.id), undefined].map(id => entries.filter(entry => !entry.triage && entry.projectId === id))]
    .flatMap(group => group.sort((a, b) => rank(a) - rank(b)));
  let next = 0, inbox = 0;
  for (const entry of grouped) {
    const record = entry.source === 'checklist' ? state.todos.find(todo => todo.id === entry.id)! : undefined, node = entry.nodeId ? state.nodes.find(node => node.id === entry.nodeId)! : undefined;
    const waiting = record?.triage && !record.completed && !record.nodeIds.length && imported.get(record.id) === record.title;
    if (record) { record.horizon = waiting ? 'inbox' : 'next'; record.todoOrder = waiting ? inbox++ : entry.completed ? record.todoOrder : next++; record.touchedAt ??= at; }
    else if (node) { if (!entry.completed) node.todoOrder = next++; node.todoTouchedAt ??= at; }
  }
  // Archived checklist to-dos are not listed; they return to Next when restored.
  for (const record of state.todos) if (!record.horizon) { record.horizon = 'next'; record.touchedAt ??= at; }
  return state;
}
