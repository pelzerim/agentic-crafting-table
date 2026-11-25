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
import { SqliteStore } from './sqlite-store.ts';
import { Plots } from './plots.ts';
import { Tidy } from './tidy.ts';
import { MapUndo } from './map-undo.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';

const ALL = { lineUp: true, spacePlots: true, colors: true, archive: false, rename: false, regroup: false };
const NOW = Date.parse('2026-01-15T12:00:00Z'), AGENT = { kind: 'agent', id: 'agent' } as never;
type Reverted = { applied?: UndoStep; revision: number; reverted: number; skipped: number };
type Fixture = { store: SqliteStore; control: WorkspaceControl; plots: Plots; tidy: Tidy; asked: string[]; revert(step: UndoStep, direction?: 'undo' | 'redo'): Reverted; person(...commands: WorkspaceCommand[]): Promise<UndoStep | undefined>; agent(...commands: WorkspaceCommand[]): Promise<void>; preview(options?: typeof ALL, regroup?: TidyRegroup[]): Promise<string> };
async function fixture(run: (value: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-tidy-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), asked: string[] = [];
  const client: ActivitySummaryClient = { async complete(request) { const system = String(request.system); asked.push(system); return system.includes('Group the items') ? '{"moves":[]}' : 'Checkout total fix'; } };
  const plots = new Plots(store, control, { client }), tidy = new Tidy(store, control, plots, () => client, () => NOW), undo = new MapUndo(store, control, plots, () => NOW);
  const revert = (step: UndoStep, direction: 'undo' | 'redo' = 'undo') => undo.run({ direction, step }) as Reverted;
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
    await run({ store, control, plots, tidy, asked, revert, person, agent, preview });
  } finally { await plots.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
const positions = (state: { nodes: { id: string; position: unknown }[] }) => Object.fromEntries(state.nodes.map(node => [node.id, node.position]));
const noteIn = (projectId: string, id: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: `Note ${id}`, data: { text: `Note ${id}` }, projectId, position: { x, y } });
const aiOn = (store: SqliteStore, requestsPerHour = 12) => store.writeSettings({ expectedRevision: store.readSettings().revision, value: { ...store.readSettings().value, summaries: { ...store.readSettings().value.summaries, enabled: true, requestsPerHour } } });

const apply = (fingerprint: string, options = ALL) => ({ operation: 'apply', fingerprint, options, archives: [], renames: [], regroup: [] });
type Applied = { revision: number; receipt?: Omit<UndoStep, 'label'> };

test('apply ignores status changes, refuses an in-scope move, and undoes as one step', () => fixture(async ({ revert, control, plots, tidy, store, agent, preview }) => {
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
  const undone = revert({ label: 'Tidy', ...result.receipt! });
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

test('undo leaves a plot Tidy created alone once it was locked', () => fixture(async ({ revert, control, plots, tidy, preview }) => {
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, regroup: true }, regroup = ['a1', 'a2', 'a3'].map(itemId => ({ itemId, newPlot: 'Fresh' }));
  const result = await tidy.run({ ...apply(await preview(options, regroup), options), regroup }) as Applied & { created: string[] };
  await plots.run('acme', { operation: 'lock', plotId: result.created[0], locked: true });
  const undone = revert({ label: 'Tidy', ...result.receipt! });
  assert.deepEqual([undone.reverted, undone.skipped], [0, 1]);
  assert.ok(plots.observe(await control.read()).list.some(plot => plot.id === result.created[0] && plot.locked));
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

test('undoing a regroup brings back a named singleton plot the regroup emptied, with its id, name and pin', () => fixture(async ({ revert, control, plots, tidy, store, preview }) => {
  store.createPinnedPlot('P', 'acme', ['loose'], NOW); store.renamePlot('P', 'Mine', false); plots.invalidate();
  const target = plots.observe(await control.read()).list.find(plot => plot.memberIds.includes('a1'))!;
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, regroup: true }, regroup = [{ itemId: 'loose', plotId: target.id }];
  const result = await tidy.run({ ...apply(await preview(options, regroup), options), regroup }) as Applied;
  assert.equal(plots.observe(await control.read()).list.some(plot => plot.id === 'P'), false, 'the regroup emptied P');
  revert({ label: 'Tidy', ...result.receipt! });
  const back = plots.observe(await control.read()).list.find(plot => plot.id === 'P');
  assert.deepEqual([back?.name, back?.source, back?.memberIds], ['Mine', 'user', ['loose']]);
  assert.deepEqual(store.plotRecords().find(record => record.id === 'P')!.pinnedMemberIds, ['loose']);
}));

test('undoing a regroup out of a pinned plot pins the item there again', () => fixture(async ({ revert, control, plots, tidy, store, preview }) => {
  const list = plots.observe(await control.read()).list, from = list.find(plot => plot.memberIds.includes('a1'))!, to = list.find(plot => plot.memberIds.includes('b1'))!;
  store.pinPlotMembers(from.id, ['a1', 'a2', 'a3']); plots.invalidate();
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, regroup: true }, regroup = [{ itemId: 'a1', plotId: to.id }];
  const result = await tidy.run({ ...apply(await preview(options, regroup), options), regroup }) as Applied;
  revert({ label: 'Tidy', ...result.receipt! });
  assert.deepEqual(store.plotRecords().find(record => record.id === from.id)!.pinnedMemberIds, ['a1', 'a2', 'a3']);
}));

test('undoing a regroup keeps the pin of a member archived before it', () => fixture(async ({ revert, control, plots, tidy, store, person, preview }) => {
  const list = plots.observe(await control.read()).list, from = list.find(plot => plot.memberIds.includes('a1'))!, to = list.find(plot => plot.memberIds.includes('b1'))!;
  store.pinPlotMembers(from.id, ['a1', 'a2', 'a3']); plots.invalidate();
  await person({ type: 'node.archive', id: 'a2' });
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, regroup: true }, regroup = [{ itemId: 'a1', plotId: to.id }];
  const result = await tidy.run({ ...apply(await preview(options, regroup), options), regroup }) as Applied;
  revert({ label: 'Tidy', ...result.receipt! });
  assert.deepEqual(store.plotRecords().find(record => record.id === from.id)!.pinnedMemberIds, ['a1', 'a2', 'a3']);
}));

test('two projects can each regroup into a new plot of the same name', () => fixture(async ({ tidy, person, preview }) => {
  await person({ type: 'project.create', id: 'beta', title: 'Beta', summary: '', position: { x: 0, y: 8000 } });
  await person(noteIn('beta', 'c1', 0, 8000), noteIn('beta', 'c2', 0, 8000));
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, regroup: true }, regroup = [{ itemId: 'a1', newPlot: 'Fresh' }, { itemId: 'c1', newPlot: 'Fresh' }];
  const result = await tidy.run({ ...apply(await preview(options, regroup), options), regroup }) as { created: string[] };
  assert.equal(result.created.length, 2);
}));

test('a project an agent created is offered for rename and stays a machine name once renamed; a person\'s project never is', () => fixture(async ({ control, tidy, person, agent, store, asked, preview }) => {
  aiOn(store);
  await agent({ type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 8000 } });
  await person(noteIn('billing', 'c1', 0, 8000));
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, rename: true }, projectAsks = () => asked.filter(system => system.includes('Name the project')).length;
  const suggested = await tidy.run({ operation: 'suggest', options }) as { renames: { kind: 'project'; id: string; to: string }[] };
  const rows = suggested.renames.filter(row => row.kind === 'project').map(({ kind, id, to }) => ({ kind, id, to }));
  assert.deepEqual(rows, [{ kind: 'project', id: 'billing', to: 'Checkout total fix' }]);
  assert.equal(projectAsks(), 1, 'never asked for Acme');
  await tidy.run({ ...apply(await preview(options), options), renames: rows });
  const billing = (await control.read()).nodes.find(node => node.id === 'billing')!;
  assert.deepEqual([billing.title, billing.generatedTitle, billing.titleChosen], ['Checkout total fix', 'Checkout total fix', undefined]);
  await tidy.run({ operation: 'suggest', options });
  assert.equal(projectAsks(), 2, 'a later Tidy may rename it again');
}));

test('undo of a Tidy rename puts back the machine names it replaced, and redo renames again', () => fixture(async ({ control, tidy, agent, store, revert, preview }) => {
  aiOn(store);
  await agent({ type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 8000 } });
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, rename: true }, rows = [{ kind: 'project' as const, id: 'billing', to: 'Checkout total fix' }];
  const result = await tidy.run({ ...apply(await preview(options), options), renames: rows }) as Applied;
  const billing = async () => { const node = (await control.read()).nodes.find(node => node.id === 'billing')!; return [node.title, node.generatedTitle, node.titleChosen]; };
  const undone = revert({ label: 'Tidy', ...result.receipt! });
  assert.deepEqual([await billing(), undone.skipped], [['Billing', 'Billing', undefined], 0]);
  revert(undone.applied!, 'redo');
  assert.deepEqual(await billing(), ['Checkout total fix', 'Checkout total fix', undefined]);
}));

test('undo leaves a name the person typed after Tidy renamed it', () => fixture(async ({ control, tidy, person, agent, store, revert, preview }) => {
  aiOn(store);
  await agent({ type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 8000 } });
  const options = { ...ALL, lineUp: false, spacePlots: false, colors: false, rename: true };
  const result = await tidy.run({ ...apply(await preview(options), options), renames: [{ kind: 'project', id: 'billing', to: 'Checkout total fix' }] }) as Applied;
  await person({ type: 'node.update', id: 'billing', title: 'Payments' });
  const undone = revert({ label: 'Tidy', ...result.receipt! });
  assert.deepEqual([(await control.read()).nodes.find(node => node.id === 'billing')!.title, undone.skipped], ['Payments', 1]);
}));

test('one suggest makes at most 12 AI requests across the board and says it stopped', () => fixture(async ({ tidy, person, store, asked }) => {
  aiOn(store, 120);
  for (let i = 0; i < 6; i++) {
    const y = 8000 + i * 3000;
    await person({ type: 'project.create', id: `p${i}`, title: `Project ${i}`, summary: '', position: { x: 0, y } });
    await person(...['a', 'b', 'c'].map(id => noteIn(`p${i}`, `p${i}${id}`, 0, y)), ...['d', 'e', 'f'].map(id => noteIn(`p${i}`, `p${i}${id}`, 3000, y)));
  }
  const result = await tidy.run({ operation: 'suggest', options: { ...ALL, rename: true, regroup: true } }) as { limited?: boolean };
  assert.equal(asked.length, 12);
  assert.equal(result.limited, true);
}));

