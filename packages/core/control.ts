import { TODO_CONTEXT_LIMIT, checklistContext, checklistContextFields, groupWorkspaceTodos, mapTodoContext, mapTodoContextFields, mapTodoNode, todoEntries, todoList } from '../../src/graph/todos.ts';
import { cardPipsSchema, indicatorsSchema } from '../../src/resource-plugins/indicators.ts';
import { mapDimensionsSchema, resolveMapSize } from './item-map-sizes.ts';
import type { MapLayout } from '../../src/graph/snap.ts';
import { snapPosition } from '../../src/graph/snap.ts';
import * as z from 'zod/v4';
import { resourceCardinality } from '../../src/graph/resource-links.ts';
import { ITEM_SIZES, existingRelationship, saveLink } from '../../src/graph/graph.ts';
import type { GraphNode } from '../../src/graph/graph.ts';
import { ITEM_GAP, layoutFootprints, moveItems, repairLayout, resizeItem } from '../../src/graph/movement.ts';
import { arrivalPlacement } from '../../src/graph/project-arrival.ts';
import { COLUMN_KINDS } from '../../src/graph/project-column.ts';
import { creationAnchors, creationContext, itemPlacement, projectPlacement } from '../../src/graph/creation-placement.ts';
import type { TodoContext, TodoEntry } from '../../src/graph/todos.ts';
import { archiveNode, restoreNode, isArchived, isDrawn, isOffMap, surfaceBlocker } from '../../src/graph/archive.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { itemFootprint, freePosition } from '../../src/graph/footprints.ts';
import { restoreMapPositions, sendBelow } from '../../src/graph/undermap.ts';
import { localItemTitle } from '../../src/resource-plugins/generated-title.ts';
import { fieldDefaults } from '../../src/resource-plugins/define.ts';
import { ATTENTION_NOTE_LENGTH, attentionNote } from '../../src/graph/attention.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
const projectColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const id = z.string().trim().min(1).max(200);
const title = z.string().trim().min(1).max(500);
const position = z.object({ x: z.number().finite(), y: z.number().finite() });
const data = z.record(z.string(), z.json());
const activity = z.enum(['working', 'idle', 'complete', 'unknown']);
const attention = z.enum(['none', 'input', 'review', 'error']);
const attentionReason = z.enum(['input', 'review', 'error', 'assigned', 'finished', 'approved', 'checks-failing', 'validation', 'comment']);
const note = z.string().max(500);
const attentionNoteInput = note.describe(`Short plain-text reason shown in Needs me, in sentence case without a trailing period, e.g. "Agent waiting" or "Job needs approval"; trimmed to ${ATTENTION_NOTE_LENGTH} characters.`);
export { TODO_CONTEXT_LIMIT };
const contextLimit = `A to-do's context is limited to ${TODO_CONTEXT_LIMIT.toLocaleString('en-US')} characters`;
const todoContextText = z.string().max(TODO_CONTEXT_LIMIT, contextLimit);
const todoContextInput = todoContextText.describe('Plain text kept with the to-do for the person or a later agent: reasoning, links, next steps. Markdown stays text. It stays when you are gone.');
const contextWriter = z.object({ kind: z.enum(['user', 'agent', 'provider', 'system']), id, title: title.optional() });
/** Line breaks and tabs stay; other control characters go. */
const cleanContext = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
const resource = z.object({ id, pluginId: id, schemaVersion: z.number().int().positive(), title, connectionId: id.optional(), data });
const POSES = ['gate', 'asking', 'fallen', 'shearing', 'command', 'ended'] as const;
const taskProgress = z.object({ done: z.number().int().min(0).max(999), total: z.number().int().min(0).max(999) }).refine(tasks => tasks.done <= tasks.total, 'More tasks done than there are');
const moment = z.object({ kind: z.enum(['stumble', 'bump', 'enter', 'leave']), at: z.number().int().positive() });
const recapSchema = z.object({ text: z.string().min(1).max(600), at: z.iso.datetime() });
const node = z.object({
  id, title, position, resourceId: id.optional(), projectId: id.optional(),
  mapSize: z.enum(ITEM_SIZES).optional(),
  mapDimensions: mapDimensionsSchema.optional(),
  acceptsContext: z.boolean().optional(), archivedAt: z.iso.datetime().optional(), belowAt: z.iso.datetime().optional(), hiddenAt: z.iso.datetime().optional(), hideLabel: z.string().trim().min(1).max(60).optional(), mutedAt: z.iso.datetime().optional(), mapPosition: position.optional(), lostProject: title.optional(),
  completedAt: z.iso.datetime().optional(),
  todoLabel: z.object({ title: z.string().min(1).max(48), sourceTitle: title }).optional(),
  generatedTitle: title.optional(),
  inTodoList: z.boolean().optional(), todoOrder: z.number().int().nonnegative().optional(),
  todoContext: todoContextText.optional(), todoContextBy: contextWriter.optional(), todoContextAt: z.iso.datetime().optional(),
  todoHorizon: z.enum(['next', 'later']).optional(), todoTouchedAt: z.iso.datetime().optional(), todoDoneAt: z.iso.datetime().optional(), todoTicketId: id.optional(),
  attentionSources: z.record(id, attentionReason).optional(),
  attentionNotes: z.record(id, note).optional(),
  attentionNote: note.optional(),
  attentionVersion: z.number().int().nonnegative().optional(),
  attentionSeenVersion: z.number().int().nonnegative().optional(),
  attentionAt: z.iso.datetime().optional(),
  attentionEvents: z.record(id, id).optional(),
  indicators: indicatorsSchema.optional(),
  /** Card pips the item's type presentation draws, with their count line. */
  pips: cardPipsSchema.optional(),
  activityAt: z.iso.datetime().optional(),
  helpers: z.number().int().positive().max(999).optional(),
  waiting: z.literal(true).optional(),
  pose: z.enum(POSES).optional(),
  beside: z.number().int().positive().max(999).optional(),
  tasks: taskProgress.optional(),
  bell: z.literal(true).optional(), pen: z.literal(true).optional(),
  moment: moment.optional(),
  summary: z.string().max(4000).default(''),
  /** The last line an agent said when its turn ended, shown in its Needs me row (STATE-02). */
  lastLine: z.string().min(1).max(200).optional(),
  /** The newest recap Claude Code wrote while the person was away, newer than the turn end; shown in place of the last line. */
  recap: recapSchema.optional(),
  /** When the agent's last turn ended (its Stop); a recap counts only when it is newer. */
  turnEndedAt: z.iso.datetime().optional(),
  /** What an agent is changing on this item right now; while set the item is working (node.rework). */
  rework: z.object({ note: z.string().min(1).max(200), since: z.string(), by: z.string().min(1).max(200).optional() }).optional(),
  workingDirectory: z.string().max(4096).optional(),
  color: projectColorSchema.optional(),
  activity: activity.default('unknown'),
  attention: attention.default('none'),
});
/** `reveal: 'hover'` keeps a link off the map until one of its ends, or the link itself, is hovered, focused, selected or open. */
export const linkReveal = z.literal('hover');
const link = z.object({ id, sourceId: id, targetId: id, kind: z.enum(['reference', 'context', 'blocks']), label: z.string().max(500).default(''), reveal: linkReveal.optional() });
/** A link saved with a new item, in the same command. `newItemIs` names the new item's end: `source` (default) points
 * from it to `otherId`, `target` points from `otherId` to it. Without `id` the link is ensured: its id is derived
 * (`itemLinkId`) and a relationship the two already have is kept. With `id` it follows `link.save` exactly. */
export const itemLinkSchema = z.object({ otherId: id, kind: z.enum(['reference', 'context', 'blocks']), newItemIs: z.enum(['source', 'target']).default('source'), label: z.string().max(500).optional(), id: id.optional() });
export type ItemLink = z.infer<typeof itemLinkSchema>;
export const ITEM_LINK_LIMIT = 8;
export const POSITION_REQUIRED = 'position is required: nothing on the map places this. Link the item to a node on the map, name a projectId, or give a position.';
/** An imported to-do awaiting triage. `key` is the provider's identity of the work (never imported twice);
 * `item` becomes a map item attached to the to-do once it is placed in a project. */
const triage = z.object({ source: id, key: id, label: z.string().trim().min(1).max(60), url: z.string().max(2000).regex(/^https:\/\//).optional(), status: z.string().trim().min(1).max(100).optional(),
  item: z.object({ pluginId: id, connectionId: id.optional(), title, data }) });
const todo = z.object({ id, title, todoOrder: z.number().int().nonnegative().optional(), completed: z.boolean().default(false), nodeIds: z.array(id).default([]), archivedAt: z.iso.datetime().optional(), triage: triage.optional(),
  context: todoContextText.optional(), contextBy: contextWriter.optional(), contextAt: z.iso.datetime().optional(),
  /** When it was last ticked off; recorded by the host from then on, so to-dos completed earlier have none. */
  doneAt: z.iso.datetime().optional(),
  /** `inbox` is an imported ticket nobody has taken yet (TODO-09); none reads as next. */
  horizon: z.enum(['next', 'later', 'inbox']).optional(), touchedAt: z.iso.datetime().optional(),
  dismissed: z.object({ at: z.iso.datetime(), title, status: z.string().max(100).optional() }).optional() });
/** A to-do as a command gives it: the host alone records who wrote its context and when, when it was done or touched, and dismissals. Without `context` a save keeps what is there; an empty one clears it. */
const todoInput = todo.omit({ contextBy: true, contextAt: true, doneAt: true, touchedAt: true, dismissed: true, horizon: true }).extend({ context: todoContextInput.optional(),
  horizon: z.enum(['next', 'later', 'inbox']).optional().describe('When the to-do is for: next (default for a new to-do) or later. A save without it keeps where the to-do is.') });
export const viewSchema = z.object({
  mode: z.enum(['workspace', 'project', 'item']).default('workspace'),
  nodeId: id.optional(), camera: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(.2).max(1.35) }).optional(),
  todosOpen: z.boolean().default(false), archive: z.boolean().default(false),
  todoOverlay: z.object({ width: z.number().min(260).max(900).optional(), height: z.number().min(160).max(1000).optional(), autoHide: z.boolean().optional(), x: z.number().finite(), y: z.number().finite(), draft: z.string().max(500).default(''), scrollTop: z.number().finite().nonnegative().default(0),
    groupByProject: z.boolean().optional() }).optional(),
  itemViewBounds: z.record(id, z.object({ x: z.number().finite().optional(), y: z.number().finite().optional(), width: z.number().min(1).max(10000).optional(), height: z.number().min(1).max(10000).optional() })).optional(),
  /** What an item's view keeps of its own layout, such as a folded panel; never the item's data. */
  itemViewState: z.record(id, z.record(z.string().regex(/^[A-Za-z][\w-]{0,63}$/), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
    .refine(state => Object.keys(state).length <= 16, 'At most 16 view-state keys per item')).optional(),
  inboxPanel: z.object({ width: z.number().min(260).max(900).optional(), height: z.number().min(160).max(1000).optional() }).optional(),
  attentionPanel: z.object({ width: z.number().min(260).max(900).optional(), height: z.number().min(160).max(1000).optional() }).optional(),
  remindersPanel: z.object({ width: z.number().min(260).max(900).optional(), height: z.number().min(160).max(1000).optional() }).optional(),
  /** The Projects panel (MAP-22): its size, folded project and plot ids, row filters, and whether it stays open. */
  projectsPanel: z.object({ width: z.number().min(260).max(900).optional(), height: z.number().min(160).max(1000).optional(), folded: z.array(id).max(500).optional(),
    filters: z.object({ needsMe: z.boolean().optional(), off: z.array(z.enum(COLUMN_KINDS)).max(COLUMN_KINDS.length).optional() }).optional(), pinned: z.boolean().optional() }).optional(),
  /** Update offers the person closed, by subject (`app` or `plugin:<id>`) and the tag dismissed; a newer tag is offered again. */
  dismissedUpdates: z.record(z.string().regex(/^(app|plugin:[A-Za-z0-9._-]{1,80})$/), z.string().max(80)).optional(),
});
export const stateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  nodes: z.array(node), resources: z.array(resource), links: z.array(link), todos: z.array(todo), view: viewSchema,
});
export type WorkspaceState = z.infer<typeof stateSchema>;
export const emptyState = (): WorkspaceState => stateSchema.parse({ version: 1, revision: 0, nodes: [], resources: [], links: [], todos: [], view: {} });

/** An agent omits it: the new item lands beside what it links to, or beside the agent (MAP-14). Everyone else gives one. */
const createdPosition = position.optional().describe('Omit it: the item lands next to what it links to, or next to you, and joins that project. Give one only when the user asked for a specific place; a position far from that context is ignored.');
/** Set by the host for an item or project it creates on an agent's request, whose envelope it sends itself: the nodes
 * to place it beside, first match wins (`creationAnchors`). An agent's own commands are placed by their links and actor. */
const near = z.array(id).max(ITEM_LINK_LIMIT + 1).optional().describe('Set by the host. Omit it.');
/** Set by the host for an item it keeps off the map while it works (`hiddenAt`); `label` names it in Show and Hide. */
const hidden = z.object({ label: z.string().trim().min(1).max(60) }).optional().describe('Set by the host. Omit it.');
const itemCommands = <L extends z.ZodType>(link: L) => [
  z.object({ type: z.literal('item.create'), id, resource, projectId: id.optional(), position: createdPosition, near, hidden, links: z.array(link).max(ITEM_LINK_LIMIT).optional() }),
  z.object({ type: z.literal('item.add'), id, resourceId: id, pluginId: id, title: title.optional(), data, connectionId: id.optional(), projectId: id.optional(), position: createdPosition, near, hidden, links: z.array(link).max(ITEM_LINK_LIMIT).optional() }),
] as const;
const otherCommands = [
  z.object({ type: z.literal('project.create'), id, title, summary: z.string().max(4000).default(''), workingDirectory: z.string().max(4096).optional(), color: projectColorSchema.optional(),
    position: position.optional().describe('Omit it: the project lands beside your own project, clear of the others. Give one only when the user asked for a specific place.'), near }),
  z.object({ type: z.literal('item.update'), id, data }),
  z.object({ type: z.literal('item.resolve'), id, data }),
  z.object({ type: z.literal('item.bind'), id, connectionId: id }),
  z.object({ type: z.literal('item.convert'), id, pluginId: id, connectionId: id.optional(), keepTitle: z.boolean().optional() }),
  z.object({ type: z.literal('attention.set'), id, source: id, reason: attentionReason.nullable(), note: attentionNoteInput.optional(), eventId: id.optional() }),
  z.object({ type: z.literal('attention.acknowledge'), id, versions: z.record(id, z.number().int().nonnegative()) }),
  z.object({ type: z.literal('attention.restore'), id, versions: z.record(id, z.number().int().nonnegative()) }),
  z.object({ type: z.literal('node.update'), id, indicators: indicatorsSchema.optional(), pips: cardPipsSchema.nullable().optional(), title: title.optional(), summary: z.string().max(4000).optional(), lastLine: z.string().min(1).max(200).nullable().optional(), recap: recapSchema.nullable().optional(), turnEndedAt: z.iso.datetime().optional(), workingDirectory: z.string().max(4096).optional(), color: projectColorSchema.optional(), activity: activity.optional(), attention: attention.optional(), attentionNote: attentionNoteInput.optional(),
    helpers: z.number().int().min(0).max(999).optional().describe('How many helpers (subagents, teammates) the item has busy right now; 0 clears it. Kept only while the item is working.'),
    waiting: z.boolean().optional().describe('The item itself only waits on its busy helpers. Kept only while it is working and has helpers.'),
    pose: z.enum([...POSES, 'none']).optional().describe('What the item itself is doing or held by; none clears it. Kept only while its activity and attention allow it.'),
    beside: z.number().int().min(0).max(999).optional().describe('Background shells and watchers running beside the prompt; 0 clears it.'),
    tasks: taskProgress.optional().describe('Progress of the current task list; a total of 0 clears it.'),
    bell: z.boolean().optional().describe('The session runs on another model than it started with.'), pen: z.boolean().optional().describe('The session works in a worktree of its own.'),
    moment: moment.optional().describe('A one-shot event with its time in epoch milliseconds.') }),
  z.object({ type: z.literal('node.move'), id, position }),
  z.object({ type: z.literal('node.resize'), id, size: z.enum(ITEM_SIZES).optional(), dimensions: mapDimensionsSchema.optional(), position: position.optional() })
    .refine(value => Boolean(value.size) !== Boolean(value.dimensions) && (!value.position || Boolean(value.dimensions)), 'Choose a preset or dimensions; position requires dimensions'),
  z.object({ type: z.literal('nodes.move'), positions: z.array(z.object({ id, position })).min(1).max(1000) }),
  z.object({ type: z.literal('layout.repair') }),
  z.object({ type: z.literal('node.attach'), id, projectId: id.nullable() }),
  z.object({ type: z.literal('node.archive'), id }),
  z.object({ type: z.literal('nodes.action'), ids: z.array(id).min(1).max(1000), action: z.enum(['archive', 'below', 'surface', 'complete', 'reopen', 'add-todo', 'remove-todo']) }),
  z.object({ type: z.literal('node.below'), id }),
  z.object({ type: z.literal('project.mute'), id, muted: z.boolean() }),
  z.object({ type: z.literal('node.surface'), id }),
  z.object({ type: z.literal('node.hide'), id }),
  z.object({ type: z.literal('node.show'), id, near: z.array(id).max(ITEM_LINK_LIMIT).optional() }),
  z.object({ type: z.literal('node.restore'), id }),
  z.object({ type: z.literal('node.complete'), id }),
  z.object({ type: z.literal('node.reopen'), id }),
  z.object({ type: z.literal('node.delete'), id }),
  z.object({ type: z.literal('node.rework'), id, note: z.string().trim().min(1).max(200).nullable(), by: id.optional() }),
  z.object({ type: z.literal('link.save'), link }),
  z.object({ type: z.literal('link.remove'), id }),
  z.object({ type: z.literal('node.todo.label'), id, title: z.string().min(1).max(48), sourceTitle: title }),
  z.object({ type: z.literal('node.title.generated'), id, title: z.string().trim().min(1).max(48), sourceTitle: title }),
  z.object({ type: z.literal('node.todo'), id, enabled: z.boolean() }),
  z.object({ type: z.literal('todos.reorder'), ids: z.array(id).min(1).max(1000), scope: z.enum(['items', 'projects']) }),
  z.object({ type: z.literal('todo.place'), id, nodeId: id, resourceId: id, position, projectId: id.optional() }),
  z.object({ type: z.literal('todo.send'), id, projectId: id, nodeId: id.optional(), resourceId: id.optional() }),
  z.object({ type: z.literal('nodes.send'), ids: z.array(id).min(1).max(1000), projectId: id.nullable() }),
  z.object({ type: z.literal('todo.save'), todo: todoInput }),
  z.object({ type: z.literal('todo.context'), id: id.describe('A to-do id from todos, or map:<nodeId> for a to-do on the map.'), context: todoContextInput,
    mode: z.enum(['replace', 'append']).describe('replace overwrites the context (empty clears it); append adds the text after a blank line and is refused past the limit.') }),
  z.object({ type: z.literal('todo.move'), id: id.describe('A to-do id from todos, or map:<nodeId> for a to-do on the map.'),
    horizon: z.enum(['next', 'later', 'done']).describe('next or later files it there (reopening it if done, taking it if it waits in the inbox); done ticks it off. Its project never changes.'),
    index: z.number().int().nonnegative().optional().describe('Position in that group, 0 first. Omitted: last when it changes group, else where it is.') }),
  z.object({ type: z.literal('todo.dismiss'), id, dismissed: z.boolean() }),
  z.object({ type: z.literal('todo.archive'), id }),
  z.object({ type: z.literal('todo.restore'), id }),
  z.object({ type: z.literal('todo.remove'), id }),
  z.object({ type: z.literal('view.set'), view: viewSchema }),
] as const;
/** The command union with another shape for a new item's links, for a transport that resolves its own shorthand before dispatch. */
export const commandSchemaWith = <L extends z.ZodType>(link: L) => z.discriminatedUnion('type', [...itemCommands(link), ...otherCommands]);
/** These are host commands, usable by the app and MCP without separate business rules. */
export const commandSchema = commandSchemaWith(itemLinkSchema);
export type WorkspaceCommand = z.infer<typeof commandSchema>;
type ItemCommand = Extract<WorkspaceCommand, { type: 'item.add' | 'item.create' }>;
const proposedResourceId = (command: ItemCommand) => command.type === 'item.add' ? command.resourceId : command.resource.id;
type Data = WorkspaceState['resources'][number]['data'];
/** The record an item command proposes; `stamp` is where the host writes authorship into its data. */
const proposedRecord = (registry: ResourcePluginRegistry, command: ItemCommand, project: WorkspaceState['nodes'][number] | undefined, stamp: (data: Data, pluginId: string) => Data = data => data): WorkspaceState['resources'][number] => command.type === 'item.add'
  ? { ...registry.createRecord(command.pluginId, command.resourceId, { title: command.title, data: stamp(fieldDefaults(registry.get(command.pluginId)?.fields, project, command.data), command.pluginId) }), ...(command.connectionId ? { connectionId: command.connectionId } : {}) }
  : { ...command.resource, data: stamp(command.resource.data, command.resource.pluginId) };
/** The node that already shows a provider identity where a new item would land (MAP-14): on the map, in that project or floating like it. */
function shownAlready(state: Pick<WorkspaceState, 'nodes' | 'resources'>, registry: ResourcePluginRegistry, key: string | undefined, projectId: string | undefined) {
  if (!key) return undefined;
  const records = new Set(state.resources.filter(saved => registry.identity(saved) === key).map(saved => saved.id));
  return state.nodes.find(node => node.resourceId && records.has(node.resourceId) && node.projectId === projectId && !isOffMap(node, state.nodes));
}
export interface ExistingItem { requestedId: string; nodeId: string }
/** The agent's item commands that created no node because their project already showed the item, read from the
 * resulting state: the id each asked for and the node that stands for it. A report never fails a committed command. */
export function itemsAlreadyOnMap(state: WorkspaceState, envelope: Pick<CommandEnvelope, 'actor' | 'commands'>, registry: ResourcePluginRegistry): ExistingItem[] {
  if (envelope.actor.kind !== 'agent') return [];
  const found = new Map<string, string>();
  return envelope.commands.flatMap(command => {
    if ((command.type !== 'item.add' && command.type !== 'item.create') || state.nodes.some(node => node.id === command.id)) return [];
    try {
      const context = creationContext(state.nodes, creationAnchors((command.links ?? []).map(entry => found.get(entry.otherId) ?? entry.otherId), envelope.actor.id), command.projectId);
      const shown = shownAlready(state, registry, registry.identity(proposedRecord(registry, command, state.nodes.find(node => node.id === context.projectId))), context.projectId);
      if (!shown) return [];
      found.set(command.id, shown.id);
      return [{ requestedId: command.id, nodeId: shown.id }];
    } catch { return []; }
  });
}
/** A later command of the batch reaches the node an agent's item resolved to under the id the agent asked for. */
function redirected(command: WorkspaceCommand, standIns: ReadonlyMap<string, string>): WorkspaceCommand {
  if (!standIns.size) return command;
  const to = (key: string) => standIns.get(key) ?? key;
  switch (command.type) {
    case 'item.add':
    case 'item.create': return command.links ? { ...command, links: command.links.map(entry => ({ ...entry, otherId: to(entry.otherId) })) } : command;
    case 'link.save': return { ...command, link: { ...command.link, sourceId: to(command.link.sourceId), targetId: to(command.link.targetId) } };
    case 'nodes.move': return { ...command, positions: command.positions.map(entry => ({ ...entry, id: to(entry.id) })) };
    case 'nodes.action':
    case 'nodes.send': return { ...command, ids: command.ids.map(to) };
    default: return 'id' in command && /^(node|item|attention)\./.test(command.type) ? { ...command, id: to(command.id) } as WorkspaceCommand : command;
  }
}
/** The id of a new item's link when none is given: the same item, partner, kind and direction always give the same id. */
export function itemLinkId(nodeId: string, link: Pick<ItemLink, 'otherId' | 'kind' | 'newItemIs'>): string {
  const derived = `link:${nodeId}:${link.otherId}:${link.kind}:${link.newItemIs}`;
  if (derived.length > 200) throw new Error('These ids are too long to derive a link id. Give the link an id.');
  return derived;
}
const itemLinkRecord = (nodeId: string, entry: ItemLink): WorkspaceState['links'][number] => ({ id: entry.id ?? itemLinkId(nodeId, entry),
  sourceId: entry.newItemIs === 'source' ? nodeId : entry.otherId, targetId: entry.newItemIs === 'source' ? entry.otherId : nodeId, kind: entry.kind, label: entry.label ?? '' });
/** What each item command with links did, read from the resulting state: whether the item reuses a resource the map
 * already had, and for each requested link the link that now holds it (`existing` when another link already held the
 * relationship). An item in `alreadyOnMap` is reported under the node that stands for it. */
export function itemLinkReport(state: WorkspaceState, commands: readonly WorkspaceCommand[], alreadyOnMap: readonly ExistingItem[] = []) {
  const existing = new Map(alreadyOnMap.map(item => [item.requestedId, item.nodeId]));
  return commands.flatMap(command => {
    if ((command.type !== 'item.add' && command.type !== 'item.create') || !command.links?.length) return [];
    const created = state.nodes.find(node => node.id === (existing.get(command.id) ?? command.id));
    if (!created) return [];
    return [{ nodeId: created.id, resourceId: created.resourceId ?? proposedResourceId(command), reusedResource: existing.has(command.id) || state.nodes.filter(node => node.resourceId === created.resourceId).length > 1,
      links: command.links.map(entry => {
        const wanted = itemLinkRecord(created.id, { ...entry, otherId: existing.get(entry.otherId) ?? entry.otherId }), held = state.links.find(link => link.id === wanted.id) ?? existingRelationship(state.nodes, state.links, wanted);
        return { id: held?.id ?? wanted.id, existing: held?.id !== wanted.id };
      }) }];
  });
}
/** Commands only a person may issue. Muting hides a project's questions from the user, so an agent must not decide it. */
const HUMAN_ONLY_COMMANDS: ReadonlySet<string> = new Set<WorkspaceCommand['type']>(['project.mute', 'node.hide', 'node.show']);
/** Why an agent may not apply this command; every agent transport and the reducer share it. */
export function agentCommandRefusal(command: WorkspaceCommand): string | undefined {
  return HUMAN_ONLY_COMMANDS.has(command.type) || (command.type === 'item.add' || command.type === 'item.create') && command.hidden ? humanOnlyMessage : undefined;
}
export const MAXIMUM_COMMANDS_PER_ENVELOPE = 100;
export const envelopeSchema = z.object({
  commandId: id,
  expectedRevision: z.number().int().nonnegative(),
  actor: z.object({ kind: z.enum(['user', 'agent', 'provider', 'system']), id }),
  commands: z.array(commandSchema).min(1).max(MAXIMUM_COMMANDS_PER_ENVELOPE),
});
export type CommandEnvelope = z.infer<typeof envelopeSchema>;
/** `alreadyOnMap` is present when an agent's item command resolved to a node its project already showed. */
export interface CommandResult { state: WorkspaceState; replayed: boolean; alreadyOnMap?: ExistingItem[] }
export type ViewState = z.infer<typeof viewSchema>;
export type ProjectsPanelState = NonNullable<ViewState['projectsPanel']>;
export class RevisionConflict extends Error {
  readonly code = 'REVISION_CONFLICT';
  readonly currentRevision: number;
  constructor(expected: number, actual: number) {
    super(`Revision conflict: expected ${expected}, current ${actual}. Read the workspace again.`);
    this.currentRevision = actual;
  }
}
export class CommandIdConflict extends Error {
  readonly code = 'COMMAND_ID_CONFLICT';
  constructor() { super('Command ID was already used with a different payload'); }
}
/** Stable equality across JSON key order; command order remains significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Reads the revision out of a receipt's saved input, which is the canonical envelope. */
export function receiptRevision(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  try { const revision = (JSON.parse(input) as { expectedRevision?: unknown }).expectedRevision; return typeof revision === 'number' ? revision : undefined; }
  catch { return undefined; }
}
export interface WorkspaceStore {
  readMapLayout?(): MapLayout;
  read(): Promise<WorkspaceState>;
  update(change: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState>;
  commit?(envelope: CommandEnvelope, change: (state: WorkspaceState) => WorkspaceState): Promise<CommandResult>;
  /** The revision a committed command was applied against, so the same command can be replayed after the workspace moved on. */
  receiptRevision?(commandId: string): number | undefined;
}
export class MemoryStore implements WorkspaceStore {
  private state: WorkspaceState;
  /** A receipt is the command, not the workspace it produced: a replay reads the current workspace. */
  private receipts = new Map<string, { input: string }>();
  private views = new Map<string, ViewState>();
  constructor(initial = emptyState()) { this.state = stateSchema.parse(initial); }
  async read() { return structuredClone(this.state); }
  async update(change: (state: WorkspaceState) => WorkspaceState) {
    this.state = stateSchema.parse(change(structuredClone(this.state)));
    return this.read();
  }
  async commit(envelope: CommandEnvelope, change: (state: WorkspaceState) => WorkspaceState): Promise<CommandResult> {
    const input = canonical(envelope);
    const saved = this.receipts.get(envelope.commandId);
    if (saved) {
      if (saved.input !== input) throw new CommandIdConflict();
      return { state: structuredClone(this.state), replayed: true };
    }
    const next = stateSchema.parse(change(structuredClone(this.state)));
    this.state = next;
    this.receipts.set(envelope.commandId, { input });
    return { state: structuredClone(next), replayed: false };
  }
  receiptRevision(commandId: string) { return receiptRevision(this.receipts.get(commandId)?.input); }
  async readView(clientId: string) { return structuredClone(this.views.get(clientId) ?? this.state.view); }
  async writeView(clientId: string, input: unknown) { const view = viewSchema.parse(input); this.views.set(clientId, view); return structuredClone(view); }
}

export class WorkspaceControl {
  readonly store: WorkspaceStore;
  readonly registry: ResourcePluginRegistry;
  constructor(store: WorkspaceStore = new MemoryStore(), registry = createResourcePluginRegistry()) {
    this.store = store;
    this.registry = registry;
  }
  read() { return this.store.read(); }
  async apply(input: unknown, expectedRevision: number) {
    const command = commandSchema.parse(input);
    return this.store.update(state => reduceCommands(state, [command], expectedRevision, this.registry, this.store.readMapLayout?.()));
  }
  async dispatch(input: unknown): Promise<CommandResult> {
    const envelope = envelopeSchema.parse(input);
    if (!this.store.commit) throw new Error('This legacy store does not support durable command envelopes');
    const result = await this.store.commit(envelope, state => reduceCommands(state, envelope.commands, envelope.expectedRevision, this.registry, this.store.readMapLayout?.(), envelope.actor));
    const alreadyOnMap = itemsAlreadyOnMap(result.state, envelope, this.registry);
    return alreadyOnMap.length ? { ...result, alreadyOnMap } : result;
  }
}

/** Commands that only place items: they settle overlaps against the state they land on, and the user's placement is their latest intent. */
const PLACEMENT = new Set<WorkspaceCommand['type']>(['node.move', 'nodes.move', 'node.attach', 'node.resize']);

/** Reduce a whole command batch against an isolated draft; failures never mutate input. The user's own batch of placements lands on the current revision instead of failing on a stale one.
 * A batch that only moves session scenes keeps the revision (SCENE_FIELDS). */
export function reduceCommands(before: WorkspaceState, commands: readonly WorkspaceCommand[], expectedRevision: number, registry: ResourcePluginRegistry, layout: MapLayout = { sizes: {} }, actor?: CommandEnvelope['actor']): WorkspaceState {
  const placement = actor?.kind === 'user' && commands.every(command => PLACEMENT.has(command.type));
  if (before.revision !== expectedRevision && !placement) throw new RevisionConflict(expectedRevision, before.revision);
  const state = structuredClone(before), standIns = new Map<string, string>();
  for (const command of commands) applyToDraft(state, redirected(command, standIns), registry, layout, actor, standIns);
  // A count of busy helpers describes working: whatever ends that drops it in the same revision.
  for (const node of state.nodes) {
    if (node.helpers !== undefined && node.activity !== 'working') delete node.helpers;
    if (node.waiting && !node.helpers) delete node.waiting;
    const working = node.activity === 'working';
    if (node.pose && !(node.pose === 'gate' || node.pose === 'asking' ? node.attention === 'input' : node.pose === 'fallen' ? node.attention === 'error' : node.pose === 'ended' ? !working : working)) delete node.pose;
    if (node.pose === 'ended') { delete node.beside; delete node.tasks; delete node.bell; delete node.pen; }
  }
  if (!commands.every(isSceneOnly)) state.revision += 1;
  return stateSchema.parse(state);
}

/** What a session's map animal shows: its pose, helpers, background work, tasks, flags and one-shot moments. They
 * change many times a minute and nothing anyone acts on depends on them, so saving them alone keeps the revision. */
export const SCENE_FIELDS: ReadonlySet<string> = new Set(['pose', 'moment', 'helpers', 'waiting', 'beside', 'tasks', 'bell', 'pen']);
const isSceneOnly = (command: WorkspaceCommand) => command.type === 'node.update' && Object.keys(command).every(key => key === 'type' || key === 'id' || SCENE_FIELDS.has(key));

/** Only the host writes authorship: the agent that changed the text, or nothing once a person does. */
function stampWriter(state: WorkspaceState, registry: ResourcePluginRegistry, pluginId: string, data: Data, previous: Data | undefined, actor?: CommandEnvelope['actor']): Data {
  const plugin = registry.get(pluginId), field = plugin?.authorship?.field;
  if (!field) return data;
  const textField = plugin.generatedTitle?.field, next = { ...data };
  delete next[field];
  const changed = !previous || (textField ? previous[textField] !== data[textField] : canonical({ ...previous, [field]: null }) !== canonical({ ...data, [field]: null }));
  if (!changed) { if (previous[field] !== undefined) next[field] = previous[field]; return next; }
  if (actor?.kind !== 'agent') return next;
  const agent = state.nodes.find(node => node.id === actor.id), provider = state.resources.find(resource => resource.id === agent?.resourceId)?.data.provider;
  next[field] = { kind: 'agent', name: typeof provider === 'string' && provider ? provider.replace(/^./, char => char.toUpperCase()) : 'Agent', at: new Date().toISOString() };
  return next;
}

function applyToDraft(state: WorkspaceState, command: WorkspaceCommand, registry: ResourcePluginRegistry, layout: MapLayout, actor?: CommandEnvelope['actor'], standIns = new Map<string, string>()): void {
      const { sizes, snap, collisions } = layout;
      const refusal = actor?.kind === 'agent' ? agentCommandRefusal(command) : undefined;
      if (refusal) throw new Error(refusal);
      const find = (key: string) => {
        const found = state.nodes.find(n => n.id === key);
        if (!found) throw new Error(`Node not found: ${key}`);
        return found;
      };
      const project = (key: string) => {
        const found = find(key);
        if (found.resourceId || found.projectId) throw new Error('Target is not a project');
        return found;
      };
      const sendBelowDraft = (ids: readonly string[]) => {
        ids.forEach(find);
        state.nodes = sendBelow(state.nodes, ids, new Date().toISOString(), node => itemFootprint(node, state.resources, registry, sizes));
      };
      const createId = (key: string) => { if (state.nodes.some(n => n.id === key)) throw new Error(`Node already exists: ${key}`); };
      const footprint = (target: GraphNode) => itemFootprint(target, state.resources, registry, sizes);
      /** A spot chosen in context is already clear by the shared layout rule, where a populated project's anchor is no obstacle. */
      const place = (created: WorkspaceState['nodes'][number], position: { x: number; y: number } | undefined, requested: { x: number; y: number } | undefined) => {
        if (!position) throw new Error(POSITION_REQUIRED);
        created.position = snapPosition(position, snap);
        const others = state.nodes.filter(node => isDrawn(node, state.nodes)).map(footprint);
        state.nodes.push(created);
        created.position = freePosition(footprint(created), position === requested ? others : layoutFootprints(state.nodes, state.resources, registry, sizes).filter(box => box.id !== created.id), ITEM_GAP, snap);
      };
      /** The nodes a creation is placed beside: an agent's links and its own node, or what the host named for it. */
      const anchorsOf = (near: readonly string[] | undefined, linked: readonly string[] = []) => actor?.kind === 'agent' ? creationAnchors(linked, actor.id) : near;
      /** Moves `leads` into a project as one block that keeps their layout around the first of them.
       * A to-do (or an item kept in the to-do list) brings its attached items: those from its own
       * project keep their place beside it, the rest stack below. Projects, archived items and items
       * in Undermap never travel, and items already in the project stay where they are. */
      const sendBlock = (leads: readonly WorkspaceState['nodes'][number][], target: WorkspaceState['nodes'][number], created: ReadonlySet<string> = new Set()) => {
        const members = new Map(leads.map(lead => [lead.id, lead])), kept = new Set(members.keys());
        const todoResources = new Set(state.resources.filter(resource => resource.pluginId === 'workspace.todo').map(resource => resource.id));
        for (const lead of leads) {
          if (!todoResources.has(lead.resourceId!) && !lead.inTodoList) continue;
          const attached = state.links.filter(link => link.sourceId === lead.id || link.targetId === lead.id).map(link => find(link.sourceId === lead.id ? link.targetId : link.sourceId))
            .filter(member => member.resourceId && !isOffMap(member, state.nodes) && !members.has(member.id));
          for (const member of attached) {
            members.set(member.id, member);
            if (!created.has(lead.id) && !created.has(member.id) && member.projectId === lead.projectId) kept.add(member.id);
          }
        }
        const moving = [...members.values()].filter(member => created.has(member.id) || member.projectId !== target.id);
        if (!moving.length) return;
        const positions = arrivalPlacement(state.nodes, moving[0].id, moving.map(member => member.id), target.id, member => itemFootprint(member, state.resources, registry, sizes), { kept });
        for (const member of moving) member.projectId = target.id;
        state.nodes = moveItems(state.nodes, state.resources, registry, [...positions].map(([id, position]) => ({ id, position })), sizes);
      };
      /** Items sent to no project leave as one block that keeps its layout, beside the lead's project but off its ground. */
      const leaveProject = (leads: readonly WorkspaceState['nodes'][number][]) => {
        for (const lead of leads) {
          if (!lead.resourceId) throw new Error('Only items can be moved to a project');
          if (isArchived(lead, state.nodes)) throw new Error('Restore this item from the archive before moving it');
          if (isOffMap(lead, state.nodes)) throw new Error('This item is in Undermap. Bring it back to move it.');
        }
        const moving = leads.filter(lead => lead.projectId);
        if (!moving.length) return;
        const positions = arrivalPlacement(state.nodes, moving[0].id, moving.map(member => member.id), moving[0].projectId!, member => itemFootprint(member, state.resources, registry, sizes), { kept: new Set(moving.map(member => member.id)), outside: true });
        for (const member of moving) delete member.projectId;
        state.nodes = moveItems(state.nodes, state.resources, registry, [...positions].map(([id, position]) => ({ id, position })), sizes);
      };
      const todoEntry = (key: string) => {
        const entry = todoEntries(state).find(entry => entry.id === key);
        const placed = key.startsWith('map:') ? state.nodes.find(node => `map:${node.id}` === key) : undefined;
        if (!entry && placed && isOffMap(placed, state.nodes) && !isArchived(placed, state.nodes)) throw new Error('This item is in Undermap. Bring it back to show it here.');
        if (!entry) throw new Error('This to-do is no longer available');
        return entry;
      };
      /** A person's edit, move, tick or context ages a to-do from now (TODO-12); provider and system writes do not. */
      const human = actor?.kind !== 'provider' && actor?.kind !== 'system';
      const touchNode = (target: WorkspaceState['nodes'][number]) => { if (human && mapTodoNode(state, `map:${target.id}`)) target.todoTouchedAt = new Date().toISOString(); };
      const setTodoOrder = (entry: TodoEntry, order: number) => { if (entry.source === 'map') find(entry.nodeId!).todoOrder = order; else state.todos.find(todo => todo.id === entry.id)!.todoOrder = order; };
      /** Puts a to-do at `index` of its group and numbers the group's open rows. */
      const fileTodo = (entry: TodoEntry, group: 'inbox' | 'next' | 'later', index: number) => {
        const rows = todoList(state)[group].filter(row => row.id !== entry.id); rows.splice(Math.min(index, rows.length), 0, entry); rows.forEach(setTodoOrder);
      };
      const lastOrder = (group: 'inbox' | 'next' | 'later') => Math.max(-1, ...todoList(state)[group].flatMap(row => row.todoOrder === undefined ? [] : [row.todoOrder])) + 1;
      /** The context a write leaves: unchanged text keeps its writer, changed text is stamped with this actor, and an empty text is none. */
      const writtenContext = (previous: TodoContext | undefined, text: string): TodoContext | undefined => {
        if (!text) return undefined;
        if (previous?.text === text) return previous;
        const writer = actor?.kind === 'agent' ? state.nodes.find(node => node.id === actor.id) : undefined;
        return { text, ...(actor ? { by: { kind: actor.kind, id: actor.id, ...(writer ? { title: writer.title } : {}) } } : {}), at: new Date().toISOString() };
      };
      /** A list-only to-do becomes one map to-do; an imported one also gains the item it was imported for. Returns the new node ids. */
      const placeChecklist = (entry: TodoEntry, nodeId: string, resourceId: string, position: { x: number; y: number }, projectId?: string) => {
        const record = state.todos.find(todo => todo.id === entry.id)!, ids = [nodeId];
        applyToDraft(state, { type: 'item.add', id: nodeId, resourceId, pluginId: 'workspace.todo', title: entry.title, data: {}, position, projectId }, registry, layout);
        const created = find(nodeId);
        if (entry.todoOrder !== undefined && entry.horizon !== 'inbox') created.todoOrder = entry.todoOrder;
        if (record.horizon === 'next' || record.horizon === 'later') created.todoHorizon = record.horizon;
        if (record.touchedAt) created.todoTouchedAt = record.touchedAt;
        Object.assign(created, mapTodoContextFields(checklistContext(record)));
        if (entry.completed) applyToDraft(state, { type: 'node.complete', id: created.id }, registry, layout);
        for (const [index, targetId] of entry.nodeIds.entries()) applyToDraft(state, { type: 'link.save', link: { id: `${nodeId}:todo:${index}`, sourceId: created.id, targetId, kind: 'reference', label: '' } }, registry, layout);
        if (record.triage) {
          const item = record.triage.item, itemId = `${nodeId}:item`;
          applyToDraft(state, { type: 'item.add', id: itemId, resourceId: `${resourceId}:item`, pluginId: item.pluginId, title: item.title, data: item.data, ...(item.connectionId ? { connectionId: item.connectionId } : {}), projectId,
            position: { x: created.position.x, y: created.position.y + 2 * ITEM_GAP } }, registry, layout);
          applyToDraft(state, { type: 'link.save', link: { id: `${nodeId}:todo:item`, sourceId: created.id, targetId: itemId, kind: 'reference', label: '' } }, registry, layout);
          created.todoTicketId = itemId; ids.push(itemId);
        }
        // Conversion replaces the checklist record, not the task or its attachments.
        state.todos = state.todos.filter(todo => todo.id !== entry.id);
        return ids;
      };
      switch (command.type) {
        case 'project.create': {
          createId(command.id);
          const created = node.parse({ id: command.id, title: command.title, summary: command.summary, ...(command.workingDirectory !== undefined ? { workingDirectory: command.workingDirectory } : {}), ...(command.color ? { color: command.color.toLowerCase() } : {}), position: command.position ?? { x: 0, y: 0 } });
          const anchors = anchorsOf(command.near);
          place(created, anchors ? projectPlacement(state.nodes, footprint, anchors, footprint(created), command.position) : command.position, command.position);
          break;
        }
        case 'item.add':
        case 'item.create': {
          createId(command.id);
          if (command.projectId) project(command.projectId);
          const anchors = anchorsOf(command.near, command.links?.map(entry => entry.otherId));
          const context = anchors ? creationContext(state.nodes, anchors, command.projectId) : { projectId: command.projectId };
          let record = proposedRecord(registry, command, context.projectId ? project(context.projectId) : undefined, (data, pluginId) => stampWriter(state, registry, pluginId, data, undefined, actor));
          const resolved = registry.resolve(record);
          if (!resolved.available) throw new Error(resolved.reason);
          const key = registry.identity(record), sameId = state.resources.find(r => r.id === record.id);
          if (sameId && (!key || registry.identity(sameId) !== key)) throw new Error('Resource already exists');
          const existing = key ? state.resources.find(r => registry.identity(r) === key) : undefined;
          if (existing) record = existing;
          else state.resources.push(record);
          const shown = actor?.kind === 'agent' && existing ? shownAlready(state, registry, key, context.projectId) : undefined;
          if (shown) standIns.set(command.id, shown.id);
          const observed = !shown && existing && (state.nodes.find(n => n.resourceId === existing.id && !n.archivedAt) ?? state.nodes.find(n => n.resourceId === existing.id));
          const created = node.parse({ id: command.id, title: record.title, resourceId: record.id, projectId: context.projectId, position: command.position ?? { x: 0, y: 0 }, acceptsContext: resolved.plugin.acceptsContext === true,
            ...(command.hidden && !shown ? { hiddenAt: new Date().toISOString(), hideLabel: command.hidden.label } : {}),
            ...(observed ? { activity: observed.activity, attention: observed.attention, attentionNote: observed.attentionNote, attentionSources: observed.attentionSources, attentionNotes: observed.attentionNotes, attentionVersion: observed.attentionVersion,
              attentionSeenVersion: observed.attentionSeenVersion, attentionAt: observed.attentionAt, attentionEvents: observed.attentionEvents, indicators: observed.indicators, pips: observed.pips, summary: observed.summary, activityAt: observed.activityAt } : {}) });
          if (!shown) place(created, anchors ? itemPlacement(state.nodes, footprint, context, footprint(created), command.position) : command.position, command.position);
          for (const entry of command.links ?? []) {
            const wanted = itemLinkRecord(shown?.id ?? command.id, entry), taken = state.links.find(saved => saved.id === wanted.id);
            if (taken && canonical(taken) === canonical(wanted)) continue;
            if (taken) throw new Error(`Link already exists: ${wanted.id}`);
            if (!entry.id && existingRelationship(state.nodes, state.links, wanted)) continue;
            state.links = saveLink(state.nodes, state.links, wanted, resourceCardinality(state.resources, registry));
          }
          break;
        }
        case 'item.bind': {
          const target = find(command.id), record = state.resources.find(r => r.id === target.resourceId);
          if (!record) throw new Error('Node is not a resource item');
          const resolved = registry.resolve(record);
          if (!resolved.available || !resolved.plugin.connectionProvider) throw new Error('This item has no provider account binding');
          const updated = { ...record, connectionId: command.connectionId }, key = registry.identity(updated);
          const existing = key && state.resources.find(r => r.id !== record.id && registry.identity(r) === key);
          if (existing) {
            // Reconcile the provider identity, preserving every map alias and all
            // node-based links/tasks/layout/lifecycle. Existing cached launches
            // are immutable historical context, not rewritten here.
            for (const node of state.nodes) if (node.resourceId === record.id) node.resourceId = existing.id;
            state.resources = state.resources.filter(r => r.id !== record.id);
            for (const link of state.links) saveLink(state.nodes, state.links, link, resourceCardinality(state.resources, registry));
          } else state.resources = state.resources.map(r => r.id === record.id ? updated : r);
          break;
        }
        case 'item.convert': {
          // A generic link becomes the type that claims its URL. The resource and node ids stay, so
          // links, to-do attachments, layout, lifecycle and agents' references remain valid.
          const target = find(command.id), record = state.resources.find(r => r.id === target.resourceId);
          if (!record) throw new Error('Node is not a resource item');
          const candidate = registry.conversions(record).find(match => match.pluginId === command.pluginId), plugin = candidate && registry.get(candidate.pluginId);
          if (!candidate || !plugin) throw new Error('This item cannot be converted to that type');
          if (command.connectionId && !plugin.connectionProvider) throw new Error('This item type has no provider account binding');
          const converted = { id: record.id, pluginId: candidate.pluginId, schemaVersion: candidate.schemaVersion, title: record.title, ...(command.connectionId ? { connectionId: command.connectionId } : {}), data: candidate.data };
          const key = registry.identity(converted);
          if (key && state.resources.some(r => r.id !== record.id && registry.identity(r) === key)) throw new Error('Another item on the map already represents this provider item');
          state.resources = state.resources.map(r => r.id === record.id ? converted : r);
          for (const alias of state.nodes.filter(node => node.resourceId === record.id)) {
            // The old type's observations do not describe the new one; its first read supplies them.
            alias.summary = ''; alias.activity = 'unknown'; delete alias.indicators; delete alias.pips;
            alias.acceptsContext = plugin.acceptsContext === true;
            if (alias.mapSize && !plugin.mapSizes?.sizes[alias.mapSize]) delete alias.mapSize;
            if (!plugin.todoSupport) { delete alias.inTodoList; delete alias.todoLabel; }
            // A kept title is recorded like a generated one: provider refreshes leave it alone.
            if (command.keepTitle) alias.generatedTitle = alias.title; else delete alias.generatedTitle;
          }
          for (const link of state.links) saveLink(state.nodes, state.links, link, resourceCardinality(state.resources, registry));
          break;
        }
        case 'item.update':
        case 'item.resolve': {
          const target = find(command.id);
          const record = state.resources.find(r => r.id === target.resourceId);
          if (!record) throw new Error('Node is not a resource item');
          const updated = { ...record, data: command.type === 'item.update' ? stampWriter(state, registry, record.pluginId, command.data, record.data, actor) : command.data };
          const resolved = registry.resolve(updated);
          if (!resolved.available) throw new Error(resolved.reason);
          const titleField = resolved.plugin.generatedTitle?.field;
          if (command.type === 'item.update' && titleField && record.data[titleField] !== updated.data[titleField]) {
            updated.title = localItemTitle(resolved.plugin, updated.data)!;
            for (const alias of state.nodes) if (alias.resourceId === record.id) alias.title = updated.title;
          }
          const key = registry.identity(updated);
          if (command.type === 'item.resolve' && (!record.connectionId || !resolved.plugin.connectionProvider || !key)) throw new Error('Provider resolution requires a bound identity');
          const existing = key && state.resources.find(r => r.id !== record.id && registry.identity(r) === key);
          if (existing) {
            if (command.type === 'item.update') throw new Error('Another resource already represents this provider item');
            for (const node of state.nodes) if (node.resourceId === record.id) node.resourceId = existing.id;
            state.resources = state.resources.filter(r => r.id !== record.id).map(r => r.id === existing.id ? { ...r, data: command.data } : r);
            for (const link of state.links) saveLink(state.nodes, state.links, link, resourceCardinality(state.resources, registry));
          } else state.resources = state.resources.map(r => r.id === record.id ? updated : r);
          break;
        }
        case 'node.update': {
          const target = find(command.id);
          if (command.workingDirectory !== undefined && target.resourceId) throw new Error('Working directory defaults belong to projects; existing session directories are immutable');
          if (command.lastLine === null) delete target.lastLine; else if (command.lastLine !== undefined) target.lastLine = command.lastLine;
          if (command.recap === null) delete target.recap; else if (command.recap !== undefined) target.recap = command.recap;
          if (command.turnEndedAt !== undefined) target.turnEndedAt = command.turnEndedAt;
          if (command.pips === null) delete target.pips; else if (command.pips !== undefined) target.pips = command.pips;
          if (command.color !== undefined && target.resourceId) throw new Error('Neighborhood colors belong to projects');
          if (command.color !== undefined) target.color = command.color.toLowerCase();
          if (command.attention && command.attention !== 'none' && command.attention !== target.attention) { target.attentionVersion = (target.attentionVersion ?? 0) + 1; target.attentionAt = new Date().toISOString(); }
          if (command.attention !== undefined || command.attentionNote !== undefined) {
            const reason = command.attention ?? target.attention;
            const text = reason === 'none' ? undefined : command.attentionNote !== undefined ? attentionNote(command.attentionNote) : reason === target.attention ? target.attentionNote : undefined;
            if (text) target.attentionNote = text; else delete target.attentionNote;
          }
          if (command.activity === 'working' && target.activity !== 'working') {
            for (const alias of state.nodes.filter(node => node.id === target.id || target.resourceId && node.resourceId === target.resourceId)) {
              if (alias.attentionSources?.completion === 'finished' && alias.attentionSeenVersion === (alias.attentionVersion ?? 0)) {
                delete alias.attentionSources.completion; delete alias.attentionNotes?.completion;
                if (alias.attentionNotes && !Object.keys(alias.attentionNotes).length) delete alias.attentionNotes;
              }
            }
          }
          if ((['activity', 'attention', 'indicators'] as const).some(key => command[key] !== undefined && JSON.stringify(command[key]) !== JSON.stringify(target[key]))) target.activityAt = new Date().toISOString();
          if (command.title !== undefined && command.title !== target.title) touchNode(target);
          for (const key of ['title', 'summary', 'workingDirectory', 'activity', 'attention', 'indicators'] as const) {
            if (command[key] !== undefined) Object.assign(target, { [key]: command[key] });
          }
          if (command.helpers !== undefined) { if (command.helpers) target.helpers = command.helpers; else delete target.helpers; }
          if (command.waiting !== undefined) { if (command.waiting) target.waiting = true; else delete target.waiting; }
          if (command.pose !== undefined) { if (command.pose === 'none') delete target.pose; else target.pose = command.pose; }
          if (command.beside !== undefined) { if (command.beside) target.beside = command.beside; else delete target.beside; }
          if (command.tasks !== undefined) { if (command.tasks.total) target.tasks = command.tasks; else delete target.tasks; }
          if (command.bell !== undefined) { if (command.bell) target.bell = true; else delete target.bell; }
          if (command.pen !== undefined) { if (command.pen) target.pen = true; else delete target.pen; }
          if (command.moment !== undefined) target.moment = command.moment;
          if (command.title && target.resourceId) state.resources.find(r => r.id === target.resourceId)!.title = command.title;
          if (target.rework) target.activity = 'working';
          break;
        }
        case 'node.rework': {
          const target = find(command.id);
          if (!target.resourceId) throw new Error('A rework note belongs to an item, not a project');
          const since = new Date().toISOString(), finished = target.rework;
          for (const node of state.nodes.filter(node => node.resourceId === target.resourceId)) {
            if (command.note === null) { if (node.rework) { delete node.rework; node.activity = 'idle'; node.activityAt = since; } continue; }
            if (node.activity !== 'working') node.activityAt = since;
            node.rework = { note: command.note, since: node.rework?.since ?? since, ...(command.by ? { by: command.by } : {}) }; node.activity = 'working';
          }
          // An agent that finishes its rework hands the item back to the person: it is their turn. A clear by hand raises nothing.
          if (command.note === null && finished && command.by) applyToDraft(state, { type: 'attention.set', id: target.id, source: 'rework', reason: 'review', note: `Reworked: ${finished.note}`, eventId: `rework:${finished.since}` }, registry, layout);
          if (command.note !== null && target.attentionSources?.rework) applyToDraft(state, { type: 'attention.set', id: target.id, source: 'rework', reason: null }, registry, layout);
          break;
        }
        case 'attention.set': {
          const target = find(command.id);
          for (const node of state.nodes.filter(node => node.id === target.id || (target.resourceId && node.resourceId === target.resourceId))) {
            const notes = { ...node.attentionNotes }, text = command.reason === null ? undefined : attentionNote(command.note);
            if (text) Object.defineProperty(notes, command.source, { value: text, enumerable: true, configurable: true, writable: true }); else delete notes[command.source];
            const replayed = command.eventId && node.attentionEvents?.[command.source] === command.eventId;
            // A replayed event may still restate its reason in new words; it never re-alerts.
            if (!replayed || (command.reason && node.attentionSources?.[command.source] === command.reason)) { if (Object.keys(notes).length) node.attentionNotes = notes; else delete node.attentionNotes; }
            if (replayed) continue;
            const sources = { ...node.attentionSources };
            if (command.reason && (sources[command.source] !== command.reason || command.eventId)) { node.attentionVersion = (node.attentionVersion ?? 0) + 1; node.activityAt = node.attentionAt = new Date().toISOString(); }
            if (command.eventId) node.attentionEvents = { ...node.attentionEvents, [command.source]: command.eventId };
            if (command.reason === null) delete sources[command.source];
            else Object.defineProperty(sources, command.source, { value: command.reason, enumerable: true, configurable: true, writable: true });
            if (Object.keys(sources).length) node.attentionSources = sources; else delete node.attentionSources;
          }
          break;
        }
        case 'attention.acknowledge': {
          const target = find(command.id);
          for (const node of state.nodes.filter(node => node.id === target.id || target.resourceId && node.resourceId === target.resourceId)) {
            if (Object.hasOwn(command.versions, node.id) && command.versions[node.id] === (node.attentionVersion ?? 0)) node.attentionSeenVersion = command.versions[node.id];
          }
          break;
        }
        case 'attention.restore': {
          const target = find(command.id);
          for (const node of state.nodes.filter(node => node.id === target.id || target.resourceId && node.resourceId === target.resourceId)) {
            if (Object.hasOwn(command.versions, node.id) && command.versions[node.id] === (node.attentionVersion ?? 0)) delete node.attentionSeenVersion;
          }
          break;
        }
        case 'node.resize': {
          if (command.dimensions) {
            state.nodes = resizeItem(state.nodes, state.resources, registry, { id: command.id, dimensions: command.dimensions, position: command.position }, sizes, snap);
            break;
          }
          const target = find(command.id);
          if (!target.resourceId) throw new Error('Only resource items have map sizes');
          const record = state.resources.find(resource => resource.id === target.resourceId)!;
          if (!resolveMapSize(target, record, registry.get(record.pluginId), sizes).profile.sizes[command.size!]) throw new Error(`This item does not support ${command.size}`);
          if (target.mapSize === command.size && !target.mapDimensions) break;
          const before = itemFootprint(target, state.resources, registry, sizes);
          target.mapSize = command.size;
          delete target.mapDimensions;
          const after = itemFootprint(target, state.resources, registry, sizes);
          if (!isArchived(target, state.nodes) && (after.width > before.width || after.height > before.height)) {
            state.nodes = moveItems(state.nodes, state.resources, registry, [{ id: target.id, position: target.position }], sizes, snap);
          }
          break;
        }
        case 'node.move': {
          state.nodes = moveItems(state.nodes, state.resources, registry, [{ id: command.id, position: snapPosition(command.position, snap) }], sizes, snap, collisions);
          break;
        }
        case 'node.attach': {
          const target = find(command.id);
          if (!target.resourceId) throw new Error('Only an item can be attached to a project');
          if (command.projectId) project(command.projectId);
          target.projectId = command.projectId ?? undefined;
          break;
        }
        case 'nodes.move': {
          state.nodes = moveItems(state.nodes, state.resources, registry, command.positions, sizes, snap, collisions);
          break;
        }
        case 'layout.repair': {
          state.nodes = repairLayout(state.nodes, state.resources, registry, sizes, snap);
          break;
        }
        case 'nodes.action': {
          if (new Set(command.ids).size !== command.ids.length) throw new Error('Duplicate selection identities');
          if (command.action === 'below') { sendBelowDraft(command.ids); break; }
          for (const id of command.ids) applyToDraft(state, command.action === 'add-todo' || command.action === 'remove-todo'
            ? { type: 'node.todo', id, enabled: command.action === 'add-todo' }
            : { type: `node.${command.action}`, id }, registry, layout);
          break;
        }
        case 'node.archive': state.nodes = archiveNode(state.nodes, command.id, new Date().toISOString()); break;
        case 'node.below': sendBelowDraft([command.id]); break;
        case 'project.mute': {
          // Display only: members, sessions, polling and unread attention are untouched.
          const target = project(command.id);
          if (command.muted) target.mutedAt ??= new Date().toISOString(); else delete target.mutedAt;
          break;
        }
        case 'node.hide': {
          const target = find(command.id);
          if (!target.resourceId) throw new Error('Only items can be hidden');
          target.hiddenAt ??= new Date().toISOString();
          break;
        }
        case 'node.show': {
          // A hidden item that was archived meanwhile comes back from the archive too.
          if (!find(command.id).hiddenAt) break;
          if (find(command.id).archivedAt) state.nodes = restoreNode(state.nodes, command.id);
          const target = find(command.id);
          delete target.hiddenAt;
          if (isOffMap(target, state.nodes)) break;
          // Placed in context like a new item (MAP-14), clear of what took its place while it was hidden.
          const others = state.nodes.filter(node => node !== target), context = creationContext(others, command.near ?? [], target.projectId);
          const position = context.anchor || context.projectId ? itemPlacement(others, footprint, context, footprint(target)) : undefined;
          target.position = freePosition({ ...footprint(target), ...snapPosition(position ?? target.position, snap) }, layoutFootprints(others, state.resources, registry, sizes), ITEM_GAP, snap);
          break;
        }
        case 'node.surface': {
          const blocker = surfaceBlocker(find(command.id), state.nodes);
          if (blocker) throw new Error(blocker);
          delete find(command.id).belowAt;
          state.nodes = restoreMapPositions(state.nodes, command.id);
          const target = find(command.id);
          if (target.resourceId) {
            const obstacles = layoutFootprints(state.nodes.filter(node => node.id !== target.id), state.resources, registry, sizes);
            target.position = freePosition({ ...itemFootprint(target, state.resources, registry, sizes), ...snapPosition(target.position, snap) }, obstacles, ITEM_GAP, snap);
          } else state.nodes = moveItems(state.nodes, state.resources, registry, [{ id: target.id, position: snapPosition(target.position, snap) }], sizes, snap);
          break;
        }
        case 'node.restore':
          state.nodes = restoreNode(state.nodes, command.id);
          if (!isDrawn(find(command.id), state.nodes)) break; // Returns to Undermap, where it was archived from, or stays hidden.
          state.nodes = moveItems(state.nodes, state.resources, registry, [{ id: command.id, position: find(command.id).position }], sizes, snap);
          break;
        case 'node.complete': find(command.id).completedAt ??= new Date().toISOString(); touchNode(find(command.id)); break;
        case 'node.reopen':
          delete find(command.id).completedAt; delete find(command.id).todoDoneAt; touchNode(find(command.id));
          state.nodes = moveItems(state.nodes, state.resources, registry, [{ id: command.id, position: find(command.id).position }], sizes, snap);
          break;
        case 'node.delete': {
          const target = find(command.id);
          if (!isArchived(target, state.nodes)) throw new Error('Archive the item or project before deleting it');
          state.nodes = state.nodes.filter(n => n.id !== target.id);
          // Keep inherited archives when removing a project container. Its items
          // remain recoverable, rather than unexpectedly reappearing on the map.
          for (const n of state.nodes) if (n.projectId === target.id) {
            n.archivedAt ??= target.archivedAt; delete n.projectId;
            if (n.belowAt) n.lostProject = target.title;
          }
          state.links = state.links.filter(l => l.sourceId !== target.id && l.targetId !== target.id);
          for (const task of state.todos) task.nodeIds = task.nodeIds.filter(nodeId => nodeId !== target.id);
          // Other aliases can still own the same resource. Never call a provider delete.
          if (target.resourceId && !state.nodes.some(n => n.resourceId === target.resourceId)) {
            state.resources = state.resources.filter(r => r.id !== target.resourceId);
          }
          if (state.view.nodeId === target.id) {
            state.view.mode = 'workspace';
            delete state.view.nodeId;
          }
          break;
        }
        case 'link.save':
          state.links = saveLink(state.nodes, state.links, command.link, resourceCardinality(state.resources, registry));
          break;
        case 'link.remove': state.links = state.links.filter(l => l.id !== command.id); break;
        case 'node.todo.label': {
          const target = find(command.id), resource = state.resources.find(r => r.id === target.resourceId);
          if (!target.inTodoList || target.title !== command.sourceTitle || !resource || !registry.get(resource.pluginId)?.todoSupport) throw new Error('Task changed before its label was ready');
          target.todoLabel = { title: command.title, sourceTitle: command.sourceTitle }; break;
        }
        case 'node.title.generated': {
          const target = find(command.id), resource = state.resources.find(r => r.id === target.resourceId);
          const plugin = resource && registry.get(resource.pluginId);
          if (!plugin || !(plugin.activityTitle || plugin.attachTitle) || target.title !== command.sourceTitle) throw new Error('Title changed before the generated title was ready');
          target.title = resource.title = target.generatedTitle = command.title; break;
        }
        case 'node.todo': {
          const target = find(command.id), resource = state.resources.find(r => r.id === target.resourceId);
          if (!resource || !registry.get(resource.pluginId)?.todoSupport) throw new Error('This item cannot be added to the task list');
          target.inTodoList = command.enabled; if (!command.enabled) delete target.todoDoneAt; break;
        }
        case 'todos.reorder': {
          if (new Set(command.ids).size !== command.ids.length) throw new Error('Duplicate ordering identities');
          const groups = groupWorkspaceTodos(state);
          if (command.scope === 'projects') {
            const expected = groups.flatMap(group => group.projectId ? [group.projectId] : []);
            if (expected.length !== command.ids.length || command.ids.some(id => !expected.includes(id))) throw new Error('Project groups changed; reorder the current list');
            command.ids.forEach((id, index) => { find(id).todoOrder = index; });
          } else {
            // Any rows of one group, in their new order: they take each other's places, so a project's rows reorder among themselves.
            const list = todoList(state), group = [list.inbox, list.next, list.later, list.done].find(rows => rows.some(row => row.id === command.ids[0]));
            if (!group || command.ids.some(id => !group.some(row => row.id === id))) throw new Error('Tasks changed; reorder within one group');
            const slots = group.flatMap((row, index) => command.ids.includes(row.id) ? [index] : []), rows = [...group];
            command.ids.forEach((id, index) => { rows[slots[index]] = group.find(row => row.id === id)!; });
            rows.forEach(setTodoOrder);
          }
          break;
        }
        case 'todo.place': {
          const entry = todoEntry(command.id);
          if (command.projectId) project(command.projectId);
          if (entry.source === 'map') {
            // A move, as when dragging the item on the map: only a drop inside another project transfers it.
            if (command.projectId && command.projectId !== find(entry.nodeId!).projectId) applyToDraft(state, { type: 'node.attach', id: entry.nodeId!, projectId: command.projectId }, registry, layout);
            applyToDraft(state, { type: 'node.move', id: entry.nodeId!, position: command.position }, registry, layout);
          } else placeChecklist(entry, command.nodeId, command.resourceId, command.position, command.projectId);
          break;
        }
        case 'todo.send': {
          const entry = todoEntry(command.id), target = project(command.projectId);
          if (isOffMap(target, state.nodes)) throw new Error('Bring this project back to the map before sending to-dos to it');
          const created = new Set<string>();
          if (entry.source === 'checklist') {
            if (!command.nodeId || !command.resourceId) throw new Error('A list-only to-do needs nodeId and resourceId to appear on the map');
            for (const id of placeChecklist(entry, command.nodeId, command.resourceId, target.position, target.id)) created.add(id);
          }
          sendBlock([find(entry.source === 'map' ? entry.nodeId! : command.nodeId!)], target, created);
          break;
        }
        case 'nodes.send': {
          if (new Set(command.ids).size !== command.ids.length) throw new Error('Duplicate selection identities');
          if (command.projectId === null) { leaveProject(command.ids.map(find)); break; }
          const target = project(command.projectId);
          if (isArchived(target, state.nodes)) throw new Error('Restore this project from the archive before moving items to it');
          if (isOffMap(target, state.nodes)) throw new Error('Bring this project back to the map before moving items to it');
          const leads = command.ids.map(find);
          for (const lead of leads) {
            if (!lead.resourceId) throw new Error('Only items can be moved to a project');
            if (isArchived(lead, state.nodes)) throw new Error('Restore this item from the archive before moving it');
            if (isOffMap(lead, state.nodes)) throw new Error('This item is in Undermap. Bring it back to move it.');
          }
          sendBlock(leads, target);
          break;
        }
        case 'todo.save': {
          command.todo.nodeIds.forEach(find);
          const previous = state.todos.find(t => t.id === command.todo.id);
          const archivedAt = previous?.archivedAt ?? command.todo.archivedAt;
          // Edits from the list never carry the import; it stays until the to-do is placed.
          const triage = command.todo.triage ?? previous?.triage;
          const { context: text, ...saved } = command.todo, held = checklistContext(previous);
          const context = text === undefined ? held : writtenContext(held, cleanContext(text));
          const doneAt = saved.completed ? previous?.completed ? previous.doneAt : new Date().toISOString() : undefined;
          // New to-dos go last in Next, imports last in the inbox; a save without a horizon keeps where the to-do is.
          const nodeIds = [...new Set(command.todo.nodeIds)];
          const edited = !previous || previous.title !== saved.title || previous.completed !== saved.completed || canonical(previous.nodeIds) !== canonical(nodeIds) || previous.context !== context?.text;
          // A person who edits a ticket waiting in the inbox has taken it.
          const kept = previous?.horizon === 'inbox' && human && edited ? 'next' : previous?.horizon;
          const horizon = command.todo.horizon ?? kept ?? (triage ? 'inbox' : 'next');
          if (horizon === 'inbox' && (!triage || previous && previous.horizon !== 'inbox')) throw new Error('Only an imported ticket that nobody has taken can wait in the inbox');
          const todoOrder = previous?.todoOrder !== undefined && (previous.horizon ?? 'next') === horizon ? previous.todoOrder : command.todo.todoOrder ?? lastOrder(horizon);
          const changed = edited || (previous?.horizon ?? 'next') !== horizon;
          const touchedAt = human && changed ? new Date().toISOString() : previous?.touchedAt;
          const dismissed = horizon === 'inbox' ? previous?.dismissed : undefined;
          state.todos = [...state.todos.filter(t => t.id !== command.todo.id), { ...saved, ...checklistContextFields(context), todoOrder, horizon, ...(archivedAt ? { archivedAt } : {}), ...(triage ? { triage } : {}), ...(doneAt ? { doneAt } : {}),
            ...(touchedAt ? { touchedAt } : {}), ...(dismissed ? { dismissed } : {}), nodeIds }];
          break;
        }
        case 'todo.move': {
          const entry = todoEntry(command.id), record = entry.source === 'checklist' ? state.todos.find(todo => todo.id === entry.id)! : undefined, target = entry.nodeId ? find(entry.nodeId) : undefined;
          if (command.horizon === 'done') {
            if (record && !record.completed) {
              record.completed = true; record.doneAt = new Date().toISOString();
              if (record.horizon === 'inbox') { record.horizon = 'next'; delete record.dismissed; }
            } else if (target && !entry.completed) {
              // An item kept in the list completes in the list only; its provider is never written from here.
              if (target.inTodoList) target.todoDoneAt = new Date().toISOString(); else applyToDraft(state, { type: 'node.complete', id: target.id }, registry, layout, actor);
            }
          } else {
            if (entry.providerDone) throw new Error('This item is done in its provider. Reopen it on the map to bring it back.');
            if (record) { if (record.completed) { record.completed = false; delete record.doneAt; } record.horizon = command.horizon; delete record.dismissed; }
            else {
              if (target!.todoDoneAt) delete target!.todoDoneAt; else if (target!.completedAt) applyToDraft(state, { type: 'node.reopen', id: target!.id }, registry, layout, actor);
              find(target!.id).todoHorizon = command.horizon;
            }
            if (command.index !== undefined || entry.horizon !== command.horizon) fileTodo(entry, command.horizon, command.index ?? Infinity);
          }
          if (record && human) record.touchedAt = new Date().toISOString(); else if (target) touchNode(find(target.id));
          break;
        }
        case 'todo.dismiss': {
          const record = state.todos.find(todo => todo.id === command.id && !todo.archivedAt);
          if (!record) throw new Error('This to-do is no longer available');
          if (record.horizon !== 'inbox' || !record.triage) throw new Error('Only a ticket waiting in the inbox can be marked not for me');
          if (command.dismissed) record.dismissed = { at: new Date().toISOString(), title: record.title, ...(record.triage.status ? { status: record.triage.status } : {}) };
          else delete record.dismissed;
          break;
        }
        case 'todo.context': {
          const record = state.todos.find(todo => todo.id === command.id), placed = record ? undefined : mapTodoNode(state, command.id);
          if (!record && !placed) throw new Error(command.id.startsWith('map:') && state.nodes.some(node => `map:${node.id}` === command.id) ? 'This item is not a to-do' : 'This to-do is no longer available');
          const held = record ? checklistContext(record) : mapTodoContext(placed), added = cleanContext(command.context);
          const text = command.mode === 'replace' ? added : [held?.text, added].filter(Boolean).join('\n\n');
          if (text.length > TODO_CONTEXT_LIMIT) throw new Error(`This to-do's context would be ${text.length.toLocaleString('en-US')} characters; the limit is ${TODO_CONTEXT_LIMIT.toLocaleString('en-US')}. Shorten the addition, or replace the context with a summary (mode "replace").`);
          const context = writtenContext(held, text);
          if (record) { delete record.context; delete record.contextBy; delete record.contextAt; Object.assign(record, checklistContextFields(context)); if (human) record.touchedAt = new Date().toISOString(); }
          else { delete placed!.todoContext; delete placed!.todoContextBy; delete placed!.todoContextAt; Object.assign(placed!, mapTodoContextFields(context)); touchNode(placed!); }
          break;
        }
        case 'todo.archive': case 'todo.restore': {
          const task = state.todos.find(task => task.id === command.id);
          if (!task) throw new Error('To-do not found');
          if (command.type === 'todo.archive') task.archivedAt ??= new Date().toISOString();
          else delete task.archivedAt;
          break;
        }
        case 'todo.remove': {
          const task = state.todos.find(task => task.id === command.id);
          if (task && !task.archivedAt) throw new Error('Archive the to-do before deleting it');
          state.todos = state.todos.filter(t => t.id !== command.id); break;
        }
        case 'view.set':
          if (command.view.mode !== 'workspace') {
            if (!command.view.nodeId) throw new Error('A target node is required');
            if (command.view.mode === 'project') project(command.view.nodeId); else find(command.view.nodeId);
          }
          state.view = command.view;
          break;
      }
}
