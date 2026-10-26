import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_ICON_LIMIT, projectColumn, projectCountsLine } from './project-column.ts';
import type { ProjectColumnSource } from './project-column.ts';
import { projectDashboard } from './project-dashboard.ts';
import type { GraphNode } from './graph.ts';
import type { TodoEntry } from './todos.ts';

type Node = GraphNode & { activity?: string; attention?: string; summary?: string };
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const project = (id: string, extra: Partial<Node> = {}): Node => ({ id, title: id[0].toUpperCase() + id.slice(1), position: { x: 0, y: 0 }, ...extra });
const item = (id: string, projectId: string, extra: Partial<Node> = {}): Node => ({ id, title: `Item ${id}`, resourceId: `r-${id}`, projectId, position: { x: 0, y: 0 }, ...extra });
const nodes: Node[] = [
  project('docs'), item('d1', 'docs', { activityAt: ago(3 * 24 * 60) }),
  project('infra'), item('i1', 'infra', { activity: 'working', summary: 'Terraform plan for the API LB', activityAt: ago(8) }),
  project('billing'), item('b1', 'billing', { title: 'Webhook agent', attention: 'input', activityAt: ago(4), attentionAt: ago(4) }), item('b2', 'billing', { title: 'PR #812 refunds', attention: 'review', activityAt: ago(40) }),
  item('b3', 'billing', { activity: 'working', activityAt: ago(3) }),
  project('runner'), item('r1', 'runner', { title: 'PR #904 capacity', attention: 'review', activityAt: ago(120) }), item('r2', 'runner', { activity: 'working', activityAt: ago(1) }),
  project('night', { mutedAt: ago(60) }), item('n1', 'night', { attention: 'input', activityAt: ago(2) }),
  project('recent'), item('c1', 'recent', { activityAt: ago(30) }),
  project('empty'),
];
const todos: TodoEntry[] = [{ id: 't1', title: 'Write the runbook', completed: false, projectId: 'infra', nodeIds: [] } as unknown as TodoEntry, { id: 't2', title: 'Check limits', completed: false, projectId: 'infra', nodeIds: [] } as unknown as TodoEntry];
const sources = (ids = ['docs', 'infra', 'billing', 'runner', 'night', 'recent', 'empty']): ProjectColumnSource[] => ids.map(id => ({ id, title: nodes.find(node => node.id === id)!.title, color: `--${id}`, board: projectDashboard(id, nodes, { todos }) }));

test('projects asking me come first, then my turn, then working, then by last activity; quiet projects fold', () => {
  const model = projectColumn(sources(), NOW);
  assert.deepEqual(model.active.map(row => row.id), ['billing', 'runner', 'infra', 'recent']);
  assert.deepEqual(model.quiet.map(row => row.id), ['docs', 'empty'], 'no Needs me, nothing working and no activity for 24 h');
  assert.deepEqual(model.icons.map(row => row.id), ['billing', 'runner', 'infra', 'recent', 'docs', 'empty']);
  assert.equal(model.more, 0);
});

test('a muted project is not in the column at all', () => {
  const model = projectColumn(sources(), NOW);
  assert.ok(![...model.active, ...model.quiet, ...model.icons].some(row => row.id === 'night'));
  assert.deepEqual(projectColumn(sources(['night']), NOW), { icons: [], more: 0, active: [], quiet: [] });
});

test('each icon carries the most urgent tier and its count', () => {
  const byId = new Map(projectColumn(sources(), NOW).icons.map(row => [row.id, row]));
  assert.deepEqual([byId.get('billing')!.mark, byId.get('billing')!.count], ['asking', 1]);
  assert.deepEqual([byId.get('runner')!.mark, byId.get('runner')!.count], ['turn', 1]);
  assert.deepEqual([byId.get('infra')!.mark, byId.get('infra')!.count], ['working', 1]);
  assert.deepEqual([byId.get('recent')!.mark, byId.get('recent')!.count], ['idle', 0]);
  assert.deepEqual(byId.get('billing')!.tiers, { asking: 1, turn: 1, finished: 0 });
  assert.equal(byId.get('billing')!.working, 1);
});

test('at most ten icons, the rest as one count', () => {
  const many = Array.from({ length: 13 }, (_, index) => project(`p${String(index).padStart(2, '0')}`));
  const boards: ProjectColumnSource[] = many.map(node => ({ id: node.id, title: node.title, color: '', board: projectDashboard(node.id, many) }));
  const model = projectColumn(boards, NOW);
  assert.equal(model.icons.length, COLUMN_ICON_LIMIT); assert.equal(model.more, 3);
});

test('a row lists its Needs me rows with tier, reason and age', () => {
  const billing = projectColumn(sources(), NOW).active[0];
  assert.deepEqual(billing.needs.map(need => [need.title, need.tier, need.reason, need.age]), [['Webhook agent', 'asking', 'Waiting for your input', '4m'], ['PR #812 refunds', 'turn', 'Ready for your review', '']]);
  assert.equal(billing.age, '3m');
});

test('without a summary the line is built from counts; with one it is the summary', () => {
  const plain = projectColumn(sources(), NOW);
  assert.equal(plain.active[0].line, '1 asking · 1 my turn · 1 working · active 3 min ago'); assert.equal(plain.active[0].generated, false);
  assert.equal(plain.active.find(row => row.id === 'infra')!.line, '1 working · 2 to-dos · active 8 min ago');
  assert.equal(plain.quiet.find(row => row.id === 'docs')!.line, 'active 3 d ago');
  assert.equal(plain.quiet.find(row => row.id === 'empty')!.line, 'Nothing open');
  const written = projectColumn(sources().map(source => source.id === 'billing' ? { ...source, summary: 'Refund PR waits on your review.' } : source), NOW);
  assert.equal(written.active[0].line, 'Refund PR waits on your review.'); assert.equal(written.active[0].generated, true);
});

test('the counts line names hours and days', () => {
  const board = projectDashboard('runner', nodes, {});
  assert.equal(projectCountsLine({ ...board, lastActivityAt: ago(180) }, NOW), '1 my turn · 1 working · active 3 h ago');
  assert.equal(projectCountsLine({ ...board, lastActivityAt: ago(0) }, NOW), '1 my turn · 1 working · active just now');
});
