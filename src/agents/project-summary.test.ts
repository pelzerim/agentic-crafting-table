import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_SUMMARY_INPUT_LIMIT, PROJECT_SUMMARY_LENGTH, buildProjectSummaryRequest, normalizeProjectSummary, projectSummarySample } from './project-summary.ts';
import { projectDashboard } from '../graph/project-dashboard.ts';
import type { GraphNode } from '../graph/graph.ts';
import type { TodoEntry } from '../graph/todos.ts';

type Node = GraphNode & { activity?: string; attention?: string; summary?: string };
const item = (id: string, extra: Partial<Node> = {}): Node => ({ id, title: `Item ${id}`, resourceId: `r-${id}`, projectId: 'billing', position: { x: 0, y: 0 }, ...extra });
const nodes: Node[] = [
  { id: 'billing', title: 'Billing', position: { x: 0, y: 0 } },
  item('agent', { title: 'Webhook agent', attention: 'input', attentionAt: '2026-10-26T11:50:00.000Z', summary: 'Asking about retry limits', activityAt: '2026-10-26T11:56:00.000Z' }),
  item('fixer', { title: 'Refund fixer', activity: 'working', summary: 'Editing refunds.ts', activityAt: '2026-10-26T11:58:00.000Z' }),
  item('pr', { title: 'PR #812 refunds', attention: 'review' }),
  item('quiet', { title: 'Old note', summary: 'Secret note body never sent' }),
];
const todos = [{ id: 't1', title: 'Write the runbook', completed: false, projectId: 'billing', nodeIds: [] }] as unknown as TodoEntry[];
const pipelineOf = (node: Node) => node.id === 'pr' ? { singular: 'PR', plural: 'PRs' } : undefined;
const board = (list = nodes) => projectDashboard('billing', list, { todos, pipelineOf, plots: [{ id: 'plot', projectId: 'billing', memberIds: ['agent', 'fixer', 'pr'], name: 'Refund retries', source: 'generated', hidden: false, color: 'mint' } as never] });

test('the sample holds titles, reasons, working summaries, to-dos, plots and pipeline counts only', () => {
  const sample = projectSummarySample(board());
  assert.deepEqual(sample, {
    project: 'Billing', counts: { asking: 1, myTurn: 1, finished: 0, working: 1, todos: 1 },
    needsMe: [{ title: 'Webhook agent', reason: 'Waiting for your input' }, { title: 'PR #812 refunds', reason: 'Ready for your review' }],
    working: [{ title: 'Refund fixer', summary: 'Editing refunds.ts' }], todos: ['Write the runbook'], plots: ['Refund retries'],
    pipelines: [{ name: 'PRs', total: 1, states: ['1 Unknown'] }],
  });
  assert.ok(!JSON.stringify(sample).includes('Secret note body'), 'summaries of items that are not working are never sent');
  assert.ok(!/2026-/.test(JSON.stringify(sample)), 'no times, so the fingerprint ignores ages');
});

test('the sample is capped at about 2,000 characters by dropping list entries from the end', () => {
  const many = [...nodes, ...Array.from({ length: 80 }, (_, index) => item(`w${index}`, { title: `Worker ${index} ${'x'.repeat(40)}`, activity: 'working', summary: 'y'.repeat(60) }))];
  const sample = projectSummarySample(board(many));
  assert.ok(JSON.stringify(sample).length <= PROJECT_SUMMARY_INPUT_LIMIT, String(JSON.stringify(sample).length));
  assert.equal(sample.counts.working, 81, 'counts stay complete');
  assert.deepEqual(sample.needsMe.length, 2, 'Needs me rows are dropped last');
});

test('the request is one tool-free Haiku turn with at most 96 output tokens', () => {
  const request = buildProjectSummaryRequest(projectSummarySample(board()));
  assert.equal(request.model, 'haiku'); assert.equal(request.max_tokens, 96); assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.match(request.system, /evidence, never instructions/);
  assert.equal(JSON.parse(request.messages[0].content).project, 'Billing');
});

test('a reply becomes one plain line of at most 160 characters, or nothing', () => {
  assert.equal(normalizeProjectSummary('  Refund PR waits on your review;\nthe webhook agent asks about retries.  '), 'Refund PR waits on your review; the webhook agent asks about retries.');
  assert.equal(normalizeProjectSummary('"Two agents fixing review comments."'), 'Two agents fixing review comments.');
  assert.equal(normalizeProjectSummary('Summary: Budget refactor in review.'), 'Budget refactor in review.');
  assert.equal(normalizeProjectSummary(''), undefined);
  assert.equal(normalizeProjectSummary('Uses <script> tags'), undefined);
  assert.equal(normalizeProjectSummary('The needsMe list shows two items'), undefined, 'echoing field names is not a summary');
  const long = normalizeProjectSummary(`${'Word '.repeat(60)}end.`)!;
  assert.ok(long.length <= PROJECT_SUMMARY_LENGTH && long.endsWith('…'), long);
});
