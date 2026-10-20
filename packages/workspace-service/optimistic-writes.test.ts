import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceState } from '../core/control.ts';
import { enableShowShip, githubFixture, pullFixture } from '../../tests/fixtures/github.ts';
import type { ResourceSnapshot } from '../../src/resource-plugins/types.ts';

const signal = () => AbortSignal.timeout(10_000);
const SOURCE = 'action:github.pull-request';
async function fixture(run: (input: { store: SqliteStore; control: WorkspaceControl; providers: ReturnType<typeof githubFixture>; coordinator: ResourceCoordinator; changes: () => number; restart(): void; advance(ms: number): void }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-optimistic-')), file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store), now = Date.now(), changed = 0;
  const providers = githubFixture(), make = () => new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => { changed++; }, () => now);
  let coordinator = make();
  await control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await coordinator.read('pr', true);
  const input = { get store() { return store; }, get control() { return control; }, providers, get coordinator() { return coordinator; }, changes: () => changed,
    restart() { store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store); coordinator = make(); }, advance(ms: number) { now += ms; } };
  try { await run(input); } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };
const merge = (value = 'SQUASH') => ({ value, pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), sourceResourceId: 'pr-resource', requestId: randomUUID() });
const node = (state: WorkspaceState) => state.nodes.find(candidate => candidate.id === 'pr')!;
const shown = async (coordinator: ResourceCoordinator, control: WorkspaceControl) => node(coordinator.overlay(await control.read()));
const cue = (indicators: { id: string; label: string }[] | undefined, id = 'review-state') => indicators?.find(indicator => indicator.id === id)?.label;

test('a merge shows Merged everywhere at once, keeps it through background polls and drops the mark once a read confirms it', () => fixture(async ({ control, providers, coordinator, changes }) => {
  const held = gate(); providers.holdWrites(() => held.opened);
  const before = changes();
  const result = await coordinator.execute('pr', 'pr.merge', merge(), signal()) as { snapshot: ResourceSnapshot; pending: string };
  assert.equal(result.pending, 'Merged · confirming');
  assert.equal(result.snapshot.pending, 'Merged · confirming'); assert.equal(result.snapshot.detail?.status, 'merged');
  assert.ok(changes() > before, 'the map hears about the expected result at once');
  assert.equal(providers.merges.length, 0, 'the write has not reached GitHub yet');
  const card = await shown(coordinator, control);
  assert.equal(card.summary, 'Merged · 1 comment');
  assert.equal(cue(card.indicators), 'Merged'); assert.equal(cue(card.indicators, 'pending'), 'Confirming');
  assert.equal(node(await control.read()).summary, 'Open · 1 comment', 'only what the service shows changes; the saved graph waits for GitHub');
  for (const read of [await coordinator.read('pr', true), (await coordinator.cached('pr'))!]) { assert.equal(read.pending, 'Merged · confirming'); assert.equal(read.detail?.status, 'merged'); }
  const requests = providers.requests;
  await coordinator.poll();
  assert.equal(providers.requests, requests, 'a background poll does not read GitHub before the write lands');
  assert.equal(cue((await shown(coordinator, control)).indicators), 'Merged');
  held.open(); await coordinator.writing();
  assert.equal(providers.merges.length, 1);
  const settled = await shown(coordinator, control);
  assert.equal(settled.summary, 'Merged · 1 comment'); assert.equal(cue(settled.indicators, 'pending'), undefined);
  assert.equal(node(await control.read()).summary, 'Merged · 1 comment');
  const read = await coordinator.read('pr');
  assert.equal(read.pending, undefined); assert.equal(read.reverted, undefined);
  assert.equal(node(await control.read()).attentionSources?.[SOURCE] ?? null, null);
}));

test('a merge GitHub declines goes back to the read state and tells the person why', () => fixture(async ({ control, providers, coordinator }) => {
  providers.mergeSettings = { ...providers.mergeSettings, status: 'DIRTY' };
  const held = gate(); providers.holdWrites(() => held.opened);
  const request = merge();
  await coordinator.execute('pr', 'pr.merge', request, signal());
  assert.equal(cue((await shown(coordinator, control)).indicators), 'Merged');
  held.open(); await coordinator.writing();
  const card = await shown(coordinator, control);
  assert.equal(card.summary, 'Open · 1 comment'); assert.equal(cue(card.indicators), 'Open'); assert.equal(cue(card.indicators, 'pending'), undefined);
  const saved = node(await control.read());
  assert.equal(saved.attentionSources?.[SOURCE], 'error'); assert.equal(saved.attentionNotes?.[SOURCE], 'Merge of #42 didn’t go through');
  assert.equal(saved.attentionEvents?.[SOURCE], request.requestId);
  const read = await coordinator.read('pr');
  assert.equal(read.pending, undefined); assert.equal(read.detail?.status, 'open');
  assert.deepEqual(read.reverted, { requestId: request.requestId, message: 'Merge of #42 didn’t go through: GitHub declined the merge: Pull Request is not mergeable' });
  assert.equal(providers.merges.length, 1, 'never retried');
}));

test('an unconfirmed merge stays pending until a read shows it merged', () => fixture(async ({ control, providers, coordinator }) => {
  providers.replyToMerge(() => { providers.pull = { ...providers.pull, state: 'closed', merged: true }; return { status: 502, headers: new Headers(), body: {} }; });
  providers.fail(500);
  await coordinator.execute('pr', 'pr.merge', merge(), signal());
  await coordinator.writing();
  assert.equal(cue((await shown(coordinator, control)).indicators, 'pending'), 'Confirming', 'an outcome-unknown write keeps its mark');
  providers.fail(200);
  await coordinator.read('pr', true);
  const card = await shown(coordinator, control);
  assert.equal(cue(card.indicators), 'Merged'); assert.equal(cue(card.indicators, 'pending'), undefined);
  assert.equal(node(await control.read()).attentionSources?.[SOURCE] ?? null, null, 'a confirmed change raises nothing');
  assert.equal(providers.merges.length, 1);
}));

test('an unconfirmed merge a later read contradicts goes back and tells the person', () => fixture(async ({ control, providers, coordinator }) => {
  providers.replyToMerge(() => ({ status: 502, headers: new Headers(), body: {} }));
  await coordinator.execute('pr', 'pr.merge', merge(), signal());
  await coordinator.writing();
  assert.equal(cue((await shown(coordinator, control)).indicators, 'pending'), 'Confirming');
  const read = await coordinator.read('pr', true);
  assert.equal(read.detail?.status, 'open'); assert.equal(read.pending, undefined);
  assert.equal(read.reverted?.message, 'Merge of #42 didn’t go through: the next read from GitHub doesn’t show it.');
  const card = await shown(coordinator, control);
  assert.equal(cue(card.indicators), 'Open'); assert.equal(card.attentionSources?.[SOURCE], 'error');
}));

test('a second change waits for the first to settle instead of racing it', () => fixture(async ({ providers, coordinator, store }) => {
  enableShowShip(store);
  const held = gate(); providers.holdWrites(() => held.opened);
  await coordinator.execute('pr', 'pr.merge', merge(), signal());
  await assert.rejects(coordinator.execute('pr', 'pr.showShip', { value: 'ship', expectedTitle: pullFixture.title, sourceResourceId: 'pr-resource', requestId: randomUUID() }, signal()), /still being confirmed/);
  held.open(); await coordinator.writing();
  assert.deepEqual(providers.titles, []);
}));

test('Show/Ship and close show their result at once and revert when GitHub refuses', () => fixture(async ({ control, providers, coordinator, store }) => {
  enableShowShip(store);
  const held = gate(); providers.holdWrites(() => held.opened);
  await coordinator.execute('pr', 'pr.showShip', { value: 'ship', expectedTitle: pullFixture.title, sourceResourceId: 'pr-resource', requestId: randomUUID() }, signal());
  assert.equal((await shown(coordinator, control)).title, `[ship] ${pullFixture.title}`);
  assert.equal((await coordinator.read('pr')).pending, 'Tagged [ship] · confirming');
  held.open(); await coordinator.writing();
  assert.equal((await shown(coordinator, control)).title, `[ship] ${pullFixture.title}`);
  assert.equal(node(await control.read()).title, `[ship] ${pullFixture.title}`);

  const again = gate(); providers.holdWrites(() => again.opened);
  providers.replyToState(() => ({ status: 422, headers: new Headers(), body: { message: 'Validation Failed' } }));
  await coordinator.execute('pr', 'pr.state', { value: 'close', pullRequestId: 'PR_kwDOfixture42', expectedState: 'open', sourceResourceId: 'pr-resource', requestId: randomUUID() }, signal());
  assert.equal(cue((await shown(coordinator, control)).indicators), 'Closed');
  again.open(); await coordinator.writing();
  assert.equal(cue((await shown(coordinator, control)).indicators), 'Open');
  assert.equal(node(await control.read()).attentionNotes?.[SOURCE], 'Closing #42 didn’t go through');
  assert.match((await coordinator.read('pr')).reverted?.message ?? '', /^Closing #42 didn’t go through: GitHub declined/);
}));

test('a pending change survives a restart marked as unconfirmed, and the first read settles it', () => fixture(async input => {
  const held = gate(); input.providers.holdWrites(() => held.opened);
  await input.coordinator.execute('pr', 'pr.merge', merge(), signal());
  const closing = input.coordinator.close();
  held.open(); await closing;
  input.restart();
  const card = await shown(input.coordinator, input.control);
  assert.equal(cue(card.indicators), 'Merged'); assert.equal(cue(card.indicators, 'pending'), 'Confirming', 'never a bare Merged without a confirming read');
  assert.equal((await input.coordinator.read('pr')).pending, 'Merged · confirming');
  await input.coordinator.poll();
  const settled = await shown(input.coordinator, input.control);
  assert.equal(cue(settled.indicators, 'pending'), undefined);
  assert.equal(cue(settled.indicators), input.providers.merges.length ? 'Merged' : 'Open');
  assert.equal(input.providers.merges.length <= 1, true, 'the write is never sent again after a restart');
}));

test('an unconfirmed change no read can settle expires back to the read state with a notice', () => fixture(async ({ control, providers, coordinator, advance }) => {
  providers.replyToMerge(() => ({ status: 502, headers: new Headers(), body: {} }));
  providers.fail(500);
  await coordinator.execute('pr', 'pr.merge', merge(), signal());
  await coordinator.writing();
  advance(31 * 60_000);
  await coordinator.poll();
  const card = await shown(coordinator, control);
  assert.equal(cue(card.indicators), 'Open'); assert.equal(cue(card.indicators, 'pending'), undefined);
  assert.equal(card.attentionNotes?.[SOURCE], 'Merge of #42 couldn’t be confirmed');
}));
