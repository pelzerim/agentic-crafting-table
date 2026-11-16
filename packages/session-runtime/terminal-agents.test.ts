import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_TABLE_TOOLS_NOTE, prepareTerminalAgent } from './terminal-agents.ts';
import type { TerminalAgentId } from './terminal-agents.ts';
import { WorkspaceControl, MemoryStore } from '../core/control.ts';
import { CLAUDE_ORIENTATION_PROMPT } from '../../src/agents/claude-orientation.ts';
import { DEFAULT_AGENT_PROVIDERS, enabledAgentProviders, settingsSchema } from '../core/settings.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';

const runtime = { directory: '/example/runtime', executable: '/Example App/Electron', entrypoint: '/Example App/dist/session-supervisor.cjs', electronRuntime: true };
const capability = { executable: '/usr/local/bin/example-cli', version: '1.0.0 (test capability)' };
async function applyAll(control: WorkspaceControl, commands: readonly unknown[]) { for (const command of commands) await control.apply(command as never, (await control.read()).revision); }
async function fixture(run: (input: { directory: string; control: WorkspaceControl; request(provider: TerminalAgentId, data?: Record<string, string>): ResourceCreate }) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'craft-terminal-agent-')));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'project', title: 'Billing', summary: 'Project facts', position: { x: 0, y: 0 } }, 0);
    await run({ directory, control, request: (provider, data = {}) => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 1, pluginId: 'agent.session',
      title: `${provider} session`, projectId: 'project', position: { x: 300, y: 0 }, data: { provider, model: 'default', cwd: directory, ...data } }) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('OpenCode gets the table tools and guide through a private config merged over its own', () => fixture(async ({ directory, control, request }) => {
  const input = request('opencode', { task: 'Keep $(printf untrusted) literal' });
  const plan = prepareTerminalAgent('opencode', { request: input, state: await control.read(), directory, runtime, capability });
  const config = plan.launch.bindings?.OPENCODE_CONFIG;
  assert.ok(config?.startsWith(join(directory, 'agent-launches', input.requestId)));
  const parsed = JSON.parse(await readFile(config!, 'utf8'));
  assert.deepEqual(parsed.mcp.crafting_table.command, ['/Example App/Electron', '/Example App/dist/mcp-bridge.cjs']);
  assert.equal(parsed.mcp.crafting_table.environment.ACT_NODE_ID, input.nodeId);
  assert.equal(parsed.mcp.crafting_table.environment.ELECTRON_RUN_AS_NODE, '1');
  assert.match(await readFile(parsed.instructions[0], 'utf8'), /Keep the map in sync/);
  assert.ok(!plan.launch.args.includes('--model'), 'the CLI default model takes no flag');
  assert.match(plan.launch.args[plan.launch.args.indexOf('--prompt') + 1], /Your task\nKeep \$\(printf untrusted\) literal/);
  const data = (plan.commands[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.provider, 'opencode'); assert.equal(data.nativeSessionId, undefined, 'OpenCode names its own sessions');
  const chosen = prepareTerminalAgent('opencode', { request: request('opencode', { model: 'example/model-1' }), state: await control.read(), directory, runtime, capability });
  assert.deepEqual(chosen.launch.args, ['--model', 'example/model-1'], 'no task, no first prompt');
}));

test('Pi keeps its conversation under the table id and is told it has no table tools', () => fixture(async ({ directory, control, request }) => {
  const input = request('pi', { task: 'Fix the build' });
  const plan = prepareTerminalAgent('pi', { request: input, state: await control.read(), directory, runtime, capability });
  const args = plan.launch.args;
  assert.equal(args[args.indexOf('--session-id') + 1], input.requestId);
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], NO_TABLE_TOOLS_NOTE);
  assert.equal(args.at(-2), '--'); assert.match(args.at(-1)!, /Fix the build/);
  assert.equal(plan.launch.bindings, undefined);
  await applyAll(control, plan.commands);
  const resumed = prepareTerminalAgent('pi', { request: { ...input, requestId: randomUUID(), data: {} }, state: await control.read(), directory, runtime, capability, resumeNodeId: input.nodeId });
  assert.equal(resumed.action, 'agent.resume');
  assert.deepEqual(resumed.launch.args, ['--session-id', input.requestId, '--append-system-prompt', NO_TABLE_TOOLS_NOTE], 'resume replays no prompt');
}));

test('Gemini reads the guide in its first prompt, gets the table tools from system defaults and resumes by id', () => fixture(async ({ directory, control, request }) => {
  const input = request('gemini');
  const plan = prepareTerminalAgent('gemini', { request: input, state: await control.read(), directory, runtime, capability });
  const args = plan.launch.args;
  assert.equal(args[args.indexOf('--session-id') + 1], input.requestId);
  const first = args[args.indexOf('--prompt-interactive') + 1];
  assert.match(first, /Keep the map in sync/); assert.ok(first.endsWith(CLAUDE_ORIENTATION_PROMPT), 'a session without a task asks what next');
  const settings = JSON.parse(await readFile(plan.launch.bindings!.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, 'utf8'));
  assert.deepEqual(settings.mcpServers.crafting_table.args, ['/Example App/dist/mcp-bridge.cjs']);
  assert.equal(settings.mcpServers.crafting_table.env.ACT_PROJECT_ID, 'project');
  await applyAll(control, plan.commands);
  const resumed = prepareTerminalAgent('gemini', { request: { ...input, requestId: randomUUID(), data: {} }, state: await control.read(), directory, runtime, capability, resumeNodeId: input.nodeId });
  assert.deepEqual(resumed.launch.args, ['--resume', input.requestId]);
  const recovered = prepareTerminalAgent('gemini', { request: { ...input, requestId: randomUUID(), data: {} }, state: await control.read(), directory, runtime, capability, resumeNodeId: input.nodeId, continueWork: true });
  assert.equal(recovered.launch.args.at(-2), '--prompt-interactive');
}));

test('Grok starts without a first prompt or table tools, and refuses what it cannot do', () => fixture(async ({ directory, control, request }) => {
  const plan = prepareTerminalAgent('grok', { request: request('grok'), state: await control.read(), directory, runtime, capability });
  assert.deepEqual(plan.launch.args, ['--rules', NO_TABLE_TOOLS_NOTE]);
  await assert.rejects(async () => prepareTerminalAgent('grok', { request: request('grok', { task: 'Fix it' }), state: await control.read(), directory, runtime, capability }), /without a first prompt/);
  await applyAll(control, plan.commands);
  const nodeId = plan.nodeId;
  await assert.rejects(async () => prepareTerminalAgent('grok', { request: request('grok'), state: await control.read(), directory, runtime, capability, resumeNodeId: nodeId }), /no resumable Grok conversation/);
  await assert.rejects(async () => prepareTerminalAgent('opencode', { request: request('opencode'), state: await control.read(), directory, runtime, capability, native: { nativeSessionId: randomUUID(), cwd: directory } }), /Continue is not available for OpenCode/);
}));

test('only Claude and Codex are offered until another agent is turned on', () => {
  const defaults = settingsSchema.parse({});
  assert.deepEqual(defaults.agentProviders, DEFAULT_AGENT_PROVIDERS);
  assert.deepEqual(enabledAgentProviders(defaults), ['claude', 'codex']);
  assert.deepEqual(enabledAgentProviders(settingsSchema.parse({ agentProviders: { codex: false, pi: true, grok: true } })), ['claude', 'pi', 'grok']);
});
