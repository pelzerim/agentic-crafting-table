import test from 'node:test';
import assert from 'node:assert/strict';
import { completionNotices } from './use-attention.ts';
import { emptyState, stateSchema } from '../../../packages/core/control.ts';

const state = (nodes: unknown[], links: unknown[] = [], revision = 1) => stateSchema.parse({ ...emptyState(), revision, nodes, links });
const project = (id: string, mutedAt?: string) => ({ id, title: id, position: { x: 0, y: 0 }, ...(mutedAt ? { mutedAt } : {}) });
const item = (id: string, projectId: string, extra = {}) => ({ id, resourceId: `r-${id}`, projectId, title: id, position: { x: 0, y: 0 }, ...extra });
const finished = { attentionSources: { completion: 'finished' }, attentionEvents: { completion: 'turn-2' }, attentionVersion: 1 };
const MUTED = '2026-10-05T08:00:00.000Z';

test('a finished item announces once; in a muted project it announces nothing, also after unmuting', () => {
  const before = state([project('loud'), project('quiet', MUTED), item('a', 'loud'), item('b', 'quiet')]);
  const after = state([project('loud'), project('quiet', MUTED), item('a', 'loud', finished), item('b', 'quiet', finished)], [], 2);
  assert.deepEqual(completionNotices(before, after).map(notice => notice.nodeId), ['a']);
  const unmuted = state([project('loud'), project('quiet'), item('a', 'loud', finished), item('b', 'quiet', finished)], [], 3);
  assert.deepEqual(completionNotices(after, unmuted), [], 'unmuting replays no completion');
});

test('an item unblocked inside a muted project stays quiet', () => {
  const nodes = (done: boolean, mutedAt?: string) => [project('loud'), project('quiet', mutedAt), item('gate', 'loud', done ? { completedAt: MUTED } : {}), item('held-l', 'loud'), item('held-q', 'quiet')];
  const links = [{ id: 'l1', sourceId: 'gate', targetId: 'held-l', kind: 'blocks' }, { id: 'l2', sourceId: 'gate', targetId: 'held-q', kind: 'blocks' }];
  assert.deepEqual(completionNotices(state(nodes(false, MUTED), links), state(nodes(true, MUTED), links, 2)).map(notice => [notice.nodeId, notice.unblocked]), [['held-l', true]]);
  assert.deepEqual(completionNotices(state(nodes(false), links), state(nodes(true), links, 2)).map(notice => notice.nodeId), ['held-l', 'held-q']);
});

test('a provider change that did not go through announces once; other errors stay in Needs me only', () => {
  const declined = { attentionSources: { 'action:github.pull-request': 'error' }, attentionEvents: { 'action:github.pull-request': 'request-1' }, attentionNotes: { 'action:github.pull-request': 'Merge of #42 didn’t go through' }, attentionVersion: 1 };
  const failing = { attentionSources: { 'provider:github.rollout': 'error' }, attentionEvents: { 'provider:github.rollout': 'run-9' }, attentionNotes: { 'provider:github.rollout': 'Rollout failed' }, attentionVersion: 1 };
  const before = state([project('loud'), item('pr', 'loud'), item('rollout', 'loud')]);
  const after = state([project('loud'), item('pr', 'loud', declined), item('rollout', 'loud', failing)], [], 2);
  assert.deepEqual(completionNotices(before, after), [{ key: 'r-pr:action:github.pull-request:request-1', nodeId: 'pr', title: 'pr', note: 'Merge of #42 didn’t go through', failed: true }]);
  assert.deepEqual(completionNotices(after, state([project('loud'), item('pr', 'loud', declined)], [], 3)), [], 'the same refusal never announces twice');
});
