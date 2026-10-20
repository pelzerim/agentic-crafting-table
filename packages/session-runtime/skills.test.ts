import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSkillCatalog } from './skills.ts';
import { agentProviders } from '../workspace-service/agent-providers.ts';
import { AgentCoordinator } from '../workspace-service/agents.ts';
import { WorkspaceControl, MemoryStore } from '../core/control.ts';
import { settingsSchema } from '../core/settings.ts';
import type { PreparedSession } from '../workspace-service/sessions.ts';

test('skill catalogs exclude built-in command collisions and validate native metadata', () => {
  assert.deepEqual(claudeSkillCatalog([
    { name: 'exit', description: 'custom command' }, { name: 'exit', description: 'builtin', builtin: true },
    { name: 'project:review', description: 'Review project', argumentHint: '<topic>' },
    { name: 'bad\nname', description: 'Cannot invoke' },
  ]), [{ id: 'project:review', name: 'project:review', description: 'Review project', argumentHint: '<topic>' }]);
  assert.throws(() => claudeSkillCatalog([{ name: 'oops' }]), /description/);
});

test('native skill launches inherit context, preserve exact invocation on retry and never rerun on resume', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'craft-skills-'))), control = new WorkspaceControl(new MemoryStore());
  const runtime = { directory: join(directory, 'runtime'), executable: '/runtime/node', entrypoint: '/runtime/dist/session-supervisor.cjs', electronRuntime: false };
  const originals = Object.fromEntries(Object.entries(agentProviders).map(([id, provider]) => [id, { ...provider }]));
  let launches = 0, latest: PreparedSession | undefined, catalogs = 0;
  // Like SessionCoordinator, validate and commit the graph before launching a process.
  const sessions = { async launchPrepared(plan: PreparedSession) { await control.dispatch({ commandId: plan.requestId, expectedRevision: plan.expectedRevision, actor: { kind: 'user', id: 'test' }, commands: plan.commands }); launches++; latest = plan; return { session: { id: plan.requestId } }; } };
  const agents = new AgentCoordinator(directory, runtime, control, sessions as any, {} as any, async () => {}, { readSettings: () => ({ revision: 0, value: settingsSchema.parse({}) }) } as any);
  try {
    await control.apply({ type: 'project.create', id: 'project', title: 'Billing', summary: 'PROJECT_REFERENCE', workingDirectory: directory, position: { x: 0, y: 0 } }, 0);
    await control.apply({ type: 'item.add', id: 'todo', resourceId: 'todo-r', pluginId: 'workspace.todo', title: 'Inspect the plan', data: {}, projectId: 'project', position: { x: 100, y: 300 } }, 1);
    for (const [id, provider] of Object.entries(agentProviders)) {
      provider.probe = async () => ({ executable: '/native/' + id, version: 'fixture', remoteControl: true });
      provider.skills = async cwd => { catalogs++; return { cwd, skills: [{ id: 'skill', name: 'inspect', description: 'Inspect project' }, { id: 'off', name: 'off', description: '', unavailable: 'Disabled' }], warnings: [] }; };
      const input = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: (await control.read()).revision,
        provider: id, model: id === 'claude' ? 'fable' : 'gpt-6-astra', skillId: 'skill', arguments: 'literal $(touch no) `no` "quotes"\nsecond line', position: { x: 300, y: 0 },
        connection: { id: randomUUID(), otherId: 'todo', kind: 'context', sourceIsNew: false } };
      const before = launches;
      await assert.rejects(agents.runSkill('project', { ...input, skillId: 'missing' }), /no longer available/);
      await assert.rejects(agents.runSkill('project', { ...input, skillId: 'off' }), /Disabled/);
      const beforeInvalid = await control.read();
      await assert.rejects(agents.runSkill('project', { ...input, requestId: randomUUID(), connection: { ...input.connection, sourceIsNew: true } }), /Context must point/);
      assert.equal(launches, before);
      assert.deepEqual(await control.read(), beforeInvalid, 'invalid skill connections cannot leave a partial agent item');
      await Promise.all([agents.runSkill('project', input), agents.runSkill('project', input)]);
      assert.equal(launches, before + 1, 'simultaneous retries share preparation');
      assert.ok((await control.read()).links.some(link => link.sourceId === 'todo' && link.targetId === input.nodeId && link.kind === 'context'));
      const first = latest!, data = (first.commands[0] as any).data;
      assert.equal(first.launch.cwd, directory); assert.deepEqual(data.skill, { id: 'skill', name: 'inspect' });
      assert.ok(data.projectSummary.includes('PROJECT_REFERENCE'));
      assert.equal(id === 'claude' ? first.launch.args.at(-1) : first.launch.native?.initialPrompt, (id === 'claude' ? '/inspect ' : '$inspect ') + input.arguments);
      const count = catalogs;
      provider.skills = async () => { throw new Error('Should not rediscover a retry'); };
      await agents.runSkill('project', input); assert.deepEqual(latest, JSON.parse(JSON.stringify(first))); assert.equal(catalogs, count);
      await assert.rejects(agents.runSkill('project', { ...input, arguments: 'changed' }), /reused/);
      const state = await control.read();
      if (id === 'codex') await control.apply({ type: 'item.update', id: input.nodeId, data: { ...data, nativeSessionId: randomUUID() } }, state.revision);
      const resumed = provider.prepare({ request: { requestId: randomUUID(), nodeId: input.nodeId, resourceId: input.resourceId, expectedRevision: (await control.read()).revision, pluginId: 'agent.session', title: 'inspect', position: input.position, data: {} }, state: await control.read(), directory, runtime, capability: await provider.probe(), resumeNodeId: input.nodeId }, settingsSchema.parse({}));
      assert.equal(id === 'claude' ? resumed.launch.args.includes('--') : Boolean(resumed.launch.native?.initialPrompt), false, 'resume never invokes the selected skill again');
      assert.deepEqual((resumed.commands[0] as any).data.skill, data.skill);
    }
    await control.apply({ type: 'node.archive', id: 'project' }, (await control.read()).revision);
    await assert.rejects(agents.skills({ projectId: 'project', provider: 'claude' }), /available project/);
  } finally { for (const id of Object.keys(agentProviders)) Object.assign(agentProviders[id], originals[id]); await rm(directory, { recursive: true, force: true }); }
});
