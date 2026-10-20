import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBackground } from './agent-background.ts';
import type { BackgroundState } from './agent-background.ts';
import { COMMAND_AFTER_MS, COMMAND_HOLD_MS, MOMENT_GAP_MS, agentScene, commandShowing, sceneChanges } from './agent-scene.ts';

const working = { activity: 'working', attention: 'none' } as const, idle = { activity: 'idle', attention: 'none' } as const;
const shell = (since: number, until?: number): BackgroundState => ({ tasks: [], ended: [], snapshotAt: 0, turnEnded: false, observedAt: until ?? since, shell: { since, running: until === undefined ? 1 : 0, ...(until === undefined ? {} : { until }) } });

test('a command shows once it has run for a while and then stays long enough to be seen', () => {
  assert.equal(commandShowing(undefined, 1), false);
  assert.equal(commandShowing(shell(10_000).shell, 10_000 + COMMAND_AFTER_MS - 1), false, 'a quick command never shows');
  assert.equal(commandShowing(shell(10_000).shell, 10_000 + COMMAND_AFTER_MS), true);
  assert.equal(commandShowing(shell(10_000).shell, 10_000 + 60_000), true, 'for as long as it runs');
  assert.equal(commandShowing(shell(10_000, 10_000 + COMMAND_AFTER_MS - 1).shell, 10_000 + COMMAND_AFTER_MS), false, 'it ended before it would have shown');
  // One that ran two seconds stays until the pose has been up for the hold time.
  const ended = shell(10_000, 12_000).shell;
  assert.equal(commandShowing(ended, 12_001), true);
  assert.equal(commandShowing(ended, 10_000 + COMMAND_AFTER_MS + COMMAND_HOLD_MS - 1), true);
  assert.equal(commandShowing(ended, 10_000 + COMMAND_AFTER_MS + COMMAND_HOLD_MS), false);
  assert.equal(commandShowing(shell(10_000, 40_000).shell, 40_000), false, 'a long one goes when it ends');
});

test('the pose is the first that applies: gate, asking, fallen, shearing, command, ended', () => {
  const busy = { ...shell(1_000), compacting: true } as BackgroundState, now = 10_000;
  assert.equal(agentScene({ activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission' }, busy, now).pose, 'gate');
  assert.equal(agentScene({ activity: 'idle', attention: 'input', attentionNote: 'Agent asked a question' }, busy, now).pose, 'asking');
  assert.equal(agentScene({ activity: 'idle', attention: 'input', attentionNote: 'Agent waiting' }, busy, now).pose, 'asking');
  assert.equal(agentScene({ activity: 'idle', attention: 'error' }, busy, now).pose, 'fallen');
  assert.equal(agentScene(working, busy, now).pose, 'shearing');
  assert.equal(agentScene(working, shell(1_000), now).pose, 'command');
  assert.equal(agentScene(working, shell(9_500), now).pose, undefined, 'grazing');
  assert.equal(agentScene(idle, shell(1_000), now).pose, undefined, 'a command does not show on an item that is not working');
  assert.equal(agentScene(idle, undefined, now, { ended: true }).pose, 'ended');
  assert.equal(agentScene({ activity: 'idle', attention: 'error' }, undefined, now, { ended: true }).pose, 'fallen', 'an error outranks the end');
  assert.equal(agentScene(working, undefined, now, { ended: true }).pose, undefined);
});

test('shells and watchers beside the prompt are counted apart from helpers, and not at all once the session ended', () => {
  const state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [{ id: 'sh', type: 'shell', status: 'running' }, { id: 'm', type: 'monitor' }, { id: 'a', type: 'subagent', status: 'running' }] });
  assert.deepEqual(agentScene(working, state, 1_001), { pose: undefined, helpers: 1, waiting: true, beside: 2, tasks: undefined, bell: false, pen: false });
  const alone = applyBackground(state, { observedAt: 2_000, turnEnded: true, snapshot: [{ id: 'm', type: 'monitor' }] });
  assert.deepEqual(agentScene(idle, alone, 2_001), { pose: undefined, helpers: 0, waiting: false, beside: 1, tasks: undefined, bell: false, pen: false });
  assert.equal(agentScene(idle, alone, 2_001, { ended: true }).beside, 0);
});

test('only what differs from the node is written, and a helper that left takes a moment with it', () => {
  const node = { helpers: 2, waiting: true as const, pose: undefined, beside: 1 };
  const same = agentScene(working, applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [{ id: 'a', type: 'subagent' }, { id: 'b', type: 'subagent' }, { id: 'sh', type: 'shell' }] }), 1_001);
  assert.equal(sceneChanges(node, same, 1_001), undefined);
  const one = { ...same, helpers: 1 };
  assert.deepEqual(sceneChanges(node, one, 5_000), { helpers: 1, moment: { kind: 'leave', at: 5_000 } });
  assert.deepEqual(sceneChanges({ ...node, moment: { kind: 'leave' as const, at: 5_000 - MOMENT_GAP_MS + 1 } }, one, 5_000), { helpers: 1 }, 'not twice within the gap');
  assert.deepEqual(sceneChanges(node, { ...same, helpers: 0, waiting: false, pose: 'gate' }, 6_000), { helpers: 0, waiting: false, pose: 'gate', moment: { kind: 'leave', at: 6_000 } });
  assert.deepEqual(sceneChanges({ ...node, pose: 'command' as const }, same, 7_000), { pose: 'none' });
  assert.deepEqual(sceneChanges(node, { ...same, beside: 0 }, 7_000), { beside: 0 });
});

test('tasks, another model and a worktree decorate the scene until the session ends', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, worktree: true, model: { to: 'opus' } });
  for (const id of ['1', '2']) state = applyBackground(state, { observedAt: 1_100, task: { id, state: 'created' } });
  state = applyBackground(state, { observedAt: 1_200, task: { id: '1', state: 'completed' } });
  assert.deepEqual(agentScene(working, state, 1_300), { pose: undefined, helpers: 0, waiting: false, beside: 0, tasks: { done: 1, total: 2 }, bell: false, pen: true });
  state = applyBackground(state, { observedAt: 1_400, model: { to: 'haiku', from: 'opus' } });
  assert.equal(agentScene(working, state, 1_500).bell, true);
  assert.deepEqual(agentScene(idle, state, 1_500, { ended: true }), { pose: 'ended', helpers: 0, waiting: false, beside: 0, tasks: undefined, bell: false, pen: false });
  assert.equal(agentScene(working, { ...state, compacting: true }, 1_500).pose, 'shearing');
});

test('a helper that arrives walks in; a stumble or a bump is written at most once per gap and never over a walk', () => {
  const node = { helpers: 1 }, scene = agentScene(working, applyBackground(undefined, { observedAt: 1_000, turnEnded: false, helper: { id: 'a', state: 'tool' } }), 1_001);
  assert.deepEqual(sceneChanges({}, scene, 1_001), { helpers: 1, moment: { kind: 'enter', at: 1_001 } });
  assert.equal(sceneChanges(node, scene, 2_000), undefined);
  assert.deepEqual(sceneChanges(node, scene, 10_000, 'stumble'), { moment: { kind: 'stumble', at: 10_000 } });
  assert.equal(sceneChanges({ ...node, moment: { kind: 'stumble' as const, at: 10_000 } }, scene, 10_000 + MOMENT_GAP_MS - 1, 'stumble'), undefined, 'a burst of failures is one stumble');
  assert.deepEqual(sceneChanges({ ...node, moment: { kind: 'stumble' as const, at: 10_000 } }, scene, 10_000 + MOMENT_GAP_MS, 'bump'), { moment: { kind: 'bump', at: 10_000 + MOMENT_GAP_MS } });
  assert.deepEqual(sceneChanges({ helpers: 2 }, scene, 20_000, 'stumble'), { helpers: 1, moment: { kind: 'leave', at: 20_000 } }, 'the helper leaving is the moment');
});
