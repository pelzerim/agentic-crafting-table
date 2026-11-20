import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { explainInVideo, pullRequestVideoRun, PR_VIDEO_LINE, SESSION_VIDEO_REQUEST } from './video-explain.ts';
import type { VideoExplainHost } from './video-explain.ts';
import type { VideoSkill } from '../core/settings.ts';
import type { ProjectSkillCatalog, SkillRun } from '../core/skills.ts';
import type { SessionCoordinator } from './sessions.ts';

interface Fixture {
  control: WorkspaceControl; host: VideoExplainHost; skill: { value: VideoSkill }; off: Set<string>; inputs: string[]; failInput: { next: boolean }; failLaunch: { code?: string };
  launches: { projectId: string; run: SkillRun }[]; discovery: { during?: () => Promise<unknown> }; apply(commands: any[]): Promise<unknown>;
}
async function fixture(run: (context: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'act-video-explain-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: any[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  const inputs: string[] = [], launches: { projectId: string; run: SkillRun }[] = [], off = new Set<string>(), failInput = { next: false }, failLaunch: Fixture['failLaunch'] = {}, discovery: Fixture['discovery'] = {};
  const skill = { value: { provider: 'claude', skillId: '/default-folder/demo-video', name: 'demo-video' } as VideoSkill };
  const sessions = { runtime: { call: async (method: string, args: any) => {
    if (method === 'sessions.read') return { session: { state: 'running', nodeId: args.sessionId === 'session-fixture' ? 'agent' : String(args.sessionId).slice('session-'.length), cwd: '/work/codex-folder' } };
    if (failInput.next) { failInput.next = false; throw new Error('The session runtime stopped answering'); }
    inputs.push(args.data);
  } } } as unknown as SessionCoordinator;
  const host: VideoExplainHost = { store, sessions, skill: () => skill.value, enabled: provider => !off.has(provider), defaultModel: async () => 'gpt-default',
    skills: async ({ provider, projectId, cwd }): Promise<ProjectSkillCatalog> => {
      await discovery.during?.();
      const folder = projectId ? `/work/${projectId}` : cwd!;
      return { cwd: folder, warnings: [], skills: provider === 'codex' || projectId ? [{ id: `${folder}/demo-video/SKILL.md`, name: 'demo-video', description: '' }] : [] };
    },
    skillPrompt: (provider, selected, text) => `${provider === 'codex' ? '$' : '/'}${selected.name} ${text}`,
    runSkill: async (projectId, run) => {
      launches.push({ projectId, run });
      if (failLaunch.code) { const code = failLaunch.code; delete failLaunch.code; throw Object.assign(new Error('The supervisor did not answer'), { code }); }
      await apply([{ type: 'item.create', id: run.nodeId, resource: { id: run.resourceId, pluginId: 'agent.session', schemaVersion: 1, title: 'Video', data: { provider: run.provider, sessionId: `session-${run.nodeId}` } }, position: run.position },
        { type: 'node.update', id: run.nodeId, activity: 'working' }]);
      return {};
    } };
  try {
    await apply([
      { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
      { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'PR', projectId: 'project', position: { x: 50, y: 60 }, data: { owner: 'acme', repo: 'billing', number: 42 } },
      { type: 'item.create', id: 'agent', resource: { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Codex', data: { provider: 'codex', sessionId: 'session-fixture' } }, position: { x: 400, y: 0 } },
      { type: 'node.update', id: 'agent', activity: 'idle' },
    ]);
    await run({ control, host, skill, off, inputs, failInput, failLaunch, launches, discovery, apply });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('a pull request launches the same-named skill from its project folder with its URL, beside it and connected from it, with ids fixed by the request', () => fixture(async ({ control, host, launches }) => {
  const requestId = randomUUID(), result = await explainInVideo(control, host, 'pr', { requestId });
  assert.equal(launches.length, 1);
  const [{ projectId, run }] = launches;
  assert.equal(projectId, 'project');
  assert.deepEqual({ provider: run.provider, model: run.model, skillId: run.skillId, arguments: run.arguments, cwd: run.cwd },
    { provider: 'claude', model: 'gpt-default', skillId: '/work/project/demo-video/SKILL.md', arguments: `https://github.com/acme/billing/pull/42\n${PR_VIDEO_LINE}`, cwd: '/work/project' });
  assert.deepEqual({ otherId: run.connection?.otherId, kind: run.connection?.kind, sourceIsNew: run.connection?.sourceIsNew }, { otherId: 'pr', kind: 'context', sourceIsNew: false });
  assert.deepEqual(result, { nodeId: run.nodeId });
  const again = (id: string) => pullRequestVideoRun({ id: 'pr', position: { x: 0, y: 0 } }, 'https://example.test/pr', { provider: 'claude', model: 'm', skillId: 's', cwd: '/w' }, id);
  assert.deepEqual(again(requestId), again(requestId), 'a retried request sends the same launch');
  assert.notEqual(again(requestId).nodeId, again(randomUUID()).nodeId);
}));

test('a pull request launch is refused while its provider is off, and a second click returns the video session only while it is at work', () => fixture(async ({ control, host, off, launches, apply }) => {
  off.add('claude');
  await assert.rejects(explainInVideo(control, host, 'pr', { requestId: randomUUID() }), /Claude is turned off/);
  off.clear();
  const first = await explainInVideo(control, host, 'pr', { requestId: randomUUID() }) as { nodeId: string };
  assert.deepEqual(await explainInVideo(control, host, 'pr', { requestId: randomUUID() }), { nodeId: first.nodeId, reused: true }, 'a lost reply then a second click launches nothing new');
  assert.equal(launches.length, 1);
  await apply([{ type: 'node.update', id: first.nodeId, activity: 'unknown' }]);
  assert.notEqual((await explainInVideo(control, host, 'pr', { requestId: randomUUID() }) as { nodeId: string }).nodeId, first.nodeId, 'a session lost after a restart no longer holds the PR');
  assert.equal(launches.length, 2);
}));

test('a pull request launch whose start is uncertain is replayed as the same launch by the next click', () => fixture(async ({ control, host, failLaunch, launches }) => {
  failLaunch.code = 'LAUNCH_UNCERTAIN';
  await assert.rejects(explainInVideo(control, host, 'pr', { requestId: randomUUID() }), /did not answer/);
  const replay = await explainInVideo(control, host, 'pr', { requestId: randomUUID() }) as { nodeId: string };
  assert.equal(replay.nodeId, launches[0].run.nodeId);
  assert.deepEqual(launches[1], launches[0], 'one launch identity only');
}));

test('a session is prompted with its own provider’s skill once per request, never while busy, off, without the skill or without a choice', () => fixture(async ({ control, host, skill, off, inputs, discovery, apply }) => {
  const requestId = randomUUID();
  assert.deepEqual(await explainInVideo(control, host, 'agent', { requestId }), { sent: true });
  await apply([{ type: 'node.update', id: 'agent', activity: 'working' }]);
  assert.deepEqual(await explainInVideo(control, host, 'agent', { requestId }), { sent: true }, 'a retry of a delivered request answers while the agent works on it');
  assert.equal(inputs.length, 2, 'one prompt and its Enter');
  assert.ok(inputs[0].startsWith(`$demo-video ${SESSION_VIDEO_REQUEST} `), 'the session’s provider invokes the skill at the start of the line');
  assert.equal(inputs[1], '\r');
  await apply([{ type: 'node.update', id: 'agent', activity: 'working' }]);
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /ready for a new prompt/);
  await delay(5);
  await apply([{ type: 'node.update', id: 'agent', activity: 'idle', turnEndedAt: new Date().toISOString() }]);
  off.add('claude');
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /Claude is turned off/);
  off.clear();
  discovery.during = () => apply([{ type: 'node.update', id: 'agent', activity: 'working' }]);
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /ready for a new prompt/, 'work that starts during skill discovery is still seen');
  delete discovery.during;
  await apply([{ type: 'node.update', id: 'agent', activity: 'idle' }]);
  skill.value = { provider: 'claude', skillId: 'other-video', name: 'other-video' };
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /Codex has no other-video skill/);
  skill.value = { provider: 'claude', skillId: '', name: '' };
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /Choose a video skill in Settings/);
  await assert.rejects(explainInVideo(control, host, 'pr', { requestId: randomUUID() }), /Choose a video skill in Settings/);
  assert.equal(inputs.length, 2);
}));

test('a session prompt holds the session until the agent ends a turn after it, so a lost reply is never typed twice', () => fixture(async ({ control, host, inputs, failInput, apply }) => {
  failInput.next = true;
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /stopped answering/);
  await delay(5);
  await apply([{ type: 'node.update', id: 'agent', attention: 'error', attentionNote: 'Check failed' }]);
  await apply([{ type: 'node.update', id: 'agent', attention: 'none' }]);
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /not picked up the last video request/, 'an attention change is not a turn');
  assert.equal(inputs.length, 0);
  await apply([{ type: 'node.update', id: 'agent', turnEndedAt: new Date().toISOString() }]);
  assert.deepEqual(await explainInVideo(control, host, 'agent', { requestId: randomUUID() }), { sent: true });
  assert.equal(inputs.length, 2);
  await assert.rejects(explainInVideo(control, host, 'agent', { requestId: randomUUID() }), /not picked up the last video request/, 'a delivered prompt with a lost reply holds too');
  assert.equal(inputs.length, 2);
}));
