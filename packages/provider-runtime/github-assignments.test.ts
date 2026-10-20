import test from 'node:test';
import assert from 'node:assert/strict';
import { githubAssignmentAdapter } from './github-assignments.ts';
import { GitHubClient } from './github.ts';
import { pullFixture } from '../../tests/fixtures/github.ts';

test('missing assigned PRs are verified directly; lost access or wrong accounts never become unassignment', async () => {
  const connection = { id: 'github', providerId: 'github', account: 'fixture-developer', enabled: true, isDefault: true }, previous = [{ key: 'fixture/billing/pull/42', data: { owner: 'fixture', repo: 'billing', number: 42 }, title: pullFixture.title, assigned: true, cycle: 'cycle' }];
  let login = connection.account, status = 200, pull = structuredClone(pullFixture);
  const paths: string[] = [];
  const client = new GitHubClient({ async get(path) { paths.push(path); return { status: path.startsWith('/repos/') ? status : 200, headers: new Headers(), body: path === '/user' ? { id: 1, login } : path.startsWith('/issues?') ? [] : pull }; } });
  const adapter = githubAssignmentAdapter(() => client), signal = AbortSignal.timeout(1000);
  assert.equal((await adapter.discover(connection, previous, signal))[0].assigned, true); assert.ok(paths.some(path => path === '/repos/fixture/billing/pulls/42'));
  pull.assignees = []; assert.equal((await adapter.discover(connection, previous, signal))[0].assigned, false);
  status = 404; await assert.rejects(adapter.discover(connection, previous, signal), /unavailable/);
  login = 'another-user'; await assert.rejects(adapter.discover(connection, previous, signal), /different signed-in account/);
});
