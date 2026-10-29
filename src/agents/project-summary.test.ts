import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_SUMMARY_INPUT_LIMIT, PROJECT_SUMMARY_LENGTH, buildProjectSummaryRequest, normalizeProjectSummary, parseProjectSummary, projectSummarySample, projectSummaryText, readProjectSummary } from './project-summary.ts';
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

test('a Needs me row carries what its agent said only when it has a recap, clipped', () => {
  const recap = { text: `I removed the flag. ${'More detail. '.repeat(40)}`, at: '2026-10-26T11:59:00.000Z' };
  const said = projectSummarySample(board(nodes.map(node => node.id === 'agent' ? { ...node, lastLine: 'Done.', recap } as Node : node))).needsMe;
  assert.equal(said[0].title, 'Webhook agent'); assert.ok(said[0].said!.startsWith('I removed the flag.')); assert.ok(said[0].said!.length <= 240, String(said[0].said!.length));
  assert.equal('said' in said[1], false);
  assert.equal('said' in projectSummarySample(board(nodes.map(node => node.id === 'agent' ? { ...node, lastLine: 'Done.' } as Node : node))).needsMe[0], false, 'a last line alone is not sent');
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

test('with two or more plots each Needs me and working row names its plot', () => {
  const plots = [
    { id: 'p1', projectId: 'billing', memberIds: ['agent'], name: 'Webhooks', source: 'user', hidden: false, color: 'rose' },
    { id: 'p2', projectId: 'billing', memberIds: ['fixer', 'pr'], name: 'Refunds', source: 'user', hidden: false, color: 'mint' },
  ] as never[];
  const sample = projectSummarySample(projectDashboard('billing', nodes, { todos, pipelineOf, plots }));
  assert.deepEqual(sample.needsMe, [{ title: 'Webhook agent', reason: 'Waiting for your input', plot: 'Webhooks' }, { title: 'PR #812 refunds', reason: 'Ready for your review', plot: 'Refunds' }]);
  assert.deepEqual(sample.working, [{ title: 'Refund fixer', summary: 'Editing refunds.ts', plot: 'Refunds' }]);
  assert.deepEqual(projectSummarySample(board()).needsMe.map(row => 'plot' in row), [false, false], 'one plot: no plot names on rows');
});

test('the request asks for a labelled Next and Status line of at most 60 words', () => {
  const request = buildProjectSummaryRequest(projectSummarySample(board()));
  assert.match(request.system, /Next:/); assert.match(request.system, /Status:/);
  assert.match(request.system, /60 words/);
  assert.match(request.system, /per plot/);
  assert.equal(request.max_tokens, 96);
});

test('a reply parses into Next and Status; Next must name an item of the input', () => {
  const sample = projectSummarySample(board());
  assert.deepEqual(parseProjectSummary('Next: Answer the webhook agent about retry limits.\nStatus: Refund PR waits on review; the fixer edits refunds.ts.', sample),
    { next: 'Answer the webhook agent about retry limits.', status: 'Refund PR waits on review; the fixer edits refunds.ts.' });
  assert.deepEqual(parseProjectSummary('**Next:** Review the refunds PR. **Status:** One review open.', sample), { next: 'Review the refunds PR.', status: 'One review open.' }, 'a title word of four or more letters grounds it');
  assert.deepEqual(parseProjectSummary('Next: Take a break.\nStatus: All calm.', sample), { status: 'All calm.' }, 'an ungrounded Next is dropped');
  assert.deepEqual(parseProjectSummary('Next: Check the PR.\nStatus: All calm.', sample), { status: 'All calm.' }, 'words under four letters do not ground');
  assert.deepEqual(parseProjectSummary('Refund PR waits on your review.', sample), { status: 'Refund PR waits on your review.' }, 'an unlabelled reply is a Status');
  assert.deepEqual(parseProjectSummary('Next: Review PR #812 refunds.', sample), { next: 'Review PR #812 refunds.' });
  assert.equal(parseProjectSummary('Next: <b>x</b>\nStatus: The needsMe list.', sample), undefined);
  assert.equal(parseProjectSummary('', sample), undefined);
});

test('stored text is JSON of both lines; a plain-text row from before reads as Status', () => {
  assert.equal(projectSummaryText({ next: 'Review PR #812 refunds.', status: 'One review open.' }), `{"next":"Review PR #812 refunds.","status":"One review open."}`);
  assert.deepEqual(readProjectSummary(`{"next":"Review PR #812 refunds.","status":"One review open."}`), { next: 'Review PR #812 refunds.', status: 'One review open.' });
  assert.deepEqual(readProjectSummary(`{"status":"One review open."}`), { status: 'One review open.' });
  assert.deepEqual(readProjectSummary('Refund PR waits on your review.'), { status: 'Refund PR waits on your review.' });
  assert.deepEqual(readProjectSummary(`{"next":3}`), { status: `{"next":3}` });
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
