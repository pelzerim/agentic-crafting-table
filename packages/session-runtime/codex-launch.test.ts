import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceControl, MemoryStore, canonical } from '../core/control.ts';
import { prepareCodex, nativeConfigArguments } from './codex-launch.ts';
import { readAgentPlan } from './agent-plan.ts';
import { buildAgentToolContext } from '../../src/agents/tool-context.ts';

test('Codex launch freezes provider context and literal MCP bindings without assigning general-purpose work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-plan-'));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'p', title: 'Billing', summary: 'UNTRUSTED_BRIEF', workingDirectory: directory, position: { x: 0, y: 0 } }, 0);
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'agent.session', title: 'Codex', projectId: 'p', position: { x: 100, y: 100 }, expectedRevision: 1, data: { provider: 'codex', model: 'gpt-6-astra' } };
    const input = { request, state: await control.read(), directory, runtime: { directory: join(directory, 'runtime'), executable: '/host/Electron', entrypoint: '/host/session-supervisor.cjs', electronRuntime: true }, capability: { executable: '/native/codex', version: 'fixture' } };
    const plan = prepareCodex(input), native = plan.launch.native!;
    assert.equal(plan.launch.cwd, await import('node:fs').then(fs => fs.realpathSync(directory)));
    assert.equal(native.initialPrompt, undefined); assert.equal(native.nativeSessionId, undefined);
    assert.ok(native.instructions.includes('Keep the map in sync')); assert.ok(!native.instructions.includes('UNTRUSTED_BRIEF'));
    assert.ok(native.context.includes('UNTRUSTED_BRIEF')); assert.equal(native.model, 'gpt-6-astra');
    const mcp = native.config['mcp_servers.crafting_table'] as any;
    assert.equal(mcp.env.ACT_NODE_ID, request.nodeId); assert.equal(mcp.env.ACT_PROJECT_ID, 'p'); assert.equal(mcp.env.ELECTRON_RUN_AS_NODE, '1');
    assert.deepEqual(mcp.args, ['/host/mcp-bridge.cjs']);
    assert.equal(canonical(prepareCodex(input)), canonical(plan));
    assert.throws(() => prepareCodex({ ...input, request: { ...request, data: { ...request.data, model: 'another' } } }), /reused/);
    const stored = JSON.parse(await readFile(join(directory, 'agent-launches', request.requestId, 'context.json'), 'utf8'));
    assert.equal(stored.referenceContext, native.context);
    const encoded = nativeConfigArguments({ developer_instructions: 'quotes " $HOME `echo bad`\nnew line', 'mcp_servers.test': { command: '/a space/node', args: ['a"b'], env: { K: 'value' } } });
    assert.equal(encoded[1], 'developer_instructions="quotes \\" $HOME `echo bad`\\nnew line"');
    assert.ok(encoded[3].includes('"command" = "/a space/node"'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex native resume keeps conversation and workspace while recovery prompts only interrupted work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-resume-'));
  try {
    const control = new WorkspaceControl(new MemoryStore()), nativeSessionId = randomUUID();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'r', pluginId: 'agent.session', title: 'Existing', position: { x: 0, y: 0 }, data: { provider: 'codex', sessionId: 'old-process', nativeSessionId, workspaceId: 'original', cwd: directory, model: 'native' } }, 0);
    const request = { requestId: randomUUID(), nodeId: 'agent', resourceId: 'r', pluginId: 'agent.session', title: 'Existing', position: { x: 0, y: 0 }, expectedRevision: 1, data: {} };
    const input = { request, state: await control.read(), directory, resumeNodeId: 'agent', runtime: { directory, electronRuntime: false, executable: '/host/node', entrypoint: '/host/session-supervisor.cjs' }, capability: { executable: '/native/codex', version: 'fixture' } };
    const plan = prepareCodex(input);
    assert.equal(plan.launch.native?.nativeSessionId, nativeSessionId); assert.equal(plan.launch.native?.model, undefined);
    assert.equal(plan.launch.predecessorId, 'old-process'); assert.equal(plan.launch.workspaceId, 'original');
    assert.equal(plan.launch.native?.config.model_reasoning_effort, undefined, 'a resumed conversation keeps its effort');
    assert.equal(plan.launch.native?.contextDelivered, undefined, 'a guide of another version is delivered');
    assert.equal(plan.launch.native?.initialPrompt, undefined);
    const continued = prepareCodex({ ...input, request: { ...request, requestId: randomUUID() }, continueWork: true });
    assert.match(continued.launch.native!.initialPrompt!, /do not repeat completed actions/);
    assert.equal(continued.commands[0].type, 'item.update');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a new Codex session runs at high effort, and a launch the supervisor would refuse leaves no plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-effort-'));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'p', title: 'Billing', workingDirectory: directory, position: { x: 0, y: 0 } }, 0);
    const request = (task: string) => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'agent.session', title: 'Codex', projectId: 'p', position: { x: 100, y: 100 }, expectedRevision: 1, data: { provider: 'codex', model: 'fixture-model', task } });
    const input = { state: await control.read(), directory, runtime: { directory, electronRuntime: false, executable: '/host/node', entrypoint: '/host/session-supervisor.cjs' }, capability: { executable: '/native/codex', version: 'fixture' } };
    const plan = prepareCodex({ ...input, request: request('') });
    assert.equal(plan.launch.native?.config.model_reasoning_effort, 'high');
    assert.ok(plan.launch.args.includes('model_reasoning_effort="high"'));
    assert.ok(plan.launch.native?.serverArguments.includes('model_reasoning_effort="high"'));
    const refused = request('x'.repeat(32_000));
    assert.throws(() => prepareCodex({ ...input, request: refused }));
    assert.equal(readAgentPlan(directory, refused.requestId), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a resumed conversation gets the guide again only when its version changed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-guide-'));
  try {
    const control = new WorkspaceControl(new MemoryStore()), nativeSessionId = randomUUID();
    const add = (guideVersion: string, revision: number, id: string) => control.apply({ type: 'item.add', id, resourceId: `r-${id}`, pluginId: 'agent.session', title: 'Existing', position: { x: revision * 400, y: 0 }, data: { provider: 'codex', sessionId: `old-${id}`, nativeSessionId, workspaceId: 'original', cwd: directory, model: 'fixture-model', guideVersion } }, revision);
    await add(buildAgentToolContext({}).version, 0, 'same'); await add('2000-01-01.1', 1, 'older');
    const input = (id: string, state: Awaited<ReturnType<typeof control.read>>) => ({ request: { requestId: randomUUID(), nodeId: id, resourceId: `r-${id}`, pluginId: 'agent.session', title: 'Existing', position: { x: 0, y: 0 }, expectedRevision: 2, data: {} }, state, directory, resumeNodeId: id, runtime: { directory, electronRuntime: false, executable: '/host/node', entrypoint: '/host/session-supervisor.cjs' }, capability: { executable: '/native/codex', version: 'fixture' } });
    const state = await control.read();
    assert.equal(prepareCodex(input('same', state)).launch.native?.contextDelivered, true);
    assert.equal(prepareCodex(input('older', state)).launch.native?.contextDelivered, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a deleted working directory gets the plain message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-gone-'));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'agent.session', title: 'Codex', position: { x: 0, y: 0 }, expectedRevision: 0, data: { provider: 'codex', model: 'fixture-model', cwd: join(directory, 'removed') } };
    const state = await control.read();
    assert.throws(() => prepareCodex({ request, state, directory, runtime: { directory, electronRuntime: false, executable: '/host/node', entrypoint: '/host/session-supervisor.cjs' }, capability: { executable: '/native/codex', version: 'fixture' } }), /Choose an existing working directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a new Codex session without a folder uses the launch fallback only after the project folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-fallback-'));
  try {
    const project = join(directory, 'project'), fallback = join(directory, 'fallback');
    await mkdir(project); await mkdir(fallback);
    const control = new WorkspaceControl(new MemoryStore());
    await control.apply({ type: 'project.create', id: 'bare', title: 'Bare', position: { x: 0, y: 0 } }, 0);
    await control.apply({ type: 'project.create', id: 'owned', title: 'Owned', workingDirectory: project, position: { x: 2000, y: 0 } }, 1);
    const runtime = { directory: join(directory, 'runtime'), executable: '/host/Electron', entrypoint: '/host/session-supervisor.cjs', electronRuntime: true };
    const capability = { executable: '/native/codex', version: 'fixture' };
    const request = (projectId: string) => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'agent.session', title: 'Codex', projectId, position: { x: 100, y: 100 }, expectedRevision: 2, data: { provider: 'codex', model: 'fixture-model' } });
    const state = await control.read();
    assert.throws(() => prepareCodex({ request: request('bare'), state, directory, runtime, capability }), /working directory/);
    assert.equal(prepareCodex({ request: request('bare'), state, directory, runtime, capability, fallbackDirectory: fallback }).launch.cwd, await realpath(fallback));
    assert.equal(prepareCodex({ request: request('owned'), state, directory, runtime, capability, fallbackDirectory: fallback }).launch.cwd, await realpath(project));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
