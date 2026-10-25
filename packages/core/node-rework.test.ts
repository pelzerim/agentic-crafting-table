import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl } from './control.ts';
import type { WorkspaceCommand } from './control.ts';
import { COMMAND_REVISION_RULES } from './revision-policy.ts';
import { attentionItems } from '../../src/graph/attention.ts';

async function fixture() {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (commands: WorkspaceCommand[], actor: 'user' | 'provider' | 'agent' = 'user') => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: actor, id: 'test' }, commands })).state;
  await apply([
    { type: 'project.create', id: 'project', title: 'Project', summary: '', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Plan switcher', data: { owner: 'acme', repo: 'app', number: 48 }, projectId: 'project', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr-alias', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Plan switcher', data: { owner: 'acme', repo: 'app', number: 48 }, position: { x: 3000, y: 0 } },
  ]);
  return { control, apply };
}
const at = (state: Awaited<ReturnType<WorkspaceControl['read']>>, id: string) => state.nodes.find(node => node.id === id)!;

test('a rework note puts every node of the item in the working state until it is cleared; provider status cannot take it out', async () => {
  const { apply } = await fixture();
  let state = await apply([{ type: 'node.rework', id: 'pr', note: 'Addressing the review findings', by: 'agent-1' }], 'agent');
  for (const id of ['pr', 'pr-alias']) {
    assert.equal(at(state, id).activity, 'working');
    assert.deepEqual([at(state, id).rework?.note, at(state, id).rework?.by], ['Addressing the review findings', 'agent-1']);
    assert.ok(at(state, id).rework?.since);
  }
  state = await apply([{ type: 'node.update', id: 'pr', activity: 'idle', summary: 'Ready for review' }], 'provider');
  assert.deepEqual([at(state, 'pr').activity, at(state, 'pr').summary], ['working', 'Ready for review']);
  state = await apply([{ type: 'node.rework', id: 'pr-alias', note: null }]);
  for (const id of ['pr', 'pr-alias']) { assert.equal(at(state, id).rework, undefined); assert.equal(at(state, id).activity, 'idle'); }
  state = await apply([{ type: 'node.update', id: 'pr', activity: 'complete' }], 'provider');
  assert.equal(at(state, 'pr').activity, 'complete');
});

test('a rework note belongs to items, is short, and anyone may set or clear it without a fresh read', async () => {
  const { apply } = await fixture();
  await assert.rejects(apply([{ type: 'node.rework', id: 'project', note: 'x' }]), /item/);
  await assert.rejects(apply([{ type: 'node.rework', id: 'pr', note: 'x'.repeat(201) }]));
  await assert.rejects(apply([{ type: 'node.rework', id: 'pr', note: '' }]));
  assert.equal(COMMAND_REVISION_RULES['node.rework'].free, true);
});

test('an agent finishing its rework puts the item in Needs me as my turn; clearing it by hand does not, and a new rework takes it back', async () => {
  const { apply } = await fixture();
  const needs = (state: Awaited<ReturnType<WorkspaceControl['read']>>) => attentionItems(state.nodes).filter(item => item.node.resourceId === 'pr-r').map(item => [item.tier, item.details.join(' · ')]);
  let state = await apply([{ type: 'node.rework', id: 'pr', note: 'Fixing CI', by: 'agent-1' }], 'agent');
  state = await apply([{ type: 'node.rework', id: 'pr', note: null }]);
  assert.deepEqual(needs(state), [], 'Mark as completed manually raises nothing');
  state = await apply([{ type: 'node.rework', id: 'pr', note: 'Addressing review findings', by: 'agent-1' }], 'agent');
  state = await apply([{ type: 'node.rework', id: 'pr', note: null, by: 'agent-1' }], 'agent');
  assert.deepEqual(needs(state), [['turn', 'Reworked: Addressing review findings']]);
  assert.equal(at(state, 'pr').activity, 'idle');
  state = await apply([{ type: 'node.rework', id: 'pr', note: 'One more fix', by: 'agent-1' }], 'agent');
  assert.deepEqual(needs(state), [], 'working on it again takes it out of Needs me');
});
