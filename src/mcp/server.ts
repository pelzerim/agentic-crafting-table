import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { WorkspaceControl, agentCommandRefusal, commandSchema } from './control.ts';
import type { WorkspaceState } from './control.ts';
import { FileStore } from './store.ts';
import { createResourcePluginHost } from '../resource-plugins/catalog.server.ts';
import type { ResourcePluginHost } from '../resource-plugins/host.ts';
import { humanOnlyMessage } from '../resource-plugins/host.ts';
import { buildAgentToolContext } from '../agents/tool-context.ts';

import { runtimeSchema, agentRuntimeRefusal } from '../../packages/core/runtime.ts';
import type { RuntimeAdapter, RuntimeExecutionContext } from '../../packages/core/runtime.ts';
import { revisionGuard } from '../../packages/core/revision-policy.ts';
export type { RuntimeRequest, RuntimeAdapter, RuntimeExecutionContext } from '../../packages/core/runtime.ts';
const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const errorResponse = (error: unknown) => ({ ...response({ error: error instanceof Error ? error.message : String(error) }), isError: true });

export function createServer(control = new WorkspaceControl(), runtime?: RuntimeAdapter, plugins: ResourcePluginHost = createResourcePluginHost(control.registry)) {
  if (plugins.registry !== control.registry) throw new Error('MCP and plugin host must share the same item registry');
  const server = new McpServer({ name: 'benchgrove', version: '0.1.0' }, { instructions: buildAgentToolContext().prompt });
  server.registerTool('workspace_read', {
    description: 'Read all projects, plugin items, status, links, tasks, archive state and map location. Read before applying commands to obtain the current revision.',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => response(await control.read()));
  server.registerTool('workspace_plugins', {
    description: 'Discover item types, their data schemas and creation fields, appearance, relationships.cardinality (one or many connected items), context support and connected backend capabilities. Find attachment candidates for a URL. New types use these contracts with item.add, not new MCP tools.',
    inputSchema: { input: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ input }) => response({ plugins: control.registry.describe().map(plugin => ({ ...plugin, capabilities: plugins.capabilities(plugin.id) })), candidates: input ? control.registry.matchInput(input) : [] }));
  server.registerTool('workspace_apply', {
    description: 'Apply one command through the shared host controller: create/move/update/attach/archive/restore/complete/reopen/delete a project or item, manage context/reference/blocks links and tasks, or change map location and zoom. link.save enforces each endpoint plugin relationship limit, across directions, link kinds and aliases; a rejected connection leaves state untouched. A blocks link means its source must be finished before its target; self-links, duplicates and cycles are refused. Project membership does not consume an item connection. Completion quiets a map node without changing provider activity or its links. Delete removes the node, its links and task references; deleting a project leaves its items floating. These commands never delete external resources or terminate sessions. Task completion does not change its linked items. Revision mismatch leaves state untouched. Creating a session item records an existing session; use workspace_run to launch one.',
    inputSchema: { expectedRevision: z.number().int().nonnegative().optional().describe('Omit for writes that only add; they apply to the current map. Required when a command changes, moves or removes something that exists.'), command: commandSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ command, expectedRevision }) => {
    try {
      const refusal = agentCommandRefusal(command); if (refusal) throw new Error(refusal);
      if (expectedRevision !== undefined) return response(await control.apply(command, expectedRevision));
      for (let attempt = 1; ; attempt++) {
        const state = await control.read();
        revisionGuard(state, { actor: { kind: 'agent', id: 'mcp-client' }, commands: [command] });
        try { return response(await control.apply(command, state.revision)); }
        catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT' || attempt >= 5) throw error; }
      }
    }
    catch (error) { return errorResponse(error); }
  });
  server.registerTool('workspace_run', {
    description: 'Read plugin content, discover and execute item actions, or get context through registered connectors. resource.action arguments are {actionId, input}. Other operations use the host adapter for sessions, skills and PR workflows. Missing connectors fail explicitly. Runtime actions may send prompts, terminal input or a /review comment externally.',
    inputSchema: runtimeSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (request, extra) => {
    try {
      const refusal = agentRuntimeRefusal(request); if (refusal) throw new Error(refusal);
      if (request.action.startsWith('resource.')) {
        const state = await control.read();
        const node = state.nodes.find(n => n.id === request.nodeId);
        const resource = state.resources.find(r => r.id === node?.resourceId);
        if (!resource) throw new Error('Node is not a resource item');
        if (request.action === 'resource.read') return response(await plugins.load(resource, extra.signal));
        if (request.action === 'resource.actions') return response(plugins.actions(resource, extra.signal));
        if (request.action === 'resource.context') return response(await plugins.getContext(resource, extra.signal));
        const args = z.object({ actionId: z.string().min(1), input: z.record(z.string(), z.json()).default({}) }).parse(request.arguments);
        if (plugins.actions(resource, extra.signal).find(action => action.id === args.actionId)?.humanOnly) throw new Error(humanOnlyMessage);
        return response(await plugins.execute(resource, args.actionId, args.input, extra.signal));
      }
      if (!runtime) throw new Error('Provider runtime is not connected. No session, command, review or comment was started.');
      const state = await control.read();
      const node = state.nodes.find(n => n.id === request.nodeId);
      if (!node) throw new Error('Node not found');
      const context: RuntimeExecutionContext = {};
      if (['agent.start', 'agent.resume', 'skill.run', 'pr.review.codex', 'pr.review.claude', 'pr.architecture'].includes(request.action)) {
        const record = state.resources.find(r => r.id === node.resourceId);
        const guide = buildAgentToolContext({
          projectId: node.projectId ?? (!node.resourceId ? node.id : undefined),
          agentNodeId: record && control.registry.get(record.pluginId)?.acceptsContext ? node.id : undefined,
          workspaceId: typeof record?.data.workspaceId === 'string' ? record.data.workspaceId : undefined,
        });
        context.agentInstructions = Object.freeze({ systemPrompt: guide.prompt, version: guide.version, delivery: request.action === 'agent.resume' ? 'resume' : 'system' });
      }
      return response(await runtime.execute(request, state, Object.freeze(context)));
    } catch (error) { return errorResponse(error); }
  });
  server.registerResource('workspace', 'benchgrove://workspace', { mimeType: 'application/json', description: 'Current workspace graph and revision' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await control.read()) }] }));
  server.registerResource('agent-guide', 'benchgrove://agent-guide', { mimeType: 'text/plain', description: 'How agents keep Agentic Crafting Table in sync during their work' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: buildAgentToolContext().prompt }] }));
  return server;
}

// Start only as an entrypoint, allowing the real app host to import createServer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.BENCHGROVE_STATE_FILE;
  if (!file || !isAbsolute(file)) throw new Error('Set BENCHGROVE_STATE_FILE to an absolute local workspace state file.');
  const server = createServer(new WorkspaceControl(new FileStore(file)));
  await server.connect(new StdioServerTransport());
}
