import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { codexInput, codexStatus, codexSwitch } from './codex-status.ts';
test('Codex status uses native state, preserves input needs and ignores other conversations', () => {
  const event = (type: string, activeFlags: string[] = [], threadId = 'mine') => ({ method: 'thread/status/changed', params: { threadId, status: { type, activeFlags } } });
  assert.equal(codexStatus(event('active'), 'mine'), 'working');
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) assert.equal(codexStatus(event('active', [flag]), 'mine'), 'input');
  assert.equal(codexStatus(event('idle'), 'mine'), 'idle');
  assert.equal(codexStatus(event('systemError'), 'mine'), 'error');
  assert.equal(codexStatus(event('notLoaded'), 'mine'), 'unknown');
  assert.equal(codexStatus(event('active', [], 'another'), 'mine'), undefined);
  assert.equal(codexStatus(event('unsupported'), 'mine'), undefined);
  assert.equal(codexStatus({ method: 'item/agentMessage/delta', params: { text: 'I am working' } }, 'mine'), undefined);
});

test('Codex input says whether it waits on an approval or a question', () => {
  const event = (activeFlags: string[], threadId = 'mine') => ({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags } } });
  assert.equal(codexInput(event(['waitingOnUserInput', 'waitingOnApproval']), 'mine'), 'approval');
  assert.equal(codexInput(event(['waitingOnUserInput']), 'mine'), 'question');
  assert.equal(codexInput(event([]), 'mine'), undefined); assert.equal(codexInput(event(['waitingOnApproval'], 'another'), 'mine'), undefined);
});

test('Codex terminal commands read as switches, and a subagent thread never does', () => {
  const current = randomUUID(), other = randomUUID(), helper = randomUUID(), subagents = new Set<string>();
  const started = (thread: Record<string, unknown>) => codexSwitch({ method: 'thread/started', params: { thread } }, current, subagents);
  const status = (threadId: string) => codexSwitch({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } }, current, subagents);
  assert.deepEqual(started({ id: other, forkedFromId: null, source: 'vscode' }), { kind: 'new', nativeSessionId: other });
  assert.deepEqual(started({ id: other, forkedFromId: current, source: 'vscode' }), { kind: 'fork', nativeSessionId: other });
  assert.deepEqual(status(other), { kind: 'resume', nativeSessionId: other });
  assert.equal(started({ id: current, source: 'vscode' }), undefined);
  assert.equal(status(current), undefined);
  assert.equal(started({ id: helper, parentThreadId: current, source: { subAgent: 'review' } }), undefined);
  assert.equal(status(helper), undefined);
  assert.equal(codexSwitch({ method: 'thread/goal/cleared', params: { threadId: other } }, current, subagents), undefined);
});
