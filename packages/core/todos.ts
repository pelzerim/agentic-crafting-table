import type { TodoEntry, TodoHorizon } from '../../src/graph/todos.ts';
import type { WorkspaceCommand, WorkspaceState } from './control.ts';
import { isOffMap } from '../../src/graph/archive.ts';

export function renameTodo(entry: TodoEntry, title: string): WorkspaceCommand {
  return entry.source === 'map' ? { type: 'node.update', id: entry.nodeId!, title }
    : { type: 'todo.save', todo: { id: entry.id, title, nodeIds: entry.nodeIds, completed: entry.completed } };
}

/** Sets a to-do's context from the list; an empty text clears it. */
export function contextTodo(entry: TodoEntry, context: string): WorkspaceCommand {
  return { type: 'todo.context', id: entry.id, context, mode: 'replace' };
}

/** Overlay operations target the original record; map tasks are never checklist copies. Ticking an inbox ticket takes it into Next. */
export function completeTodo(entry: Pick<TodoEntry, 'id' | 'horizon'>, completed: boolean): WorkspaceCommand {
  return { type: 'todo.move', id: entry.id, horizon: completed ? 'done' : entry.horizon === 'later' ? 'later' : 'next' };
}
/** Moves a to-do to a group, at `index` when given. */
export function moveTodo(entry: Pick<TodoEntry, 'id'>, horizon: TodoHorizon | 'done', index?: number): WorkspaceCommand {
  return { type: 'todo.move', id: entry.id, horizon, ...(index === undefined ? {} : { index }) };
}
/** What sends a to-do to Archive, the same way the row and map menus do; an item kept in the list only leaves the list. */
export function archiveTodo(state: Pick<WorkspaceState, 'nodes'>, entry: Pick<TodoEntry, 'id' | 'source' | 'nodeId'>): WorkspaceCommand {
  if (entry.source === 'checklist') return { type: 'todo.archive', id: entry.id };
  return state.nodes.find(node => node.id === entry.nodeId)?.inTodoList ? { type: 'node.todo', id: entry.nodeId!, enabled: false } : { type: 'node.archive', id: entry.nodeId! };
}
export function attachTodo(state: WorkspaceState, entry: TodoEntry | undefined, nodeId: string, id: string): WorkspaceCommand[] {
  const node = state.nodes.find(node => node.id === nodeId);
  if (!node) throw new Error('This map item no longer exists');
  if (entry?.source === 'map') {
    if (entry.nodeId === nodeId || entry.nodeIds.includes(nodeId)) return [];
    return [{ type: 'link.save', link: { id, sourceId: nodeId, targetId: entry.nodeId!, kind: 'reference', label: '' } }];
  }
  if (entry) return [{ type: 'todo.save', todo: { id: entry.id, title: entry.title, completed: entry.completed, nodeIds: [...new Set([...entry.nodeIds, nodeId])] } }];
  if (node.inTodoList) return [];
  if (state.resources.some(resource => resource.id === node.resourceId && resource.pluginId === 'workspace.todo')) return [];
  return [{ type: 'todo.save', todo: { id, title: node.title, completed: false, nodeIds: [nodeId] } }];
}
export function detachTodo(state: WorkspaceState, entry: TodoEntry, nodeId: string): WorkspaceCommand[] {
  return entry.source === 'map' ? state.links.filter(link => (link.sourceId === entry.nodeId && link.targetId === nodeId) || (link.targetId === entry.nodeId && link.sourceId === nodeId)).map(link => ({ type: 'link.remove', id: link.id }))
    : [{ type: 'todo.save', todo: { id: entry.id, title: entry.title, completed: entry.completed, nodeIds: entry.nodeIds.filter(id => id !== nodeId) } }];
}

/** Reorder stable identities, never mutate membership or use row indexes as IDs. */
export function reorderTodoIds(ids: string[], moving: string, target: string): string[] {
  if (!ids.includes(moving) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== moving); next.splice(ids.indexOf(target), 0, moving); return next;
}

type ProjectTarget = { id: string; title: string; current: boolean };
/** The map's projects in the to-do list's project order, without archived projects and projects in Undermap. */
function projectTargets(state: WorkspaceState, current: string | undefined): ProjectTarget[] {
  return state.nodes.filter(node => !node.resourceId && !node.projectId && !isOffMap(node, state.nodes))
    .map((node, index) => ({ node, index })).sort((a, b) => (a.node.todoOrder ?? Infinity) - (b.node.todoOrder ?? Infinity) || a.index - b.index)
    .map(({ node }) => ({ id: node.id, title: node.title, current: current === node.id }));
}
/** Projects a to-do can be sent to; `current` marks where a map to-do already lives. */
export function sendTargets(state: WorkspaceState, entry: TodoEntry): ProjectTarget[] {
  return projectTargets(state, entry.source === 'map' ? entry.projectId : undefined);
}
/** Projects map items can be moved to; `current` marks the project they all share, if they do. */
export function moveTargets(state: WorkspaceState, nodeIds: readonly string[]): ProjectTarget[] {
  const projects = new Set(nodeIds.map(id => state.nodes.find(node => node.id === id)?.projectId));
  return projectTargets(state, projects.size === 1 ? [...projects][0] : undefined);
}
/** Moves a to-do and its attached items into a project. `ids` name the map to-do a list-only entry becomes. */
export function sendTodo(entry: TodoEntry, projectId: string, ids: { nodeId: string; resourceId: string }): WorkspaceCommand {
  return { type: 'todo.send', id: entry.id, projectId, ...(entry.source === 'checklist' ? ids : {}) };
}
