import test from 'node:test';
import assert from 'node:assert/strict';
import { patchedData, savedSnapshot } from './views.ts';

test('a mounted view is updated with its item\'s saved map state, without a provider title or content', () => {
  const cues = [{ id: 'rollout-state', label: 'Ongoing', icon: 'clock' as const, tone: 'blue' as const }];
  assert.deepEqual(savedSnapshot({ activity: 'working', attention: 'none', summary: 'Ongoing', indicators: cues }, '2026-10-07T10:00:00.000Z'),
    { activity: 'working', attention: 'none', connection: 'unknown', label: 'Ongoing', observedAt: '2026-10-07T10:00:00.000Z', indicators: cues });
  const paused = savedSnapshot({ activity: 'idle', attention: 'review', summary: '', indicators: [...cues, { id: 'connection', label: 'Updates paused', icon: 'clock' as const, tone: 'amber' as const }] }, '2026-10-07T10:00:00.000Z');
  assert.equal(paused.connection, 'disconnected');
  assert.deepEqual(Object.keys(savedSnapshot({ activity: 'unknown', attention: 'none', summary: '' }, '2026-10-07T10:00:00.000Z')), ['activity', 'attention', 'connection', 'label', 'observedAt']);
});

test('a view saves fields into its item\'s data: a value replaces, null removes, the rest stays', () => {
  const data = { owner: 'acme', repo: 'app', number: 42 };
  assert.deepEqual(patchedData(data, { autoValidate: false }), { owner: 'acme', repo: 'app', number: 42, autoValidate: false });
  assert.deepEqual(patchedData({ ...data, autoValidate: false }, { autoValidate: null }), data);
  assert.deepEqual(patchedData(data, { autoValidate: null }), data);
  assert.deepEqual(data, { owner: 'acme', repo: 'app', number: 42 });
});
