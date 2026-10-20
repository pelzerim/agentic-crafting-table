import test from 'node:test';
import assert from 'node:assert/strict';
import { githubPullRequest } from './items/github-pull-request/definition.ts';
import { githubRollout } from './items/github-rollout/definition.ts';

test('context-menu Merge and production Approve confirm in two steps like their view buttons', () => {
  const choices = (plugin: typeof githubPullRequest, id: string) => plugin.contextMenu?.find(group => group.id === id)?.choices;
  assert.equal(choices(githubPullRequest, 'merge')?.irreversible, true);
  assert.equal(choices(githubRollout, 'approve')?.irreversible, true);
  assert.notEqual(choices(githubPullRequest, 'showShip')?.irreversible, true);
});

test('a merge is confirmed once, by picking the method under its question; an approval keeps its second step', () => {
  const choices = (plugin: typeof githubPullRequest, id: string) => plugin.contextMenu?.find(group => group.id === id)?.choices;
  assert.equal(choices(githubPullRequest, 'merge')?.pickConfirms, true);
  assert.notEqual(choices(githubRollout, 'approve')?.pickConfirms, true);
});
