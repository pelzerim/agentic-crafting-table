import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DASHBOARD_SECTIONS, DEFAULT_MAP_DASHBOARDS, dashboardArea, dashboardLayout, dashboardPreview, dashboardsShown, projectDashboard, shortAge } from './project-dashboard.ts';
import type { GraphLink, GraphNode } from './graph.ts';
import type { TodoEntry } from './todos.ts';
import type { PlotView } from './plots.ts';
import type { ResourceIndicator } from '../resource-plugins/indicators.ts';

type Node = GraphNode & { activity?: string; attention?: string; summary?: string };
const cue = (label: string, tone: ResourceIndicator['tone'], icon: ResourceIndicator['icon'], stage?: ResourceIndicator['stage']): ResourceIndicator[] => [{ id: 'state', label, tone, icon, ...(stage ? { stage } : {}) }];
const item = (id: string, extra: Partial<Node> = {}): Node => ({ id, title: `Item ${id}`, resourceId: `r-${id}`, projectId: 'p', position: { x: 0, y: 0 }, ...extra });
const nodes: Node[] = [
  { id: 'p', title: 'Photos', position: { x: 0, y: 0 } },
  item('pr-a', { title: 'Cache metrics', resourceId: 'pr-a', indicators: cue('Approved', 'green', 'check', 'ready') }),
  item('pr-b', { title: 'Refresh loop', resourceId: 'pr-b', indicators: cue('Checks failing', 'red', 'x', 'failing'), attentionSources: { provider: 'checks-failing' } }),
  item('pr-c', { title: 'Old resizer', resourceId: 'pr-c', indicators: cue('Draft', 'neutral', 'clock') }),
  item('pr-d', { title: 'Migration', resourceId: 'pr-d', indicators: cue('Open', 'green', 'git-pull-request'), attention: 'review' }),
  item('pr-e', { title: 'Album order', resourceId: 'pr-e', indicators: cue('Open', 'green', 'git-pull-request') }),
  item('pr-f', { title: 'Shutdown', resourceId: 'pr-f', indicators: cue('Merged', 'violet', 'git-merge', 'done') }),
  item('pr-alias', { title: 'Cache metrics', resourceId: 'pr-a', indicators: cue('Approved', 'green', 'check', 'ready') }),
  item('t-1', { title: 'APP-1 · Albums', resourceId: 't-1', indicators: cue('In progress', 'amber', 'clock') }),
  item('t-2', { title: 'APP-2 · Limits', resourceId: 't-2', indicators: cue('In progress', 'amber', 'clock') }),
  item('t-3', { title: 'APP-3 · Shutdown', resourceId: 't-3', indicators: cue('Done', 'green', 'check', 'done') }),
  item('t-4', { title: 'APP-4 · Budget', resourceId: 't-4', indicators: cue('Backlog', 'neutral', 'clock') }),
  item('split', { title: 'Importer split', activity: 'working', summary: 'editing importer.ts', activityAt: '2026-09-30T10:05:00.000Z' }),
  item('fair', { title: 'Ordering fixes', activity: 'working', activityAt: '2026-09-30T10:07:00.000Z' }),
  item('input', { title: 'Metrics agent', attention: 'input', activityAt: '2026-09-30T10:01:00.000Z' }),
  item('seen', { title: 'Seen agent', attention: 'finished', attentionVersion: 2, attentionSeenVersion: 2 }),
  item('gone', { title: 'Archived', attention: 'input', archivedAt: '2026-09-30T09:00:00.000Z', activityAt: '2026-09-30T11:00:00.000Z' }),
  item('elsewhere', { projectId: 'q', attention: 'input' }),
];
const pipelineOf = (node: Node) => node.resourceId?.startsWith('pr-') ? { singular: 'PR', plural: 'PRs' } : undefined;
const tallyOf = (node: Node) => node.resourceId?.startsWith('t-') ? { singular: 'ticket', plural: 'tickets' } : undefined;

test('a project dashboard lists unread Needs you rows, working agents, PR groups and ticket states', () => {
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf });
  assert.equal(board.title, 'Photos');
  assert.equal(board.items, 14, 'one per resource; archived members and other projects do not count');
  assert.equal(board.lastActivityAt, '2026-09-30T10:07:00.000Z');
  assert.deepEqual(board.needsYou.map(row => [row.id, row.detail]), [['input', 'Waiting for your input'], ['pr-b', 'Checks failing'], ['pr-d', 'Ready for your review']], 'the same unread state and order as Needs me');
  assert.deepEqual(board.working.map(row => [row.id, row.detail, row.at]), [['fair', '', '2026-09-30T10:07:00.000Z'], ['split', 'editing importer.ts', '2026-09-30T10:05:00.000Z']], 'most recent first');
  assert.equal(board.pipelines.length, 1);
  const [prs] = board.pipelines;
  assert.equal(prs.total, 6);
  assert.deepEqual(prs.groups.map(group => [group.label, group.count, group.yours]), [['Checks failing', 1, 1], ['Open', 2, 1], ['Draft', 1, 0], ['Approved', 1, 0], ['Merged', 1, 0]], 'failing, open, ready, finished; larger groups first');
  assert.deepEqual(prs.cells.map(cell => cell.id), ['pr-b', 'pr-e', 'pr-d', 'pr-c', 'pr-a', 'pr-f'], 'strip cells follow the groups');
  assert.equal(prs.cells.filter(cell => cell.needsYou).length, 2, 'cells that need you are marked so a click opens them');
  assert.ok(prs.cells.find(cell => cell.id === 'pr-b')?.needsYou);
  const [tickets] = board.tallies;
  assert.deepEqual(tickets.name, { singular: 'ticket', plural: 'tickets' });
  assert.deepEqual(tickets.groups.map(group => [group.label, group.count, group.icon, group.stage]), [['In progress', 2, 'clock', undefined], ['Backlog', 1, 'clock', undefined], ['Done', 1, 'check', 'done']]);
});

test('Undermap dashboards omit Needs you and Working, and empty sections stay empty', () => {
  const below = projectDashboard('p', nodes, { pipelineOf, tallyOf, paused: true });
  assert.deepEqual([below.needsYou, below.working], [[], []]);
  assert.equal(below.pipelines[0].total, 6); assert.equal(below.pipelines[0].groups.reduce((sum, group) => sum + group.yours, 0), 0);
  assert.ok(below.pipelines[0].cells.every(cell => !cell.needsYou));
  const quiet = projectDashboard('q', [{ id: 'q', title: 'Quiet', position: { x: 0, y: 0 } }], { pipelineOf, tallyOf });
  assert.deepEqual(quiet, { id: 'q', title: 'Quiet', items: 0, needs: 0, counts: { asking: 0, turn: 0, finished: 0, needsMe: 0 }, needsYou: [], working: [], pipelines: [], pipelineIds: [], tallies: [], todos: { open: [], done: 0 }, plots: [], lastActivityAt: undefined });
});

test('layout picks full or compact from the on-screen size and truncates long lists with +N more', () => {
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf });
  const roomy = dashboardLayout({ width: 460, height: 520 }, board);
  assert.equal(roomy.mode, 'full');
  assert.deepEqual([roomy.needs, roomy.needsMore, roomy.working, roomy.workingMore, roomy.pipelines, roomy.tallies], [3, 0, 2, 0, 1, 1]);
  assert.ok(roomy.height <= 520);
  const short = dashboardLayout({ width: 460, height: 250 }, board);
  assert.equal(short.mode, 'full');
  assert.ok(short.height <= 250, `${short.height} fits`);
  assert.ok(short.needs >= 1 && short.needs + short.needsMore === 3, 'Needs you always shows at least one row and counts the rest');
  assert.ok(short.needsMore === 0 || short.needs < 3);
  const many = projectDashboard('p', [...nodes, ...Array.from({ length: 9 }, (_, index) => item(`wait-${index}`, { title: `Waiting ${index}`, attention: 'input' }))], { pipelineOf, tallyOf });
  const capped = dashboardLayout({ width: 460, height: 2000 }, many);
  assert.equal(capped.needs + capped.needsMore, 12); assert.ok(capped.needs <= 5 && capped.needsMore > 0, 'long lists truncate even with room');
  assert.equal(dashboardLayout({ width: 240, height: 520 }, board).mode, 'compact', 'too narrow for rows');
  assert.equal(dashboardLayout({ width: 460, height: 120 }, board).mode, 'compact', 'too short for sections');
  const tiny = dashboardLayout({ width: 90, height: 40 }, board);
  assert.equal(tiny.mode, 'compact'); assert.ok(tiny.width >= 180, 'compact keeps a legible minimum');
  assert.ok(dashboardLayout({ width: 1400, height: 900 }, board).width <= 480, 'full dashboards stay a readable width');
  assert.deepEqual(dashboardLayout({ width: 460, height: 520 }, board), roomy, 'stable for the same input');
});

test('dashboards show below the threshold with hysteresis and never when turned off', () => {
  const setting = { ...DEFAULT_MAP_DASHBOARDS };
  assert.deepEqual(setting, { enabled: true, belowZoom: .65, placement: 'center', sections: DEFAULT_DASHBOARD_SECTIONS }, 'cards hand over to dashboards where they would become icons');
  assert.equal(dashboardsShown(.5, setting, false), true);
  assert.equal(dashboardsShown(.7, setting, true), false);
  assert.equal(dashboardsShown(.645, setting, false), false, 'entering needs to pass the band');
  assert.equal(dashboardsShown(.645, setting, true), true);
  assert.equal(dashboardsShown(.655, setting, true), true, 'leaving needs to pass the band too');
  assert.equal(dashboardsShown(.655, setting, false), false);
  assert.equal(dashboardsShown(.2, { ...setting, enabled: false, belowZoom: .45 }, true), false);
});

test('a dashboard area stays inside the neighbourhood and the canvas and avoids fixed controls', () => {
  const canvas = { width: 1600, height: 760 };
  assert.deepEqual(dashboardArea({ x: 400, y: 100, width: 600, height: 400 }, canvas, []), { x: 416, y: 116, width: 568, height: 368 });
  assert.deepEqual(dashboardArea({ x: -300, y: 100, width: 600, height: 400 }, canvas, []), { x: 12, y: 116, width: 272, height: 368 }, 'clipped to the visible canvas');
  const atlas = { x: 1364, y: 594, width: 220, height: 150 }, rail = { x: 14, y: 100, width: 52, height: 170 };
  const beside = dashboardArea({ x: 1000, y: 300, width: 580, height: 440 }, canvas, [atlas])!;
  assert.ok(beside.x + beside.width <= atlas.x - 8 || beside.y + beside.height <= atlas.y - 8, 'the Atlas is avoided');
  assert.ok(beside.width * beside.height > 100_000, 'the larger remaining part is kept');
  const left = dashboardArea({ x: 0, y: 80, width: 500, height: 300 }, canvas, [rail])!;
  assert.ok(left.x >= rail.x + rail.width + 8);
  assert.equal(dashboardArea({ x: 2000, y: 100, width: 300, height: 300 }, canvas, []), undefined, 'offscreen projects get none');
});

test('short ages for working rows', () => {
  const now = Date.parse('2026-09-30T10:08:00.000Z');
  assert.equal(shortAge('2026-09-30T10:07:40.000Z', now), 'now');
  assert.equal(shortAge('2026-09-30T10:05:00.000Z', now), '3m');
  assert.equal(shortAge('2026-09-30T07:08:00.000Z', now), '3h');
  assert.equal(shortAge('2026-09-28T10:08:00.000Z', now), '2d');
  assert.equal(shortAge(undefined, now), '');
});

const todo = (id: string, extra: Partial<TodoEntry> = {}): TodoEntry => ({ id, source: 'checklist', title: `To-do ${id}`, completed: false, projectId: 'p', nodeIds: [], horizon: 'next', ...extra });
test('the to-dos section lists the project’s open to-dos in list order and counts completed ones', () => {
  const todos = [todo('a', { nodeIds: ['split'] }), todo('done', { completed: true }), todo('map:task', { source: 'map', nodeId: 'task', title: 'Map task' }), todo('other', { projectId: 'q' }), todo('floating', { projectId: undefined }), todo('b', { completed: true })];
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos });
  assert.deepEqual(board.todos.open.map(row => [row.id, row.title, row.nodeId, row.nodeIds]), [['a', 'To-do a', undefined, ['split']], ['map:task', 'Map task', 'task', []]]);
  assert.equal(board.todos.done, 2);
  assert.deepEqual(projectDashboard('p', nodes, { pipelineOf, tallyOf }).todos, { open: [], done: 0 });
  const roomy = dashboardLayout({ width: 460, height: 620 }, board);
  assert.deepEqual([roomy.todos, roomy.todosMore], [2, 0]);
  const many = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos: Array.from({ length: 9 }, (_, index) => todo(`t${index}`)) });
  const capped = dashboardLayout({ width: 460, height: 2000 }, many);
  assert.equal(capped.todos + capped.todosMore, 9); assert.ok(capped.todos <= 4 && capped.todosMore > 0, 'long to-do lists end with +N more');
  const done = dashboardLayout({ width: 460, height: 620 }, projectDashboard('p', nodes, { pipelineOf, tallyOf, todos: [todo('x', { completed: true })] }));
  assert.deepEqual([done.todos, done.todosMore], [0, 0], 'only completed: a heading with the count, no rows');
  assert.ok(roomy.height > dashboardLayout({ width: 460, height: 620 }, projectDashboard('p', nodes, { pipelineOf, tallyOf })).height);
});

test('a dashboard preview describes an item from its node, presentation and links without provider data', () => {
  const links: GraphLink[] = [{ id: 'l1', sourceId: 'split', targetId: 'pr-b', kind: 'reference', label: '' }, { id: 'l2', sourceId: 'pr-b', targetId: 't-1', kind: 'context', label: '' }, { id: 'l3', sourceId: 'pr-b', targetId: 'gone', kind: 'reference', label: '' }];
  const describe = (node: Node) => node.id.startsWith('pr-') ? { typeName: 'GitHub pull request', subtitle: `example/billing #${node.id.length}` } : { typeName: node.id.startsWith('t-') ? 'Linear ticket' : 'Agent session' };
  const withComments = nodes.map(node => node.id === 'pr-b' ? { ...node, activityAt: '2026-09-30T10:00:00.000Z', indicators: [...node.indicators!, { id: 'comments', label: '3 comments', tone: 'blue' as const, icon: 'message-square' as const }] } : node);
  const preview = dashboardPreview('pr-b', withComments, links, describe)!;
  assert.equal(preview.title, 'Refresh loop'); assert.equal(preview.subtitle, 'example/billing #4'); assert.equal(preview.typeName, 'GitHub pull request');
  assert.equal(preview.status?.label, 'Checks failing'); assert.equal(preview.status?.icon, 'x');
  assert.deepEqual(preview.cues.map(cue => cue.label), ['3 comments']);
  assert.deepEqual(preview.attention, [], 'a reason that repeats the status is said once');
  assert.deepEqual(dashboardPreview('pr-d', nodes, links, describe)?.attention, ['Ready for your review']);
  const noted = nodes.map(node => node.id === 'pr-d' ? { ...node, attentionNote: 'Review requested' } : node);
  assert.deepEqual(dashboardPreview('pr-d', noted, links, describe)?.attention, ['Review requested']);
  assert.equal(projectDashboard('p', noted).needsYou.find(row => row.id === 'pr-d')?.detail, 'Review requested');
  assert.equal(preview.activityAt, '2026-09-30T10:00:00.000Z');
  assert.deepEqual(preview.linked, [{ id: 't-1', title: 'APP-1 · Albums', typeName: 'Linear ticket' }, { id: 'split', title: 'Importer split', typeName: 'Agent session' }], 'archived links are left out');
  assert.equal(dashboardPreview('missing', nodes, links, describe), undefined);
});

test('blocked PRs carry a marker in the strip and their preview names what still blocks them', () => {
  const links: GraphLink[] = [{ id: 'b1', sourceId: 'pr-b', targetId: 'pr-e', kind: 'blocks', label: '' }, { id: 'b2', sourceId: 'pr-f', targetId: 'pr-d', kind: 'blocks', label: '' }];
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, links });
  assert.deepEqual(board.pipelines[0].cells.filter(cell => cell.blocked).map(cell => cell.id), ['pr-e'], 'a merged blocker no longer blocks');
  const describe = (node: Node) => ({ typeName: 'GitHub pull request', reference: `#${node.id.length * 100}` });
  assert.deepEqual(dashboardPreview('pr-e', nodes, links, describe)?.blockedBy, ['#400 Refresh loop']);
  assert.deepEqual(dashboardPreview('pr-d', nodes, links, describe)?.blockedBy, []);
});

test('the plots section lists the project’s plots with their Needs me, working and item counts', () => {
  const plot = (id: string, name: string, memberIds: string[], projectId = 'p'): PlotView => ({ id, projectId, name, memberIds, source: 'local', hidden: false, color: 'rose' });
  const plots = [plot('thumbs', 'Thumbnail refresh fix', ['split', 'pr-b', 't-1', 'gone']), plot('billing', 'Billing plan switch', ['input', 'fair', 'pr-d', 'pr-a']), plot('elsewhere', 'Other', ['elsewhere'], 'q')];
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots });
  assert.deepEqual(board.plots.map(row => [row.id, row.name, row.items, row.needs, row.working]), [['billing', 'Billing plan switch', 4, 2, 1], ['thumbs', 'Thumbnail refresh fix', 3, 1, 1]], 'Needs me first, archived members and other projects do not count');
  assert.deepEqual(projectDashboard('p', nodes, { pipelineOf, tallyOf, plots, paused: true }).plots.map(row => [row.needs, row.working]), [[0, 0], [0, 0]]);
  const single = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: plots.slice(0, 1) });
  const roomy = dashboardLayout({ width: 460, height: 900 }, single), without = dashboardLayout({ width: 460, height: 900 }, projectDashboard('p', nodes, { pipelineOf, tallyOf }));
  assert.deepEqual([roomy.plots, roomy.plotsMore, without.plots], [1, 0, 0], 'a single plot keeps the Plots section');
  assert.ok(roomy.height > without.height);
});

const plotView = (id: string, name: string, memberIds: string[], projectId = 'p'): PlotView => ({ id, projectId, name, memberIds, source: 'local', hidden: false, color: 'rose' });
const twoPlots = [plotView('thumbs', 'Thumbnail refresh fix', ['split', 'pr-b', 't-1', 'gone']), plotView('billing', 'Billing plan switch', ['input', 'fair', 'pr-d', 'pr-a'])];
test('with two or more shown plots the dashboard splits into plot blocks and a last Loose block', () => {
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots });
  assert.deepEqual(board.blocks?.map(block => [block.id, block.plot, block.name, block.items]), [['billing', true, 'Billing plan switch', 4], ['thumbs', true, 'Thumbnail refresh fix', 3], ['loose', false, 'Loose', 7]], 'blocks count every item once and add up to the header total');
  const [billing, thumbs, loose] = board.blocks!;
  assert.deepEqual([billing.needsYou.map(row => row.id), billing.working.map(row => row.id)], [['input', 'pr-d'], ['fair']], 'rows keep the Needs me and working order inside a block');
  assert.deepEqual([thumbs.needsYou.map(row => row.id), thumbs.working.map(row => row.id)], [['pr-b'], ['split']]);
  assert.deepEqual([loose.needsYou, loose.working], [[], []]);
  assert.deepEqual(board.blocks!.map(block => block.pipelines.map(section => [section.name.plural, section.cells.map(cell => cell.id)])), [[['PRs', ['pr-d', 'pr-a']]], [['PRs', ['pr-b']]], [['PRs', ['pr-c', 'pr-e', 'pr-f']]]], 'each block has its own PR line');
  assert.equal(board.tallies[0].total, 4, 'tickets stay project-wide');
  assert.equal(board.plots.length, 2);
  const colored = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: [{ ...twoPlots[0], color: 'sky', chosenColor: 'clay' }, twoPlots[1]] });
  assert.deepEqual([colored.plots.map(plot => plot.color), colored.blocks!.map(block => block.color)], [['rose', 'clay'], ['rose', 'clay', undefined]], 'rows and blocks carry the color the plot shows');
  const one =projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: [twoPlots[0]] });
  assert.equal(one.blocks, undefined, 'one plot: today’s dashboard'); assert.equal(one.plots.length, 1);
  assert.equal(projectDashboard('p', nodes, { pipelineOf, tallyOf }).blocks, undefined);
  const emptied = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: [twoPlots[0], plotView('ghost', 'Ghost', ['gone', 'elsewhere'])] });
  assert.equal(emptied.blocks, undefined, 'a plot without live members is not shown and does not split');
  const paused = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots, paused: true });
  assert.ok(paused.blocks?.every(block => !block.needsYou.length && !block.working.length), 'Undermap blocks have headers, strips and to-dos only');
});

test('plot blocks are ordered by their highest Needs me row, then working, then map position, never by name', () => {
  const at = (minutes: number) => `2026-09-30T10:${String(minutes).padStart(2, '0')}:00.000Z`;
  const spots = { a: { x: 600, y: 0 }, b: { x: 0, y: 400 }, c: { x: 300, y: 0 }, d: { x: 0, y: 0 } };
  const field: Node[] = [{ id: 'p', title: 'Field', position: { x: 0, y: 0 } },
    ...Object.entries(spots).flatMap(([key, position]) => [item(`${key}1`, { position }), item(`${key}2`, { position })]), item('loose-wait', { attention: 'input' })];
  const fieldPlots = (names: string[]) => Object.keys(spots).map((key, index) => plotView(key, names[index], [`${key}1`, `${key}2`]));
  const ordered = (patch: (node: Node) => Node, names = ['Zeta', 'Alpha', 'Mid', 'Beta']) => projectDashboard('p', field.map(patch), { plots: fieldPlots(names) }).blocks!.map(block => block.id);
  assert.deepEqual(ordered(node => node), ['d', 'c', 'a', 'b', 'loose'], 'quiet blocks by map position: top band, then left');
  assert.deepEqual(ordered(node => node, ['A', 'B', 'C', 'D']), ['d', 'c', 'a', 'b', 'loose'], 'a rename never moves a block');
  const busy = (node: Node) => node.id === 'b1' ? { ...node, activity: 'working', activityAt: at(1) } : node.id === 'a2' ? { ...node, activity: 'working', activityAt: at(5) } : node;
  assert.deepEqual(ordered(busy), ['a', 'b', 'd', 'c', 'loose'], 'working blocks by most recent activity come before quiet ones');
  const waiting = (node: Node) => node.id === 'c1' ? { ...node, attention: 'input' } : node.id === 'b2' ? { ...node, attention: 'review' } : busy(node);
  const board = projectDashboard('p', field.map(waiting), { plots: fieldPlots(['Zeta', 'Alpha', 'Mid', 'Beta']) });
  assert.deepEqual(board.blocks!.map(block => block.id), ['c', 'b', 'a', 'd', 'loose'], 'Needs you blocks first, in the Needs me order; Loose is always last');
  assert.equal(board.blocks![0].needsYou[0].id, board.needsYou[0].id, 'the first amber row is the first Needs me entry');
  assert.equal(board.blocks!.at(-1)!.needsYou[0].id, 'loose-wait', 'Loose holds Needs you rows too');
});

test('a to-do joins a plot block only when all its items are in that plot; others go to a To-dos section after the blocks', () => {
  const todos = [todo('map:task', { source: 'map', nodeId: 'input', title: 'Map task' }), todo('thumbs-only', { nodeIds: ['split', 'pr-b'] }), todo('across', { nodeIds: ['split', 'input'] }),
    todo('unattached'), todo('loose-only', { nodeIds: ['seen', 'pr-c'] }), todo('half-loose', { nodeIds: ['seen', 'split'] }), todo('done', { completed: true })];
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots, todos });
  assert.deepEqual(board.blocks!.map(block => [block.id, block.todos.map(entry => entry.id)]), [['billing', ['map:task']], ['thumbs', ['thumbs-only']], ['loose', ['loose-only']]]);
  assert.deepEqual(board.otherTodos?.map(entry => entry.id), ['across', 'unattached', 'half-loose']);
  assert.equal(board.todos.open.length, 6, 'the project-wide list is unchanged');
});

/** A project with `plots` plots of three items; the first `waiting` need you and the first `busy` are working. */
const plotField = (plots: number, options: { busy?: number; waiting?: number } = {}) => {
  const list: Node[] = [{ id: 'p', title: 'Six', position: { x: 0, y: 0 } }], views = [];
  for (let index = 0; index < plots; index++) {
    const ids = [0, 1, 2].map(n => `p${index}-${n}`);
    ids.forEach((id, n) => list.push(item(id, { title: `Plot ${index} item ${n}`, position: { x: index * 300, y: 0 },
      ...(index < (options.waiting ?? 0) && n === 0 ? { attention: 'input' } : {}), ...(index < (options.busy ?? 0) && n === 1 ? { activity: 'working', activityAt: `2026-09-30T10:0${index}:00.000Z` } : {}) })));
    views.push(plotView(`plot-${index}`, `Plot number ${index}`, ids));
  }
  list.push(item('loose-0', { position: { x: 0, y: 900 } }), item('loose-1', { position: { x: 0, y: 900 } }));
  return projectDashboard('p', list, { plots: views });
};
test('split layout: every block gets its header and rows when roomy; Loose keeps its header', () => {
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots });
  const roomy = dashboardLayout({ width: 460, height: 900 }, board);
  assert.equal(roomy.mode, 'full');
  assert.deepEqual(roomy.blocks, [{ id: 'billing', needs: 2, working: 1, todos: 0, more: 0, pipelines: 1 }, { id: 'thumbs', needs: 1, working: 1, todos: 0, more: 0, pipelines: 1 }, { id: 'loose', needs: 0, working: 0, todos: 0, more: 0, pipelines: 1 }]);
  assert.deepEqual([roomy.needs, roomy.working, roomy.plots, roomy.pipelines, roomy.tallies, roomy.folded], [0, 0, 0, 0, 1, []], 'no separate sections or project-wide PR line; tickets stay');
  assert.ok(roomy.height <= 900);
  assert.deepEqual(dashboardLayout({ width: 460, height: 900 }, board), roomy, 'stable for the same input');
  const unsplit = dashboardLayout({ width: 460, height: 900 }, projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: [twoPlots[0]] }));
  assert.deepEqual([unsplit.blocks, unsplit.plots, unsplit.pipelines], [[], 1, 1], 'one plot: today’s sections');
});

test('split layout: in a short room quiet plots fold into one line before any Needs you row is dropped', () => {
  const board = plotField(6, { waiting: 2, busy: 3 });
  const roomy = dashboardLayout({ width: 460, height: 2000 }, board);
  assert.deepEqual(roomy.folded, []); assert.equal(roomy.blocks.length, 7);
  const short = dashboardLayout({ width: 460, height: 330 }, board);
  assert.equal(short.mode, 'full');
  assert.ok(short.height <= 330, `${short.height} fits`);
  assert.equal(short.blocks.reduce((sum, block) => sum + block.needs, 0), 2, 'both Needs you rows stay');
  assert.ok(short.folded.length >= 2, `quiet plots fold (${short.folded.join(', ')})`);
  assert.ok(short.folded.every(id => !board.blocks!.find(block => block.id === id)!.needsYou.length), 'only blocks without Needs you fold');
  assert.equal(short.blocks.at(-1)?.id, 'loose', 'Loose keeps its header');
  assert.deepEqual([...short.blocks.map(block => block.id), ...short.folded].sort(), board.blocks!.map(block => block.id).sort(), 'every block is shown or folded');
  const capped = dashboardLayout({ width: 460, height: 2000 }, plotField(6, { waiting: 6 }));
  assert.equal(capped.blocks.reduce((sum, block) => sum + block.needs, 0), 5, 'Needs you rows are capped at five in total');
  assert.equal(capped.blocks.filter(block => block.more).length, 0, 'a block whose only row is capped counts it in its header, not +N more');
  const crowded = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots, todos: Array.from({ length: 6 }, (_, index) => todo(`t${index}`, { source: 'map', nodeId: 'input' })) });
  const more = dashboardLayout({ width: 460, height: 2000 }, crowded).blocks.find(block => block.id === 'billing')!;
  assert.deepEqual([more.todos, more.more], [4, 2], 'a block with more rows than its share ends with +N more');
});

test('split layout: more than six plots split the same way and fold when short', () => {
  const board = plotField(14, { waiting: 2, busy: 3 });
  assert.equal(board.blocks!.length, 15);
  const roomy = dashboardLayout({ width: 460, height: 4000 }, board);
  assert.deepEqual([roomy.blocks.length, roomy.folded], [15, []]);
  const short = dashboardLayout({ width: 460, height: 330 }, board);
  assert.equal(short.mode, 'full');
  assert.ok(short.height <= 330, `${short.height} fits`);
  assert.equal(short.blocks.reduce((sum, block) => sum + block.needs, 0), 2, 'both Needs you rows stay');
  assert.ok(short.folded.length >= 10, `${short.folded.length} quiet plots fold into one line`);
  assert.deepEqual([...short.blocks.map(block => block.id), ...short.folded].sort(), board.blocks!.map(block => block.id).sort(), 'every block is shown or folded');
});

test('split layout: the compact form gains a plot chip line', () => {
  const board = plotField(3, { waiting: 2, busy: 2 });
  const compact = dashboardLayout({ width: 240, height: 520 }, board);
  assert.equal(compact.mode, 'compact');
  assert.equal(compact.height, 98, 'one more line than the plain compact form');
  assert.equal(dashboardLayout({ width: 240, height: 520 }, projectDashboard('p', nodes, { pipelineOf, tallyOf })).height, 78);
  assert.equal(dashboardLayout({ width: 460, height: 120 }, board).mode, 'compact', 'too short for Needs you');
});

const allOff = { needsYou: false, working: false, todos: false, plots: false, pipelines: false, tallies: false };
test('dashboard sections default to everything but the PR and ticket lines', () => {
  assert.deepEqual(DEFAULT_DASHBOARD_SECTIONS, { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false });
  assert.deepEqual(DEFAULT_MAP_DASHBOARDS.sections, DEFAULT_DASHBOARD_SECTIONS);
});

test('sections that are off leave the dashboard; Needs you keeps its count for the header', () => {
  const todos = [todo('a', { nodeIds: ['split'] }), todo('b', { completed: true })];
  const full = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos, plots: [twoPlots[0]] });
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos, plots: [twoPlots[0]], sections: DEFAULT_DASHBOARD_SECTIONS });
  assert.deepEqual([board.pipelines, board.tallies], [[], []], 'no PR or ticket lines by default');
  assert.deepEqual([board.needsYou, board.working, board.todos, board.plots], [full.needsYou, full.working, full.todos, full.plots]);
  assert.deepEqual(board.pipelineIds, ['pr-b', 'pr-e', 'pr-d', 'pr-c', 'pr-a', 'pr-f'], 'PR rows still preview without the PR line');
  const empty = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos, plots: twoPlots, sections: allOff });
  assert.deepEqual([empty.needsYou, empty.working, empty.todos, empty.plots, empty.pipelines, empty.tallies, empty.blocks], [[], [], { open: [], done: 0 }, [], [], [], undefined], 'plots off: no plot rows and no split');
  assert.deepEqual([empty.items, empty.needs, empty.title], [14, 3, 'Photos'], 'the header keeps the item count and how many need you');
  assert.equal(full.needs, 3);
  assert.equal(projectDashboard('p', nodes, { pipelineOf, tallyOf, paused: true, sections: allOff }).needs, 0, 'Undermap has no Needs you count');
});

test('layout uses only the sections that are on; with everything off it is the header alone', () => {
  const todos = [todo('a', { nodeIds: ['split'] })];
  const off = dashboardLayout({ width: 460, height: 900 }, projectDashboard('p', nodes, { pipelineOf, tallyOf, todos, sections: allOff }));
  assert.deepEqual([off.mode, off.height, off.needs, off.working, off.todoSection, off.pipelines, off.tallies], ['full', 12 * 2 + 36, 0, 0, false, 0, 0]);
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos, sections: DEFAULT_DASHBOARD_SECTIONS }), every = projectDashboard('p', nodes, { pipelineOf, tallyOf, todos });
  const roomy = dashboardLayout({ width: 460, height: 900 }, board), withLines = dashboardLayout({ width: 460, height: 900 }, every);
  assert.deepEqual([roomy.needs, roomy.working, roomy.todos, roomy.pipelines, roomy.tallies], [3, 2, 1, 0, 0]);
  assert.deepEqual([withLines.pipelines, withLines.tallies], [1, 1]);
  assert.ok(roomy.height < withLines.height, 'no room goes to PR and ticket lines that are off');
  // A room that fits the rows but not a PR line after them: turning PRs on cannot take rows away.
  const tight = { width: 460, height: roomy.height };
  assert.deepEqual([dashboardLayout(tight, every).needs, dashboardLayout(tight, every).working, dashboardLayout(tight, every).pipelines], [3, 2, 0]);
  const needsOff = dashboardLayout({ width: 460, height: 900 }, projectDashboard('p', nodes, { pipelineOf, tallyOf, todos, sections: { ...DEFAULT_DASHBOARD_SECTIONS, needsYou: false } }));
  assert.deepEqual([needsOff.mode, needsOff.needs, needsOff.needsMore, needsOff.working], ['full', 0, 0, 2]);
});

test('split blocks without PR lines still split by plot; Needs you off keeps block order and header counts', () => {
  const board = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots, sections: DEFAULT_DASHBOARD_SECTIONS });
  assert.deepEqual(board.blocks?.map(block => [block.id, block.items, block.pipelines]), [['billing', 4, []], ['thumbs', 3, []], ['loose', 7, []]]);
  assert.deepEqual(board.tallies, []);
  const roomy = dashboardLayout({ width: 460, height: 900 }, board);
  assert.deepEqual(roomy.blocks, [{ id: 'billing', needs: 2, working: 1, todos: 0, more: 0, pipelines: 0 }, { id: 'thumbs', needs: 1, working: 1, todos: 0, more: 0, pipelines: 0 }, { id: 'loose', needs: 0, working: 0, todos: 0, more: 0, pipelines: 0 }]);
  assert.equal(roomy.tallies, 0);
  const quiet = projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots, sections: { ...DEFAULT_DASHBOARD_SECTIONS, needsYou: false, working: false } });
  assert.deepEqual(quiet.blocks?.map(block => [block.id, block.needsYou.length, block.working.length, block.needs, block.active]), [['billing', 0, 0, 2, 1], ['thumbs', 0, 0, 1, 1], ['loose', 0, 0, 0, 0]], 'rows go; the header counts and attention-first order stay');
  const layout = dashboardLayout({ width: 460, height: 900 }, quiet);
  assert.equal(layout.mode, 'full', 'no Needs you rows is not a reason for the compact form');
  assert.deepEqual(layout.blocks.map(block => [block.id, block.needs, block.working]), [['billing', 0, 0], ['thumbs', 0, 0], ['loose', 0, 0]]);
  const compact = dashboardLayout({ width: 240, height: 520 }, projectDashboard('p', nodes, { pipelineOf, tallyOf, plots: twoPlots, sections: { ...DEFAULT_DASHBOARD_SECTIONS, plots: false } }));
  assert.equal(compact.height, 78, 'plots off: no chip line in the compact form');
});

test('Needs me rows carry their tier and wait; the counted number leaves Finished out unless it is counted', () => {
  const at = (id: string, extra: Record<string, unknown>) => ({ id, title: id, position: { x: 0, y: 0 }, projectId: 'p', resourceId: `r-${id}`, ...extra });
  const members = [{ id: 'p', title: 'Photos', position: { x: 0, y: 0 } },
    at('done', { attentionSources: { completion: 'finished' }, attentionAt: '2026-10-06T07:00:00.000Z' }), at('review', { attention: 'review', attentionAt: '2026-10-06T09:00:00.000Z' }),
    at('ask', { attention: 'input', attentionNote: 'Needs permission to push', attentionAt: '2026-10-06T10:00:00.000Z' }), at('checks', { attentionSources: { ci: 'checks-failing' }, attentionAt: '2026-10-06T08:00:00.000Z' })];
  const plots = [{ id: 'plot', projectId: 'p', name: 'Thumbnail', memberIds: ['ask', 'done', 'review'], source: 'local' as const, hidden: false, color: 'rose' as const }];
  const board = projectDashboard('p', members, { plots });
  assert.deepEqual(board.needsYou.map(row => [row.id, row.tier, row.detail, row.since]), [['ask', 'asking', 'Needs permission to push', '2026-10-06T10:00:00.000Z'], ['checks', 'turn', 'Checks failing', '2026-10-06T08:00:00.000Z'], ['review', 'turn', 'Ready for your review', '2026-10-06T09:00:00.000Z'], ['done', 'finished', 'Finished · ready to view', '2026-10-06T07:00:00.000Z']]);
  assert.deepEqual(board.counts, { asking: 1, turn: 2, finished: 1, needsMe: 3, top: 'asking' });
  assert.equal(projectDashboard('p', members, { counting: { countFinished: true } }).counts.needsMe, 4);
  assert.deepEqual(board.plots.map(plot => plot.tiers), [{ asking: 1, turn: 1, finished: 1 }]);
  assert.deepEqual(projectDashboard('p', members, { paused: true, plots }).counts, { asking: 0, turn: 0, finished: 0, needsMe: 0 });
});
