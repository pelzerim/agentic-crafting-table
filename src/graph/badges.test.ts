import test from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_CHARACTERS, PINNED_BADGE_CHARACTERS, badgeWords, mapBadges } from './badges.ts';
import type { GraphLink, GraphNode } from './graph.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';

test('a note is a badge when it is one or two plain words of at most 12 characters; display pins it either way', () => {
  assert.equal(BADGE_CHARACTERS, 12); assert.equal(PINNED_BADGE_CHARACTERS, 24);
  for (const text of ['S2', ' v1.4 ', 'Q4 goal', 'infra', 'needs design']) assert.equal(badgeWords(text), text.trim(), text);
  for (const text of ['', '   ', 'ask Alex first', 'customer escalation', 'S2\nnext', '- S2', '# S2', '[ ] S2', '`S2`', '**S2**', '1. S2']) assert.equal(badgeWords(text), undefined, JSON.stringify(text));
  assert.equal(badgeWords('S2', 'note'), undefined, 'kept as paper');
  assert.equal(badgeWords('customer escalation', 'badge'), 'customer escalation', 'pinned: longer and more words');
  assert.equal(badgeWords('waiting on the infra team', 'badge'), undefined, 'pinned still caps at 24 characters');
  assert.equal(badgeWords('S2\nnext', 'badge'), undefined, 'pinned still one line');
});

test('a badge is drawn in its note\'s paper, mint while the note has none', () => {
  const pairs = [item('pr'), note('a', 'S2'), note('b', 'infra')];
  pairs[2]![1]!.data.paper = 'slate';
  const nodes = pairs.map(([node]) => node), resources = pairs.map(([, resource]) => resource);
  assert.deepEqual(mapBadges(nodes, resources, [link('l1', 'a', 'pr'), link('l2', 'b', 'pr')]).onItems.get('pr')!.map(badge => [badge.text, badge.paper]), [['infra', 'slate'], ['S2', 'mint']]);
});

const note = (id: string, text: string, extra: Partial<GraphNode> = {}, display?: string): [GraphNode, ResourceRecord] => [
  { id, resourceId: `${id}-r`, title: text, position: { x: 0, y: 0 }, ...extra },
  { id: `${id}-r`, pluginId: 'workspace.note', schemaVersion: 2, title: text, data: { text, ...(display ? { display } : {}) } },
];
const item = (id: string, extra: Partial<GraphNode> = {}): [GraphNode, ResourceRecord] => [
  { id, resourceId: `${id}-r`, title: id, position: { x: 0, y: 0 }, ...extra },
  { id: `${id}-r`, pluginId: 'github.pull-request', schemaVersion: 1, title: id, data: { owner: 'a', repo: 'b', number: 1 } },
];
const link = (id: string, sourceId: string, targetId: string): GraphLink => ({ id, sourceId, targetId, kind: 'reference', label: '' });

test('a connected short note sits on every item it is connected to, and leaves the map with its links', () => {
  const pairs = [item('pr'), item('ticket'), item('other'), note('s2', 'S2'), note('long', 'ask Alex first'), note('loose', 'v1.4'), note('two', 'infra', { archivedAt: '2026-01-01T00:00:00Z' }),
    [{ id: 'project', title: 'Project', position: { x: 0, y: 0 } }, undefined] as const];
  const nodes = pairs.map(([node]) => node), resources = pairs.flatMap(([, resource]) => resource ? [resource] : []);
  const links = [link('l1', 's2', 'pr'), link('l2', 'ticket', 's2'), link('l3', 'long', 'pr'), link('l4', 'pr', 'other'), link('l5', 'two', 'other'), link('l6', 's2', 'project')];
  const result = mapBadges(nodes, resources, links);
  assert.deepEqual([...result.onItems].map(([id, badges]) => [id, badges.map(badge => [badge.noteId, badge.text, badge.paper])]),
    [['pr', [['s2', 'S2', 'mint']]], ['ticket', [['s2', 'S2', 'mint']]]]);
  assert.deepEqual(result.nodes.map(node => node.id), ['pr', 'ticket', 'other', 'long', 'loose', 'two', 'project'], 'only the attached badge note leaves the map; a loose one stays paper');
  assert.deepEqual(result.links.map(link => link.id), ['l3', 'l4', 'l5']);
  assert.deepEqual(result.attached, new Set(['s2']));
});

test('an item lists its badges in a stable order, and a note being edited stays paper', () => {
  const pairs = [item('pr'), note('b', 'S2'), note('a', 'infra')];
  const nodes = pairs.map(([node]) => node), resources = pairs.map(([, resource]) => resource);
  const links = [link('l1', 'b', 'pr'), link('l2', 'a', 'pr')];
  assert.deepEqual(mapBadges(nodes, resources, links).onItems.get('pr')!.map(badge => badge.text), ['infra', 'S2']);
  const editing = mapBadges(nodes, resources, links, new Set(['a']));
  assert.deepEqual(editing.onItems.get('pr')!.map(badge => badge.text), ['S2']);
  assert.ok(editing.nodes.some(node => node.id === 'a'));
});
