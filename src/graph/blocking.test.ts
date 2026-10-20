import assert from 'node:assert/strict';
import test from 'node:test';
import { saveLink } from './graph.ts';
import type { GraphLink, GraphNode } from './graph.ts';
import { blockedBy, blockerResolved, blockingState, unblockedSince } from './blocking.ts';

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, resourceId: `r-${id}`, title: id.toUpperCase(), position: { x: 0, y: 0 }, ...extra });
const nodes = [node('a'), node('b'), node('c'), node('agent', { acceptsContext: true })];
const blocks = (id: string, sourceId: string, targetId: string): GraphLink => ({ id, sourceId, targetId, kind: 'blocks', label: '' });

test('a blocks link is a directed kind that refuses self-links, duplicates and cycles with a clear message', () => {
  const ab = saveLink(nodes, [], blocks('ab', 'a', 'b'));
  assert.equal(ab[0].kind, 'blocks');
  assert.throws(() => saveLink(nodes, [], blocks('aa', 'a', 'a')), /itself/);
  assert.throws(() => saveLink([...nodes, node('a2', { resourceId: 'r-a' })], [], blocks('alias', 'a', 'a2')), /itself/);
  assert.throws(() => saveLink(nodes, ab, blocks('ab2', 'a', 'b')), /already have this relationship/);
  assert.throws(() => saveLink(nodes, ab, blocks('ba', 'b', 'a')), /A already blocks B\. .*cycle/);
  const chain = saveLink(nodes, ab, blocks('bc', 'b', 'c'));
  assert.throws(() => saveLink(nodes, chain, blocks('ca', 'c', 'a')), /A already blocks C, through other items.*cycle/);
  // Aliases share identity, so a cycle through an alias is still a cycle.
  assert.throws(() => saveLink([...nodes, node('a2', { resourceId: 'r-a' })], chain, blocks('ca', 'c', 'a2')), /cycle/);
  // Editing a link in place replaces its old endpoints: flipping a→b to b→a is allowed.
  assert.deepEqual(saveLink(nodes, ab, blocks('ab', 'b', 'a')).map(link => [link.sourceId, link.targetId]), [['b', 'a']]);
  // A blocks link coexists with an informational link between the same items.
  assert.equal(saveLink(nodes, ab, { id: 'ref', sourceId: 'a', targetId: 'b', kind: 'reference', label: '' }).length, 2);
  // Changing an existing link's kind to blocks keeps the id and is validated the same way.
  const reference: GraphLink = { id: 'x', sourceId: 'c', targetId: 'a', kind: 'reference', label: '' };
  assert.throws(() => saveLink(nodes, [...chain, reference], { ...reference, kind: 'blocks' }), /cycle/);
  assert.throws(() => saveLink(nodes, [], { ...reference, kind: 'depends' as GraphLink['kind'] }), /Unknown relationship type/);
});

test('a blocker resolves generically: done, archived, deleted or a finished indicator; never by type', () => {
  assert.equal(blockerResolved(undefined), true);
  assert.equal(blockerResolved(node('x')), false);
  assert.equal(blockerResolved(node('x', { completedAt: '2026-09-30' })), true);
  assert.equal(blockerResolved(node('x', { archivedAt: '2026-09-30' })), true);
  assert.equal(blockerResolved(node('x', { indicators: [{ id: 'review-state', label: 'Merged', icon: 'git-merge', tone: 'violet', stage: 'done' }] })), true);
  assert.equal(blockerResolved(node('x', { indicators: [{ id: 'review-state', label: 'Open', icon: 'git-pull-request', tone: 'green', stage: 'ready' }] })), false);
  // An agent or terminal has no finished indicator: working or idle it keeps blocking until marked done.
  assert.equal(blockerResolved(node('x', { belowAt: '2026-09-30' })), false);
});

test('blocked-by follows aliases of the blocked item, lists only unresolved blockers, and reports link resolution', () => {
  const all = [...nodes, node('b2', { resourceId: 'r-b' }), node('d', { completedAt: '2026-09-30' })];
  const links = [blocks('ab', 'a', 'b'), blocks('db', 'd', 'b'), blocks('cb', 'c', 'b2'), { id: 'ref', sourceId: 'agent', targetId: 'b', kind: 'reference' as const, label: '' }];
  assert.deepEqual(blockedBy('b', all, links).map(n => n.id), ['a', 'c']);
  assert.deepEqual(blockedBy('b2', all, links).map(n => n.id), ['a', 'c']);
  assert.deepEqual(blockedBy('a', all, links), []);
  const state = blockingState(all, links);
  assert.deepEqual([...state.blocked.get('b')!].map(n => n.id), ['a', 'c']);
  assert.equal(state.blocked.has('d'), false);
  assert.deepEqual(Object.fromEntries(state.resolved), { ab: false, db: true, cb: false });
  // A missing blocker (deleted) no longer blocks.
  assert.deepEqual(blockedBy('b', all.filter(n => n.id !== 'a' && n.id !== 'c'), links), []);
});

test('unblocked items are those whose blockers all resolved, not those whose blocking link was removed', () => {
  const links = [blocks('ab', 'a', 'b'), blocks('ac', 'a', 'c')];
  const before = blockingState(nodes, links);
  const resolved = nodes.map(n => n.id === 'a' ? { ...n, completedAt: '2026-09-30' } : n);
  assert.deepEqual(unblockedSince(before, resolved, links).map(n => n.id), ['b', 'c']);
  assert.deepEqual(unblockedSince(before, nodes, links.filter(link => link.id !== 'ab')), []);
  assert.deepEqual(unblockedSince(before, resolved.filter(n => n.id !== 'c'), links).map(n => n.id), ['b']);
});
