import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { canonical } from '../core/control.ts';
import type { AppSettings } from '../core/settings.ts';
import { creationConnections, creationNear, requestConnections } from '../core/resource-creation.ts';
import { findExecutable, sessionPath } from '../platform/shell.ts';
import { readAgentPlan, RECOVERY_PROMPT } from './agent-plan.ts';
import type { AgentCapability, AgentPreparation } from './agent-plan.ts';
import { launchSchema } from './protocol.ts';
import type { LaunchRequest } from './protocol.ts';
import { buildAgentLaunch } from '../../src/agents/project-context.ts';
import { buildAgentToolContext } from '../../src/agents/tool-context.ts';
import { CLAUDE_ORIENTATION_PROMPT } from '../../src/agents/claude-orientation.ts';
import type { PreparedSession } from '../workspace-service/sessions.ts';

/** Agent CLIs the table starts in a plain terminal, without a provider-specific status channel. Off by default. */
export const TERMINAL_AGENT_IDS = ['opencode', 'pi', 'gemini', 'grok'] as const;
export type TerminalAgentId = typeof TERMINAL_AGENT_IDS[number];
/** The model a CLI is configured with; no `--model` flag is passed. */
export const CLI_DEFAULT_MODEL = 'default';

/** What a launch gives a spec to build its argv, environment and private files from. */
interface LaunchParts {
  launchDirectory: string;
  /** The table's workbench guide, for CLIs that get the table tools. */
  guide: string;
  /** The first prompt, when the launch has one. */
  prompt?: string;
  /** Set for CLIs that save conversations under an id the table chooses. */
  nativeSessionId?: string;
  resumed: boolean;
  model: string;
  thinking: AppSettings['agentThinking'];
  mcp: { command: string; args: string[]; env: Record<string, string> };
}
interface TerminalAgentSpec {
  name: string;
  executable: string;
  /** Extra folders an installer puts the CLI in, when a GUI launch lacks the shell PATH. */
  folders: string[];
  /** Flags the launch passes; a CLI whose `--help` lacks one is too old. */
  requiredFlags: string[];
  /** The CLI saves its conversation under the id the table passes, so Resume can reopen it. */
  ownSessionId: boolean;
  /** A per-launch config gives the CLI the crafting table MCP server without changing user configuration. */
  tableTools: boolean;
  /** The CLI takes a first prompt and stays interactive. */
  firstPrompt: boolean;
  args(parts: LaunchParts): string[];
  bindings?(parts: LaunchParts): LaunchRequest['bindings'];
  files?(parts: LaunchParts): Record<string, string>;
}
const model = (parts: LaunchParts) => parts.model === CLI_DEFAULT_MODEL || parts.model === 'native' ? [] : ['--model', parts.model];
/** Said to a CLI that has no table tools, so it does not look for them. */
export const NO_TABLE_TOOLS_NOTE = 'You run in a terminal item of Agentic Crafting Table. This session has no crafting table tools: the person keeps the table in sync.';

export const terminalAgentSpecs: Readonly<Record<TerminalAgentId, TerminalAgentSpec>> = {
  // OPENCODE_CONFIG is merged over the user's own configuration (global and project files stay in effect).
  opencode: {
    name: 'OpenCode', executable: 'opencode', folders: [join(homedir(), '.opencode/bin')], requiredFlags: ['--model', '--prompt'], ownSessionId: false, tableTools: true, firstPrompt: true,
    args: parts => [...model(parts), ...(parts.prompt ? ['--prompt', parts.prompt] : [])],
    bindings: parts => ({ OPENCODE_CONFIG: join(parts.launchDirectory, 'opencode.json') }),
    files: parts => ({
      'guide.md': parts.guide,
      'opencode.json': JSON.stringify({ $schema: 'https://opencode.ai/config.json', instructions: [join(parts.launchDirectory, 'guide.md')],
        mcp: { crafting_table: { type: 'local', command: [parts.mcp.command, ...parts.mcp.args], environment: parts.mcp.env, enabled: true } } }, null, 2),
    }),
  },
  // Pi has no MCP client of its own; extensions may add one, so the table does not assume it.
  pi: {
    name: 'Pi', executable: 'pi', folders: [], requiredFlags: ['--session-id', '--append-system-prompt', '--model'], ownSessionId: true, tableTools: false, firstPrompt: true,
    args: parts => ['--session-id', parts.nativeSessionId!, ...(parts.resumed ? [] : model(parts)), '--append-system-prompt', NO_TABLE_TOOLS_NOTE, ...(parts.prompt ? ['--', parts.prompt] : [])],
  },
  // The system defaults file has the lowest precedence, and Gemini merges `mcpServers` across its settings files.
  gemini: {
    name: 'Gemini', executable: 'gemini', folders: [], requiredFlags: ['--session-id', '--resume', '--prompt-interactive', '--model'], ownSessionId: true, tableTools: true, firstPrompt: true,
    args: parts => [...(parts.resumed ? ['--resume', parts.nativeSessionId!] : ['--session-id', parts.nativeSessionId!, ...model(parts)]),
      // Gemini has no flag that appends to its system prompt (GEMINI_SYSTEM_MD replaces it), so a new conversation reads the guide first.
      ...(parts.prompt || !parts.resumed ? ['--prompt-interactive', parts.resumed ? parts.prompt! : [parts.guide, parts.prompt ?? CLAUDE_ORIENTATION_PROMPT].join('\n\n')] : [])],
    bindings: parts => ({ GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(parts.launchDirectory, 'gemini-settings.json') }),
    files: parts => ({ 'gemini-settings.json': JSON.stringify({ mcpServers: { crafting_table: parts.mcp }, ui: { inlineThinkingMode: parts.thinking === 'expanded' ? 'full' : 'off' } }, null, 2) }),
  },
  // Grok Build reads MCP servers only from its own and the project's config files, which the table does not write.
  grok: {
    name: 'Grok', executable: 'grok', folders: [], requiredFlags: [], ownSessionId: false, tableTools: false, firstPrompt: false,
    args: parts => [...model(parts), '--rules', NO_TABLE_TOOLS_NOTE],
  },
};
export function isTerminalAgent(id: unknown): id is TerminalAgentId { return typeof id === 'string' && (TERMINAL_AGENT_IDS as readonly string[]).includes(id); }

const capabilities = new Map<TerminalAgentId, Promise<AgentCapability>>();
export function probeTerminalAgent(id: TerminalAgentId): Promise<AgentCapability> {
  let capability = capabilities.get(id);
  if (!capability) {
    capability = (async () => {
      const spec = terminalAgentSpecs[id], env = { ...process.env, PATH: await sessionPath() };
      const executable = findExecutable(spec.executable, env.PATH, [...spec.folders, join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']);
      if (!executable) throw new Error(`${spec.name} CLI is not installed. Install and sign in to ${spec.name}, then retry.`);
      const exec = promisify(execFile);
      const [version, help] = await Promise.all([exec(executable, ['--version'], { timeout: 10_000, env }), spec.requiredFlags.length ? exec(executable, ['--help'], { timeout: 10_000, env }) : undefined]);
      const output = (help?.stdout ?? '') + (help?.stderr ?? '');
      if (spec.requiredFlags.some(flag => !output.includes(flag))) throw new Error(`This ${spec.name} version lacks flags the table needs (${spec.requiredFlags.join(', ')}). Update ${spec.name} and retry.`);
      return { executable: realpathSync(executable), version: (version.stdout || version.stderr).trim().split('\n')[0].slice(0, 100) };
    })().catch(error => { capabilities.delete(id); throw error; });
    capabilities.set(id, capability);
  }
  return capability;
}

const fieldsSchema = z.object({ cwd: z.string().min(1, 'Select a working directory for this session or its project').max(4096), model: z.string().trim().min(1).max(200).default(CLI_DEFAULT_MODEL), task: z.string().max(32_000).default('') });
/** Only the host builds this plan. User text reaches the CLI as one argv entry and is never interpolated into a shell. */
export function prepareTerminalAgent(id: TerminalAgentId, input: AgentPreparation, thinking: AppSettings['agentThinking'] = 'collapsed'): PreparedSession {
  const spec = terminalAgentSpecs[id], { request, state, runtime, capability } = input;
  const source = JSON.parse(JSON.stringify(input.originRequest ? { request: input.originRequest } : { request, ...(input.resumeNodeId ? { resumeNodeId: input.resumeNodeId } : {}), ...(input.continueWork ? { continueWork: true } : {}), ...(input.blank ? { blank: true } : {}) }));
  const saved = readAgentPlan(input.directory, request.requestId);
  if (saved) { if (canonical(saved.source) !== canonical(source)) throw new Error('Agent launch ID was reused with different input'); return saved; }
  if (input.native) throw new Error(`Continue is not available for ${spec.name}. Start a new session.`);
  if (input.hosted) throw new Error(`${spec.name} cannot run this workflow. Use Claude.`);
  const resumedNode = input.resumeNodeId ? state.nodes.find(node => node.id === input.resumeNodeId) : undefined;
  const resumed = state.resources.find(resource => resource.id === resumedNode?.resourceId);
  if (input.resumeNodeId && (!resumedNode || !resumed || resumed.data.provider !== id || !spec.ownSessionId || typeof resumed.data.nativeSessionId !== 'string')) throw new Error(`This item has no resumable ${spec.name} conversation`);
  const projectId = resumedNode?.projectId ?? request.projectId, project = state.nodes.find(node => node.id === projectId && !node.resourceId);
  if (projectId && !project) throw new Error('Project is no longer available');
  const fields = fieldsSchema.parse(resumed ? { cwd: resumed.data.cwd, model: resumed.data.model } : { ...request.data, cwd: request.data.cwd || project?.workingDirectory || input.fallbackDirectory || '' });
  if (!isAbsolute(fields.cwd) || !statSync(fields.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Choose an existing working directory');
  const opening = input.skill?.prompt ?? (resumed ? input.continueWork ? RECOVERY_PROMPT : undefined : fields.task.trim() || undefined);
  if (opening && !spec.firstPrompt) throw new Error(`${spec.name} starts without a first prompt. Start it without a task and type the task in its terminal.`);
  const cwd = realpathSync(fields.cwd), workspaceId = resumed ? String(resumed.data.workspaceId) : `local:${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
  const nodeId = resumedNode?.id ?? request.nodeId, nativeSessionId = spec.ownSessionId ? resumed ? String(resumed.data.nativeSessionId) : request.requestId : undefined;
  const binding = { agentNodeId: nodeId, workspaceId };
  const context = project ? buildAgentLaunch({ id: project.id, name: project.title, goal: project.summary }, id, fields.task, undefined, [], binding)
    : { projectSummary: 'A floating agent on your table.', toolContext: buildAgentToolContext(binding), systemPrompt: buildAgentToolContext(binding).prompt, initialPrompt: fields.task ? `Workspace context\nA floating agent with no project.\n\nYour task\n${fields.task}` : '' };
  const prompt = input.skill?.prompt ?? (resumed ? opening : context.initialPrompt || undefined);
  const launchDirectory = join(input.directory, 'agent-launches', request.requestId), runtimeDirectory = dirname(runtime.entrypoint);
  const parts: LaunchParts = { launchDirectory, guide: context.systemPrompt, prompt: input.blank ? undefined : prompt, nativeSessionId, resumed: Boolean(resumed), model: fields.model, thinking,
    mcp: { command: runtime.executable, args: [join(runtimeDirectory, 'mcp-bridge.cjs')], env: {
      ...(runtime.electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ACT_DATA_DIR: input.directory, ACT_NODE_ID: nodeId, ACT_WORKSPACE_ID: workspaceId, ...(projectId ? { ACT_PROJECT_ID: projectId } : {}) } } };
  const data = { ...(resumed?.data ?? {}), sessionId: request.requestId, ...(nativeSessionId ? { nativeSessionId } : {}), provider: id, workspaceId, cwd, model: fields.model,
    cliVersion: capability.version, ...(spec.tableTools ? { guideVersion: context.toolContext.version } : {}), projectSummary: context.projectSummary, launchDirectory,
    ...(input.skill ? { skill: { id: input.skill.id, name: input.skill.name } } : {}) };
  const plan: PreparedSession = { requestId: request.requestId, expectedRevision: request.expectedRevision, nodeId, action: resumed ? 'agent.resume' : 'agent.create', source,
    launch: { stopOnArchive: true, sessionId: request.requestId, requestId: request.requestId, nodeId, ...(resumed ? { predecessorId: String(resumed.data.sessionId) } : {}), workspaceId,
      executable: capability.executable, args: spec.args(parts), cwd, cols: 100, rows: 30, ...(spec.bindings ? { bindings: spec.bindings(parts) } : {}) },
    commands: resumed ? [{ type: 'item.update', id: nodeId, data }, { type: 'node.update', id: nodeId, activity: 'unknown', attention: 'none', summary: `Resuming ${spec.name}…` }]
      : [{ type: 'item.add', id: nodeId, resourceId: request.resourceId, pluginId: 'agent.session', title: request.title, data, projectId, position: request.position, ...creationNear(request), ...(request.hidden ? { hidden: request.hidden } : {}) },
        { type: 'node.update', id: nodeId, activity: 'unknown', attention: 'none', summary: `Starting ${spec.name}…` }],
  };
  plan.commands.push(...creationConnections(requestConnections(requestConnections(input.originRequest).length ? input.originRequest : request), nodeId));
  // Before the item exists: a launch the supervisor would refuse must not leave one behind.
  launchSchema.parse(plan.launch);
  mkdirSync(launchDirectory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(spec.files?.(parts) ?? {})) writeFileSync(join(launchDirectory, name), content, { mode: 0o600 });
  writeFileSync(join(launchDirectory, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  return plan;
}
