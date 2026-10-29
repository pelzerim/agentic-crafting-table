import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_ICON_LIMIT, columnBaseline, columnItems, fitOrder, metaText, ORDER_LIMIT, plotMapOrder, projectColumn, projectTag, projectTags, projectsNewSince, reorder } from './project-column.ts';
import type { ColumnKind, ProjectColumnSource } from './project-column.ts';
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
  project('deploy'), item('gate', 'deploy', { title: 'Rollout: Browser Runners', attentionSources: { 'provider:github.rollout': 'input' }, attentionNotes: { 'provider:github.rollout': 'Browser Runners needs approval' }, attentionVersion: 3, attentionSeenVersion: 3, attentionAt: ago(50), activityAt: ago(50) }),
  item('note', 'deploy', { title: 'Finished thing', attentionSources: { 'provider:github.rollout': 'finished' }, attentionVersion: 1, attentionSeenVersion: 1, activityAt: ago(49) }),
  project('empty'),
];
const todos: TodoEntry[] = [{ id: 't1', title: 'Write the runbook', completed: false, projectId: 'infra', nodeIds: [] } as unknown as TodoEntry, { id: 't2', title: 'Check limits', completed: false, projectId: 'infra', nodeIds: [] } as unknown as TodoEntry];
const sources = (ids = ['docs', 'infra', 'billing', 'runner', 'night', 'recent', 'empty', 'deploy']): ProjectColumnSource[] => ids.map(id => ({ id, title: nodes.find(node => node.id === id)!.title, color: `--${id}`, board: projectDashboard(id, nodes, { todos }) }));

test('projects asking me come first, then my turn, then working, then by last activity; quiet projects fold', () => {
  const model = projectColumn(sources(), NOW);
  assert.deepEqual(model.active.map(row => row.id), ['billing', 'runner', 'infra', 'recent', 'deploy']);
  assert.deepEqual(model.quiet.map(row => row.id), ['docs', 'empty'], 'no Needs me, nothing working and no activity for 24 h');
  assert.deepEqual(model.icons.map(row => row.id), ['billing', 'runner', 'infra', 'recent', 'deploy', 'docs', 'empty']);
  assert.equal(model.more, 0);
});

test('a muted project is not in the column at all', () => {
  const model = projectColumn(sources(), NOW);
  assert.ok(![...model.active, ...model.quiet, ...model.icons].some(row => row.id === 'night'));
  assert.deepEqual(projectColumn(sources(['night']), NOW), { icons: [], more: 0, active: [], quiet: [] });
});

test('an icon carries a badge only for a tier that waits on the person: Asking me or My turn with its count', () => {
  const byId = new Map(projectColumn(sources(), NOW).icons.map(row => [row.id, row]));
  assert.deepEqual([byId.get('billing')!.mark, byId.get('billing')!.count], ['asking', 1]);
  assert.deepEqual([byId.get('runner')!.mark, byId.get('runner')!.count], ['turn', 1]);
  assert.deepEqual([byId.get('infra')!.mark, byId.get('infra')!.count], ['idle', 0], 'working agents do not need the person');
  assert.deepEqual([byId.get('deploy')!.mark, byId.get('deploy')!.count], ['idle', 0], 'a seen gate and a finished item do not badge');
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

test('Next and Status exist only when the summary model wrote them; the rows are never restated locally', () => {
  const plain = projectColumn(sources(), NOW);
  assert.equal(plain.active[0].next, undefined); assert.equal(plain.active[0].status, undefined);
  assert.equal(plain.active.find(row => row.id === 'infra')!.next, undefined);
  assert.equal(plain.quiet.find(row => row.id === 'empty')!.status, undefined);
  const written = projectColumn(sources().map(source => source.id === 'billing' ? { ...source, summary: { next: 'Answer the Webhook agent on retries.', status: 'Refund PR waits on your review.' } } : source), NOW);
  assert.equal(written.active[0].next, 'Answer the Webhook agent on retries.');
  assert.equal(written.active[0].status, 'Refund PR waits on your review.');
  const statusOnly = projectColumn(sources().map(source => source.id === 'billing' ? { ...source, summary: { status: 'Refund PR waits on your review.', next: '  ' } } : source), NOW);
  assert.equal(statusOnly.active[0].next, undefined, 'an ungrounded Next was dropped by the service; a blank one is none');
  assert.equal(statusOnly.active[0].status, 'Refund PR waits on your review.');
});

test('a tag is the initials of a name of two or more words, else its first three letters, upper case', () => {
  assert.equal(projectTag('Billing redesign'), 'BR');
  assert.equal(projectTag('Edge runtime platform team'), 'ERP');
  assert.equal(projectTag('Infra'), 'INF');
  assert.equal(projectTag('  docs  '), 'DOC');
  assert.equal(projectTag('PR #812 refunds'), 'P8R');
  assert.equal(projectTag(''), '?');
});

test('tags that clash within the column get a trailing digit, the same one whatever the order', () => {
  const tags = projectTags([{ id: 'b', title: 'Billing' }, { id: 'a', title: 'Bill' }, { id: 'c', title: 'Infra' }, { id: 'd', title: 'Billboard' }]);
  assert.deepEqual(Object.fromEntries(tags), { a: 'BIL1', b: 'BIL2', d: 'BIL3', c: 'INF' });
  assert.deepEqual(projectTags([{ id: 'd', title: 'Billboard' }, { id: 'b', title: 'Billing' }, { id: 'a', title: 'Bill' }]), new Map([['d', 'BIL3'], ['b', 'BIL2'], ['a', 'BIL1']]));
  const model = projectColumn(sources(), NOW);
  assert.deepEqual(model.icons.map(row => row.tag), ['BIL', 'RUN', 'INF', 'REC', 'DEP', 'DOC', 'EMP']);
});

test('a project is new when a Needs me row or activity arrived after the last unfold; unfolding clears it', () => {
  const before = projectColumn(sources(), NOW), baseline = columnBaseline(before);
  assert.deepEqual([...projectsNewSince(before, baseline)], []);
  const asked = nodes.map(node => node.id === 'r2' ? { ...node, attention: 'input', attentionVersion: 1, attentionAt: ago(0) } : node);
  const later = projectColumn(sources().map(source => source.id === 'runner' ? { ...source, board: projectDashboard('runner', asked, { todos }) } : source), NOW);
  assert.deepEqual([...projectsNewSince(later, baseline)], ['runner'], 'a new Needs me row');
  const again = asked.map(node => node.id === 'r2' ? { ...node, attentionVersion: 2 } : node);
  const raised = projectColumn(sources().map(source => source.id === 'runner' ? { ...source, board: projectDashboard('runner', again, { todos }) } : source), NOW);
  assert.deepEqual([...projectsNewSince(raised, columnBaseline(later))], ['runner'], 'the same item raised again (a newer attention version)');
  const moved = nodes.map(node => node.id === 'd1' ? { ...node, activityAt: ago(1) } : node);
  const active = projectColumn(sources().map(source => source.id === 'docs' ? { ...source, board: projectDashboard('docs', moved, { todos }) } : source), NOW);
  assert.deepEqual([...projectsNewSince(active, baseline)], ['docs'], 'lastActivityAt moved');
  assert.deepEqual([...projectsNewSince(active, columnBaseline(active))], [], 'unfolding takes a new baseline');
  const seen = projectColumn(sources().map(source => source.id === 'billing' ? { ...source, board: projectDashboard('billing', nodes.filter(node => node.id !== 'b2'), { todos }) } : source), NOW);
  assert.deepEqual([...projectsNewSince(seen, baseline)], [], 'a row that leaves is not new');
});

const plotted: Node[] = [
  project('shop'), item('s1', 'shop', { title: 'Webhook agent', attention: 'input', attentionAt: ago(4), activityAt: ago(4), position: { x: 900, y: 0 } }),
  item('s2', 'shop', { title: 'PR 812 refunds', attention: 'review', attentionAt: ago(40), activityAt: ago(40), position: { x: 0, y: 0 } }),
  item('s3', 'shop', { title: 'Refund agent', activity: 'working', summary: 'adding the proration test', activityAt: ago(1), position: { x: 40, y: 0 } }),
  item('s4', 'shop', { title: 'PR 798 invoices', activity: 'working', summary: 'rebasing', activityAt: ago(2), position: { x: 0, y: 800 } }),
  item('s5', 'shop', { title: 'Old ticket', position: { x: 0, y: 900 } }),
  item('s6', 'shop', { title: 'Webhook retry', position: { x: 960, y: 0 } }),
];
const shopPlots = [
  { id: 'webhooks', projectId: 'shop', memberIds: ['s1', 's6'], name: 'Webhooks', source: 'user', hidden: false, color: 'rose' },
  { id: 'refunds', projectId: 'shop', memberIds: ['s2', 's3'], name: 'Refunds', source: 'user', hidden: false, color: 'mint' },
] as never[];

test('plots in map order: the top band first, then left', () => {
  assert.deepEqual(plotMapOrder(shopPlots, plotted), ['refunds', 'webhooks']);
});

test('with Needs me rows in two or more plots the rows group by plot in map order, each with its own counts; working agents are never rows', () => {
  const board = projectDashboard('shop', plotted, { plots: shopPlots });
  const [row] = projectColumn([{ id: 'shop', title: 'Shop', color: '', board, plotOrder: plotMapOrder(shopPlots, plotted) }], NOW).active;
  assert.deepEqual(row.groups.map(group => [group.id, group.plot, group.name, group.tiers.asking, group.tiers.turn, group.working, group.entries.map(entry => entry.id)]), [
    ['refunds', true, 'Refunds', 0, 1, 1, ['s2']],
    ['webhooks', true, 'Webhooks', 1, 0, 0, ['s1']],
  ], 'Loose has only a working agent, so it has no group');
  assert.equal(row.groups[0].color, 'mint');
  assert.deepEqual(row.plots, ['Refunds', 'Webhooks']);
  assert.deepEqual(row.meta, { todos: { open: 0 }, working: 2 });
  const counted = shopPlots.map(plot => ({ ...(plot as object), name: `${(plot as { name: string }).name} · 2 items` })) as never[];
  const [local] = projectColumn([{ id: 'shop', title: 'Shop', color: '', board: projectDashboard('shop', plotted, { plots: counted }) }], NOW).active;
  assert.deepEqual(local.groups.filter(group => group.plot).map(group => group.name).sort(), ['Refunds', 'Webhooks'], 'a local name drops its own item count; the header shows one');
  assert.deepEqual(local.plots.sort(), ['Refunds', 'Webhooks']);
});

test('a saved order wins over the automatic one; projects and plots it lacks go on top in automatic order, unknown ids are ignored', () => {
  const model = projectColumn(sources(), NOW, { order: ['gone', 'deploy', 'runner', 'billing', 'empty', 'docs'] });
  assert.deepEqual(model.active.map(row => row.id), ['infra', 'recent', 'deploy', 'runner', 'billing'], 'infra and recent are not saved, so they lead');
  assert.deepEqual(model.quiet.map(row => row.id), ['empty', 'docs'], 'quiet projects keep the saved order inside their fold');
  assert.deepEqual(model.icons.map(row => row.id), ['infra', 'recent', 'deploy', 'runner', 'billing', 'empty', 'docs']);
  const extra = { id: 'labels', projectId: 'shop', memberIds: ['s5'], name: 'Labels', source: 'user', hidden: false } as never;
  const board = projectDashboard('shop', plotted, { plots: [...shopPlots, extra] });
  const [row] = projectColumn([{ id: 'shop', title: 'Shop', color: '', board, plotOrder: ['refunds', 'webhooks', 'labels'] }], NOW, { plotOrder: ['other-plot', 'webhooks', 'refunds'] }).active;
  assert.deepEqual(row.plotIds, ['labels', 'webhooks', 'refunds']);
  assert.deepEqual(row.groups.map(group => group.id), ['webhooks', 'refunds']);
  // A move while one is muted keeps its saved place: [a, b, c], b muted, c before a, b unmuted reads c, a, b.
  const moved = reorder(['a', 'b', 'c'], ['a', 'c'], 'c', 'a', '');
  assert.deepEqual(moved, ['c', 'a', 'b']);
  assert.deepEqual(reorder(moved, ['new', 'c', 'a', 'b'], 'new', null, 'b'), ['c', 'a', 'b', 'new'], 'an unsaved one is placed among the saved');
  assert.deepEqual(reorder(['webhooks', 'other-plot', 'refunds'], ['webhooks', 'refunds'], 'webhooks', null, 'refunds'), ['other-plot', 'refunds', 'webhooks'], 'another project\'s plot stays');
  // Gone ids drop before the cap; an order still too long is refused, never cut (a cut id would jump back to the top).
  const ids = Array.from({ length: ORDER_LIMIT + 1 }, (_, index) => `p${index}`), live = new Set(ids);
  assert.deepEqual(fitOrder(['gone', ...ids.slice(1)], live), ids.slice(1));
  assert.equal(fitOrder(ids, live), undefined);
});

test('with Needs me rows in fewer than two plots there is one group without a header', () => {
  const board = projectDashboard('shop', plotted, { plots: shopPlots.slice(0, 1) });
  const [row] = projectColumn([{ id: 'shop', title: 'Shop', color: '', board }], NOW).active;
  assert.equal(row.groups.length, 1); assert.equal(row.groups[0].plot, false); assert.equal(row.groups[0].id, '');
  assert.deepEqual(row.groups[0].entries.map(entry => entry.id), ['s1', 's2']);
  const oneSide = projectDashboard('shop', plotted.map(node => node.id === 's1' ? { ...node, attention: undefined } : node), { plots: shopPlots });
  const [single] = projectColumn([{ id: 'shop', title: 'Shop', color: '', board: oneSide }], NOW).active;
  assert.deepEqual(single.groups.map(group => [group.id, group.entries.map(entry => entry.id)]), [['', ['s2']]], 'two plots, but rows in only one: no headers');
});

test('with Needs me unticked the panel lists every drawn item by plot, Needs me first; type chips filter both modes', () => {
  const nodes = [...plotted, item('s7', 'shop', { title: 'Hidden note', hiddenAt: ago(5) }), item('s8', 'shop', { title: 'A ticket', archivedAt: ago(5) })];
  const kinds: Record<string, ColumnKind> = { s1: 'agents', s2: 'prs', s3: 'agents', s4: 'prs', s5: 'tickets', s6: 'other' };
  const kindOf = (id: string) => kinds[id] ?? 'other', board = projectDashboard('shop', nodes, { plots: shopPlots });
  const source = { id: 'shop', title: 'Shop', color: '', board, plotOrder: plotMapOrder(shopPlots, nodes), items: columnItems('shop', nodes, board, shopPlots, node => kindOf(node.id)) };
  const rows = (filters: { needsMe?: boolean; off?: ColumnKind[] }) => projectColumn([source], NOW, { filters, kindOf }).active[0];
  assert.equal(rows({}).items, undefined, 'Needs me ticked keeps the Needs me rows');
  assert.deepEqual(rows({ off: ['prs'] }).groups.map(group => [group.id, group.entries.map(entry => entry.id)]), [['refunds', []], ['webhooks', ['s1']]], 'a type chip off hides its Needs me rows');
  assert.deepEqual(rows({ off: ['prs'] }).needs.map(need => need.id), ['s1', 's2'], 'icons and what is new still count every row');
  assert.deepEqual(rows({ needsMe: false }).items!.map(group => [group.id, group.plot, group.name, group.entries.map(entry => [entry.id, entry.state ?? ''])]), [
    ['refunds', true, 'Refunds', [['s2', 'turn'], ['s3', 'working']]],
    ['webhooks', true, 'Webhooks', [['s1', 'asking'], ['s6', '']]],
    ['loose', false, 'Loose', [['s5', ''], ['s4', 'working']]],
  ], 'hidden and archived items leave; Needs me first, then by title');
  assert.deepEqual(rows({ needsMe: false, off: ['agents', 'other'] }).items!.map(group => [group.id, group.entries.map(entry => entry.id)]), [['refunds', ['s2']], ['loose', ['s5', 's4']]], 'a plot left empty by the chips leaves');
});

test('the meta line counts what a person still acts on: open to-dos (the first opens the list) and working agents; zeros and done to-dos leave', () => {
  const shopTodos = [{ id: 'st1', title: 'Proration', completed: false, projectId: 'shop', nodeIds: [] }, { id: 'st2', title: 'Dunning', completed: true, projectId: 'shop', nodeIds: [] }] as unknown as TodoEntry[];
  const [row] = projectColumn([{ id: 'shop', title: 'Shop', color: '', board: projectDashboard('shop', plotted, { todos: shopTodos }) }], NOW).active;
  assert.deepEqual(row.meta, { todos: { open: 1, first: 'st1' }, working: 2 });
  assert.equal(metaText(row.meta), '1 to-do · 2 working');
  const infra = projectColumn(sources(), NOW).active.find(row => row.id === 'infra')!;
  assert.equal(metaText(infra.meta), '2 to-dos · 1 working');
  assert.equal(metaText(projectColumn(sources(), NOW).quiet.find(row => row.id === 'empty')!.meta), '');
  assert.equal(metaText(projectColumn(sources(['runner']).map(source => ({ ...source, board: { ...source.board, working: [] } })), NOW).active[0].meta), '');
});

test('an item still waiting on the person after its alert was seen is a thing to do: listed as seen, not counted', () => {
  const deploy = projectColumn(sources(), NOW).active.find(row => row.id === 'deploy')!;
  assert.deepEqual(deploy.needs.map(need => [need.title, need.tier, need.reason, need.seen]), [['Rollout: Browser Runners', 'asking', 'Browser Runners needs approval', true]]);
  assert.deepEqual(deploy.tiers, { asking: 0, turn: 0, finished: 0 }, 'seen alerts do not count');
  assert.deepEqual(deploy.groups.map(group => group.entries.map(entry => entry.id)), [['gate']], 'the finished item is not a row; its alert was seen');
  const billing = projectColumn(sources(), NOW).active[0];
  assert.ok(billing.needs.every(need => !need.seen), 'unseen rows stay as they are');
});
