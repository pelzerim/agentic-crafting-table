import { settingsSchema } from '../core/settings.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClaude, supportsClaudeAutoMode } from './claude.ts';
import { CLAUDE_ORIENTATION_PROMPT } from '../../src/agents/claude-orientation.ts';
import { WorkspaceControl, MemoryStore } from '../core/control.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';

test('Claude plans keep native arguments, trusted guide and project brief separate and preserve resume identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-claude-'-$-"));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'project', title: 'Billing', summary: 'Project facts should not become system instructions', position: { x: 0, y: 0 } }, 0);
    const request: ResourceCreate = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 1, pluginId: 'agent.session', title: 'Claude task', projectId: 'project', position: { x: 300, y: 0 }, data: { provider: 'claude', model: 'opus', cwd: directory, task: 'Keep $(printf untrusted) as literal task text', summary: 'My edited brief', systemPrompt: 'Caller must not replace the guide' } };
    const runtime = { directory: join(directory, 'runtime'), executable: '/Example App/Electron', entrypoint: '/Example App/dist/session-supervisor.cjs', electronRuntime: true };
    const capability = { executable: '/Users/example/.local/bin/claude', version: '2.1.281 (test capability)' };
    const plan = prepareClaude({ request, state: await control.read(), directory, runtime, capability });
    const linkedRequest: ResourceCreate = { ...request, requestId: randomUUID(), nodeId: randomUUID(), connection: { id: randomUUID(), otherId: 'project', kind: 'context', sourceIsNew: false } };
    const linkedPlan = prepareClaude({ request: linkedRequest, state: await control.read(), directory, runtime, capability });
    assert.deepEqual(linkedPlan.commands.at(-1), { type: 'link.save', link: { id: linkedRequest.connection!.id, sourceId: 'project', targetId: linkedRequest.nodeId, kind: 'context', label: '' } });
    const args = plan.launch.args;
    assert.ok(args.includes('--remote-control'));
    assert.throws(() => settingsSchema.parse({ claude: { arguments: ['--resume=other'] } }), /managed/);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__crafting_table', 'the table tools are pre-approved so auto mode never classifies them');
    const configured = prepareClaude({ request: { ...request, requestId: randomUUID() }, state: await control.read(), directory, runtime, capability, settings: { remoteControl: false, autoMode: false, arguments: ['--effort', 'high', '--verbose'] } });
    assert.equal(configured.launch.args[configured.launch.args.indexOf('--permission-mode') + 1], 'default');
    assert.ok(!configured.launch.args.includes('--remote-control'));
    assert.deepEqual(JSON.parse(configured.launch.args[configured.launch.args.indexOf('--settings') + 1]), { disableRemoteControl: true });
    assert.equal(configured.launch.args[configured.launch.args.indexOf('--effort') + 1], 'high');

    assert.equal(plan.launch.executable, capability.executable);
    // Claude only probes for synchronized output in terminals it knows; the table's frames must still be whole.
    assert.deepEqual(plan.launch.bindings, { CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1' });
    assert.equal(args[args.indexOf('--session-id') + 1], request.requestId);
    const guide = args[args.indexOf('--append-system-prompt') + 1];
    assert.match(guide, /Keep the map in sync/); assert.ok(!guide.includes('My edited brief')); assert.ok(!guide.includes('Caller must not replace'));
    assert.ok(args.at(-1)!.includes('My edited brief')); assert.ok(args.at(-1)!.includes('$(printf untrusted)'));
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    assert.equal(config.mcpServers.crafting_table.env.ACT_NODE_ID, request.nodeId);
    assert.equal(config.mcpServers.crafting_table.env.ELECTRON_RUN_AS_NODE, '1');
    const plugin = args[args.indexOf('--plugin-dir') + 1];
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, '/usr/bin/env');
    assert.ok(hooks.hooks.SessionStart[0].hooks[0].args.includes(directory));
    assert.deepEqual(hooks.hooks.SubagentStop[0].hooks[0].args, hooks.hooks.Stop[0].hooks[0].args, 'background subagent completions reach the table');
    assert.deepEqual(hooks.hooks.TeammateIdle[0].hooks[0].args, hooks.hooks.Stop[0].hooks[0].args, 'a teammate going idle reaches the table');
    for (const event of ['SubagentStart', 'PreCompact', 'PostCompact', 'PostToolUseFailure', 'PermissionDenied', 'TaskCreated', 'TaskCompleted', 'PostModelSwitch']) assert.deepEqual(hooks.hooks[event]?.[0].hooks[0].args, hooks.hooks.Stop[0].hooks[0].args, `${event} reaches the table`);
    assert.equal(hooks.hooks.WorktreeCreate, undefined, 'that hook would have to create the worktree itself'); assert.equal(hooks.hooks.WorktreeRemove, undefined);
    assert.ok(!args.includes('--settings')); assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.deepEqual(prepareClaude({ request, state: await control.read(), directory, runtime, capability, settings: { remoteControl: false, autoMode: false, arguments: ['--verbose'] } }), plan, 'retry retains the original argv despite settings changes');
    const legacy = prepareClaude({ request: { ...request, requestId: randomUUID() }, state: await control.read(), directory, runtime, capability, settings: { remoteControl: true, autoMode: true, arguments: ['--permission-mode=plan', '--verbose'] } });
    assert.equal(legacy.launch.args[legacy.launch.args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(legacy.launch.args.filter(arg => arg.startsWith('--permission-mode')).length, 1);
    const unsupportedInput = { request: { ...request, requestId: randomUUID() }, state: await control.read(), directory, runtime, capability: { ...capability, autoMode: false } };
    assert.throws(() => prepareClaude(unsupportedInput), /turn off Auto mode/);
    const manual = prepareClaude({ ...unsupportedInput, settings: { remoteControl: true, autoMode: false, arguments: [] } });
    assert.equal(manual.launch.args[manual.launch.args.indexOf('--permission-mode') + 1], 'default');
    assert.throws(() => prepareClaude({ request: { ...request, title: 'Changed replay' }, state: {} as any, directory, runtime, capability }), /reused/);
    await control.dispatch({ commandId: 'create-agent', expectedRevision: 1, actor: { kind: 'system', id: 'test' }, commands: plan.commands });
    const state = await control.read();
    const resumed = prepareClaude({ request: { ...request, requestId: randomUUID(), expectedRevision: state.revision, data: {} }, state, directory, runtime, capability, resumeNodeId: request.nodeId });
    assert.equal(resumed.launch.args[resumed.launch.args.indexOf('--resume') + 1], request.requestId);
    assert.equal(resumed.launch.args[resumed.launch.args.indexOf('--permission-mode') + 1], 'auto');
    assert.notEqual(resumed.launch.sessionId, plan.launch.sessionId);
    assert.equal(resumed.nodeId, plan.nodeId); assert.equal(resumed.launch.workspaceId, plan.launch.workspaceId);
    const pickerRequest = { ...request, requestId: randomUUID(), data: { resumeNativeSessionId: request.requestId } };
    const pickerInput = { request: { ...request, requestId: pickerRequest.requestId, expectedRevision: state.revision, data: {} }, state, directory, runtime, capability, resumeNodeId: request.nodeId, originRequest: pickerRequest };
    const pickerPlan = prepareClaude(pickerInput);
    assert.deepEqual(pickerPlan.source, { request: pickerRequest });
    assert.deepEqual(prepareClaude(pickerInput), pickerPlan);
    assert.throws(() => prepareClaude({ ...pickerInput, originRequest: { ...pickerRequest, title: 'Changed' } }), /reused/);

    assert.ok(!resumed.launch.args.includes('--session-id')); assert.ok(!resumed.launch.args.some(value => value.includes('Your task')));
    const recovery = prepareClaude({ request: { ...request, requestId: randomUUID(), expectedRevision: state.revision, data: {} }, state, directory, runtime, capability, resumeNodeId: request.nodeId, continueWork: true });
    assert.equal(recovery.launch.args[recovery.launch.args.indexOf('--resume') + 1], request.requestId);
    assert.match(recovery.launch.args.at(-1)!, /reopened.*unfinished user task/);
    assert.match(recovery.launch.args.at(-1)!, /do not repeat completed actions/);
    await control.apply({ type: 'node.update', id: 'project', workingDirectory: directory }, state.revision);
    const externalId = randomUUID(), importedRequest = { ...request, requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), data: { resumeNativeSessionId: externalId, cwd: '/wrong/untrusted/folder' } };
    const imported = prepareClaude({ request: importedRequest, state: await control.read(), directory, runtime, capability, native: { nativeSessionId: externalId, cwd: directory } });
    assert.equal(imported.launch.args[imported.launch.args.indexOf('--resume') + 1], externalId);
    assert.equal(imported.launch.cwd, plan.launch.cwd);
    assert.ok(!imported.launch.args.includes('--model'), 'external resume keeps Claude’s original model');
    assert.ok(!imported.launch.args.includes('--'), 'resume must not send a new task');
    assert.equal(imported.nodeId, importedRequest.nodeId);
    const idleRequest = { ...request, requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: (await control.read()).revision, data: { provider: 'claude', model: 'fable' } };
    const blank = prepareClaude({ request: { ...idleRequest, requestId: randomUUID() }, state: await control.read(), directory, runtime, capability, blank: true });
    assert.ok(!blank.launch.args.includes('--'), 'a blank session sends no first prompt');
    const idle = prepareClaude({ request: idleRequest, state: await control.read(), directory, runtime, capability });
    assert.equal(idle.launch.cwd, plan.launch.cwd);
    assert.equal(idle.launch.args[idle.launch.args.indexOf('--model') + 1], 'fable');
    assert.equal(idle.launch.args.at(-1), CLAUDE_ORIENTATION_PROMPT);
    assert.equal(idle.launch.args.at(-2), '--');
    assert.match(CLAUDE_ORIENTATION_PROMPT, /What next/);
    assert.match(CLAUDE_ORIENTATION_PROMPT, /wait for my choice/);
    assert.match(CLAUDE_ORIENTATION_PROMPT, /captured revision/);
    assert.ok(CLAUDE_ORIENTATION_PROMPT.length <= 900, 'the opening prompt stays short');
    assert.match(CLAUDE_ORIENTATION_PROMPT, /nothing is connected[^.]*one or two sentences/i);
    assert.doesNotMatch(CLAUDE_ORIENTATION_PROMPT, /for example/i);
    const savedContext = JSON.parse(await readFile(join(directory, 'agent-launches', idleRequest.requestId, 'context.json'), 'utf8'));
    assert.equal(savedContext.initialPrompt, CLAUDE_ORIENTATION_PROMPT);
    assert.ok(!savedContext.systemPrompt.includes('Project facts should not become system instructions'));
    const floating = prepareClaude({ request: { ...idleRequest, requestId: randomUUID(), projectId: undefined, data: { cwd: directory } }, state: await control.read(), directory, runtime, capability });
    assert.equal(floating.launch.args.at(-1), CLAUDE_ORIENTATION_PROMPT);
    assert.equal((idle.commands[0] as any).data.cwd, plan.launch.cwd);
    await control.apply({ type: 'node.update', id: 'project', workingDirectory: '/new/project/default' }, idleRequest.expectedRevision);
    assert.deepEqual(prepareClaude({ request: idleRequest, state: await control.read(), directory, runtime, capability }), idle, 'retry preserves copied working directory');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Claude capability detects the auto choice only in the permission-mode option', () => {
  assert.equal(supportsClaudeAutoMode('--permission-mode <mode> Permission mode\n  (choices: "acceptEdits", "auto", "default")\n  --remote-control [name]'), true);
  assert.equal(supportsClaudeAutoMode('--permission-mode <mode> (choices: "default", "plan")\n  --autocompact <auto|tokens> Default "auto"'), false);
  assert.equal(supportsClaudeAutoMode('--autocompact <auto|tokens> Default "auto"'), false);
});

test('a new Claude session without a folder uses the launch fallback only after the project folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-claude-fallback-'));
  try {
    const project = join(directory, 'project'), fallback = join(directory, 'fallback');
    await mkdir(project); await mkdir(fallback);
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'bare', title: 'Bare', position: { x: 0, y: 0 } }, 0);
    await control.apply({ type: 'project.create', id: 'owned', title: 'Owned', workingDirectory: project, position: { x: 2000, y: 0 } }, 1);
    const runtime = { directory: join(directory, 'runtime'), executable: '/Example App/Electron', entrypoint: '/Example App/dist/session-supervisor.cjs', electronRuntime: true };
    const capability = { executable: '/Users/example/.local/bin/claude', version: 'fixture' };
    const request = (projectId: string): ResourceCreate => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 2, pluginId: 'agent.session', title: 'Claude', projectId, position: { x: 300, y: 0 }, data: { provider: 'claude' } });
    const state = await control.read();
    assert.throws(() => prepareClaude({ request: request('bare'), state, directory, runtime, capability }), /working directory/);
    const bare = request('bare'), planned = prepareClaude({ request: bare, state, directory, runtime, capability, fallbackDirectory: fallback });
    assert.equal(planned.launch.cwd, await realpath(fallback));
    assert.deepEqual(prepareClaude({ request: bare, state, directory, runtime, capability, fallbackDirectory: project }), planned, 'a retry keeps the directory it froze');
    assert.equal(prepareClaude({ request: request('owned'), state, directory, runtime, capability, fallbackDirectory: fallback }).launch.cwd, await realpath(project));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a host-prepared launch replaces the opening prompt and keeps its provenance with the session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-claude-hosted-'));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } }, 0);
    const request: ResourceCreate = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 1, pluginId: 'agent.session', title: 'Architecture · #42', projectId: 'project', position: { x: 300, y: 0 },
      connection: { id: randomUUID(), otherId: 'pr', kind: 'context', sourceIsNew: false }, data: { provider: 'claude', model: 'opus', cwd: directory } };
    const runtime = { directory: join(directory, 'runtime'), executable: '/Example App/Electron', entrypoint: '/Example App/dist/session-supervisor.cjs', electronRuntime: true };
    const capability = { executable: '/Users/example/.local/bin/claude', version: '2.1.281 (test capability)' };
    const hosted = { prompt: 'Read the architecture request file.', data: { architecture: { key: 'pr-architecture:fixture', sourcePrId: 'pr', headSha: 'a'.repeat(40) } } };
    const plan = prepareClaude({ request, state: await control.read(), directory, runtime, capability, hosted });
    assert.equal(plan.launch.args.at(-1), hosted.prompt);
    assert.ok(!plan.launch.args.includes(CLAUDE_ORIENTATION_PROMPT));
    const added = plan.commands.find(command => command.type === 'item.add') as { data: Record<string, unknown> };
    assert.deepEqual(added.data.architecture, hosted.data.architecture);
    assert.equal(added.data.provider, 'claude');
    assert.deepEqual(plan.commands.at(-1), { type: 'link.save', link: { id: request.connection!.id, sourceId: 'pr', targetId: request.nodeId, kind: 'context', label: '' } });
    assert.deepEqual(prepareClaude({ request, state: await control.read(), directory, runtime, capability, hosted }), plan);
    const state = await control.read();
    assert.throws(() => prepareClaude({ request, state, directory, runtime, capability, hosted: { ...hosted, prompt: 'Something else' } }), /reused/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a host-prepared launch placed by an item lands beside it with labelled connections, the default model and no fixed position', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-claude-placed-'));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'project', title: 'Web', position: { x: 0, y: 0 } }, 0);
    const link = (otherId: string, label?: string) => ({ id: randomUUID(), otherId, kind: 'context' as const, sourceIsNew: false, ...(label ? { label } : {}) });
    const request: ResourceCreate = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'agent.session', title: 'Validate · App / Deploy', projectId: 'project', placedBy: 'rollout',
      connections: [link('rollout', 'Validation'), link('pr')], data: { provider: 'claude', cwd: directory } };
    const runtime = { directory: join(directory, 'runtime'), executable: '/Example App/Electron', entrypoint: '/Example App/dist/session-supervisor.cjs', electronRuntime: true };
    const plan = prepareClaude({ request, state: await control.read(), directory, runtime, capability: { executable: '/Users/example/.local/bin/claude', version: '2.1.281 (test capability)' }, hosted: { prompt: 'Check whether this rollout works as intended.', data: {} } });
    const added = plan.commands.find(command => command.type === 'item.add') as { near?: string[]; position?: unknown; data: Record<string, unknown> };
    assert.deepEqual(added.near, ['rollout', 'pr']); assert.equal(added.position, undefined); assert.equal(plan.expectedRevision, undefined);
    assert.equal(added.data.model, 'opus'); assert.equal(plan.launch.args[plan.launch.args.indexOf('--model') + 1], 'opus');
    assert.equal(plan.launch.args.at(-1), 'Check whether this rollout works as intended.'); assert.equal(plan.launch.readOnly, undefined);
    assert.deepEqual(plan.commands.filter(command => command.type === 'link.save').map(command => [command.link.sourceId, command.link.targetId, command.link.kind, command.link.label]),
      [['rollout', request.nodeId, 'context', 'Validation'], ['pr', request.nodeId, 'context', '']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
