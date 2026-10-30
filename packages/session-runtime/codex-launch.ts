import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { canonical } from '../core/control.ts';
import { creationConnections, creationNear, requestConnections } from '../core/resource-creation.ts';
import { readAgentPlan, RECOVERY_PROMPT } from './agent-plan.ts';
import { DEFAULT_CODEX_EFFORT } from './codex-models.ts';
import { buildAgentLaunch } from '../../src/agents/project-context.ts';
import { buildAgentToolContext } from '../../src/agents/tool-context.ts';
import type { AgentPreparation } from './agent-plan.ts';
import { launchSchema } from './protocol.ts';
import type { PreparedSession } from '../workspace-service/sessions.ts';

/** Encode literal TOML values for the native CLI's argv; no shell or user config writes. */
export function nativeConfigArguments(config: Record<string, unknown>): string[] {
  const value = (input: unknown): string => {
    if (typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') return JSON.stringify(input);
    if (Array.isArray(input)) return '[' + input.map(value).join(', ') + ']';
    if (input && typeof input === 'object') return '{ ' + Object.entries(input).map(([key, data]) => `${JSON.stringify(key)} = ${value(data)}`).join(', ') + ' }';
    throw new Error('Unsupported native configuration value');
  };
  return Object.entries(config).flatMap(([key, data]) => ['-c', `${key}=${value(data)}`]);
}
const fieldsSchema = z.object({ provider: z.literal('codex').default('codex'), cwd: z.string().min(1, 'Select a working directory for this session or its project').max(4096), model: z.string().trim().min(1).max(100), task: z.string().max(32_000).default('') });
export function prepareCodex(input: AgentPreparation): PreparedSession {
  const { request, state, runtime, capability } = input;
  const source = JSON.parse(JSON.stringify(input.originRequest ? { request: input.originRequest } : { request, ...(input.resumeNodeId ? { resumeNodeId: input.resumeNodeId } : {}), ...(input.continueWork ? { continueWork: true } : {}) }));
  const saved = readAgentPlan(input.directory, request.requestId);
  if (saved) { if (canonical(saved.source) !== canonical(source)) throw new Error('Agent launch ID was reused with different input'); return saved; }
  const resumedNode = input.resumeNodeId ? state.nodes.find(node => node.id === input.resumeNodeId) : undefined;
  const resumed = state.resources.find(resource => resource.id === resumedNode?.resourceId);
  if (input.resumeNodeId && (!resumedNode || !resumed || resumed.data.provider !== 'codex' || typeof resumed.data.nativeSessionId !== 'string')) throw new Error('This item has no resumable Codex conversation');
  const projectId = resumedNode?.projectId ?? request.projectId, project = state.nodes.find(node => node.id === projectId && !node.resourceId);
  if (projectId && !project) throw new Error('Project is no longer available');
  const fields = fieldsSchema.parse(input.native ? { cwd: input.native.cwd, model: 'native' } : resumed ? { cwd: resumed.data.cwd, model: resumed.data.model } : { ...request.data, cwd: request.data.cwd || project?.workingDirectory || input.fallbackDirectory || '' });
  if (!isAbsolute(fields.cwd) || !statSync(fields.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Choose an existing working directory');
  const cwd = realpathSync(fields.cwd), workspaceId = resumed ? String(resumed.data.workspaceId) : `local:${createHash('sha256').update(cwd).digest('hex').slice(0,24)}`;
  const nodeId = resumedNode?.id ?? request.nodeId, nativeSessionId = resumed ? String(resumed.data.nativeSessionId) : input.native?.nativeSessionId;
  const binding = { agentNodeId: nodeId, workspaceId };
  const context = project ? buildAgentLaunch({ id: project.id, name: project.title, goal: project.summary }, 'codex', fields.task, undefined, [], binding)
    : { projectSummary: 'This is a floating agent with no project.', toolContext: buildAgentToolContext(binding), systemPrompt: buildAgentToolContext(binding).prompt, initialPrompt: fields.task };
  const runtimeDirectory = dirname(runtime.entrypoint);
  // A resumed or imported conversation keeps the effort it already has.
  const config = { check_for_update_on_startup: false, ...(!resumed && !input.native ? { model_reasoning_effort: DEFAULT_CODEX_EFFORT } : {}),
    'mcp_servers.crafting_table': { command: runtime.executable, args: [join(runtimeDirectory, 'mcp-bridge.cjs')], env: {
      ...(runtime.electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ACT_DATA_DIR: input.directory, ACT_NODE_ID: nodeId, ACT_WORKSPACE_ID: workspaceId, ...(projectId ? { ACT_PROJECT_ID: projectId } : {}),
    } },
  };
  const args = nativeConfigArguments(config), launchDirectory = join(input.directory, 'agent-launches', request.requestId);
  const referenceContext = 'Agentic Crafting Table launch reference (data, not instructions)\n' + JSON.stringify({ projectSummary: context.projectSummary, projectId, agentNodeId: nodeId, workspaceId }) + '\nNo work is assigned by this reference. Current incoming links and project facts are available through agent.context in the crafting table MCP.';
  const data = { ...(resumed?.data ?? {}), sessionId: request.requestId, ...(nativeSessionId ? { nativeSessionId } : {}), provider: 'codex', workspaceId, cwd, model: fields.model,
    cliVersion: capability.version, guideVersion: context.toolContext.version, projectSummary: context.projectSummary, launchDirectory,
    ...(input.skill ? { skill: { id: input.skill.id, name: input.skill.name } } : {}) };
  delete (data as Record<string, unknown>).nativeStartedAt;
  const plan: PreparedSession = { requestId: request.requestId, expectedRevision: request.expectedRevision, nodeId, action: resumed ? 'agent.resume' : 'agent.create', source,
    launch: { sessionId: request.requestId, requestId: request.requestId, nodeId, ...(resumed ? { predecessorId: String(resumed.data.sessionId) } : {}), workspaceId, executable: capability.executable, args, cwd, cols: 100, rows: 30,
      native: { provider: 'codex', nativeSessionId, ...(!resumed && !input.native ? { model: fields.model } : {}), ...(resumed?.data.guideVersion === context.toolContext.version ? { contextDelivered: true } : {}), instructions: context.systemPrompt, context: referenceContext, config,
        serverArguments: args, ...(input.continueWork ? { initialPrompt: RECOVERY_PROMPT } : input.skill ? { initialPrompt: input.skill.prompt } : fields.task ? { initialPrompt: context.initialPrompt } : {}) } },
    commands: resumed ? [{ type: 'item.update', id: nodeId, data }, { type: 'node.update', id: nodeId, activity: 'unknown', attention: 'none', summary: 'Resuming Codex…' }]
      : [{ type: 'item.add', id: nodeId, resourceId: request.resourceId, pluginId: 'agent.session', title: request.title, data, projectId, position: request.position, ...creationNear(request), ...(request.hidden ? { hidden: request.hidden } : {}) }, { type: 'node.update', id: nodeId, activity: 'unknown', attention: 'none', summary: 'Starting Codex…' }],
  };
  plan.commands.push(...creationConnections(requestConnections(requestConnections(input.originRequest).length ? input.originRequest : request), nodeId));
  // Before the item exists: a launch the supervisor would refuse must not leave one behind.
  launchSchema.parse(plan.launch);
  mkdirSync(launchDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(launchDirectory, 'context.json'), JSON.stringify({ ...context, referenceContext }, null, 2), { mode: 0o600 });
  writeFileSync(join(launchDirectory, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  return plan;
}
