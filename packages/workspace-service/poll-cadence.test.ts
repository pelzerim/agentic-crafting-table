import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { requestBudget, resetRequestBudgets } from '../provider-runtime/request-budget.ts';

async function fixture(run: (input: { providers: ReturnType<typeof githubFixture>; coordinator: ResourceCoordinator; nodeId: string; now(): number; advance(ms: number): void; polled(): Promise<number>; apply(commands: WorkspaceCommand[]): Promise<void> }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-cadence-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), providers = githubFixture();
  let now = Date.parse('2026-09-30T08:00:00Z'); resetRequestBudgets({ now: () => now });
  const coordinator = new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => {}, () => now);
  const nodeId = randomUUID();
  try {
    await coordinator.attach({ requestId: randomUUID(), nodeId, resourceId: randomUUID(), expectedRevision: 0, pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { url: 'https://github.com/fixture/billing/pull/42' } });
    await run({ providers, coordinator, nodeId, now: () => now, advance: ms => { now += ms; },
      async polled() { const before = providers.requests; await coordinator.poll(); return providers.requests - before; },
      async apply(commands) { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands }); } });
  } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
/** Polls every 15 s for `minutes`, returning the minutes (from the start) at which a read happened. */
async function schedule(input: { advance(ms: number): void; polled(): Promise<number> }, minutes: number) {
  const reads: number[] = [];
  for (let tick = 1; tick <= minutes * 4; tick++) { input.advance(15_000); if (await input.polled()) reads.push(tick / 4); }
  return reads;
}

test('unchanged pull requests back off 1 → 2 → 5 → 10 minutes and a change snaps back to one minute', () => fixture(async input => {
  assert.deepEqual(await schedule(input, 30), [1, 2, 4, 9, 19, 29]);
  input.providers.pull = { ...input.providers.pull, title: 'Retitled on GitHub' };
  assert.deepEqual(await schedule(input, 12), [9, 10, 11], 'the change is seen at the ten-minute step, then the item polls every minute again');
}));

test('opening an item or new attention returns it to one-minute polling', () => fixture(async input => {
  assert.deepEqual(await schedule(input, 10), [1, 2, 4, 9]);
  input.advance(61_000); const before = input.providers.requests; await input.coordinator.read(input.nodeId);
  assert.equal(input.providers.requests - before, 5, 'an opened item reads at once');
  assert.deepEqual(await schedule(input, 10), [1, 2, 4, 9], 'and polls a minute later, backing off again');
  await input.apply([{ type: 'node.update', id: input.nodeId, attention: 'review' }]);
  assert.deepEqual(await schedule(input, 2), [0.25, 1.25], 'attention raised elsewhere snaps back at once');
}));

test('merged and closed pull requests settle to thirty minutes once past the rollout window', () => fixture(async input => {
  input.providers.pull = { ...input.providers.pull, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: new Date(Date.now() - 7 * 3_600_000).toISOString() } as typeof input.providers.pull;
  const reads = await schedule(input, 120);
  assert.deepEqual(reads.slice(0, 6), [1, 2, 3, 5, 10, 20]);
  assert.deepEqual(reads.slice(6), [50, 80, 110], 'settled items read every thirty minutes');
}));

test('background polling stops while the account budget is paused and user reads still go out', () => fixture(async input => {
  const budget = requestBudget('github', 'fixture-developer');
  budget.observe('core', { status: 200, limit: 5000, remaining: 1500, resetAt: input.now() + 3_600_000 });
  assert.deepEqual(await schedule(input, 5), [2, 4], 'slowed: every step takes twice as long');
  budget.observe('core', { status: 200, limit: 5000, remaining: 100, resetAt: input.now() + 600_000 });
  assert.deepEqual(await schedule(input, 9), [], 'paused until the window resets');
  const before = input.providers.requests; await input.coordinator.read(input.nodeId);
  assert.equal(input.providers.requests - before, 5);
  assert.ok((await schedule(input, 3)).length > 0, 'after the reset background polling resumes');
}));

const placeIn = (input: { apply(commands: WorkspaceCommand[]): Promise<void>; nodeId: string }, ...projects: string[]) => input.apply([
  ...projects.map((id, index) => ({ type: 'project.create' as const, id, title: id, summary: '', position: { x: index * 2000, y: 0 } })),
  { type: 'node.attach', id: input.nodeId, projectId: projects[0] }]);

test('a pull request in a muted project polls only at the slowest step while an unmuted one backs off as usual', async () => {
  await fixture(async input => {
    await placeIn(input, 'quiet');
    await input.apply([{ type: 'project.mute', id: 'quiet', muted: true }]);
    assert.deepEqual(await schedule(input, 30), [10, 20, 30], 'muted: every ten minutes from the start');
  });
  await fixture(async input => {
    await placeIn(input, 'loud');
    assert.deepEqual(await schedule(input, 30), [1, 2, 4, 9, 19, 29], 'its unmuted twin');
  });
});

test('unmuting reads the pull request on the next tick and returns it to the first step', () => fixture(async input => {
  await placeIn(input, 'quiet');
  await input.apply([{ type: 'project.mute', id: 'quiet', muted: true }]);
  assert.deepEqual(await schedule(input, 3), []);
  await input.apply([{ type: 'project.mute', id: 'quiet', muted: false }]);
  assert.deepEqual(await schedule(input, 3), [0.25, 1.25], 'read at once, then backing off from one minute');
}));

test('a pull request also placed in an unmuted project keeps the ordinary cadence', () => fixture(async input => {
  await placeIn(input, 'quiet', 'loud');
  await input.coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'github.pull-request', title: 'PR', projectId: 'loud', position: { x: 2000, y: 0 }, data: { url: 'https://github.com/fixture/billing/pull/42' } });
  await input.apply([{ type: 'project.mute', id: 'quiet', muted: true }]);
  assert.deepEqual(await schedule(input, 30), [1, 2, 4, 9, 19, 29]);
}));
