import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDeskItem } from './desk.ts';
import type { RelatedResourceItem } from '../../types.ts';
import { githubFixture } from '../../../../tests/fixtures/github.ts';

const pull = { ...githubFixture().pull, state: 'open' as const };
const item: RelatedResourceItem = { nodeId: 'review', title: 'Review', summary: 'Checked error handling.', activity: 'complete', attention: 'none', typeName: 'Code review', parentResourceId: 'pr', resource: { id: 'r', pluginId: 'code.review', schemaVersion: 1, title: 'Review', data: { provider: 'claude', model: 'opus', headSha: pull.head.sha, baseTipSha: pull.base.sha } } };
test('desk reviews must belong to this PR and describe actual saved state and summary', () => {
  assert.equal(reviewDeskItem(item, 'other', pull), undefined);
  assert.deepEqual(reviewDeskItem(item, 'pr', pull), { label: 'Claude · Opus', tint: 'claude', state: 'Completed', summary: item.summary, revision: 'Current revision', stale: false });
  assert.equal(reviewDeskItem({ ...item, activity: 'working' }, 'pr', pull)?.state, 'Working');
  assert.equal(reviewDeskItem({ ...item, attention: 'error' }, 'pr', pull)?.state, 'Action required');
  assert.equal(reviewDeskItem({ ...item, summary: '' }, 'pr', pull)?.summary, 'No saved summary yet.');
});
test('desk flags changed heads and base tips, and never claims unrecorded revisions are current', () => {
  assert.equal(reviewDeskItem(item, 'pr', { ...pull, head: { ...pull.head, sha: 'new' } })?.revision, 'Earlier revision');
  assert.equal(reviewDeskItem(item, 'pr', { ...pull, base: { ...pull.base, sha: 'new' } })?.revision, 'Earlier revision');
  const withoutBase = { ...item, resource: { ...item.resource!, data: { ...item.resource!.data } } };
  delete withoutBase.resource.data.baseTipSha;
  assert.equal(reviewDeskItem(withoutBase, 'pr', pull)?.revision, 'Head current · base unverified');
  const workflow = { ...item, resource: { ...item.resource!, pluginId: 'github.review-run', data: {} } };
  assert.equal(reviewDeskItem(workflow, 'pr', pull)?.revision, 'Revision unverified'); assert.equal(reviewDeskItem(workflow, 'pr', pull)?.tint, 'workflow');
  assert.equal(reviewDeskItem(item, 'pr')?.revision, 'Revision unverified');
});
test('desk reviews carry the findings roll-up of the current run only', () => {
  const findings = { sessionId: 'run', format: 'findings', mix: [{ key: 'low', count: 2, label: 'low' }], progress: '1 sent', recipient: 'Claude · impl' };
  const current = { ...item, resource: { ...item.resource!, data: { ...item.resource!.data, sessionId: 'run', findings } } };
  assert.deepEqual(reviewDeskItem(current, 'pr', pull)?.findings, { mix: findings.mix, progress: '1 sent · to Claude · impl' });
  assert.equal(reviewDeskItem({ ...current, resource: { ...current.resource, data: { ...current.resource.data, sessionId: 'retried' } } }, 'pr', pull)?.findings, undefined);
});
