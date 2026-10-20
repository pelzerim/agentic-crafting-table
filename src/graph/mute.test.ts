import test from 'node:test';
import assert from 'node:assert/strict';
import { isMuted, mutedProjectIds, splitAttention } from './mute.ts';
import { attentionItems } from './attention.ts';
import { projectActivity } from './project-neighborhoods.ts';
import { DEFAULT_MAP_DASHBOARDS, dashboardLayout, projectDashboard } from './project-dashboard.ts';
import { atlasGlyphs, needsMeIds } from './atlas.ts';
import { groupWorkspaceTodos } from './todos.ts';
import type { GraphNode } from './graph.ts';

type Node = GraphNode & { activity?: string; attention?: string; summary?: string };
const AT = '2026-10-05T08:00:00.000Z';
const item = (id: string, projectId: string | undefined, extra: Partial<Node> = {}): Node => ({ id, title: id, resourceId: `r-${id}`, ...(projectId ? { projectId } : {}), position: { x: 0, y: 0 }, ...extra });
const nodes: Node[] = [
  { id: 'quiet', title: 'Photos', position: { x: 0, y: 0 }, mutedAt: AT },
  { id: 'loud', title: 'Billing', position: { x: 2000, y: 0 } },
  item('q-ask', 'quiet', { attention: 'input', attentionNote: 'Agent waiting' }),
  item('q-review', 'quiet', { attention: 'review' }),
  item('q-work', 'quiet', { activity: 'working', activityAt: AT }),
  item('q-idle', 'quiet'),
  item('l-ask', 'loud', { attention: 'input' }),
  item('l-work', 'loud', { activity: 'working' }),
  item('float', undefined, { attention: 'error' }),
  // One resource shown in both projects: the unmuted alias keeps it in Needs me.
  item('shared-q', 'quiet', { resourceId: 'shared', attention: 'review' }),
  item('shared-l', 'loud', { resourceId: 'shared', attention: 'review' }),
];

test('members take their project’s mute; floating items and other projects never do', () => {
  assert.deepEqual([...mutedProjectIds(nodes)], ['quiet']);
  const by = (id: string) => nodes.find(node => node.id === id)!;
  assert.equal(isMuted(by('quiet'), nodes), true);
  assert.equal(isMuted(by('q-idle'), nodes), true);
  assert.equal(isMuted(by('l-ask'), nodes), false);
  assert.equal(isMuted(by('float'), nodes), false);
  assert.equal(isMuted({ ...by('q-idle'), mutedAt: undefined, projectId: 'loud' }, nodes), false, 'moved out, it shows again');
});

test('Needs me counts exclude a muted project and keep its rows in one separate group', () => {
  const { shown, muted } = splitAttention(nodes);
  assert.deepEqual(shown.map(entry => entry.node.id).sort(), ['float', 'l-ask', 'shared-l']);
  assert.deepEqual(muted.map(entry => entry.node.id).sort(), ['q-ask', 'q-review']);
  assert.equal(shown.length + muted.length, attentionItems(nodes).length, 'nothing is lost or acknowledged');
  assert.deepEqual(shown.find(entry => entry.identity === 'shared')!.aliases.map(alias => alias.id), ['shared-l'], 'navigation never targets the covered alias');
  assert.deepEqual(muted.find(entry => entry.node.id === 'q-ask')!.details, ['Agent waiting']);
  const unmuted = nodes.map(node => node.id === 'quiet' ? { ...node, mutedAt: undefined } : node);
  assert.equal(splitAttention(unmuted).muted.length, 0);
  assert.equal(splitAttention(unmuted).shown.length, attentionItems(nodes).length, 'unmuting shows everything as it now is');
});

test('a muted project in Undermap or Archive adds no muted rows', () => {
  const below = nodes.map(node => node.id === 'quiet' ? { ...node, belowAt: AT } : node);
  assert.equal(splitAttention(below).muted.length, 0);
  const archived = nodes.map(node => node.id === 'quiet' ? { ...node, archivedAt: AT } : node);
  assert.equal(splitAttention(archived).muted.length, 0);
});

test('the plate header of a muted project counts nothing', () => {
  assert.deepEqual(projectActivity('quiet', nodes), { working: 0, needsMe: 0, asking: 0, turn: 0, finished: 0, muted: true });
  assert.deepEqual(projectActivity('loud', nodes), { working: 1, needsMe: 2, asking: 1, turn: 1, finished: 0 });
});

test('a muted dashboard keeps name and item count and lists nothing else', () => {
  const todos = [{ id: 't', source: 'checklist' as const, title: 'Write down', completed: false, projectId: 'quiet', nodeIds: [], horizon: 'next' as const }];
  const board = projectDashboard('quiet', nodes, { todos, pipelineOf: () => ({ singular: 'PR', plural: 'PRs' }), tallyOf: () => ({ singular: 'ticket', plural: 'tickets' }),
    plots: [{ id: 'plot', projectId: 'quiet', name: 'Albums', memberIds: ['q-ask', 'q-work', 'q-idle'], source: 'generated', hidden: false } as any] });
  assert.equal(board.muted, true); assert.equal(board.title, 'Photos'); assert.equal(board.items, 5);
  assert.equal(board.needs, 0); assert.deepEqual(board.needsYou, []); assert.deepEqual(board.working, []);
  assert.deepEqual(board.todos, { open: [], done: 0 }); assert.deepEqual(board.plots, []); assert.deepEqual(board.pipelines, []); assert.deepEqual(board.tallies, []);
  assert.equal(board.blocks, undefined); assert.equal(board.lastActivityAt, undefined);
  const layout = dashboardLayout({ width: 600, height: 600 }, board);
  assert.equal(layout.mode, 'compact', 'always the small card');
  // Below the map Needs me is already paused and no cover is drawn: the board is the ordinary paused one.
  assert.equal(projectDashboard('quiet', nodes, { paused: true }).muted, undefined);
  assert.equal(projectDashboard('loud', nodes).muted, undefined);
  assert.equal(DEFAULT_MAP_DASHBOARDS.enabled, true);
});

test('the Atlas draws no item marks inside a muted project', () => {
  const placed = nodes.filter(node => node.resourceId).map((node, index) => ({ id: node.id, x: index * 200, y: 0, width: 120, height: 60, projectId: node.projectId, resourceId: node.resourceId, activity: node.activity }));
  const needs = needsMeIds(nodes);
  const glyphs = atlasGlyphs(placed, needs, { scale: 1, x: 0, y: 0 }, 2, mutedProjectIds(nodes));
  assert.deepEqual(glyphs.flatMap(glyph => glyph.ids).sort(), ['float', 'l-ask', 'l-work', 'shared-l']);
  assert.ok(atlasGlyphs(placed, needs, { scale: 1, x: 0, y: 0 }, 2).some(glyph => glyph.ids.includes('q-ask')), 'without the set nothing changes');
});

test('to-dos of a muted project stay listed, tagged muted', () => {
  const groups = groupWorkspaceTodos({ nodes: [...nodes, item('todo-q', 'quiet', { inTodoList: true }), item('todo-l', 'loud', { inTodoList: true })], resources: [], links: [], todos: [] });
  assert.deepEqual(groups.map(group => [group.title, group.muted, group.items.length]), [['Photos', true, 1], ['Billing', undefined, 1]]);
});
