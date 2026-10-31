import type { AgentPreparation, AgentCapability } from './agent-plan.ts';
import { readAgentPlan, RECOVERY_PROMPT } from './agent-plan.ts';
export { readAgentPlan as readClaudePlan } from './agent-plan.ts';
import { settingsSchema } from '../core/settings.ts';
import type { AppSettings } from '../core/settings.ts';
import { sessionPath } from './shell-path.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { canonical } from '../core/control.ts';
import { creationConnections, creationNear, requestConnections } from '../core/resource-creation.ts';
import type { PreparedSession } from '../workspace-service/sessions.ts';
import { buildAgentLaunch } from '../../src/agents/project-context.ts';
import { buildAgentToolContext } from '../../src/agents/tool-context.ts';
import { CLAUDE_ORIENTATION_PROMPT } from '../../src/agents/claude-orientation.ts';
import { claudePermissionSettings } from '../core/claude-settings.ts';

export type ClaudeCapability = AgentCapability;
const requiredFlags = ['--append-system-prompt', '--session-id', '--resume', '--mcp-config', '--plugin-dir', '--system-prompt-snapshot'];
let capability: Promise<ClaudeCapability> | undefined;
export function supportsClaudeAutoMode(help: string) {
  const mode = help.match(/--permission-mode\b[^\n]*(?:\n(?!\s+--)[^\n]*)*/)?.[0];
  return Boolean(mode && /["']auto["']/.test(mode));
}
export function probeClaude(): Promise<ClaudeCapability> {
  if (!capability) capability = (async () => {
    const env = { ...process.env, PATH: await sessionPath() };
    const candidates = [...env.PATH.split(':').filter(Boolean).map(path => join(path, 'claude')), join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
    const executable = candidates.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
    if (!executable) throw new Error('Claude Code is not installed. Install and sign in to the Claude CLI, then retry.');
    const exec = promisify(execFile);
    const [version, help] = await Promise.all([exec(executable, ['--version'], { timeout: 5000, env }), exec(executable, ['--help'], { timeout: 5000, env })]);
    if (requiredFlags.some(flag => !help.stdout.includes(flag))) throw new Error('This Claude Code version lacks required native launch/resume features. Update Claude Code and retry.');
    return { executable: realpathSync(executable), version: version.stdout.trim().slice(0, 100), remoteControl: help.stdout.includes('--remote-control'), autoMode: supportsClaudeAutoMode(help.stdout) };
  })().catch(error => { capability = undefined; throw error; });
  return capability;
}

/** Claude's `/fork` runs as a background session, and it refuses to resume one until it stops. The conversation is kept.
 * `claude stop` matches a background job by the short id Claude prints, and refuses the full session id. */
export async function stopClaudeBackground(id: string) {
  const installed = await probeClaude();
  await promisify(execFile)(installed.executable, ['stop', id.slice(0, 8)], { timeout: 10_000, env: { ...process.env, PATH: await sessionPath() } });
}

export const claudeCreateFields = z.object({ provider: z.literal('claude').default('claude'), cwd: z.string().min(1, 'Select a working directory for this session or its project').max(4096), model: z.string().trim().min(1).max(100).default('opus'), task: z.string().trim().max(32_000).default(''), summary: z.string().max(4000).optional() });
export interface ClaudePreparation extends AgentPreparation { settings?: AppSettings['claude'] }

/** Only the host builds this plan. User text is never interpolated into a shell. */
export function prepareClaude(input: ClaudePreparation): PreparedSession {
  const { request, state, runtime, capability } = input;
  const source = JSON.parse(JSON.stringify(input.originRequest ? { request: input.originRequest } : { request, ...(input.resumeNodeId ? { resumeNodeId: input.resumeNodeId } : {}), ...(input.continueWork ? { continueWork: true } : {}), ...(input.hosted ? { hosted: input.hosted } : {}), ...(input.blank ? { blank: true } : {}) }));
  const launchDirectory = join(input.directory, 'agent-launches', request.requestId), planPath = join(launchDirectory, 'plan.json');
  const saved = readAgentPlan(input.directory, request.requestId);
  if (saved) {
    if (canonical(saved.source) !== canonical(source)) throw new Error('Agent launch ID was reused with different input');
    return saved;
  }
  const resumedNode = input.resumeNodeId ? state.nodes.find(node => node.id === input.resumeNodeId) : undefined;
  const resumed = state.resources.find(resource => resource.id === resumedNode?.resourceId);
  if (input.resumeNodeId && (!resumedNode || !resumed || resumed.data.provider !== 'claude' || typeof resumed.data.nativeSessionId !== 'string')) throw new Error('This item has no resumable Claude conversation');
  const projectDefault = state.nodes.find(node => node.id === request.projectId && !node.resourceId)?.workingDirectory;
  const fields = input.native ? claudeCreateFields.parse({ cwd: input.native.cwd, model: 'native' }) : resumed ? claudeCreateFields.parse({ provider: 'claude', cwd: resumed.data.cwd, model: resumed.data.model }) : claudeCreateFields.parse({ ...request.data, cwd: request.data.cwd || projectDefault || input.fallbackDirectory || '' });
  if (!isAbsolute(fields.cwd) || !statSync(fields.cwd).isDirectory()) throw new Error('Choose an existing working directory');
  const cwd = realpathSync(fields.cwd), workspaceId = resumed ? String(resumed.data.workspaceId) : `local:${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
  const nodeId = resumedNode?.id ?? request.nodeId, nativeSessionId = resumed ? String(resumed.data.nativeSessionId) : input.native?.nativeSessionId ?? request.requestId;
  const projectId = resumedNode?.projectId ?? request.projectId;
  const project = state.nodes.find(node => node.id === projectId && !node.resourceId);
  if (projectId && !project) throw new Error('Project is no longer available');
  const binding = { agentNodeId: nodeId, workspaceId };
  const context = project ? buildAgentLaunch({ id: project.id, name: project.title, goal: project.summary }, 'claude', fields.task, fields.summary, [], binding) : {
    projectSummary: fields.summary || 'A floating agent on your table.', toolContext: buildAgentToolContext(binding),
    systemPrompt: buildAgentToolContext(binding).prompt, initialPrompt: `Workspace context\nA floating agent with no project.\n\nYour task\n${fields.task}`,
  };
  const orientation = !resumed && !input.native && !input.skill && !input.hosted && !fields.task;
  const launchContext = orientation ? { ...context, initialPrompt: CLAUDE_ORIENTATION_PROMPT } : context;
  mkdirSync(join(launchDirectory, 'plugin', '.claude-plugin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(launchDirectory, 'plugin', 'hooks'), { recursive: true, mode: 0o700 });
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  const runtimeDirectory = dirname(runtime.entrypoint);
  const mcpConfig = join(launchDirectory, 'mcp.json');
  save(mcpConfig, { mcpServers: { crafting_table: { type: 'stdio', command: runtime.executable, args: [join(runtimeDirectory, 'mcp-bridge.cjs')], env: {
    ...(runtime.electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ACT_DATA_DIR: input.directory, ACT_NODE_ID: nodeId, ACT_WORKSPACE_ID: workspaceId, ...(projectId ? { ACT_PROJECT_ID: projectId } : {}),
  } } } });
  save(join(launchDirectory, 'plugin', '.claude-plugin', 'plugin.json'), { name: 'agent-crafting-table', version: '0.1.0', description: 'Keep this native Claude session in sync with its crafting table.' });
  const hookArguments = [...(runtime.electronRuntime ? ['ELECTRON_RUN_AS_NODE=1'] : []), runtime.executable, join(runtimeDirectory, 'agent-hook.cjs'), input.directory, nodeId, request.requestId, nativeSessionId];
  // WorktreeCreate is left out on purpose: Claude Code hands the creation of the worktree to whoever registers it.
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop', 'TeammateIdle',
    'SubagentStart', 'PreCompact', 'PostCompact', 'PostToolUseFailure', 'PermissionDenied', 'TaskCreated', 'TaskCompleted', 'PostModelSwitch'];
  // A session-local plugin adds hooks without rewriting user/project settings.
  save(join(launchDirectory, 'plugin', 'hooks', 'hooks.json'), { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: '/usr/bin/env', args: hookArguments, timeout: 5 }] }]])) });
  const launchSettings = input.settings ?? settingsSchema.parse({}).claude;
  if (launchSettings.remoteControl && capability.remoteControl === false) throw new Error('This Claude Code version does not support Remote Control. Update Claude or turn it off in Settings.');
  const permission = claudePermissionSettings(launchSettings);
  if (permission.mode === 'auto' && capability.autoMode === false) throw new Error('This Claude Code version does not support Auto mode. Update Claude or turn off Auto mode in Settings → Items → Claude.');
  const args = [resumed || input.native ? '--resume' : '--session-id', nativeSessionId, ...(fields.model === 'native' ? [] : ['--model', fields.model]), '--append-system-prompt', context.systemPrompt,
    '--system-prompt-snapshot', 'off', '--mcp-config', mcpConfig, '--plugin-dir', join(launchDirectory, 'plugin'), '--allowedTools', 'mcp__crafting_table', ...permission.arguments, '--permission-mode', permission.mode, ...(launchSettings.remoteControl ? ['--remote-control'] : ['--settings', JSON.stringify({ disableRemoteControl: true })])];
  if (!resumed && !input.native && !input.blank) args.push('--', input.skill?.prompt ?? input.hosted?.prompt ?? launchContext.initialPrompt);
  if (resumed && input.continueWork) args.push('--', RECOVERY_PROMPT);
  // Host provenance never overrides the session identity fields that follow.
  const data = { ...(resumed?.data ?? {}), ...(!resumed ? input.hosted?.data ?? {} : {}), sessionId: request.requestId, nativeSessionId, provider: 'claude', workspaceId, cwd, model: fields.model,
    cliVersion: capability.version, launchSettings, guideVersion: context.toolContext.version, projectSummary: context.projectSummary, ...(fields.summary ? { briefOverride: fields.summary } : {}), launchDirectory,
    ...(input.skill ? { skill: { id: input.skill.id, name: input.skill.name } } : {}) };
  delete (data as Record<string, unknown>).nativeStartedAt;
  // Claude probes for synchronized output only in terminals it knows by name;
  // the table's emulator supports it, and torn frames while scrolling are worse
  // than any probe. Forcing it leaves the wheel profile the native one.
  const plan: PreparedSession = {
    requestId: request.requestId, expectedRevision: request.expectedRevision, nodeId, action: resumed ? 'agent.resume' : 'agent.create', source,
    launch: { stopOnArchive: true, sessionId: request.requestId, requestId: request.requestId, nodeId, ...(resumed ? { predecessorId: String(resumed.data.sessionId) } : {}), workspaceId, executable: capability.executable, args, cwd, cols: 100, rows: 30, bindings: { CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1' } },
    commands: resumed ? [{ type: 'item.update', id: nodeId, data }, { type: 'node.update', id: nodeId, activity: 'unknown', attention: 'none', summary: 'Resuming Claude…' }]
      : [{ type: 'item.add', id: nodeId, resourceId: request.resourceId, pluginId: 'agent.session', title: request.title, data, projectId, position: request.position, ...creationNear(request), ...(request.hidden ? { hidden: request.hidden } : {}) },
        { type: 'node.update', id: nodeId, activity: 'unknown', attention: 'none', summary: 'Starting Claude…' }],
  };
  plan.commands.push(...creationConnections(requestConnections(requestConnections(input.originRequest).length ? input.originRequest : request), nodeId));
  save(join(launchDirectory, 'context.json'), launchContext); save(planPath, plan); return plan;
}
