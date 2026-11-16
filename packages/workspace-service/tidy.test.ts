import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_ACTOR, WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { UndoStep } from '../core/map-undo.ts';
import { planTidy, tidyFingerprint } from '../core/tidy.ts';
import type { TidyRegroup } from '../core/tidy.ts';
import { plotSnap } from '../core/map-undo.ts';
import { SqliteStore } from './sqlite-store.ts';
import { Plots } from './plots.ts';
import { Tidy } from './tidy.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';

const ALL = { lineUp: true, spacePlots: true, colors: true, archive: false, rename: false, regroup: false };
const NOW = Date.parse('2026-01-15T12:00:00Z'), AGENT = { kind: 'agent', id: 'agent' } as never;
type Fixture = { store: SqliteStore; control: WorkspaceControl; plots: Plots; tidy: Tidy; asked: string[]; person(...commands: WorkspaceCommand[]): Promise<UndoStep | undefined>; agent(...commands: WorkspaceCommand[]): Promise<void>; preview(options?: typeof ALL, regroup?: TidyRegroup[]): Promise<string> };
async function fixture(run: (value: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-tidy-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), asked: string[] = [];
  const client: ActivitySummaryClient = { async complete(request) { const system = String(request.system); asked.push(system); return system.includes('Group the items') ? '{"moves":[]}' : 'Checkout total fix'; } };
  const plots = new Plots(store, control, { client }), tidy = new Tidy(store, control, plots, () => client, () => NOW);
  const send = async (actor: { kind: 'user'; id: string }, commands: WorkspaceCommand[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor, commands });
  const person = async (...commands: WorkspaceCommand[]) => { const { receipt } = await send({ kind: 'user', id: PERSON_ACTOR }, commands); return receipt && { label: 'Edit', ...receipt }; };
  const agent = async (...commands: WorkspaceCommand[]) => { await send(AGENT, commands); };
  // What the dialog sends: the fingerprint of the map its preview was made from.
  const preview = async (options = ALL, regroup: TidyRegroup[] = []) => {
    const state = await control.read(), input = { state, registry: control.registry, sizes: store.readSettings().value.itemMapSizes, plots: plots.observe(state).list, now: NOW, regroup, archived: [] };
    return tidyFingerprint(input, planTidy(input, options));
  };
  try {
    await person({ type: 'project.create', id: 'acme', title: 'Acme', summary: '', position: { x: 0, y: 0 } });
    const note = (id: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: `Note ${id}`, data: { text: `Note ${id}` }, projectId: 'acme', position: { x, y } });
    await person(note('a1', 0, 0), note('a2', 0, 0), note('a3', 0, 0));
    await person(note('b1', 3000, 0), note('b2', 3000, 0), note('b3', 3000, 0), note('loose', 1500, 2000));
    await run({ store, control, plots, tidy, asked, person, agent, preview });
  } finally { await plots.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
const positions = (state: { nodes: { id: string; position: unknown }[] }) => Object.fromEntries(state.nodes.map(node => [node.id, node.position]));

const apply = (fingerprint: string, options = ALL) => ({ operation: 'apply', fingerprint, options, archives: [], renames: [], regroup: [] });
type Applied = { revision: number; receipt?: Omit<UndoStep, 'label'> };

test('apply ignores status changes, refuses an in-scope move, and undoes as one step', () => fixture(async ({ control, plots, tidy, store, agent, preview }) => {
  const [first, second] = plots.observe(await control.read()).list;
  store.colorPlots(new Map([[second.id, first.color]])); plots.invalidate();
  const stale = await preview(), a1 = (await control.read()).nodes.find(node => node.id === 'a1')!.position;
  await agent({ type: 'node.move', id: 'a1', position: { x: a1.x + 40, y: a1.y } });
  await assert.rejects(tidy.run(apply(stale)), /changed since this preview/);
  const fingerprint = await preview(), seen = await control.read();
  await agent({ type: 'node.update', id: 'a2', activity: 'working', attention: 'input', attentionNote: 'Needs a call' });
  const result = await tidy.run(apply(fingerprint)) as Applied, tidied = await control.read();
  assert.equal(result.revision, seen.revision + 2, 'one revision for the status update, one for Tidy');
  assert.notEqual(plots.observe(tidied).list[1].color, first.color, 'the duplicate colour changed');
  assert.notDeepEqual(positions(tidied), positions(seen));
  assert.deepEqual(plots.observe(tidied).list.map(plot => plot.memberIds), plots.observe(seen).list.map(plot => plot.memberIds));
  const again = await tidy.run(apply(await preview())) as Applied;
  assert.deepEqual([again.revision, again.receipt], [result.revision, undefined], 'a tidied board has nothing to apply');
  const undone = await tidy.run({ operation: 'revert', direction: 'undo', step: { label: 'Tidy', ...result.receipt! } }) as { revision: number; skipped: number };
  const after = await control.read();
  assert.deepEqual([undone.revision, undone.skipped], [result.revision + 1, 0]);
  assert.deepEqual(positions(after), positions(seen));
  assert.equal(after.nodes.find(node => node.id === 'a2')!.activity, 'working', 'undo leaves the status alone');
  assert.deepEqual(plots.observe(after).list.map(plot => plot.color), [first.color, first.color], 'the same undo put the colour back');
}));

test('a preview is stale once a plot colour or the item sizes change', () => fixture(async ({ control, plots, tidy, store, preview }) => {
  const stale = await preview(), plot = plots.observe(await control.read()).list[0];
  await plots.run('acme', { operation: 'color', plotId: plot.id, color: '#123456' });
  await assert.rejects(tidy.run(apply(stale)), /changed since this preview/);
  const fresh = await preview(), settings = store.readSettings();
  store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, itemMapSizes: { 'workspace.note': { defaultSize: 'medium', sizes: {} } } } });
  await assert.rejects(tidy.run(apply(fresh)), /changed since this preview/);
}));

test('a failed plot write leaves the map as it was', () => fixture(async ({ control, plots, tidy, store, preview }) => {
  const [first, second] = plots.observe(await control.read()).list;
  store.colorPlots(new Map([[second.id, first.color]])); plots.invalidate();
  const before = await control.read(), fingerprint = await preview();
  store.writeTidyPlots = () => { throw new Error('disk full'); };
  await assert.rejects(tidy.run(apply(fingerprint)), /disk full/);
  const after = await control.read();
  assert.deepEqual([after.revision, positions(after)], [before.revision, positions(before)]);
}));

test('undo checks the latest map and leaves a neighbour an agent moved since', () => fixture(async ({ control, tidy, person, agent }) => {
  const before = await control.read(), a1 = before.nodes.find(node => node.id === 'a1')!;
  const step = (await person({ type: 'node.move', id: 'loose', position: a1.position }))!;
  const pushed = step.items.find(item => item.id !== 'loose')!;
  await agent({ type: 'node.move', id: pushed.id, position: { x: 5000, y: 5000 } });
  const undone = await tidy.run({ operation: 'revert', direction: 'undo', step }) as { skipped: number };
  const after = await control.read();
  assert.deepEqual(after.nodes.find(node => node.id === pushed.id)!.position, { x: 5000, y: 5000 });
  assert.deepEqual(after.nodes.find(node => node.id === 'loose')!.position, before.nodes.find(node => node.id === 'loose')!.position);
  assert.equal(undone.skipped, 1);
}));

test('rename proposes only machine names, never one the person chose or a provider title, and stays a machine name once applied', () => fixture(async ({ control, plots, tidy, person, agent, store, asked, preview }) => {
  store.writeSettings({ expectedRevision: store.readSettings().revision, value: { ...store.readSettings().value, summaries: { ...store.readSettings().value.summaries, enabled: true } } });
  const session = (id: string, x: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: `Session ${id}`, data: { sessionId: `native-${id}`, provider: 'claude' }, projectId: 'acme', position: { x, y: 900 } });
  await person(session('s1', 0), session('s2', 600), session('s3', 1200), { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 4000 } });
  await agent({ type: 'node.title.generated', id: 's1', title: 'Session one', sourceTitle: 'Session s1' });
  await person({ type: 'node.update', id: 's2', title: 'Named by me' });
  const plot = plots.observe(await control.read()).list[0];
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'My plot' });
  const suggested = await tidy.run({ operation: 'suggest', options: { ...ALL, rename: true } }) as { revision: number; renames: { kind: string; id: string; to: string; ticked: boolean }[] };
  assert.deepEqual(suggested.renames.filter(row => row.kind !== 'plot').map(row => [row.kind, row.id, row.ticked]), [['item', 's1', true]], 'not s2, the provider title of s3, nor the projects Acme and Billing');
  assert.equal(suggested.renames.some(row => row.id === plot.id), false);
  assert.ok(asked.length > 0);
  const rows = suggested.renames.filter(row => row.id === 's1'), options = { ...ALL, lineUp: false, spacePlots: false, colors: false, rename: true };
  await tidy.run({ ...apply(await preview(options), options), renames: rows });
  const s1 = (await control.read()).nodes.find(node => node.id === 's1')!;
  assert.deepEqual([s1.title, s1.generatedTitle, s1.titleChosen], ['Checkout total fix', 'Checkout total fix', undefined]);
}));

test('line up never pulls loose items into a plot, and a second Tidy is empty', () => fixture(async ({ control, plots, tidy, person, preview }) => {
  const options = { ...ALL, spacePlots: false, colors: false };
  const note = (id: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: `Note ${id}`, data: { text: `Note ${id}` }, projectId: 'acme', position: { x, y } });
  await person(note('p1', 0, 5000), note('p2', 0, 5140), note('p3', 0, 5280), note('l1', 384, 5000), note('l2', 584, 5000));
  const members = async () => plots.observe(await control.read()).list.map(plot => [...plot.memberIds].sort()).sort();
  const before = await members();
  assert.ok(before.some(ids => ids.join() === 'p1,p2,p3'));
  await tidy.run(apply(await preview(options), options));
  assert.deepEqual(await members(), before);
  const again = await tidy.run(apply(await preview(options), options)) as Applied;
  assert.equal(again.receipt, undefined);
}));

test('undo leaves a plot Tidy created alone once it was locked', () => fixture(async ({ control, plots, tidy, preview }) => {
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, regroup: true }, regroup = ['a1', 'a2', 'a3'].map(itemId => ({ itemId, newPlot: 'Fresh' }));
  const result = await tidy.run({ ...apply(await preview(options, regroup), options), regroup }) as Applied & { created: string[] };
  await plots.run('acme', { operation: 'lock', plotId: result.created[0], locked: true });
  const undone = await tidy.run({ operation: 'revert', direction: 'undo', step: { label: 'Tidy', ...result.receipt! } }) as { reverted: number; skipped: number };
  assert.deepEqual([undone.reverted, undone.skipped], [0, 1]);
  assert.ok(plots.observe(await control.read()).list.some(plot => plot.id === result.created[0] && plot.locked));
}));

test('undoing pins never takes an item from a plot outside the step', () => fixture(async ({ control, plots, tidy, store }) => {
  store.createPinnedPlot('P', 'acme', ['b1', 'b2'], NOW); store.createPinnedPlot('Q', 'acme', ['a1'], NOW); plots.invalidate();
  const after = plotSnap(plots.observe(await control.read()).list.find(plot => plot.id === 'P')!), step = { label: 'Tidy', items: [], links: [], plots: [{ id: 'P', before: { ...after, pinnedMemberIds: ['b1', 'b2'] }, after: { ...after, pinnedMemberIds: ['b2'] } }] };
  store.pinPlotMembers('P', ['b2']); store.unpinPlotMembers(['b1']); store.pinPlotMembers('Q', ['a1', 'b1']); plots.invalidate();
  const undone = await tidy.run({ operation: 'revert', direction: 'undo', step }) as { skipped: number };
  const pins = Object.fromEntries(store.plotRecords().map(record => [record.id, record.pinnedMemberIds]));
  assert.deepEqual([pins.P, pins.Q, undone.skipped], [['b2'], ['a1', 'b1'], 1]);
}));

test('undo of a plot rename puts back the name the service replaced, not the one this window saw', () => fixture(async ({ control, plots, tidy }) => {
  const plot = plots.observe(await control.read()).list[0];
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Old' });
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Other' });
  const renamed = await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'This' }) as { receipt?: Omit<UndoStep, 'label'> };
  await tidy.run({ operation: 'revert', direction: 'undo', step: { label: 'Rename plot', ...renamed.receipt! } });
  assert.equal(plots.observe(await control.read()).list[0].name, 'Other');
}));

test('an archive row whose item got busy after the preview is skipped, not refused', () => fixture(async ({ control, plots, store, person, agent }) => {
  const later = () => Date.now() + 4 * 86_400_000, client: ActivitySummaryClient = { async complete() { return ''; } };
  const tidy = new Tidy(store, control, plots, () => client, later), options = { ...ALL, lineUp: false, spacePlots: false, colors: false, archive: true };
  await person({ type: 'node.complete', id: 'loose' });
  const state = await control.read(), input = { state, registry: control.registry, sizes: store.readSettings().value.itemMapSizes, plots: plots.observe(state).list, now: later(), regroup: [], archived: ['loose'] };
  const fingerprint = tidyFingerprint(input, planTidy(input, options));
  await agent({ type: 'node.update', id: 'loose', activity: 'working' });
  const result = await tidy.run({ ...apply(fingerprint, options), archives: ['loose'] }) as { skipped: number };
  assert.equal(result.skipped, 1);
  assert.equal((await control.read()).nodes.find(node => node.id === 'loose')!.archivedAt, undefined);
}));

test('a move the final map would carry into another plot is dropped before the commit', () => fixture(async ({ control, plots, tidy, preview }) => {
  const seen = await control.read(), members = (state: typeof seen) => plots.observe(state).list.map(plot => [...plot.memberIds].sort());
  const b1 = seen.nodes.find(node => node.id === 'b1')!.position, reduce = control.reduce.bind(control);
  let carried = 0;
  // Stands in for a solid stop: wherever a1 is sent, the final map leaves it beside the b plot.
  control.reduce = (state, envelope) => {
    const next = reduce(state, envelope), sent = envelope.commands.some(command => command.type === 'nodes.move' && command.positions.some(entry => entry.id === 'a1'));
    carried += Number(sent);
    return sent ? { ...next, nodes: next.nodes.map(node => node.id === 'a1' ? { ...node, position: { x: b1.x + 200, y: b1.y } } : node) } : next;
  };
  const result = await tidy.run(apply(await preview())) as Applied & { moved: string[] };
  assert.ok(carried > 0, 'the plan did send a1');
  assert.equal(result.moved.includes('a1'), false);
  assert.deepEqual(members(await control.read()), members(seen));
}));
