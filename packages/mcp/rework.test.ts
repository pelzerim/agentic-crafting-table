import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentLinks } from './service-server.ts';

test('an agent\'s rework note and its clearing name its own session unless they name one', () => {
  assert.deepEqual(resolveAgentLinks({ type: 'node.rework', id: 'pr', note: 'Fixing CI' }, 'agent-1'), { type: 'node.rework', id: 'pr', note: 'Fixing CI', by: 'agent-1' });
  assert.deepEqual(resolveAgentLinks({ type: 'node.rework', id: 'pr', note: 'Fixing CI', by: 'other' }, 'agent-1'), { type: 'node.rework', id: 'pr', note: 'Fixing CI', by: 'other' });
  assert.deepEqual(resolveAgentLinks({ type: 'node.rework', id: 'pr', note: null }, 'agent-1'), { type: 'node.rework', id: 'pr', note: null, by: 'agent-1' });
  assert.deepEqual(resolveAgentLinks({ type: 'node.rework', id: 'pr', note: 'Fixing CI' }, undefined), { type: 'node.rework', id: 'pr', note: 'Fixing CI' });
});
