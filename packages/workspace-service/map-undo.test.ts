import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_ACTOR, WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { UNDO_ANCHOR_CAP, UNDO_PAIR_CAP, plotSnap } from '../core/map-undo.ts';
import type { UndoStep } from '../core/map-undo.ts';
import { SqliteStore } from './sqlite-store.ts';
import { Plots } from './plots.ts';
import { MapUndo } from './map-undo.ts';
import { layoutFootprints } from '../../src/graph/movement.ts';

const NOW = Date.parse('2026-01-15T12:00:00Z'), AGENT = { kind: 'agent', id: 'agent' } as never;
type Reverted = { applied?: UndoStep; reverted: number; skipped: number };
type Fixture = { store: SqliteStore; control: WorkspaceControl; plots: Plots; revert(step: UndoStep, direction?: 'undo' | 'redo'): Reverted; person(...commands: WorkspaceCommand[]): Promise<UndoStep | undefined>; agent(...commands: WorkspaceCommand[]): Promise<void> };
async function fixture(run: (value: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-undo-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const plots = new Plots(store, control), undo = new MapUndo(store, control, plots, () => NOW);
  const revert = (step: UndoStep, direction: 'undo' | 'redo' = 'undo') => undo.run({ direction, step }) as Reverted;
  const send = async (actor: { kind: 'user'; id: string }, commands: WorkspaceCommand[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor, commands });
  const person = async (...commands: WorkspaceCommand[]) => { const { receipt } = await send({ kind: 'user', id: PERSON_ACTOR }, commands); return receipt && { label: 'Edit', ...receipt }; };
  const agent = async (...commands: WorkspaceCommand[]) => { await send(AGENT, commands); };
  try {
    await person({ type: 'project.create', id: 'acme', title: 'Acme', summary: '', position: { x: 0, y: 0 } });
    await person(noteIn('acme', 'a1', 0, 0), noteIn('acme', 'a2', 0, 0), noteIn('acme', 'a3', 0, 0));
    await person(noteIn('acme', 'b1', 3000, 0), noteIn('acme', 'b2', 3000, 0), noteIn('acme', 'b3', 3000, 0), noteIn('acme', 'loose', 1500, 2000));
    await run({ store, control, plots, revert, person, agent });
  } finally { await plots.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
const positions = (state: { nodes: { id: string; position: unknown }[] }) => Object.fromEntries(state.nodes.map(node => [node.id, node.position]));
const noteIn = (projectId: string, id: string, x: number, y: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: `Note ${id}`, data: { text: `Note ${id}` }, projectId, position: { x, y } });
/** Sets positions directly, the way an older layout or another client left them, without collision handling. */
const setPositions = (store: SqliteStore, at: Record<string, { x: number; y: number }>) => store.atomic((state, commit) => commit({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: AGENT, commands: [] },
  current => ({ ...current, revision: current.revision + 1, nodes: current.nodes.map(node => at[node.id] ? { ...node, position: at[node.id] } : node) })));
type Pinned = { receipt?: Omit<UndoStep, 'label'> };

test('undo checks the latest map and leaves a neighbour an agent moved since', () => fixture(async ({ control, revert, person, agent }) => {
  const before = await control.read(), a1 = before.nodes.find(node => node.id === 'a1')!;
  const step = (await person({ type: 'node.move', id: 'loose', position: a1.position }))!;
  const pushed = step.items.find(item => item.id !== 'loose')!;
  await agent({ type: 'node.move', id: pushed.id, position: { x: 5000, y: 5000 } });
  const undone = revert(step);
  const after = await control.read();
  assert.deepEqual(after.nodes.find(node => node.id === pushed.id)!.position, { x: 5000, y: 5000 });
  assert.deepEqual(after.nodes.find(node => node.id === 'loose')!.position, before.nodes.find(node => node.id === 'loose')!.position);
  assert.equal(undone.skipped, 1);
}));

test('undoing pins never takes an item from a plot outside the step', () => fixture(async ({ control, plots, revert, store }) => {
  store.createPinnedPlot('P', 'acme', ['b1', 'b2'], NOW); store.createPinnedPlot('Q', 'acme', ['a1'], NOW); plots.invalidate();
  const after = plotSnap(plots.observe(await control.read()).list.find(plot => plot.id === 'P')!), step = { label: 'Move', items: [], links: [], plots: [{ id: 'P', before: { ...after, pinnedMemberIds: ['b1', 'b2'] }, after: { ...after, pinnedMemberIds: ['b2'] } }] };
  store.pinPlotMembers('P', ['b2']); store.unpinPlotMembers(['b1']); store.pinPlotMembers('Q', ['a1', 'b1']); plots.invalidate();
  const undone = revert(step);
  const pins = Object.fromEntries(store.plotRecords().map(record => [record.id, record.pinnedMemberIds]));
  assert.deepEqual([pins.P, pins.Q, undone.skipped], [['b2'], ['a1', 'b1'], 1]);
}));

test('undo of a plot rename puts back the name the service replaced, not the one this window saw', () => fixture(async ({ control, plots, revert }) => {
  const plot = plots.observe(await control.read()).list[0];
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Old' });
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Other' });
  const renamed = await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'This' }) as Pinned;
  revert({ label: 'Plot rename', ...renamed.receipt! });
  assert.equal(plots.observe(await control.read()).list[0].name, 'Other');
}));

test('undoing a pin brings back a named singleton plot it emptied, with its id, name and pin', () => fixture(async ({ control, plots, revert, store }) => {
  store.createPinnedPlot('P', 'acme', ['loose'], NOW); store.renamePlot('P', 'Mine', false); plots.invalidate();
  const target = plots.observe(await control.read()).list.find(plot => plot.memberIds.includes('a1'))!;
  const pinned = await plots.run('acme', { operation: 'pin', plotId: target.id, memberIds: ['loose'] }) as Pinned;
  assert.equal(plots.observe(await control.read()).list.some(plot => plot.id === 'P'), false, 'the pin emptied P');
  revert({ label: 'Move', ...pinned.receipt! });
  const back = plots.observe(await control.read()).list.find(plot => plot.id === 'P');
  assert.deepEqual([back?.name, back?.source, back?.memberIds], ['Mine', 'user', ['loose']]);
  assert.deepEqual(store.plotRecords().find(record => record.id === 'P')!.pinnedMemberIds, ['loose']);
}));

test('undoing a pin out of a pinned plot keeps the pin of a member archived before it', () => fixture(async ({ control, plots, revert, store, person }) => {
  const list = plots.observe(await control.read()).list, from = list.find(plot => plot.memberIds.includes('a1'))!, to = list.find(plot => plot.memberIds.includes('b1'))!;
  store.pinPlotMembers(from.id, ['a1', 'a2', 'a3']); plots.invalidate();
  await person({ type: 'node.archive', id: 'a2' });
  const pinned = await plots.run('acme', { operation: 'pin', plotId: to.id, memberIds: ['a1'] }) as Pinned;
  revert({ label: 'Move', ...pinned.receipt! });
  assert.deepEqual(store.plotRecords().find(record => record.id === from.id)!.pinnedMemberIds, ['a1', 'a2', 'a3']);
}));

test('undoing pins into a locked plot keeps it locked and relocks the locked plot they emptied, so redo still applies', () => fixture(async ({ control, plots, revert, store }) => {
  const list = plots.observe(await control.read()).list, from = list.find(plot => plot.memberIds.includes('a1'))!.id, to = list.find(plot => plot.memberIds.includes('b1'))!.id;
  await plots.run('acme', { operation: 'lock', plotId: from, locked: true }); await plots.run('acme', { operation: 'lock', plotId: to, locked: true });
  const record = (id: string) => { const found = store.plotRecords().find(entry => entry.id === id)!; return { pins: found.pinnedMemberIds, locked: found.locked, lockPins: found.lockPinnedIds }; };
  const locked = { [from]: record(from), [to]: record(to) };
  const pinned = await plots.run('acme', { operation: 'pin', plotId: to, memberIds: ['a1', 'a2', 'a3'] }) as Pinned;
  assert.equal(record(from).locked, false, 'emptying a plot unlocks it');
  const undone = revert({ label: 'Move', ...pinned.receipt! });
  assert.deepEqual([record(from), record(to), undone.skipped], [locked[from], locked[to], 0]);
  const redone = revert(undone.applied!, 'redo');
  assert.deepEqual([record(to).pins, record(to).locked, redone.skipped], [['a1', 'a2', 'a3', 'b1', 'b2', 'b3'], true, 0]);
}));

test('undoing a plot moved to another project with its items brings the plot back too, keeping its name', () => fixture(async ({ control, plots, revert, store, person }) => {
  await person({ type: 'project.create', id: 'beta', title: 'Beta', summary: '', position: { x: 9000, y: 9000 } });
  const plot = plots.observe(await control.read()).list.find(entry => entry.memberIds.includes('a1'))!;
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Mine' });
  const moved = (await person({ type: 'nodes.send', ids: plot.memberIds, projectId: 'beta' }))!;
  const followed = await plots.run('acme', { operation: 'move', plotId: plot.id, projectId: 'beta' }) as Pinned;
  assert.ok(followed.receipt, 'moving a plot returns a receipt');
  revert({ ...moved, plots: [...moved.plots, ...followed.receipt.plots] });
  const back = plots.observe(await control.read()).list.find(entry => entry.id === plot.id);
  assert.deepEqual([store.plotRecords().find(entry => entry.id === plot.id)!.projectId, back?.projectId, back?.name], ['acme', 'acme', 'Mine']);
}));

test('undo leaves a moved plot where its items stay when the project they came from is archived since', () => fixture(async ({ control, plots, revert, store, person, agent }) => {
  await person({ type: 'project.create', id: 'beta', title: 'Beta', summary: '', position: { x: 9000, y: 9000 } });
  const plot = plots.observe(await control.read()).list.find(entry => entry.memberIds.includes('a1'))!;
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Mine' }); store.pinPlotMembers(plot.id, plot.memberIds); plots.invalidate();
  const moved = (await person({ type: 'nodes.send', ids: plot.memberIds, projectId: 'beta' }))!;
  const followed = await plots.run('acme', { operation: 'move', plotId: plot.id, projectId: 'beta' }) as Pinned;
  await agent({ type: 'node.archive', id: 'acme' });
  const undone = revert({ ...moved, plots: [...moved.plots, ...followed.receipt!.plots] });
  const kept = plots.observe(await control.read()).list.find(entry => entry.id === plot.id);
  assert.deepEqual([store.plotRecords().find(entry => entry.id === plot.id)!.projectId, kept?.name, kept?.memberIds, undone.reverted], ['beta', 'Mine', ['a1', 'a2', 'a3'], 0]);
}));

test('a locked plot moved without a pinned member archived before keeps that pin and redoes to the new project', () => fixture(async ({ control, plots, revert, store, person }) => {
  await person({ type: 'project.create', id: 'beta', title: 'Beta', summary: '', position: { x: 9000, y: 9000 } });
  const plot = plots.observe(await control.read()).list.find(entry => entry.memberIds.includes('a1'))!;
  await plots.run('acme', { operation: 'rename', plotId: plot.id, name: 'Mine' }); await plots.run('acme', { operation: 'lock', plotId: plot.id, locked: true });
  await person({ type: 'node.archive', id: 'a2' });
  const moved = (await person({ type: 'nodes.send', ids: ['a1', 'a3'], projectId: 'beta' }))!;
  const followed = await plots.run('acme', { operation: 'move', plotId: plot.id, projectId: 'beta' }) as Pinned;
  const record = () => { const found = store.plotRecords().find(entry => entry.id === plot.id)!; return [found.projectId, found.name, found.locked, found.pinnedMemberIds]; }, after = record();
  const undone = revert({ ...moved, plots: [...moved.plots, ...followed.receipt!.plots] });
  assert.deepEqual([record()[0], undone.skipped], ['acme', 0]);
  const redone = revert(undone.applied!, 'redo');
  assert.deepEqual([record(), redone.skipped], [after, 0]);
}));

test('a partial undo between locked plots leaves a redo that still applies', () => fixture(async ({ control, plots, revert, store, person, agent }) => {
  const list = plots.observe(await control.read()).list, from = list.find(plot => plot.memberIds.includes('a1'))!.id, to = list.find(plot => plot.memberIds.includes('b1'))!.id;
  await plots.run('acme', { operation: 'lock', plotId: from, locked: true }); await plots.run('acme', { operation: 'lock', plotId: to, locked: true });
  const b1 = (await control.read()).nodes.find(node => node.id === 'b1')!.position;
  const moved = (await person({ type: 'node.move', id: 'a1', position: { x: b1.x, y: b1.y + 400 } }))!;
  const pinned = await plots.run('acme', { operation: 'pin', plotId: to, memberIds: ['a1'] }) as Pinned;
  await agent({ type: 'node.move', id: 'a1', position: { x: 5000, y: 5000 } });
  const undone = revert({ ...moved, plots: [...moved.plots, ...pinned.receipt!.plots] });
  assert.deepEqual(store.plotRecords().find(record => record.id === from)!.lockPinnedIds, ['a2', 'a3']);
  const redone = revert(undone.applied!, 'redo');
  assert.deepEqual([redone.skipped, store.plotRecords().find(record => record.id === to)!.pinnedMemberIds], [0, ['a1', 'b1', 'b2', 'b3']]);
}));

test('undoing a resize of an item on the default preset puts it back on the default, not on a fixed preset', () => fixture(async ({ control, revert, person }) => {
  const step = (await person({ type: 'node.resize', id: 'loose', size: 'large' }))!;
  revert(step);
  assert.equal((await control.read()).nodes.find(node => node.id === 'loose')!.mapSize, undefined);
}));

test('Clear overlaps undoes to the exact overlap and redoes, but not once the item it overlapped moved', () => fixture(async ({ control, store, revert, person, agent }) => {
  await person(noteIn('acme', 'o1', 6000, 0), noteIn('acme', 'o2', 6600, 0));
  const o1 = (await control.read()).nodes.find(node => node.id === 'o1')!.position;
  setPositions(store, { o2: { x: o1.x + 30, y: o1.y + 10 } });
  const overlapped = positions(await control.read()), step = (await person({ type: 'layout.repair' }))!, cleared = positions(await control.read());
  assert.equal(step.items.length, 1, 'repair moved one of the two');
  const moved = step.items[0].id, anchor = moved === 'o1' ? 'o2' : 'o1';
  const undone = revert(step);
  assert.deepEqual([positions(await control.read()), undone.skipped], [overlapped, 0]);
  const redone = revert(undone.applied!, 'redo');
  assert.deepEqual([positions(await control.read()), redone.skipped], [cleared, 0]);
  const at = cleared[anchor] as { x: number; y: number }, away = Math.sign(at.x - (cleared[moved] as { x: number }).x) || 1;
  await agent({ type: 'node.move', id: anchor, position: { x: at.x + 10 * away, y: at.y } });
  const again = revert(redone.applied!);
  assert.deepEqual([again.skipped, (await control.read()).nodes.find(node => node.id === moved)!.position], [1, cleared[moved]]);
}));

test('Clear overlaps on a pile of three undoes to the exact pile and redoes', () => fixture(async ({ control, store, revert, person }) => {
  await person(noteIn('acme', 'o1', 6000, 0), noteIn('acme', 'o2', 6600, 0), noteIn('acme', 'o3', 7200, 0));
  setPositions(store, { o1: { x: 6000, y: 0 }, o2: { x: 6020, y: 10 }, o3: { x: 6040, y: 20 } });
  const pile = positions(await control.read()), step = (await person({ type: 'layout.repair' }))!, cleared = positions(await control.read());
  assert.ok(step.items.length >= 2, 'repair moved at least two of the pile');
  const undone = revert(step);
  assert.deepEqual([positions(await control.read()), undone.skipped], [pile, 0]);
  const redone = revert(undone.applied!, 'redo');
  assert.deepEqual([positions(await control.read()), redone.skipped], [cleared, 0]);
}));

test('Clear overlaps on two empty projects undoes to the exact overlap and redoes', () => fixture(async ({ control, store, revert, person }) => {
  await person({ type: 'project.create', id: 'e1', title: 'Empty one', summary: '', position: { x: 6000, y: 4000 } }, { type: 'project.create', id: 'e2', title: 'Empty two', summary: '', position: { x: 7000, y: 4000 } });
  setPositions(store, { e2: { x: 6030, y: 4010 } });
  const pile = positions(await control.read()), step = (await person({ type: 'layout.repair' }))!, cleared = positions(await control.read());
  assert.notDeepEqual(cleared, pile, 'repair separated the two projects');
  const undone = revert(step);
  assert.deepEqual([positions(await control.read()), undone.skipped], [pile, 0]);
  const redone = revert(undone.applied!, 'redo');
  assert.deepEqual([positions(await control.read()), redone.skipped], [cleared, 0]);
}));

test('undo puts an item back onto what it overlapped only while every one of those is still in place', () => fixture(async ({ control, store, revert, person, agent }) => {
  await person(noteIn('acme', 'p', 6000, 0), noteIn('acme', 'q', 7000, 0), noteIn('acme', 'x', 8000, 0));
  const state = await control.read(), width = layoutFootprints(state.nodes, state.resources, control.registry).find(box => box.id === 'p')!.width;
  setPositions(store, { p: { x: 6000, y: 0 }, q: { x: 6000 + width + 100, y: 0 }, x: { x: 6000 + (width + 100) / 2, y: 0 } });
  const straddled = positions(await control.read()), step = (await person({ type: 'node.move', id: 'x', position: { x: 6000, y: 3000 } }))!;
  assert.deepEqual(step.anchors?.map(anchor => anchor.id).sort(), ['p', 'q']);
  const undone = revert(step);
  assert.deepEqual([positions(await control.read()), undone.skipped], [straddled, 0]);
  const redone = revert(undone.applied!, 'redo');
  await agent({ type: 'node.move', id: 'p', position: { x: 6000, y: 6000 } });
  const again = revert(redone.applied!);
  assert.deepEqual([again.skipped, (await control.read()).nodes.find(node => node.id === 'x')!.position], [1, { x: 6000, y: 3000 }]);
}));

test('a step over the anchor caps records none for the items past them, so its receipt still passes the undo schema', () => fixture(async ({ store, revert, person }) => {
  for (let batch = 0; batch < 6; batch++) await person(...Array.from({ length: 100 }, (_, i) => noteIn('acme', `n${batch * 100 + i}`, 6000, 0)));
  await person(noteIn('acme', 'x', 6000, 0));
  setPositions(store, Object.fromEntries([...Array.from({ length: 600 }, (_, i) => `n${i}`), 'x'].map(id => [id, { x: 6000, y: 0 }])));
  const step = (await person({ type: 'node.move', id: 'x', position: { x: 6000, y: -8000 } }))!;
  assert.ok(step.pairs!.length <= UNDO_PAIR_CAP && step.anchors!.length <= UNDO_ANCHOR_CAP);
  const undone = revert(step);
  assert.ok(undone.skipped > 0, 'items whose overlaps were not recorded stay where they are');
}));
