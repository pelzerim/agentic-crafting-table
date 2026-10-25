import type { CommandEnvelope, WorkspaceCommand, WorkspaceState } from './control.ts';

/** What a rule may look at: the workspace the command would apply to, and who sends it. */
export interface RevisionContext { state: WorkspaceState; actor: CommandEnvelope['actor'] }
type CommandOf<T extends WorkspaceCommand['type']> = Extract<WorkspaceCommand, { type: T }>;
/** `why` reads after "it": the reason a revision is needed, or for a free command why none is. A conditional rule
 * is free while `free` holds; `otherwise` is the reason given when it does not. */
export type RevisionRule<C extends WorkspaceCommand = WorkspaceCommand> =
  | { free: true; why: string }
  | { free: false; why: string }
  | { free: (command: C, context: RevisionContext) => boolean; why: string; otherwise: string };

const ownNode = (id: string, { actor }: RevisionContext) => actor.kind === 'agent' && actor.id === id;
/** Fields an agent reports about its own session. Title, colour, working directory and indicators belong to the user or the host. */
const STATUS_FIELDS: ReadonlySet<string> = new Set(['type', 'id', 'summary', 'activity', 'attention', 'attentionNote']);
const positions = 'overwrites positions the user may be changing';

/** Whether a command may be applied without the revision its sender last read. Free means it only adds, or carries
 * its own guard, so applying it to the newest workspace cannot undo a change the sender has not seen. Every command
 * type has a row; the reducer still checks the revision of every envelope it is given. */
export const COMMAND_REVISION_RULES: { readonly [T in WorkspaceCommand['type']]: RevisionRule<CommandOf<T>> } = {
  'item.create': { free: true, why: 'adds a new item under a new id; its links are ensured, and an invalid one refuses the item' },
  'item.add': { free: true, why: 'adds a new item under a new id; its links are ensured, and an invalid one refuses the item' },
  'project.create': { free: true, why: 'adds a new project under a new id' },
  'attention.acknowledge': { free: true, why: 'names the attention versions it acknowledges, so a newer alert stays unread' },
  'attention.restore': { free: true, why: 'names the attention versions it puts back into Needs me, so a newer alert is left as it is' },
  'node.todo.label': { free: true, why: 'names the title it was written for and is refused once that title changed' },
  'node.title.generated': { free: true, why: 'names the title it was written for and is refused once that title changed' },
  'link.save': { free: (command, { state }) => !state.links.some(link => link.id === command.link.id),
    why: 'adds a new link; limits, duplicates and cycles are checked against the current map', otherwise: 'replaces a link that already exists' },
  'todo.save': { free: (command, { state }) => !state.todos.some(todo => todo.id === command.todo.id),
    why: 'adds a new to-do to the list', otherwise: 'replaces a to-do that already exists' },
  'node.todo': { free: command => command.enabled, why: 'adds the item to the task list, which changes nothing when it is already there', otherwise: 'takes the item off the task list' },
  'node.attach': { free: (command, { state }) => command.projectId !== null && !state.nodes.find(node => node.id === command.id)?.projectId,
    why: 'gives an item without a project its first one', otherwise: 'moves the item out of the project it is in' },
  'node.update': { free: (command, context) => ownNode(command.id, context) && Object.keys(command).every(key => STATUS_FIELDS.has(key)),
    why: 'reports the calling session\'s own summary, activity and attention', otherwise: 'changes a node other than your own session, or its title, colour, working directory or indicators' },
  'attention.set': { free: (command, context) => ownNode(command.id, context),
    why: 'raises or clears one attention source on the calling session\'s own node', otherwise: 'changes attention on a node other than your own session' },
  'todo.move': { free: false, why: 'moves, ticks or reopens a to-do whose place you may not have seen' },
  'todo.dismiss': { free: false, why: 'hides or shows a ticket waiting in the inbox' },
  'todo.context': { free: true, why: 'sets one text on a to-do; it never moves, completes or removes anything, and an append keeps what is there' },
  'item.update': { free: false, why: 'replaces the item\'s data, including fields changed since your last read' },
  'item.resolve': { free: false, why: 'replaces the item\'s data with a provider reading' },
  'item.bind': { free: false, why: 'rebinds the item\'s provider account and may merge it into another item' },
  'item.convert': { free: false, why: 'replaces the item\'s type and data' },
  'node.move': { free: false, why: positions },
  'nodes.move': { free: false, why: positions },
  'node.resize': { free: false, why: 'overwrites a size the user may be changing and can move neighbours' },
  'layout.repair': { free: false, why: 'moves every overlapping item on the map' },
  'nodes.send': { free: false, why: 'moves existing items to another project and place' },
  'todo.send': { free: false, why: 'moves an existing to-do and its items to another project' },
  'todo.place': { free: false, why: 'moves an existing to-do onto the map or to another place' },
  'node.archive': { free: false, why: 'takes an item or project off the map and stops its session' },
  'node.below': { free: false, why: 'takes an item or project off the map' },
  'node.surface': { free: false, why: 'returns an item to the map and places it' },
  'node.hide': { free: false, why: 'takes an item off the map' },
  'node.show': { free: false, why: 'returns a hidden item to the map and places it' },
  'node.restore': { free: false, why: 'returns an archived item to the map and places it' },
  'node.delete': { free: false, why: 'permanently removes an item with its links' },
  'node.rework': { free: true, why: 'sets or clears one note saying what is being changed on an item; it never moves, completes or removes anything' },
  'nodes.action': { free: false, why: 'changes every item of a selection made from an earlier read' },
  'node.complete': { free: false, why: 'sets the done state, which the user may have just changed, and unblocks what it blocks' },
  'node.reopen': { free: false, why: 'clears the done state, which the user may have just changed, and places the item again' },
  'project.mute': { free: false, why: 'is the user\'s display choice; agents may not apply it at all' },
  'link.remove': { free: false, why: 'removes a link' },
  'todos.reorder': { free: false, why: 'orders the list as it was when you read it' },
  'todo.archive': { free: false, why: 'takes a to-do off the list' },
  'todo.restore': { free: false, why: 'returns an archived to-do to the list' },
  'todo.remove': { free: false, why: 'permanently removes a to-do' },
  'view.set': { free: false, why: 'overwrites the user\'s view of the map' },
};

/** The same decision for requests outside the command union that carry a revision, by MCP tool. */
export const REQUEST_REVISION_RULES = {
  workspace_apply: { free: 'per command', why: 'follows COMMAND_REVISION_RULES; a batch is free only when every command in it is' },
  workspace_create_item: { free: true, why: 'adds a new item and its connections under new ids; requestId makes a retry the same request' },
  workspace_run_skill: { free: true, why: 'adds a new agent item under new ids; requestId makes a retry the same request' },
  'workspace_run skill.run': { free: true, why: 'is the same request as workspace_run_skill' },
  workspace_settings: { free: false, why: 'replaces all settings; its revision is the settings revision, not the workspace one' },
} as const;

/** Refuses an envelope sent without a revision when the workspace it would apply to does not allow that. */
export function revisionGuard(state: WorkspaceState, envelope: Pick<CommandEnvelope, 'actor' | 'commands'>): void {
  const refusal = revisionRefusal(envelope.commands, { state, actor: envelope.actor });
  if (refusal) throw Object.assign(new Error(refusal), { code: 'REVISION_REQUIRED' });
}

/** Why these commands cannot be applied without a revision, or nothing when all of them can. */
export function revisionRefusal(commands: readonly WorkspaceCommand[], context: RevisionContext): string | undefined {
  for (const command of commands) {
    const rule = COMMAND_REVISION_RULES[command.type] as RevisionRule;
    const reason = typeof rule.free === 'function' ? (rule.free(command, context) ? undefined : (rule as { otherwise: string }).otherwise) : rule.free ? undefined : rule.why;
    if (reason) return `${command.type} needs expectedRevision: it ${reason}. Pass the revision from workspace_read.`;
  }
  return undefined;
}
