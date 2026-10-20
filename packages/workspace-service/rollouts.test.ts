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
import { attentionItems, attentionReceipt } from '../../src/graph/attention.ts';
import { rolloutFixture } from '../../tests/fixtures/rollout.ts';

test('rollouts attach/deduplicate through shared commands, poll while closed, acknowledge/rearm across runs and preserve stale state through restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-rollout-')), path = join(directory, 'workspace.sqlite'), providers = rolloutFixture();
  let now = Date.now(), store = new SqliteStore(path), control = new WorkspaceControl(store);
  const coordinator = () => new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => {}, () => now);
  let resources = coordinator();
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  const tick = async () => { now += 61_000; await resources.poll(); };
  const attention = async () => attentionItems((await control.read()).nodes);
  const ack = async () => apply([{ type: 'attention.acknowledge', ...attentionReceipt((await control.read()).nodes, 'rollout') }]);
  try {
    // MCP and UI both use the registry/shared coordinator, without transport cases.
    assert.ok(control.registry.describe().some(plugin => plugin.id === 'github.rollout'));
    await apply([{ type: 'item.add', id: 'rollout', resourceId: 'resource', pluginId: 'github.rollout', title: 'Agent-created observer', data: { owner: 'fixture', repo: 'web', workflow: 'deploy.yml' }, position: { x: 400, y: 200 } }]);
    const attached = await resources.attach({ requestId: randomUUID(), nodeId: 'duplicate', resourceId: 'duplicate-resource', expectedRevision: (await control.read()).revision, pluginId: 'github.rollout', title: 'URL', data: { url: 'https://github.com/fixture/web/actions/workflows/deploy.yml' }, position: { x: 50, y: 60 } });
    assert.deepEqual(attached, { nodeId: 'rollout', resourceId: 'resource' }); assert.equal((await control.read()).resources.length, 1);
    providers.gates = [{ environment: { id: 1, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }];
    providers.run.status = 'waiting'; await tick();
    assert.equal((await attention())[0].reasons[0], 'input'); await ack(); await tick(); assert.equal((await attention()).length, 0);
    providers.run.status = 'in_progress'; providers.gates = []; await tick();
    providers.run.status = 'waiting'; providers.gates = [{ environment: { id: 1, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [] }];
    await tick(); assert.equal((await attention()).length, 1); await ack();
    providers.gates = []; providers.run.status = 'completed'; providers.run.conclusion = 'success';
    providers.jobs = providers.jobs.map(job => ({ ...job, status: 'completed', conclusion: 'success' })); await tick();
    assert.equal((await attention())[0].reasons[0], 'finished');
    assert.equal((await control.read()).nodes[0].indicators?.[0].label, 'Passed');
    await ack(); await resources.close(); store.close(); store = new SqliteStore(path); control = new WorkspaceControl(store); resources = coordinator();
    await tick(); assert.equal((await attention()).length, 0);
    // A whole new run can finish between polls. Its event must not be swallowed.
    providers.run.id++; providers.run.run_number++; providers.jobs = providers.jobs.map(j => ({ ...j, run_id: providers.run.id })); await tick();
    assert.equal((await attention()).length, 1); await ack();
    providers.fail(429, { 'retry-after': '3600' }); await tick();
    assert.equal((await resources.read('rollout')).stale, true);
    assert.deepEqual((await control.read()).nodes[0].indicators?.map(cue => cue.label), ['Passed', '3/3 jobs', 'Updates paused']);
    const calls = providers.paths.length; await resources.close(); store.close(); store = new SqliteStore(path); control = new WorkspaceControl(store); resources = coordinator();
    await tick(); assert.equal(providers.paths.length, calls);
    now += 3_600_000; providers.fail(200); await tick();
    assert.deepEqual((await control.read()).nodes[0].indicators?.map(cue => cue.label), ['Passed', '3/3 jobs']);
    await apply([{ type: 'node.archive', id: 'rollout' }]); const before = providers.paths.length; await tick(); assert.equal(providers.paths.length, before);
    await apply([{ type: 'node.restore', id: 'rollout' }]); await tick(); assert.ok(providers.paths.length > before);
    providers.accounts[0].enabled = false; const stopped = providers.paths.length; await tick(); assert.equal(providers.paths.length, stopped);
  } finally { await resources.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
