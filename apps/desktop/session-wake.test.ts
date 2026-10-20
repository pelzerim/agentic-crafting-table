import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionWake } from './session-wake.ts';

function harness() {
  const calls: [string, unknown][] = [], sent: string[][] = [], runs: (() => void)[] = [];
  const wake = new SessionWake(async (method, input) => { calls.push([method, input]); }, ids => sent.push(ids), run => { runs.push(run); });
  return { wake, calls, sent, flush() { const pending = runs.splice(0); pending.forEach(run => run()); } };
}

test('a session is attached once however many views watch it, and detached with the last', async () => {
  const { wake, calls } = harness();
  await wake.attach('a'); await wake.attach('a'); await wake.attach('b');
  assert.deepEqual(calls, [['sessions.attach', { sessionId: 'a' }], ['sessions.attach', { sessionId: 'b' }]]);
  await wake.detach('a'); await wake.detach('missing');
  assert.equal(calls.length, 2);
  await wake.detach('a');
  assert.deepEqual(calls.at(-1), ['sessions.detach', { sessionId: 'a' }]);
  await wake.detach('a');
  assert.equal(calls.length, 3);
});

test('supervisor events for watched sessions become one activity message per turn', async () => {
  const { wake, sent, flush } = harness();
  await wake.attach('a');
  wake.notify({ event: 'session', data: { kind: 'output', sessionId: 'a', chunk: { sequence: 1, data: 'x' } } });
  wake.notify({ event: 'session', data: { kind: 'output', sessionId: 'a', chunk: { sequence: 2, data: 'y' } } });
  wake.notify({ event: 'session', data: { kind: 'state', session: { id: 'a' } } });
  wake.notify({ event: 'session', data: { kind: 'output', sessionId: 'other', chunk: { sequence: 1, data: 'z' } } });
  wake.notify({ event: 'other', data: { sessionId: 'a' } });
  assert.deepEqual(sent, []);
  flush();
  assert.deepEqual(sent, [['a']]);
  flush();
  assert.deepEqual(sent, [['a']], 'an empty turn sends nothing');
});

test('a reconnected supervisor is asked again for every watched session', async () => {
  const { wake, calls } = harness();
  await wake.attach('a'); await wake.attach('b'); await wake.detach('b');
  calls.length = 0;
  await wake.reconnected();
  assert.deepEqual(calls, [['sessions.attach', { sessionId: 'a' }]]);
});

test('a failed attach does not count as watching', async () => {
  const sent: string[][] = [];
  const wake = new SessionWake(async () => { throw new Error('gone'); }, ids => sent.push(ids), run => run());
  await assert.rejects(wake.attach('a'));
  wake.notify({ event: 'session', data: { kind: 'output', sessionId: 'a', chunk: { sequence: 1, data: 'x' } } });
  assert.deepEqual(sent, []);
});
