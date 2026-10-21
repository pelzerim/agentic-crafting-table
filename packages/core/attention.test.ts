import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl, stateSchema, emptyState } from './control.ts';
import { attentionItems, attentionReceipt } from '../../src/graph/attention.ts';
import { completionAttention } from './completion-attention.ts';

test('view receipts persist independently of input, alias placement and user completion; stale receipts preserve newer attention', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (command: unknown) => control.apply(command, (await control.read()).revision);
  const add = (id: string) => ({ type: 'item.add', id, resourceId: `resource-${id}`, pluginId: 'github.pull-request', title: id, position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'repo', number: 1 } });
  await apply(add('a')); await apply(add('alias'));
  await apply({ type: 'node.update', id: 'a', attention: 'input', activity: 'idle' });
  let state = await apply({ type: 'attention.set', id: 'a', source: 'github.assignment', reason: 'assigned' });
  const before = structuredClone(state), receipt = attentionReceipt(state.nodes, 'a');
  state = await apply({ type: 'attention.acknowledge', ...receipt });
  assert.equal(attentionItems(state.nodes).length, 0);
  assert.equal(state.nodes[0].attention, 'input'); assert.equal(state.nodes[0].activity, 'idle');
  assert.deepEqual(state.resources, before.resources); assert.deepEqual(state.links, before.links);
  state = await apply({ type: 'attention.set', id: 'a', source: 'github.assignment', reason: 'assigned' });
  assert.equal(attentionItems(state.nodes).length, 0, 'an unchanged poll does not make a seen item unread');
  await apply(add('later-alias'));
  assert.equal(attentionItems((await control.read()).nodes).length, 0, 'new aliases inherit the observed read state');
  state = await apply({ type: 'attention.set', id: 'a', source: 'completion', reason: 'finished', eventId: 'turn-1' });
  assert.equal(attentionItems(state.nodes).length, 1);
  state = await apply({ type: 'attention.acknowledge', ...receipt });
  assert.equal(attentionItems(state.nodes).length, 1, 'a delayed receipt cannot acknowledge a newer turn');
  state = await apply({ type: 'attention.acknowledge', ...attentionReceipt(state.nodes, 'later-alias') });
  assert.equal(attentionItems(state.nodes).length, 0);
  state = await apply({ type: 'node.complete', id: 'a' });
  state = await apply({ type: 'node.update', id: 'a', attention: 'error' });
  assert.deepEqual(attentionItems(state.nodes)[0].reasons, ['error', 'assigned', 'finished']);
  assert.ok(state.nodes[0].completedAt);
  const restored = stateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(attentionItems(restored.nodes), JSON.parse(JSON.stringify(attentionItems(state.nodes))));
});

test('completion replay is idempotent after viewing and restarting work; each later turn resurfaces', async () => {
  const control = new WorkspaceControl();
  const apply = async (command: unknown) => control.apply(command, (await control.read()).revision);
  let state = await apply({ type: 'project.create', id: 'item', title: 'Fixture', position: { x: 0, y: 0 } });
  const completion = completionAttention(state.nodes[0], 'turn-1', 'Agent finished')[0];
  state = await apply(completion);
  const receipt = attentionReceipt(state.nodes, 'item');
  state = await apply({ type: 'attention.acknowledge', ...receipt });
  assert.equal(completionAttention(state.nodes[0], 'turn-1', 'Agent finished').length, 0);
  state = await apply({ type: 'node.update', id: 'item', activity: 'working' });
  state = await apply(completion);
  assert.equal(state.nodes[0].attentionSources?.completion, undefined); assert.equal(state.nodes[0].attentionNotes, undefined);
  assert.equal(attentionItems(state.nodes).length, 0);
  state = await apply(completionAttention(state.nodes[0], 'turn-2', 'Agent finished')[0]);
  assert.deepEqual(attentionItems(state.nodes)[0].reasons, ['finished']); assert.deepEqual(attentionItems(state.nodes)[0].notes, ['Agent finished']);
  state = await apply({ type: 'attention.acknowledge', ...receipt });
  assert.equal(attentionItems(state.nodes).length, 1);
  state = await apply({ type: 'node.update', id: 'item', activity: 'idle' });
  state = await apply({ type: 'node.update', id: 'item', activity: 'working' });
  assert.equal(attentionItems(state.nodes).length, 1, 'starting more work cannot dismiss an unread result');
});

test('legacy snapshots are unread until acknowledged, without resetting saved data', () => {
  const state = stateSchema.parse({ ...emptyState(), nodes: [{ id: 'old', title: 'Old', attention: 'input', position: { x: 7, y: 9 } }] });
  assert.equal(attentionItems(state.nodes).length, 1);
  assert.deepEqual(attentionReceipt(state.nodes, 'old').versions, { old: 0 });
  assert.equal(attentionItems([{ ...state.nodes[0], attentionSeenVersion: 0 }]).length, 0);
});
test('activity time records real changes of activity, indicators and raised attention, not repeated polls, summaries or renames', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (command: unknown) => control.apply(command, (await control.read()).revision);
  const at = async () => (await control.read()).nodes.find(node => node.id === 'a')?.activityAt;
  await apply({ type: 'item.add', id: 'a', resourceId: 'resource-a', pluginId: 'github.pull-request', title: 'a', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'repo', number: 1 } });
  assert.equal(await at(), undefined);
  const indicators = [{ id: 'review-state', label: 'Open', tone: 'green', icon: 'git-pull-request' }];
  for (const change of [{ activity: 'working' }, { indicators }, { attention: 'input' }]) {
    await apply({ type: 'node.update', id: 'a', title: 'renamed', summary: `summary ${JSON.stringify(change)}` }); const before = await at();
    await new Promise(resolve => setTimeout(resolve, 2));
    await apply({ type: 'node.update', id: 'a', ...change }); const after = await at();
    assert.ok(after && (!before || after > before), JSON.stringify(change));
    await new Promise(resolve => setTimeout(resolve, 2));
    await apply({ type: 'node.update', id: 'a', ...change });
    assert.equal(await at(), after, `repeating ${JSON.stringify(change)} keeps the time`);
  }
  const before = await at(); await new Promise(resolve => setTimeout(resolve, 2));
  await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: 'approved' });
  assert.ok((await at())! > before!);
  const raised = await at(); await new Promise(resolve => setTimeout(resolve, 2));
  await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: null });
  assert.equal(await at(), raised, 'clearing attention is not activity');
});

test('attention notes follow their source: set, restated, replaced, cleared and inherited by aliases', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (command: unknown) => control.apply(command, (await control.read()).revision);
  const add = (id: string) => ({ type: 'item.add', id, resourceId: `resource-${id}`, pluginId: 'github.pull-request', title: id, position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'repo', number: 1 } });
  await apply(add('a'));
  let state = await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: 'input', note: ' Production needs\napproval. ', eventId: 'gate-1' });
  assert.deepEqual(state.nodes[0].attentionNotes, { provider: 'Production needs approval' });
  const version = state.nodes[0].attentionVersion;
  state = await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: 'input', note: 'Job needs approval', eventId: 'gate-1' });
  assert.deepEqual([state.nodes[0].attentionNotes, state.nodes[0].attentionVersion], [{ provider: 'Job needs approval' }, version], 'a replayed event updates its words without re-alerting');
  state = await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: 'error', eventId: 'failed' });
  assert.equal(state.nodes[0].attentionNotes, undefined, 'a new reason without a note drops the stale one');
  await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: 'error', note: 'Rollout failed', eventId: 'failed-2' });
  state = await apply({ type: 'attention.set', id: 'a', source: 'other', reason: 'finished', note: 'Rollout finished' });
  assert.deepEqual(attentionItems(state.nodes)[0].notes, ['Rollout failed', 'Rollout finished']);
  state = await apply(add('alias'));
  assert.deepEqual(state.nodes[1].attentionNotes, { provider: 'Rollout failed', other: 'Rollout finished' });
  state = await apply({ type: 'attention.set', id: 'a', source: 'provider', reason: null, note: 'ignored' });
  assert.deepEqual(state.nodes.map(node => node.attentionNotes), [{ other: 'Rollout finished' }, { other: 'Rollout finished' }]);

  state = await apply({ type: 'node.update', id: 'a', attention: 'input', attentionNote: 'Agent needs permission' });
  assert.equal(state.nodes[0].attentionNote, 'Agent needs permission');
  state = await apply({ type: 'node.update', id: 'a', attention: 'input' });
  assert.equal(state.nodes[0].attentionNote, 'Agent needs permission', 'restating the same attention keeps its note');
  state = await apply({ type: 'node.update', id: 'a', attention: 'input', attentionNote: 'Agent asked a question' });
  assert.equal(state.nodes[0].attentionNote, 'Agent asked a question');
  state = await apply({ type: 'node.update', id: 'a', attention: 'error' });
  assert.equal(state.nodes[0].attentionNote, undefined, 'changed attention without a note has none');
  state = await apply({ type: 'node.update', id: 'a', attention: 'none', attentionNote: 'ignored' });
  assert.equal(state.nodes[0].attentionNote, undefined);
  assert.equal(stateSchema.parse(JSON.parse(JSON.stringify(state))).nodes[0].attentionNotes?.other, 'Rollout finished');
});

test('attention.restore puts the cycle an open acknowledged back into Needs me; a newer turn or a stale receipt is left alone', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (command: unknown) => control.apply(command, (await control.read()).revision);
  await apply({ type: 'item.add', id: 'a', resourceId: 'resource-a', pluginId: 'github.pull-request', title: 'a', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'repo', number: 1 } });
  let state = await apply({ type: 'attention.set', id: 'a', source: 'turn', reason: 'input' });
  const receipt = attentionReceipt(state.nodes, 'a');
  state = await apply({ type: 'attention.acknowledge', ...receipt });
  assert.equal(attentionItems(state.nodes).length, 0);
  state = await apply({ type: 'attention.restore', ...receipt });
  assert.equal(attentionItems(state.nodes).length, 1, 'the acknowledged cycle is unread again');
  assert.equal(attentionItems(state.nodes)[0].tier, 'asking');
  state = await apply({ type: 'attention.acknowledge', ...attentionReceipt(state.nodes, 'a') });
  state = await apply({ type: 'attention.set', id: 'a', source: 'completion', reason: 'finished', eventId: 'turn-2' });
  state = await apply({ type: 'attention.acknowledge', ...attentionReceipt(state.nodes, 'a') });
  state = await apply({ type: 'attention.restore', ...receipt });
  assert.equal(attentionItems(state.nodes).length, 0, 'a receipt from an older cycle restores nothing');
});
