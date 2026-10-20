import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentResourceCreateSchema, creationConnections, creationConnectionSchema, creationNear, placedRequest, resourceCreateSchema } from './resource-creation.ts';
import type { GraphNode } from '../../src/graph/graph.ts';

const request = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'terminal.session', title: 'Shell', data: {}, ...extra });
const connection = (otherId: string) => ({ id: randomUUID(), otherId, kind: 'reference' as const, sourceIsNew: true });
const nodes: GraphNode[] = [
  { id: 'p', title: 'p', position: { x: 0, y: 0 } }, { id: 'gone', title: 'gone', position: { x: 0, y: 0 }, archivedAt: '2026-10-07T00:00:00.000Z' },
  { id: 'agent', title: 'agent', resourceId: 'agent-r', projectId: 'p', position: { x: 0, y: 0 } }, { id: 'floating', title: 'floating', resourceId: 'floating-r', position: { x: 900, y: 0 } },
];

test('a creation request keeps its old shape and no longer needs a position', () => {
  const old = request({ position: { x: 1, y: 2 }, projectId: 'p' });
  assert.deepEqual(resourceCreateSchema.parse(old), old);
  assert.equal(resourceCreateSchema.parse(request()).position, undefined);
  assert.equal(resourceCreateSchema.parse(request({ placedBy: 'agent' })).placedBy, 'agent');
});

test('only the host names the asking agent', () => {
  assert.ok(!('placedBy' in agentResourceCreateSchema.parse(request({ placedBy: 'someone-else' }))));
  assert.throws(() => agentResourceCreateSchema.parse(request({ connections: Array.from({ length: 9 }, () => connection('agent')) })));
});

test('an agent\'s request is placed beside its connections, then the agent', () => {
  assert.deepEqual(creationNear(resourceCreateSchema.parse(request({ position: { x: 1, y: 2 } }))), {});
  assert.deepEqual(creationNear(resourceCreateSchema.parse(request({ placedBy: 'agent', connection: connection('pr'), connections: [connection('note')] }))), { near: ['pr', 'note', 'agent'] });
});

test('a request joins its anchor\'s project before any host work, and a named project is kept', () => {
  assert.equal(placedRequest(resourceCreateSchema.parse(request({ placedBy: 'agent' })), nodes).projectId, 'p');
  assert.equal(placedRequest(resourceCreateSchema.parse(request({ placedBy: 'agent', connection: connection('floating') })), nodes).projectId, undefined);
  const named = resourceCreateSchema.parse(request({ placedBy: 'floating', projectId: 'p' }));
  assert.equal(placedRequest(named, nodes), named);
  const person = resourceCreateSchema.parse(request({ position: { x: 5, y: 5 } }));
  assert.equal(placedRequest(person, nodes), person);
});

test('a request nothing can place is refused before any host work', () => {
  assert.throws(() => placedRequest(resourceCreateSchema.parse(request()), nodes), /position is required/);
  assert.throws(() => placedRequest(resourceCreateSchema.parse(request({ placedBy: 'mcp-client' })), nodes), /position is required/);
  assert.throws(() => placedRequest(resourceCreateSchema.parse(request({ placedBy: 'agent', projectId: 'gone' })), nodes), /position is required/);
  assert.equal(placedRequest(resourceCreateSchema.parse(request({ placedBy: 'mcp-client', position: { x: 5, y: 5 } })), nodes).projectId, undefined);
});

test('a connection saves its label with the link, and none when it has no label', () => {
  const link = { id: randomUUID(), otherId: 'rollout', kind: 'context' as const, sourceIsNew: false };
  assert.deepEqual(creationConnections([{ ...link, label: 'Validation' }, { ...link, id: 'b', otherId: 'pr' }], 'agent').map(command => command.link),
    [{ id: link.id, sourceId: 'rollout', targetId: 'agent', kind: 'context', label: 'Validation' }, { id: 'b', sourceId: 'pr', targetId: 'agent', kind: 'context', label: '' }]);
  assert.equal(creationConnectionSchema.parse({ ...link, label: 'Validation' }).label, 'Validation');
  assert.equal('label' in creationConnectionSchema.parse(link), false);
});

test('a connection can be saved to show only on hover', () => {
  const link = { id: randomUUID(), otherId: 'rollout', kind: 'context' as const, sourceIsNew: false, label: 'Validation', reveal: 'hover' as const };
  assert.deepEqual(creationConnections(creationConnectionSchema.parse(link), 'agent').map(command => command.link),
    [{ id: link.id, sourceId: 'rollout', targetId: 'agent', kind: 'context', label: 'Validation', reveal: 'hover' }]);
  assert.equal('reveal' in creationConnections({ ...link, reveal: undefined }, 'agent')[0].link, false);
});
