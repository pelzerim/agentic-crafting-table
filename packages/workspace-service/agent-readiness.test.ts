import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceState } from '../core/control.ts';
import type { SessionCoordinator } from './sessions.ts';
import { AGENT_QUIET_MS, agentReadiness } from './rollout-validation.ts';

const agentState = (activity: string, attention: string) => ({ nodes: [{ id: 'agent', title: 'Claude', position: { x: 0, y: 0 }, activity, attention }] }) as unknown as WorkspaceState;
function runtime() {
  const session = { sequence: 10 };
  const sessions = { runtime: { async call() { return { session: { state: 'running' }, chunks: [], firstSequence: 0, lastSequence: session.sequence, truncated: false }; } } } as unknown as SessionCoordinator;
  return { sessions, session };
}

test('a Claude agent left working without a Stop hook becomes ready once its terminal is quiet', async () => {
  const { sessions, session } = runtime(), agent = { nodeId: 'agent', sessionId: 'quiet' }; let now = 1_000;
  const check = () => agentReadiness(sessions, agentState('working', 'none'), agent, () => ({ event: 'PostToolUse', observedAt: 1 }), () => now);
  assert.equal(await check(), 'working', 'output just seen');
  now += AGENT_QUIET_MS - 1; assert.equal(await check(), 'working');
  now += 1; assert.equal(await check(), 'idle', 'silent terminal is at its prompt');
  session.sequence++; assert.equal(await check(), 'working', 'new output means it is busy again');
});

test('Claude waiting at its idle prompt is ready; a permission prompt or question is not', async () => {
  const { sessions } = runtime(), agent = { nodeId: 'agent', sessionId: 'prompt' };
  assert.equal(await agentReadiness(sessions, agentState('idle', 'input'), agent, () => ({ event: 'Notification:idle_prompt', observedAt: 1 })), 'idle');
  assert.equal(await agentReadiness(sessions, agentState('idle', 'input'), agent, () => ({ event: 'Notification:permission_prompt', observedAt: 1 })), 'working');
  assert.equal(await agentReadiness(sessions, agentState('idle', 'input'), agent, () => ({ event: 'PermissionRequest', observedAt: 1 })), 'working');
  assert.equal(await agentReadiness(sessions, agentState('idle', 'none'), agent, () => ({ event: 'Stop', observedAt: 1 })), 'idle');
});

test('an answered permission prompt is ready once the person decided it in the terminal, output followed and the terminal is quiet', async () => {
  const prompt = { event: 'Notification:permission_prompt', observedAt: 5_000 };
  const scenario = (name: string, input?: { at: number; sequence: number }, last = prompt) => {
    const session = { sequence: 10 }; let now = 6_000;
    const sessions = { runtime: { async call() { return { session: { state: 'running', ...(input ? { decisiveInputAt: input.at, decisiveInputSequence: input.sequence } : {}) }, chunks: [], firstSequence: 0, lastSequence: session.sequence, truncated: false }; } } } as unknown as SessionCoordinator;
    return { session, tick(ms: number) { now += ms; }, check: () => agentReadiness(sessions, agentState('idle', 'input'), { nodeId: 'agent', sessionId: name }, () => last, () => now) };
  };
  const answered = scenario('answered', { at: 5_500, sequence: 9 });
  assert.equal(await answered.check(), 'working', 'not yet quiet');
  answered.tick(AGENT_QUIET_MS - 1); assert.equal(await answered.check(), 'working');
  answered.tick(1); assert.equal(await answered.check(), 'idle');
  answered.session.sequence++; assert.equal(await answered.check(), 'working', 'new output restarts the quiet period');
  answered.tick(AGENT_QUIET_MS); assert.equal(await answered.check(), 'idle');

  for (const [name, input, last] of [
    ['never', undefined, prompt],
    ['before', { at: 4_999, sequence: 3 }, prompt],
    ['same-instant', { at: 5_000, sequence: 3 }, prompt],
    ['no-output-since', { at: 5_500, sequence: 10 }, prompt],
    ['question', { at: 5_500, sequence: 9 }, { event: 'PreToolUse', observedAt: 5_000 }],
  ] as const) {
    const stuck = scenario(name, input, last);
    assert.equal(await stuck.check(), 'working', name);
    stuck.tick(10 * AGENT_QUIET_MS); assert.equal(await stuck.check(), 'working', `${name} stays unanswered however quiet the terminal is`);
  }
  const request = scenario('request', { at: 5_500, sequence: 9 }, { event: 'PermissionRequest', observedAt: 5_000 });
  await request.check(); request.tick(AGENT_QUIET_MS); assert.equal(await request.check(), 'idle', 'a PermissionRequest hook is the same prompt');
});

test('an ended turn that only waits on background shells or watchers is ready, even while the terminal prints', async () => {
  const { sessions, session } = runtime(), agent = { nodeId: 'agent', sessionId: 'background' }, last = () => ({ event: 'Stop', observedAt: 1 });
  const waiting = (kinds: string[], turnEnded = true) => () => ({ tasks: kinds.map((kind, index) => ({ id: `t${index}`, kind })), ended: [], snapshotAt: 1, turnEnded, observedAt: 1 });
  const check = (attention: string, background: ReturnType<typeof waiting>) => { session.sequence++; return agentReadiness(sessions, agentState('working', attention), agent, last, () => 5_000, background); };
  assert.equal(await check('none', waiting(['shell'])), 'idle');
  assert.equal(await check('none', waiting(['monitor', 'shell'])), 'idle');
  assert.equal(await check('none', waiting(['shell', 'subagent'])), 'working', 'a subagent will wake the main thread');
  assert.equal(await check('none', waiting(['teammate'])), 'working');
  assert.equal(await check('none', waiting(['workflow'])), 'working');
  assert.equal(await check('none', waiting(['shell'], false)), 'working', 'the main turn is still running');
  assert.equal(await check('input', waiting(['shell'])), 'working', 'a prompt is open');
  assert.equal(await check('none', waiting([])), 'working', 'nothing says the turn is parked');
});
