import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { Plots } from './plots.ts';
import { agentRuntimeRefusal } from '../core/runtime.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { PLOT_NAME_DEBOUNCE_MS, PLOT_NAME_INTERVAL_MS } from './plots.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';

type Fixture = { directory: string; store: SqliteStore; control: WorkspaceControl; apply(...commands: WorkspaceCommand[]): Promise<void> };
async function fixture(run: (value: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plots-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (...commands: WorkspaceCommand[]) => { await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands }); };
  try {
    await apply({ type: 'project.create', id: 'photos', title: 'Photos', summary: '', position: { x: 0, y: 0 } });
    const note = (id: string, title: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title, data: { text: title }, projectId: 'photos', position: { x, y } });
    await apply(note('a1', 'Billing proration', 0, 0), note('a2', 'Billing invoice tests', 0, 0), note('a3', 'Plan switcher', 0, 0));
    await apply(note('b1', 'Upload size check', 3000, 0), note('b2', 'Upload samples', 3000, 0), note('b3', 'Upload stalls', 3000, 0));
    await apply(note('loose', 'Ideas', 1500, 2000));
    await run({ directory, store, control, apply });
  } finally { for (const plots of running.splice(0)) await plots.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
const running: Plots[] = [];
const groups = (plots: ReturnType<Plots['observe']>) => plots.list.map(plot => plot.memberIds.join(','));

test('plots come from committed layout with a local name, and keep their identity across a restart', () => fixture(async ({ store, control }) => {
  const plots = new Plots(store, control);
  const first = plots.observe(await control.read());
  assert.deepEqual(groups(first), ['a1,a2,a3', 'b1,b2,b3']);
  assert.deepEqual(first.list.map(plot => [plot.name, plot.source, plot.hidden]), [['Billing · 3 items', 'local', false], ['Upload · 3 items', 'local', false]]);
  assert.equal(plots.observe(await control.read()), first, 'an unchanged revision reuses the result');
  const again = new Plots(store, control).observe(await control.read());
  assert.deepEqual(again.list.map(plot => plot.id), first.list.map(plot => plot.id));
}));

test('a moved card leaves its plot only past the leave gap; archived and Undermap items never count', () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control), first = plots.observe(await control.read());
  const b2 = (await control.read()).nodes.find(node => node.id === 'b2')!;
  await apply({ type: 'node.move', id: 'b2', position: { x: b2.position.x, y: b2.position.y + 80 } });
  const nudged = plots.observe(await control.read());
  assert.deepEqual(groups(nudged), groups(first)); assert.equal(nudged.list[1].id, first.list[1].id);
  await apply({ type: 'node.move', id: 'b2', position: { x: 6000, y: 4000 } });
  assert.deepEqual(groups(plots.observe(await control.read())), ['a1,a2,a3']);
  await apply({ type: 'node.archive', id: 'a3' });
  assert.deepEqual(groups(plots.observe(await control.read())), []);
  await apply({ type: 'node.restore', id: 'a3' });
  assert.deepEqual(plots.observe(await control.read()).list.map(plot => plot.id), [first.list[0].id], 'a re-formed plot reclaims its dormant identity');
}));

test('saving or removing a link recomputes plots, joining linked items however far apart', () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control);
  const note = (id: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, projectId: 'photos', position: { x, y } });
  await apply(note('f1', 1500, -2000), note('f2', -2000, 1500));
  assert.deepEqual(groups(plots.observe(await control.read())), ['a1,a2,a3', 'b1,b2,b3']);
  await apply({ type: 'link.save', link: { id: 'l1', sourceId: 'loose', targetId: 'f1', kind: 'reference', label: '' } }, { type: 'link.save', link: { id: 'l2', sourceId: 'f2', targetId: 'loose', kind: 'reference', label: '' } });
  assert.deepEqual(groups(plots.observe(await control.read())), ['a1,a2,a3', 'b1,b2,b3', 'f1,f2,loose']);
  const linked = plots.observe(await control.read()).list[2];
  await apply({ type: 'link.remove', id: 'l2' });
  const pair = plots.observe(await control.read());
  assert.deepEqual(groups(pair), ['a1,a2,a3', 'b1,b2,b3', 'f1,loose'], 'two linked items are still a plot');
  assert.equal(pair.list[2].id, linked.id);
  assert.equal(pair.list[2].name, '2 items');
  await apply({ type: 'link.remove', id: 'l1' });
  assert.deepEqual(groups(plots.observe(await control.read())), ['a1,a2,a3', 'b1,b2,b3']);
}));

test('a link saved between two plots keeps both, also after a restart; a link from a loose item joins one', () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control);
  await apply({ type: 'link.save', link: { id: 'l1', sourceId: 'a3', targetId: 'loose', kind: 'reference', label: '' } });
  const first = plots.observe(await control.read());
  assert.deepEqual(groups(first), ['a1,a2,a3,loose', 'b1,b2,b3']);
  await apply({ type: 'link.save', link: { id: 'l2', sourceId: 'loose', targetId: 'b1', kind: 'reference', label: '' } }, { type: 'link.save', link: { id: 'l3', sourceId: 'b2', targetId: 'a1', kind: 'reference', label: '' } });
  const kept = plots.observe(await control.read());
  assert.deepEqual(kept.list.map(plot => [plot.id, plot.memberIds.join(',')]), first.list.map(plot => [plot.id, plot.memberIds.join(',')]));
  const restarted = new Plots(store, control).observe(await control.read());
  assert.deepEqual(restarted.list.map(plot => [plot.id, plot.memberIds.join(',')]), first.list.map(plot => [plot.id, plot.memberIds.join(',')]), 'the saved plots are the boundary');
}));

test('a person renames, hides and turns plots off per project; an empty name hands it back; agents cannot', () => fixture(async ({ store, control }) => {
  const plots = new Plots(store, control), first = plots.observe(await control.read()), billing = first.list[0];
  await plots.run('photos', { operation: 'rename', plotId: billing.id, name: '  Q4   pricing ' });
  let view = plots.observe(await control.read());
  assert.deepEqual([view.list[0].name, view.list[0].source], ['Q4 pricing', 'user']);
  await plots.run('photos', { operation: 'hide', plotId: billing.id, hidden: true });
  assert.equal(plots.observe(await control.read()).list[0].hidden, true);
  await plots.run('photos', { operation: 'project', shown: false });
  assert.deepEqual(plots.observe(await control.read()).hiddenProjects, ['photos']);
  await plots.run('photos', { operation: 'rename', plotId: billing.id, name: '' });
  view = plots.observe(await control.read());
  assert.deepEqual([view.list[0].name, view.list[0].source], ['Billing · 3 items', 'local']);
  await assert.rejects(plots.run('other', { operation: 'hide', plotId: billing.id, hidden: true }), /not in this project/);
  await assert.rejects(plots.run('photos', { operation: 'rename', plotId: billing.id, name: 'x'.repeat(49) }));
  assert.equal(agentRuntimeRefusal({ action: 'plot', arguments: { operation: 'rename' } }), humanOnlyMessage);
}));

const colors = (plots: ReturnType<Plots['observe']>) => plots.list.map(plot => [plot.memberIds[0], plot.color, plot.chosenColor]);
const note = (id: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, projectId: 'photos', position: { x, y } });

test('plots in a project get distinct colors that stay through recomputes, other plots coming and going, and a restart', () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control);
  assert.deepEqual(colors(plots.observe(await control.read())), [['a1', 'rose', undefined], ['b1', 'sky', undefined]]);
  await apply(note('c1', 0, 3000), note('c2', 0, 3000), note('c3', 0, 3000));
  assert.deepEqual(colors(plots.observe(await control.read())), [['a1', 'rose', undefined], ['b1', 'sky', undefined], ['c1', 'citron', undefined]]);
  await apply({ type: 'node.move', id: 'b2', position: { x: 6000, y: 4000 } });
  assert.deepEqual(colors(plots.observe(await control.read())), [['a1', 'rose', undefined], ['c1', 'citron', undefined]], 'a dissolving plot recolors nothing');
  assert.deepEqual(colors(new Plots(store, control).observe(await control.read())), [['a1', 'rose', undefined], ['c1', 'citron', undefined]]);
  await apply(note('d1', -3000, 0), note('d2', -3000, 0), note('d3', -3000, 0));
  const view = plots.observe(await control.read());
  assert.equal(view.list.find(plot => plot.memberIds[0] === 'd1')!.color, 'sky', 'a new plot takes the first free color');
  assert.deepEqual(colors(view).filter(([id]) => id !== 'd1'), [['a1', 'rose', undefined], ['c1', 'citron', undefined]]);
}));

test(`a person picks a plot color; it survives recomputes and a restart, may repeat another plot's, and Automatic clears it`, () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control), [billing, uploads] = plots.observe(await control.read()).list;
  await plots.run('photos', { operation: 'color', plotId: uploads.id, color: 'rose' });
  assert.deepEqual(colors(plots.observe(await control.read())), [['a1', 'rose', undefined], ['b1', 'sky', 'rose']], 'both keep rose; nothing reshuffles');
  const b2 = (await control.read()).nodes.find(node => node.id === 'b2')!;
  await apply({ type: 'node.move', id: 'b2', position: { x: b2.position.x, y: b2.position.y + 80 } });
  assert.deepEqual(colors(plots.observe(await control.read())), [['a1', 'rose', undefined], ['b1', 'sky', 'rose']]);
  assert.deepEqual(colors(new Plots(store, control).observe(await control.read())), [['a1', 'rose', undefined], ['b1', 'sky', 'rose']]);
  await plots.run('photos', { operation: 'color', plotId: billing.id, color: 'orchid' });
  await plots.run('photos', { operation: 'color', plotId: uploads.id, color: null });
  assert.deepEqual(colors(plots.observe(await control.read())), [['a1', 'rose', 'orchid'], ['b1', 'sky', undefined]]);
  await assert.rejects(plots.run('other', { operation: 'color', plotId: billing.id, color: 'sky' }), /not in this project/);
  await assert.rejects(plots.run('photos', { operation: 'color', plotId: billing.id, color: 'teal' }));
  assert.equal(agentRuntimeRefusal({ action: 'plot', arguments: { operation: 'color' } }), humanOnlyMessage);
}));

test('a plot moved to another project keeps its identity, name and chosen color there', () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control), [billing] = plots.observe(await control.read()).list;
  await plots.run('photos', { operation: 'rename', plotId: billing.id, name: 'Pricing' });
  await plots.run('photos', { operation: 'color', plotId: billing.id, color: 'orchid' });
  const resident = (id: string, x: number): WorkspaceCommand => ({ ...note(id, x, 6000), projectId: 'video' } as WorkspaceCommand);
  await apply({ type: 'project.create', id: 'video', title: 'Video', summary: '', position: { x: 0, y: 6000 } }, resident('v1', 0), resident('v2', 1500), resident('v3', 3000), resident('v4', 4500), resident('v5', 6000));
  await apply({ type: 'nodes.send', ids: ['a1', 'a2', 'a3'], projectId: 'video' });
  const moved = plots.observe(await control.read()).list.find(plot => plot.projectId === 'video')!;
  assert.deepEqual([moved.id, moved.name, moved.source, moved.chosenColor], [billing.id, 'Pricing', 'user', 'orchid']);
  assert.ok(['a1', 'a2', 'a3'].every(id => moved.memberIds.includes(id)));
  assert.equal(plots.observe(await control.read()).list.filter(plot => plot.id === billing.id).length, 1);
  await plots.run('video', { operation: 'rename', plotId: billing.id, name: 'Pricing v2' });
}));

test('a short note shown as a badge on an item is no plot member', async () => fixture(async ({ store, control, apply }) => {
  const plots = new Plots(store, control);
  await apply({ type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Proration', data: { owner: 'acme', repo: 'app', number: 7 }, projectId: 'photos', position: { x: 0, y: 0 } },
    note('s2', 50, 0), { type: 'item.update', id: 's2', data: { text: 'S2' } }, { type: 'link.save', link: { id: 's2-pr', sourceId: 's2', targetId: 'pr', kind: 'reference', label: '' } });
  assert.ok(plots.observe(await control.read()).list.every(plot => !plot.memberIds.includes('s2')));
  await apply({ type: 'item.update', id: 's2', data: { text: 'S2', display: 'note' } });
  assert.ok(plots.observe(await control.read()).list.some(plot => plot.memberIds.includes('s2')), 'kept as paper it joins its neighbours');
}));

function naming(store: SqliteStore, control: WorkspaceControl, answers: string[], now: { value: number }) {
  const requests: any[] = [];
  const client: ActivitySummaryClient = { async complete(request) { requests.push(request); return answers.shift() ?? 'KEEP'; } };
  const plots = new Plots(store, control, { clock: () => now.value, client, timeoutMs: 50 });
  plots.start(); running.push(plots);
  return { requests, plots };
}
function limit(store: SqliteStore, summaries: Record<string, unknown>) {
  const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, ...summaries } } });
}

test('a seen plot is named 30 s after it forms from titles only, once per membership, at most every 10 min', () => fixture(async ({ store, control, apply }) => {
  await apply({ type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Proration agent', data: { sessionId: 'static', provider: 'claude' }, projectId: 'photos', position: { x: 0, y: 0 } });
  await apply({ type: 'node.update', id: 'agent', summary: 'Writing invoice tests' });
  const now = { value: 1_000_000 }, { requests, plots } = naming(store, control, ['"Billing plan switch."', 'Billing and invoices'], now);
  let view = plots.observe(await control.read());
  const billing = view.list.find(plot => plot.memberIds.includes('agent'))!;
  await plots.tick(); assert.equal(requests.length, 0, 'not seen yet');
  await plots.run('photos', { operation: 'seen', plotIds: [billing.id] });
  await plots.tick(); assert.equal(requests.length, 0, 'membership settles for 30 s first');
  now.value += PLOT_NAME_DEBOUNCE_MS; await plots.tick();
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0].messages[0].content);
  assert.equal(input.project, 'Photos'); assert.equal(input.currentName, null);
  assert.deepEqual(input.items.find((item: { title: string }) => item.title === 'Proration agent'), { type: 'Agent session', title: 'Proration agent', summary: 'Writing invoice tests' });
  assert.ok(input.items.every((item: { summary?: string }) => !item.summary || item.summary === 'Writing invoice tests'), 'notes send their title only');
  view = plots.observe(await control.read());
  assert.deepEqual([view.list.find(plot => plot.id === billing.id)!.name, view.list.find(plot => plot.id === billing.id)!.source], ['Billing plan switch', 'generated']);
  now.value += PLOT_NAME_INTERVAL_MS; await plots.tick(); assert.equal(requests.length, 1, 'unchanged membership is not named again');
  const a3 = (await control.read()).nodes.find(node => node.id === 'a3')!;
  await apply({ type: 'node.move', id: 'a3', position: { x: 9000, y: 9000 } });
  await apply({ type: 'item.add', id: 'a4', resourceId: 'a4-r', pluginId: 'workspace.note', title: 'Invoice rounding', data: { text: 'PRIVATE NOTE BODY' }, projectId: 'photos', position: a3.position });
  plots.observe(await control.read());
  now.value += PLOT_NAME_DEBOUNCE_MS; await plots.tick();
  assert.equal(requests.length, 2);
  const second = JSON.parse(requests[1].messages[0].content);
  assert.equal(second.currentName, 'Billing plan switch'); assert.doesNotMatch(requests[1].messages[0].content, /PRIVATE NOTE BODY/);
}));

test('a user name is never replaced; Name automatically hands it back at once; off or out of allowance keeps the local name', () => fixture(async ({ store, control }) => {
  const now = { value: 1_000_000 }, { requests, plots } = naming(store, control, ['Billing plan switch', 'Upload stall triage'], now);
  const [billing, uploads] = plots.observe(await control.read()).list;
  await plots.run('photos', { operation: 'seen', plotIds: [billing.id, uploads.id] });
  await plots.run('photos', { operation: 'rename', plotId: uploads.id, name: 'My upload work' });
  limit(store, { requestsPerHour: 1 });
  now.value += PLOT_NAME_DEBOUNCE_MS; await plots.tick(); await plots.tick();
  assert.equal(requests.length, 1, 'only the automation-owned plot is named');
  assert.equal(JSON.parse(requests[0].messages[0].content).items.length, 3);
  let view = plots.observe(await control.read());
  assert.equal(view.list.find(plot => plot.id === uploads.id)!.name, 'My upload work');
  await plots.run('photos', { operation: 'auto', plotId: uploads.id });
  view = plots.observe(await control.read());
  assert.deepEqual([view.list.find(plot => plot.id === uploads.id)!.name, view.list.find(plot => plot.id === uploads.id)!.source], ['Upload · 3 items', 'local']);
  await plots.tick(); assert.equal(requests.length, 1, 'the shared hourly allowance is used up; the local name stays');
  limit(store, { requestsPerHour: 12, plotNames: false });
  await plots.tick(); assert.equal(requests.length, 1, 'Name plots off');
  await assert.rejects(plots.run('photos', { operation: 'auto', plotId: uploads.id }), /Name plots/);
  limit(store, { plotNames: true });
  await plots.tick(); assert.equal(requests.length, 2, 'the requested plot skips the 30 s wait');
  assert.equal(plots.observe(await control.read()).list.find(plot => plot.id === uploads.id)!.name, 'Upload stall triage');
}));

test('turning Show plots off stops naming as well as drawing', () => fixture(async ({ store, control }) => {
  const now = { value: 1_000_000 }, { requests, plots } = naming(store, control, ['Billing plan switch'], now);
  const [billing] = plots.observe(await control.read()).list;
  await plots.run('photos', { operation: 'seen', plotIds: [billing.id] });
  const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapPlots: false } });
  now.value += PLOT_NAME_DEBOUNCE_MS; await plots.tick();
  assert.equal(requests.length, 0);
}));
