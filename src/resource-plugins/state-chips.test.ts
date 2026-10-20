import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionChip, workflowReviewChip } from './state-chips.ts';

test('session states become toned labels, never raw strings', () => {
  assert.deepEqual(sessionChip('starting'), { label: 'Starting', tone: 'blue' });
  assert.deepEqual(sessionChip('running'), { label: 'Running', tone: 'green' });
  assert.deepEqual(sessionChip('running', true), { label: 'Stopping…', tone: 'neutral' });
  assert.deepEqual(sessionChip('exited', true), { label: 'Exited', tone: 'neutral' });
  assert.deepEqual(sessionChip('failed'), { label: 'Failed', tone: 'red' });
  assert.deepEqual(sessionChip(undefined), { label: 'Connecting…', tone: 'neutral' });
  assert.deepEqual(sessionChip('half-open'), { label: 'Half open', tone: 'neutral' });
});

test('workflow review statuses become toned labels', () => {
  assert.deepEqual(workflowReviewChip('complete'), { label: 'Complete', tone: 'green' });
  assert.deepEqual(workflowReviewChip('needs-confirmation'), { label: 'Unconfirmed', tone: 'amber' });
  assert.deepEqual(workflowReviewChip('timed-out'), { label: 'Timed out', tone: 'red' });
  assert.deepEqual(workflowReviewChip('awaiting-result'), { label: 'Awaiting result', tone: 'blue' });
  assert.deepEqual(workflowReviewChip('something-new'), { label: 'Something new', tone: 'neutral' });
});
