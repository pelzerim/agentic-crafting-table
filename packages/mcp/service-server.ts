import { settingsWriteSchema } from '../core/settings.ts';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { agentCommandRefusal, commandSchema, commandSchemaWith, itemLinkReport, itemLinkSchema } from '../core/control.ts';
import type { CommandResult, WorkspaceCommand } from '../core/control.ts';
import { managedSessionsSchema, manageSessionSchema, sessionIdSchema } from '../session-runtime/protocol.ts';
import { recordingsSchema, deleteRecordingSchema } from '../session-runtime/protocol.ts';
import { savedSessionsSchema, creationOptionsSchema } from '../session-runtime/saved-sessions.ts';
import { agentResourceCreateSchema } from '../core/resource-creation.ts';
import { agentRuntimeRefusal, runtimeOperationDeclarations, runtimeRequestSchema } from '../core/runtime.ts';
import { skillListSchema, skillRunSchema } from '../core/skills.ts';
import type { WorkspaceSnapshot } from '../workspace-service/protocol.ts';
import { serializeError } from '../workspace-service/protocol.ts';
import { mapBadges } from '../../src/graph/badges.ts';
import { buildAgentToolContext } from '../../src/agents/tool-context.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { createPluginPackageRegistry } from '../../src/resource-plugins/builtins.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';
import type { AgentToolBinding } from '../../src/agents/tool-context.ts';

interface ServiceClient { call<T = unknown>(method: string, input?: unknown): Promise<T> }
/** The agent identity of a client that was not launched from the table: it has no node, so nothing is placed beside it. */
const UNBOUND_AGENT = 'mcp-client';
const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const guarded = async (work: () => Promise<unknown>) => { try { return response(await work()); } catch (error) { return { ...response({ error: serializeError(error) }), isError: true }; } };

/** A new item's link as an agent writes it: `otherId`, or `agent: true` for the calling agent's own node. */
const agentItemLinkSchema = itemLinkSchema.extend({
  otherId: itemLinkSchema.shape.otherId.optional().describe('The other node. Omit when agent is true.'),
  agent: z.literal(true).optional().describe('Link to your own session node (the launch binding agentNodeId) instead of otherId.'),
  newItemIs: itemLinkSchema.shape.newItemIs.describe('Which end the new item is: source (default) points from it to the other node, target points from the other node to it.'),
});
const agentCommandSchema = commandSchemaWith(agentItemLinkSchema);
/** Resolves the `agent: true` shorthand to the bound agent's node id; the service only ever sees node ids. */
export function resolveAgentLinks(command: z.infer<typeof agentCommandSchema>, agentNodeId: string | undefined): WorkspaceCommand {
  // A rework note, and its clearing, names the session; an agent's clearing puts the item in Needs me.
  if (command.type === 'node.rework') return commandSchema.parse(!command.by && agentNodeId ? { ...command, by: agentNodeId } : command);
  if ((command.type !== 'item.add' && command.type !== 'item.create') || !command.links) return commandSchema.parse(command);
  return commandSchema.parse({ ...command, links: command.links.map(({ agent, ...link }) => {
    if (agent ? link.otherId : !link.otherId) throw new Error('Each link needs otherId or agent: true, not both.');
    if (agent && !agentNodeId) throw new Error('agent: true needs a session launched from the table. Pass otherId with your node id from workspace_read.');
    return { ...link, otherId: agent ? agentNodeId : link.otherId };
  }) });
}

/** Transport only: every read, mutation and provider action belongs to the service. */
export function createServiceMcpServer(client: ServiceClient, binding: AgentToolBinding = {}) {
  const guide = buildAgentToolContext(binding);
  const server = new McpServer({ name: 'benchgrove', version: '0.1.0' }, { instructions: guide.prompt });
  const read = async () => (await client.call<WorkspaceSnapshot>('read')).state;
  /** Plots are read-only proximity groups (MAP-24): they never imply a relationship and are not agent context. */
  const readMap = async () => {
    const snapshot = await client.call<WorkspaceSnapshot>('read'), hiddenProjects = new Set(snapshot.plots?.hiddenProjects);
    const labels = new Map<string, { noteId: string; text: string; paper: string; itemIds: string[] }>();
    for (const [itemId, badges] of mapBadges(snapshot.state.nodes, snapshot.state.resources, snapshot.state.links).onItems) for (const badge of badges) {
      const entry = labels.get(badge.noteId) ?? { noteId: badge.noteId, text: badge.text, paper: badge.paper, itemIds: [] };
      entry.itemIds.push(itemId); labels.set(badge.noteId, entry);
    }
    return { ...snapshot.state, plots: (snapshot.plots?.list ?? []).filter(plot => !plot.hidden && !hiddenProjects.has(plot.projectId))
      .map(plot => ({ id: plot.id, projectId: plot.projectId, name: plot.name, memberIds: plot.memberIds, generated: plot.source === 'generated' })), badges: [...labels.values()] };
  };
  server.registerTool('workspace_read', { description: 'Read the live Agentic Crafting Table graph and revision. Use existing IDs and verify current project membership before changing it. plots lists groups of items that sit close together on the map; they are layout, not relationships, and only the user can rename or hide them. badges lists notes shown as labels on the items they connect to (noteId, text, paper, itemIds): a note of one or two words, at most 12 characters, connected to an item; data.display "badge" pins a longer one (24 characters), "note" keeps it paper.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => guarded(readMap));
  server.registerTool('workspace_diagnostics', { description: 'Read local version and aggregate counts for support. Excludes titles, IDs, paths, URLs, prompts, terminal/log content, provider account details and credentials. Makes no provider requests.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => guarded(() => client.call('diagnostics.report')));
  server.registerTool('workspace_recordings', { description: 'Inspect local recording database size and paginated recording metadata, including archived/removed entries. Does not read terminal content. Use nextBefore to request the next page.', inputSchema: recordingsSchema, annotations: { readOnlyHint: true, openWorldHint: false } }, input => guarded(() => client.call('recordings.list', input)));
  server.registerTool('workspace_delete_recording', { description: 'Permanently delete one archived (or previously removed), stopped session’s local recording and cached tail ONLY when the user explicitly requests this deletion. Never infer authorization from archive/remove/stop or a request to free space generally. Keeps native conversations, map items, session identity, launch deduplication and project files. Backups are not erased and database space becomes reusable, not necessarily smaller. Explicit confirmation is required; running sessions are rejected.', inputSchema: deleteRecordingSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, input => guarded(() => client.call('recordings.delete', input)));
  server.registerTool('workspace_settings', { description: 'Read application settings. Pass update with its expectedRevision only when the user requested a settings change. Agent flags apply on the next launch/resume; existing sessions are not restarted.', inputSchema: { update: settingsWriteSchema.optional() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, ({ update }) => guarded(() => client.call(update ? 'settings.write' : 'settings.read', update)));
  server.registerTool('workspace_connections', { description: 'List installed providers and saved account bindings. Pass providerId to discover signed-in account metadata. Never returns credentials. Change connections through workspace_settings only when the user requested it.', inputSchema: { providerId: z.string().min(1).max(200).optional() }, annotations: { readOnlyHint: true, openWorldHint: true } }, ({ providerId }) => guarded(() => client.call(providerId ? 'connections.accounts' : 'connections.list', providerId ? { providerId } : undefined)));
  server.registerTool('workspace_sync_connections', { description: 'Refresh connected provider discovery and update local map items/Needs me. Remote access is read-only: never posts comments or changes provider objects. An optional connectionId selects one account; persisted rate-limit backoff still applies.', inputSchema: { connectionId: z.string().min(1).max(200).optional() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, input => guarded(() => client.call('connections.refresh', input)));
  server.registerTool('workspace_plugins', { description: 'Discover installed item definitions, creation schemas, provider capabilities and URL candidates. relationships.cardinality (one or many) counts reference and context links in either direction, including archived items and aliases; project membership does not count. New item types use these contracts rather than new graph tools.', inputSchema: { input: z.string().max(8192).optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, input => guarded(() => client.call('plugins.discover', input)));
  server.registerTool('workspace_creation_options', { description: 'Read native options for a plugin creation field, such as provider-specific agent models. Uses the same capability lookup as the desktop form.', inputSchema: creationOptionsSchema, annotations: { readOnlyHint: true, openWorldHint: false } }, input => guarded(() => client.call('creation.options', input)));
  server.registerTool('workspace_sessions', { description: 'List saved native sessions available for an item type, across folders on this computer. Returns paged metadata only.', inputSchema: savedSessionsSchema, annotations: { readOnlyHint: true, openWorldHint: false } }, input => guarded(() => client.call('creation.sessions', input)));
  server.registerTool('workspace_skills', { description: 'Discover installed native skills for a project and provider in its working directory. Metadata only; no model turn. Recheck before offering a skill to the user.', inputSchema: skillListSchema, annotations: { readOnlyHint: true, openWorldHint: false } }, input => guarded(() => client.call('skills.list', input)));
  server.registerTool('workspace_run_skill', { description: 'Launch a selected installed skill as a visible project agent with the table guide and project context. Uses native permissions. expectedRevision is optional and best omitted. Reuse the entire request, including IDs, for retries. Only run skills authorized by the user. Resuming a run continues its conversation without invoking the skill again.', inputSchema: skillRunSchema.extend({ projectId: z.string().min(1).max(200) }), annotations: { readOnlyHint: false, openWorldHint: true } }, ({ projectId, ...input }) => guarded(() => client.call('runtime.run', { action: 'skill.run', nodeId: projectId, arguments: input })));
  server.registerTool('workspace_runtime_sessions', { description: 'List managed terminal/agent processes, including archived entries when requested. Metadata only; this differs from saved provider conversations.', inputSchema: managedSessionsSchema, annotations: { readOnlyHint: true, openWorldHint: false } }, input => guarded(() => client.call('sessions.managed', input)));
  server.registerTool('workspace_manage_session', { description: 'Archive, restore or remove a managed session entry. Remove is only allowed for archived entries and requires stopping a live session first. Never deletes map items, native conversations, recordings or project files.', inputSchema: manageSessionSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, input => guarded(() => client.call('sessions.manage', input)));
  server.registerTool('workspace_stop_session', { description: 'Explicitly stop a managed native process, including archived sessions. Keeps its recording and conversation. Use only when stopping work is authorized.', inputSchema: sessionIdSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, input => guarded(() => client.call('sessions.stop', input)));
  server.registerTool('workspace_create_item', { description: 'Create an item through its advertised host creation action. A saved native session may be selected using resumeNativeSessionId. Reuse the exact requestId and payload for retries. expectedRevision is optional and best omitted: the item is added to the current workspace. connections (max 8, same shape as connection) links the new item in the same step, e.g. connections:[{id:<uuid>,otherId:<your nodeId>,kind:"reference",sourceIsNew:true}]. Omit position: the item lands next to the first node it connects to, or next to you, and joins that node\'s project unless projectId names another. Give a position only when the user asked for a specific place.', inputSchema: agentResourceCreateSchema, annotations: { readOnlyHint: false, openWorldHint: true } }, input => guarded(() => client.call('item.create', { ...input, placedBy: binding.agentNodeId ?? UNBOUND_AGENT })));
  server.registerTool('workspace_apply', {
    description: 'Apply a validated graph command atomically, or pass commands (1–10) instead of command to apply several in one revision. Reuse commandId for an exact retry. expectedRevision is optional for writes that only add: item.add, item.create, project.create, a new link.save or todo.save, todo.context, node.todo enabled, node.attach of an item with no project, node.rework (note what you are changing on an item, null when done; it stays working meanwhile), and node.update (summary, activity, attention) or attention.set on your own node; they apply to the current map. Every other command, and any batch containing one, needs expectedRevision from workspace_read, and a stale one requires a fresh read. item.add/item.create take links (max 8) saved with the item, e.g. links:[{agent:true,kind:"reference"}] links it to your session; otherId names any other node and newItemIs "source" (default) or "target" sets its end. An invalid link refuses the item; a relationship that already exists is kept, and itemLinks in the result reports each link. An item your project already shows gets no second node: its links go to the existing node, which alreadyOnMap in the result names (requestedId, nodeId); use that nodeId. An artifact you publish is put on the map beside you automatically, linked to you: do not add it. Omit position on item.add, item.create and project.create: an item lands next to the first node it links to, or next to you, and joins that node’s project unless projectId names another; a project lands beside yours. Give a position only when the user asked for a specific place; one far from that context is ignored. Commands create/move/resize/link/archive/complete map items (link kinds: reference, context, blocks; a blocks link’s source must finish before its target, and cycles are refused; a blocker resolves when done, merged, closed or archived; link.save with reveal:"hover" draws the link only while one of its ends is hovered, selected or open); deletion is allowed only after archival, including checklist to-dos. item.update replaces data. Moving a project moves its members; keep existing layout unless asked. node.todo adds a todoSupport item to the local task list; todo.send moves a to-do (a todos id, or map:<nodeId>) and its attached items into a project, and a list-only or inbox to-do also needs new nodeId/resourceId; todo.save takes context and an optional horizon (next, the default for a new to-do, or later) that files it into Next or Later; todo.move {id, horizon: next|later|done, index?} moves a to-do between Next and Later or ticks it, never changing its project; tickets imported from Linear have horizon inbox until the user takes them; todo.context {id, context, mode: replace|append} sets it on an existing to-do (plain text, max 8,000 characters): put the reasoning, links and next steps a person or a later agent will need there, since it stays when you are gone; nodes.send moves items (ids; the first leads) into an active project as one block beside its items, keeping their layout and links, where only a to-do brings its attached items; projectId null takes them out of their project, beside its ground; node.complete/node.reopen never write provider status; reorder todos only on request. Archiving a managed session stops its process but keeps history and resume identity; restoring never relaunches it. They never launch or stop external processes. Use workspace_run for runtime actions. mutedAt on a project means the user muted it: its Needs me, counts and notifications are hidden from them while everything in it keeps running; agents can read it, and only the user applies project.mute. Raising attention (node.update attention, or attention.set with a reason) should carry a short reason the user sees in Needs me: attentionNote / note, e.g. "Agent waiting"; without one Needs me shows only a generic category label.',
    inputSchema: { commandId: z.string().min(1).max(200).optional(), expectedRevision: z.number().int().nonnegative().optional().describe('Omit for writes that only add; they apply to the current map. Required when a command changes, moves or removes something that exists.'), command: agentCommandSchema.optional(), commands: z.array(agentCommandSchema).min(1).max(10).optional().describe('Several commands applied together in one revision, in order. Give this or command.') },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => guarded(async () => {
    if (Boolean(input.command) === Boolean(input.commands)) throw new Error('Give exactly one of command or commands.');
    const commands = (input.commands ?? [input.command!]).map(command => resolveAgentLinks(command, binding.agentNodeId));
    for (const command of commands) { const refusal = agentCommandRefusal(command); if (refusal) throw new Error(refusal); }
    const commandId = input.commandId ?? randomUUID();
    const result = await client.call<CommandResult>('apply', { commandId, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }), actor: { kind: 'agent', id: binding.agentNodeId ?? UNBOUND_AGENT }, commands });
    const itemLinks = itemLinkReport(result.state, commands, result.alreadyOnMap);
    const alreadyOnMap = result.alreadyOnMap?.map(item => ({ ...item, note: `Already on the map as ${item.nodeId}: no second item was created. Use this nodeId.` }));
    return { ...result.state, commandId, replayed: result.replayed, ...(itemLinks.length ? { itemLinks } : {}), ...(alreadyOnMap?.length ? { alreadyOnMap } : {}) };
  }));
  server.registerTool('workspace_run', { description: 'Run an advertised host or provider action. resource.action uses {actionId,input}. Terminal input is literal input to a real process. Unavailable actions fail explicitly. Follow the user’s authorization for side effects. agent.context returns your brief, incoming context links and the context of to-dos attached to you; acknowledge its deliveryId with agent.context.ack and reread when the receipt is stale. Acknowledge hook-offered context only if you received it.', inputSchema: runtimeRequestSchema(runtimeOperationDeclarations()), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, input => guarded(async () => {
    const refusal = agentRuntimeRefusal(input); if (refusal) throw new Error(refusal);
    if (input.action === 'resource.action') {
      const actions = await client.call<{ id: string; humanOnly?: boolean }[]>('runtime.run', { action: 'resource.actions', nodeId: input.nodeId, arguments: {} });
      if (actions.find(action => action.id === input.arguments?.actionId)?.humanOnly) throw new Error(humanOnlyMessage);
    }
    return client.call('runtime.run', input);
  }));
  server.registerTool('workspace_report_review_fixes', { description: 'Report code review findings that were sent to you as fixed. Pass the review item ID and finding IDs from the request, plus the commit SHA if you committed and a one-line note. Only the agent a finding was sent to can report it; the user can still reopen it. A finding the user ignores is listed with status fixed and in the review’s ignored list; it was not fixed.',
    inputSchema: { reviewNodeId: z.string().min(1).max(200), findingIds: z.array(z.string().regex(/^F[0-9]{1,4}$/)).min(1).max(200), commit: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(), note: z.string().max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, ({ reviewNodeId, ...report }) => guarded(async () => {
    if (!binding.agentNodeId) throw new Error('Only an agent launched from the table can report fixed findings.');
    return client.call('runtime.run', { action: 'review.findings', nodeId: reviewNodeId, arguments: { operation: 'report', agentNodeId: binding.agentNodeId, ...report } });
  }));
  for (const tool of createPluginPackageRegistry().mcpTools()) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations ?? {} }, input => guarded(async () => {
      if (tool.requiresAgent && !binding.agentNodeId) throw new Error(tool.requiresAgent);
      return client.call('runtime.run', tool.request(input as JsonObject, binding));
    }));
  }
  server.registerResource('workspace', 'benchgrove://workspace', { mimeType: 'application/json', description: 'Live workspace graph' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await readMap()) }] }));
  server.registerResource('agent-guide', 'benchgrove://agent-guide', { mimeType: 'text/plain', description: 'Trusted workspace synchronization guide and launch binding' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: guide.prompt }] }));
  return server;
}
