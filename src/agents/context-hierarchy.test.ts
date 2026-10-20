import test from 'node:test';
import assert from 'node:assert/strict';
import { stateSchema } from '../../packages/core/control.ts';
import { createResourcePluginRegistry } from '../resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../resource-plugins/define.ts';
import { contextHierarchy, MAX_CONTEXT_ITEMS } from './context-hierarchy.ts';

const registry = createResourcePluginRegistry();
const node = (id: string, extra = {}) => ({ id, title: id, position: { x: 0, y: 0 }, ...extra });
const resource = (id: string, pluginId: string, data = {}) => ({ id, pluginId, data, schemaVersion: 1, title: id });
const link = (id: string, sourceId: string, targetId: string, kind = 'reference') => ({ id, sourceId, targetId, kind });
function fixture() {
  return stateSchema.parse({ version: 1, revision: 0, view: {}, todos: [], nodes: [
    node('project'), node('other'), node('agent', { resourceId: 'agent-r', projectId: 'project', acceptsContext: true }),
    node('pr', { resourceId: 'pr-r', projectId: 'project' }),
    node('a-review', { resourceId: 'review-r', projectId: 'project', activity: 'complete' }),
    node('note', { resourceId: 'note-r', projectId: 'project', completedAt: '2026-09-28T00:00:00Z' }),
    node('alias', { resourceId: 'note-r', projectId: 'other' }),
    node('external', { resourceId: 'external-r', projectId: 'other' }), node('unrelated', { projectId: 'other' }),
    node('archived', { projectId: 'project', archivedAt: '2026-09-28T00:00:00Z' }),
    node('loose-ticket', { resourceId: 'loose-r', projectId: 'project' }), node('sent-below', { resourceId: 'below-r', projectId: 'project', belowAt: '2026-09-28T00:00:00Z' }),
  ], resources: [resource('agent-r', 'agent.session', { provider: 'claude' }), resource('pr-r', 'github.pull-request'),
    resource('review-r', 'code.review', { sourcePrId: 'pr', headSha: 'abc', provider: 'claude', secret: 'NEVER_EMIT' }),
    resource('note-r', 'workspace.note'), resource('external-r', 'future.thing'), resource('loose-r', 'linear.ticket'), resource('below-r', 'workspace.note')],
  links: [link('review-pr', 'a-review', 'pr'), link('pr-agent', 'pr', 'agent', 'context'), link('note-pr', 'alias', 'pr'),
    link('note-review', 'note', 'a-review'), link('external-note', 'external', 'alias'), link('below-pr', 'sent-below', 'pr')] });
}

test('context centers on the agent: directly and indirectly connected items, never unconnected project members or Undermap items', () => {
  const state = fixture(), result = contextHierarchy(state, 'agent', registry);
  assert.equal(result.project?.nodeId, 'project');
  assert.deepEqual(new Set(result.entries.map(entry => entry.nodeId)), new Set(['pr', 'a-review', 'note', 'external']));
  // Unconnected project members are brief background only; archived/Undermap items are left out.
  assert.deepEqual(result.projectItems, [{ nodeId: 'loose-ticket', title: 'loose-ticket', type: 'linear.ticket', activity: 'unknown', done: false }]);
  assert.match(result.scope, /connected to this agent/);
  const review = result.entries.find(entry => entry.nodeId === 'a-review')!;
  assert.equal(review.parentId, 'pr'); assert.equal(review.activity, 'complete');
  assert.ok(result.entries.findIndex(entry => entry.nodeId === 'pr') < result.entries.indexOf(review));
  assert.equal(result.entries.find(entry => entry.nodeId === 'note')?.done, true);
  assert.equal(result.entries.find(entry => entry.nodeId === 'external')?.type, 'future.thing');
  assert.deepEqual(review.facts, { provider: 'claude', headSha: 'abc' });
  assert.ok(!JSON.stringify(result).includes('NEVER_EMIT'));
  assert.equal(result.links.find(link => link.id === 'note-pr')?.sourceId, 'note');
  assert.deepEqual(contextHierarchy({ ...state, nodes: [...state.nodes].reverse(), links: [...state.links].reverse() }, 'agent', registry), result);
});

test('floating agents see explicit linked hierarchy only; removing a connection drops unreachable context', () => {
  const state = fixture(); state.nodes.find(node => node.id === 'agent')!.projectId = undefined;
  const linked = contextHierarchy(state, 'agent', registry);
  assert.equal(linked.project, null); assert.equal(linked.entries.length, 4);
  const cleared = contextHierarchy({ ...state, links: state.links.filter(link => link.id !== 'pr-agent') }, 'agent', registry);
  assert.equal(cleared.entries.length, 0);
});

test('large connected sets have an explicit omission count and bounded, parent-first depth', () => {
  const state = fixture();
  for (let i = 0; i < MAX_CONTEXT_ITEMS + 20; i++) {
    state.nodes.push(stateSchema.shape.nodes.element.parse(node(`extra-${i}`, { projectId: 'project' })));
    state.links.push(stateSchema.shape.links.element.parse(link(`extra-link-${i}`, `extra-${i}`, 'pr')));
  }
  const result = contextHierarchy(state, 'agent', registry);
  assert.equal(result.entries.length, MAX_CONTEXT_ITEMS); assert.equal(result.omittedItems, 24);
  assert.ok(result.entries.every(entry => !entry.parentId || result.entries.findIndex(other => other.nodeId === entry.parentId) < result.entries.indexOf(entry)));
});

test('a new plugin declares its parent and safe context facts without graph branches; parent cycles remain finite', () => {
  const custom = createResourcePluginRegistry();
  custom.register(defineResourcePlugin({ id: 'future.thing', name: 'Future item', apiVersion: 1, schemaVersion: 1, icon: 'box', preferredView: 'focus',
    context: { parentField: 'parent', fields: ['safe'] }, fields: { parent: { kind: 'text', label: 'Parent' }, safe: { kind: 'text', label: 'Safe' } } }));
  const state = fixture(); state.resources.find(resource => resource.id === 'external-r')!.data = { parent: 'alias', safe: 'metadata', secret: 'NEVER_EMIT' };
  const result = contextHierarchy(state, 'agent', custom), item = result.entries.find(entry => entry.nodeId === 'external')!;
  assert.equal(item.parentId, 'note'); assert.deepEqual(item.facts, { safe: 'metadata' });
  state.resources.find(resource => resource.id === 'note-r')!.pluginId = 'future.thing';
  state.resources.find(resource => resource.id === 'note-r')!.data = { parent: 'external' };
  const cycle = contextHierarchy(state, 'agent', custom);
  assert.equal(cycle.entries.length, 4);
  assert.ok(cycle.entries.every(entry => !entry.parentId || cycle.entries.findIndex(other => other.nodeId === entry.parentId) < cycle.entries.indexOf(entry)));
});

test('entries state blocking order: what an item blocks and what still blocks it, resolved blockers marked', () => {
  const state = fixture();
  state.links.push(...[link('external-blocks-pr', 'external', 'pr', 'blocks'), link('note-blocks-pr', 'alias', 'pr', 'blocks'), link('pr-blocks-review', 'pr', 'a-review', 'blocks')].map(entry => ({ ...entry, label: '' }) as never));
  const entries = contextHierarchy(state, 'agent', registry).entries, pr = entries.find(entry => entry.nodeId === 'pr')!;
  assert.equal(pr.facts.blockedBy, 'external; note (resolved)');
  assert.equal(pr.facts.blocks, 'a-review');
  assert.equal(entries.find(entry => entry.nodeId === 'a-review')!.facts.blockedBy, 'pr');
  assert.equal(entries.find(entry => entry.nodeId === 'external')!.facts.blocks, 'pr');
  assert.equal(entries.find(entry => entry.nodeId === 'note')!.facts.blockedBy, undefined);
});
