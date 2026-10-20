import test from 'node:test';
import assert from 'node:assert/strict';
import { codexInput, codexStatus } from './codex-status.ts';
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
