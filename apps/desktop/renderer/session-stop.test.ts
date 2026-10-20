import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopNeedsConfirm } from './session-stop.ts';

test('only a running agent with a working turn asks before stopping', () => {
  const running = { state: 'running' as const };
  assert.equal(stopNeedsConfirm(running, true, 'working'), true);
  assert.equal(stopNeedsConfirm({ ...running, native: { status: 'working' as const } }, true, 'idle'), true);
  assert.equal(stopNeedsConfirm(running, true, 'idle'), false);
  assert.equal(stopNeedsConfirm(running, true, undefined), false);
  assert.equal(stopNeedsConfirm(running, false, 'working'), false);
  assert.equal(stopNeedsConfirm({ state: 'starting' as const }, true, 'working'), false);
  assert.equal(stopNeedsConfirm({ ...running, stopRequestedAt: '2026-09-30T00:00:00.000Z' }, true, 'working'), false);
  assert.equal(stopNeedsConfirm(undefined, true, 'working'), false);
});
