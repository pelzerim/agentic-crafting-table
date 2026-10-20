import type { GraphLink, GraphNode } from './graph.ts';
import { mutedProjectIds } from './mute.ts';

/** Where an imported to-do came from: `key` is the provider's identity of the work, `label` its short name,
 * `status` the provider's own state name as last read. */
export interface TodoTriage { source: string; key: string; label: string; url?: string; status?: string }
/** When a to-do is for (TODO-12): `inbox` holds imported tickets nobody has taken yet. Done is completion, not a horizon. */
export type TodoHorizon = 'next' | 'later';
export const NEXT_SOFT_LIMIT = 5, LATER_AGE_DAYS = 30;
/** Choices for how long Done rows stay before Archive; `never` keeps them. */
export const DONE_ARCHIVE_CHOICES = ['1', '3', '7', 'never'] as const;
export const DEFAULT_DONE_ARCHIVE = '3';
const DAY = 86_400_000;
/** Who last wrote a to-do's context: `title` is the agent's title at that moment, kept after the agent is gone. */
export interface TodoContextWriter { kind: 'user' | 'agent' | 'provider' | 'system'; id: string; title?: string }
export const TODO_CONTEXT_LIMIT = 8000;
/** A to-do's context (TODO-11) in one shape, wherever it is stored. */
export interface TodoContext { text: string; by?: TodoContextWriter; at?: string }
/** A ticket a person said is not for them: hidden from the inbox until the ticket differs from this. */
export interface TodoDismissal { at: string; title: string; status?: string }
interface ChecklistTodo { id: string; title: string; completed: boolean; nodeIds: readonly string[]; archivedAt?: string; todoOrder?: number; triage?: TodoTriage; context?: string; contextBy?: TodoContextWriter; contextAt?: string
  horizon?: TodoHorizon | 'inbox'; doneAt?: string; touchedAt?: string; dismissed?: TodoDismissal }
type TodoWorkspace = { nodes: readonly GraphNode[]; resources: readonly { id: string; pluginId: string }[]; todos: readonly ChecklistTodo[] };
const contextOf = (text: string | undefined, by: TodoContextWriter | undefined, at: string | undefined): TodoContext | undefined => text ? { text, ...(by ? { by } : {}), ...(at ? { at } : {}) } : undefined;
/** A checklist to-do keeps its context on its record, a map to-do on its node. */
export const checklistContext = (todo: Pick<ChecklistTodo, 'context' | 'contextBy' | 'contextAt'> | undefined) => contextOf(todo?.context, todo?.contextBy, todo?.contextAt);
export const mapTodoContext = (node: Pick<GraphNode, 'todoContext' | 'todoContextBy' | 'todoContextAt'> | undefined) => contextOf(node?.todoContext, node?.todoContextBy, node?.todoContextAt);
/** The stored fields of a context for each kind; none when there is no context. */
export const checklistContextFields = (context: TodoContext | undefined) => context ? { context: context.text, ...(context.by ? { contextBy: context.by } : {}), ...(context.at ? { contextAt: context.at } : {}) } : {};
export const mapTodoContextFields = (context: TodoContext | undefined) => context ? { todoContext: context.text, ...(context.by ? { todoContextBy: context.by } : {}), ...(context.at ? { todoContextAt: context.at } : {}) } : {};
/** The node behind `map:<nodeId>` when it is a to-do: a to-do item, or an item kept in the to-do list. */
export function mapTodoNode<N extends GraphNode>(workspace: { nodes: readonly N[]; resources: readonly { id: string; pluginId: string }[] }, id: string): N | undefined {
  const node = id.startsWith('map:') ? workspace.nodes.find(node => `map:${node.id}` === id) : undefined;
  return node?.resourceId && (node.inTodoList || workspace.resources.some(resource => resource.id === node.resourceId && resource.pluginId === 'workspace.todo')) ? node : undefined;
}
/** The context of a to-do by its list id (a to-do id, or `map:<nodeId>`), archived or not. */
export function todoContext(workspace: TodoWorkspace, id: string): TodoContext | undefined {
  const record = workspace.todos.find(todo => todo.id === id);
  return record ? checklistContext(record) : mapTodoContext(mapTodoNode(workspace, id));
}
export interface TodoEntry {
  id: string;
  source: 'checklist' | 'map';
  /** Imported and not yet sent to a project. */
  triage?: TodoTriage;
  providerTask?: boolean;
  todoOrder?: number;
  nodeId?: string;
  title: string;
  completed: boolean;
  projectId?: string;
  nodeIds: string[];
  /** Hidden in the list until asked for; never part of the title. */
  context?: TodoContext;
  /** `inbox` is an imported ticket nobody has taken yet; completion is separate and keeps the horizon to return to. */
  horizon: TodoHorizon | 'inbox';
  /** When it was ticked off, if known. */
  doneAt?: string;
  touchedAt?: string;
  /** An inbox ticket the person said is not for them. */
  dismissed?: true;
  /** Done because its provider says so, not because it was ticked here. */
  providerDone?: true;
}
export interface TodoGroup { projectId?: string; title: string; triage?: true; muted?: true; items: TodoEntry[] }
type TodoSource = { nodes: readonly GraphNode[]; resources: readonly { id: string; pluginId: string }[]; links: readonly GraphLink[]; todos: readonly ChecklistTodo[] };
const later = (...times: (string | undefined)[]) => times.filter((time): time is string => Boolean(time)).sort().at(-1);

/** Every to-do in the list, with its project as a property: map tasks keep their node identity, membership and completion.
 * Tasks archived or in Undermap leave the list until they return to the map. Dismissed inbox tickets are included. */
export function todoEntries(workspace: TodoSource): TodoEntry[] {
  const byId = new Map(workspace.nodes.map(node => [node.id, node]));
  const projectIds = new Set(workspace.nodes.filter(node => !node.resourceId && !node.projectId).map(node => node.id));
  const membership = (id: string) => {
    const node = byId.get(id);
    return node && projectIds.has(node.projectId ?? node.id) ? node.projectId ?? node.id : undefined;
  };
  const entries: TodoEntry[] = workspace.todos.filter(todo => !todo.archivedAt).map(todo => {
    const scopes = [...new Set(todo.nodeIds.map(membership))], { triage } = todo, horizon = todo.horizon ?? 'next', context = checklistContext(todo);
    return { id: todo.id, source: 'checklist', title: todo.title, completed: todo.completed, nodeIds: [...todo.nodeIds], horizon, ...(todo.todoOrder !== undefined ? { todoOrder: todo.todoOrder } : {}),
      ...(context ? { context } : {}), ...(todo.doneAt ? { doneAt: todo.doneAt } : {}), ...(todo.touchedAt ? { touchedAt: todo.touchedAt } : {}), ...(todo.dismissed && horizon === 'inbox' ? { dismissed: true as const } : {}),
      ...(triage ? { triage: { source: triage.source, key: triage.key, label: triage.label, ...(triage.url ? { url: triage.url } : {}), ...(triage.status ? { status: triage.status } : {}) } } : {}),
      projectId: horizon === 'inbox' || scopes.length !== 1 ? undefined : scopes[0] };
  });
  const todoResources = new Set(workspace.resources.filter(r => r.pluginId === 'workspace.todo').map(r => r.id));
  for (const node of workspace.nodes) {
    if (!node.resourceId || !(todoResources.has(node.resourceId) || node.inTodoList) || node.archivedAt || node.belowAt) continue;
    const project = byId.get(node.projectId ?? ''); if (project?.archivedAt || project?.belowAt) continue;
    const doneAt = later(node.completedAt, node.todoDoneAt);
    entries.push({
      id: `map:${node.id}`, source: 'map', nodeId: node.id, title: node.title, todoOrder: node.todoOrder, horizon: node.todoHorizon ?? 'next',
      providerTask: node.inTodoList || undefined, completed: Boolean(doneAt), ...(doneAt ? { doneAt } : {}), ...(node.todoTouchedAt ? { touchedAt: node.todoTouchedAt } : {}),
      ...(node.inTodoList && node.completedAt ? { providerDone: true as const } : {}),
      projectId: membership(node.id), ...(node.todoContext ? { context: mapTodoContext(node) } : {}),
      nodeIds: [...new Set(workspace.links.filter(link => link.sourceId === node.id || link.targetId === node.id)
        .map(link => link.sourceId === node.id ? link.targetId : link.sourceId).filter(id => byId.has(id)))],
    });
  }
  return entries;
}
const ordered = (items: TodoEntry[]) => items.sort((a, b) => (a.todoOrder ?? Infinity) - (b.todoOrder ?? Infinity));
/** The list by when (TODO-12): untaken tickets, Next and Later in their manual order, and Done with the latest first. */
export function todoList(workspace: TodoSource) {
  const entries = todoEntries(workspace), open = (horizon: TodoHorizon) => ordered(entries.filter(entry => entry.horizon === horizon && !entry.completed));
  return { inbox: ordered(entries.filter(entry => entry.horizon === 'inbox' && !entry.dismissed)), next: open('next'), later: open('later'),
    done: entries.filter(entry => entry.horizon !== 'inbox' && entry.completed).sort((a, b) => doneTime(b) - doneTime(a)) };
}
export type TodoList = ReturnType<typeof todoList>;
/** The list as the person sees it: to-dos of muted projects are left out until the project is unmuted; the inbox stays whole. */
export function withoutMuted(list: TodoList, nodes: readonly GraphNode[]): TodoList {
  const muted = mutedProjectIds(nodes), shown = (rows: TodoEntry[]) => rows.filter(row => !row.projectId || !muted.has(row.projectId));
  return muted.size ? { inbox: list.inbox, next: shown(list.next), later: shown(list.later), done: shown(list.done) } : list;
}
const time = (value: string | undefined) => value ? Date.parse(value) || 0 : 0;
const doneTime = (entry: Pick<TodoEntry, 'doneAt' | 'touchedAt'>) => Math.max(time(entry.doneAt), time(entry.touchedAt));
/** A Done row goes to Archive `days` after it was ticked or last touched, whichever is later; undefined days is never. */
export const archiveDue = (entry: Pick<TodoEntry, 'completed' | 'doneAt' | 'touchedAt'>, days: number | undefined, now: number) =>
  entry.completed && days !== undefined && doneTime(entry) > 0 && now - doneTime(entry) >= days * DAY;
/** Whole days since a person last touched the row; none recorded is no age. */
export const untouchedDays = (entry: Pick<TodoEntry, 'touchedAt'>, now: number) => entry.touchedAt ? Math.max(0, Math.floor((now - time(entry.touchedAt)) / DAY)) : 0;
/** The row untouched longest; rows without a recorded touch count as oldest, and among equals the lowest in the list. */
export const oldestTodo = <T extends Pick<TodoEntry, 'touchedAt'>>(rows: readonly T[]) => rows.reduce<T | undefined>((oldest, row) => !oldest || time(row.touchedAt) <= time(oldest.touchedAt) ? row : oldest, undefined);
/** The saved choice of days before Done goes to Archive; anything unknown is the default. */
export const doneArchiveDays = (setting: unknown) => {
  const choice = (DONE_ARCHIVE_CHOICES as readonly unknown[]).includes(setting) ? setting as typeof DONE_ARCHIVE_CHOICES[number] : DEFAULT_DONE_ARCHIVE;
  return choice === 'never' ? undefined : Number(choice);
};

/** Project groups for the list's Group by project view, led by tickets waiting in the inbox. */
export function groupWorkspaceTodos(workspace: TodoSource): TodoGroup[] {
  const projects = workspace.nodes.filter(node => !node.resourceId && !node.projectId).sort((a, b) => (a.todoOrder ?? Infinity) - (b.todoOrder ?? Infinity));
  const entries = todoEntries(workspace).filter(entry => !entry.dismissed);
  const groups: TodoGroup[] = [{ title: 'Triage', triage: true, items: ordered(entries.filter(entry => entry.horizon === 'inbox')) },
    ...[...projects.map(project => ({ projectId: project.id as string | undefined, title: project.title, ...(project.mutedAt ? { muted: true as const } : {}) })), { projectId: undefined, title: 'No project' }]
      .map(group => ({ ...group, items: ordered(entries.filter(entry => entry.horizon !== 'inbox' && entry.projectId === group.projectId)) }))];
  return groups.filter(group => group.items.length > 0);
}
