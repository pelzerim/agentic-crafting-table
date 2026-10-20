import test from 'node:test';
import assert from 'node:assert/strict';
import { pullPreview } from './preview.ts';
import type { ResourceSnapshot } from '../../types.ts';
import { githubFixture } from '../../../../tests/fixtures/github.ts';

const pull = { ...githubFixture().pull, state: 'open' as const, user: { login: 'octo' }, updated_at: '2026-09-30T09:00:00Z' };
const snapshot = (detail: Record<string, unknown>): ResourceSnapshot => ({ activity: 'idle', attention: 'none', connection: 'connected', label: 'Checks failing', observedAt: '2026-09-30T10:00:00Z', detail: detail as never });

test('a PR preview names the author, when it changed and its failing checks from the saved snapshot', () => {
  assert.deepEqual(pullPreview(snapshot({ pull, status: 'checks-failing', failingChecks: ['unit', 'lint'] })), { byline: 'by octo', updatedAt: '2026-09-30T09:00:00Z', facts: [{ label: 'Checks', value: '2 failing · unit, lint', tone: 'red' }] });
  assert.deepEqual(pullPreview(snapshot({ pull, status: 'approved' })).facts, [], 'no failing checks, no checks line');
  assert.equal(pullPreview(snapshot({ pull, status: 'checks-failing', failingChecks: ['a', 'b', 'c', 'd', 'e'] })).facts[0].value, '5 failing · a, b, c +2');
  assert.deepEqual(pullPreview(null), { facts: [] }, 'nothing saved yet: no facts rather than a provider read');
});
