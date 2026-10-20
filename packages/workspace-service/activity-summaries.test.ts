import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceControl } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { ActivitySummaries } from './activity-summaries.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';

async function fixture(run: (value: { directory: string; store: SqliteStore; control: WorkspaceControl }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-summaries-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    await control.apply({ type: 'item.create', id: 'shell', position: { x: 30, y: 40 }, resource: { id: 'resource', pluginId: 'terminal.session', schemaVersion: 1, title: 'Shell', data: { sessionId: 'session', workspaceId: 'workspace', cwd: directory, shell: '/bin/sh' } } }, 0);
    await control.apply({ type: 'node.update', id: 'shell', activity: 'working', attention: 'input', summary: 'Original factual label' }, 1);
    await run({ directory, store, control });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
const snapshot = (output: string, state: SessionSnapshot['session']['state'] = 'running'): SessionSnapshot => ({
  session: { id: 'session', requestId: 'request', nodeId: 'shell', workspaceId: 'workspace', cwd: '/tmp', state, cols: 80, rows: 24, createdAt: '', updatedAt: '' },
  chunks: [{ sequence: 1, data: output }], firstSequence: 1, lastSequence: 1, truncated: false,
});
function enable(store: SqliteStore) {
  const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, enabled: true } } });
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('summaries are opt-in, debounced, redacted, durable and do not rewrite session state or explicit labels', () => fixture(async ({ directory, store, control }) => {
  let now = 1_000_000, reads = 0, requests = 0, broadcasts = 0;
  const initial = await control.read();
  const client: ActivitySummaryClient = { async complete(request) {
    requests++; assert.equal(request.model, 'haiku'); assert.equal(request.max_tokens, 64);
    const input = JSON.parse(request.messages[0].content); assert.equal(input.status, 'waiting');
    assert.ok(input.recentOutput.includes('Running billing tests')); assert.ok(!input.recentOutput.includes('FAKE_SECRET'));
    return 'Checking billing regression tests';
  } };
  const make = () => new ActivitySummaries(store, control, async () => { reads++; return snapshot('Running billing tests\npassword=FAKE_SECRET'); }, async () => { broadcasts++; }, () => true, directory, client, () => now);
  let summaries = make();
  try {
    await summaries.tick(); assert.equal(reads, 0); assert.equal(requests, 0);
    enable(store); await summaries.tick(); now += 1999; await summaries.tick(); assert.equal(requests, 0);
    now++; await summaries.tick(); assert.equal(requests, 1); assert.equal(broadcasts, 1);
    const changed = await control.read();
    assert.deepEqual(changed.nodes[0], { ...initial.nodes[0], summary: 'Checking billing regression tests' });
    assert.deepEqual(changed.resources, initial.resources); assert.deepEqual(changed.links, initial.links);
    now += 100_000; await summaries.tick(); assert.equal(requests, 1);
    await summaries.close(); summaries = make(); await summaries.tick(); now += 2000; await summaries.tick(); assert.equal(requests, 1);
    await control.apply({ type: 'node.update', id: 'shell', summary: 'User supplied description' }, (await control.read()).revision);
    await summaries.tick(); assert.equal((await control.read()).nodes[0].summary, 'User supplied description'); assert.equal(requests, 1);
  } finally { await summaries.close(); }
}));

test('continuous output is bounded by debounce, item interval and the table allowance', () => fixture(async ({ directory, store, control }) => {
  enable(store);
  let now = 1_000_000, output = 'first', requests = 0;
  const summaries = new ActivitySummaries(store, control, async () => snapshot(output), async () => {}, () => true, directory, { async complete() { requests++; return 'Running billing regression tests'; } }, () => now);
  try {
    for (let i = 0; i < 5; i++) { output += ' next'; await summaries.tick(); now += 2000; }
    assert.equal(requests, 0);
    output += ' latest'; await summaries.tick(); assert.equal(requests, 1);
    for (let i = 0; i < 20; i++) { now += 2000; output += ' next'; await summaries.tick(); }
    assert.equal(requests, 1);
    now += 20_000; await summaries.tick(); assert.equal(requests, 2);
  } finally { await summaries.close(); }
}));

for (const change of ['status', 'manual', 'archive', 'disable', 'pause'] as const) test(`pending summary is single-flight and discarded after ${change}`, () => fixture(async ({ directory, store, control }) => {
  enable(store); let now = 1_000_000, requests = 0;
  const entered = deferred<AbortSignal>(), response = deferred<string>();
  const summaries = new ActivitySummaries(store, control, async () => snapshot('Testing billing'), async () => {}, () => true, directory, { async complete(_request, signal) { requests++; entered.resolve(signal); return response.promise; } }, () => now);
  try {
    await summaries.tick(); now += 2000; const pending = summaries.tick(), signal = await entered.promise;
    assert.equal(summaries.tick(), pending); assert.equal(requests, 1);
    const state = await control.read();
    if (change === 'status') await control.apply({ type: 'node.update', id: 'shell', activity: 'idle', attention: 'none', summary: 'Ready for next prompt' }, state.revision);
    if (change === 'manual') await control.apply({ type: 'node.update', id: 'shell', summary: 'Pinned manual description' }, state.revision);
    if (change === 'archive') await control.apply({ type: 'node.archive', id: 'shell' }, state.revision);
    if (change === 'disable') { const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, enabled: false } } }); summaries.settingsChanged(); }
    if (change === 'pause') await summaries.pause(); else summaries.observe(await control.read());
    assert.equal(signal.aborted, true);
    const before = await control.read(); response.resolve('Running outdated regression tests'); await pending;
    assert.deepEqual(await control.read(), before);
    assert.equal(store.summary('resource')?.text, undefined);
  } finally { await summaries.close(); }
}));

test('turning summaries off while reading a session starts no helper', () => fixture(async ({ directory, store, control }) => {
  enable(store); let now = 1_000_000, reads = 0, requests = 0;
  const entered = deferred<void>(), result = deferred<SessionSnapshot>();
  const summaries = new ActivitySummaries(store, control, async () => { if (++reads === 1) return snapshot('Tests'); entered.resolve(); return result.promise; }, async () => {}, () => true, directory, { async complete() { requests++; return 'Running billing regression tests'; } }, () => now);
  try {
    await summaries.tick(); now += 2000; const pending = summaries.tick(); await entered.promise;
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, enabled: false } } }); summaries.settingsChanged();
    result.resolve(snapshot('Tests')); await pending; assert.equal(requests, 0);
  } finally { await summaries.close(); }
}));

test('failed helper keeps factual state and does not retry unchanged evidence after restart', () => fixture(async ({ directory, store, control }) => {
  enable(store); let now = 1_000_000, requests = 0;
  const make = () => new ActivitySummaries(store, control, async () => snapshot('Tests'), async () => {}, () => true, directory, { async complete() { requests++; throw new Error('Offline'); } }, () => now);
  let summaries = make();
  try {
    await summaries.tick(); now += 2000; await summaries.tick();
    assert.equal((await control.read()).nodes[0].summary, 'Waiting for input');
    assert.equal((await control.read()).nodes[0].attention, 'input'); assert.equal(store.summary('resource')?.generated, false);
    await summaries.close(); summaries = make(); now += 100_000; await summaries.tick(); now += 2000; await summaries.tick(); assert.equal(requests, 1);
  } finally { await summaries.close(); }
}));

test('summary ledger survives database restart, counts uncertain attempts and rolls hourly/daily limits', () => fixture(async ({ store, control }) => {
  const policy = { ...store.readSettings().value.summaries, requestsPerHour: 2, requestsPerDay: 3 }, now = 100_000_000;
  assert.equal(store.reserveSummary('resource', 'one', 'Original', policy, now), true);
  let reopened = new SqliteStore(store.file);
  try {
    assert.equal(reopened.reserveSummary('resource', 'one', 'Original', policy, now + 61_000), false);
    assert.equal(reopened.reserveSummary('resource', 'two', 'Original', policy, now + 59_000), false);
    assert.equal(reopened.reserveSummary('resource', 'two', 'Original', policy, now + 60_000), true);
    assert.equal(store.finishSummary('resource', 'one', 'Old response ignored', true), false);
    assert.equal(store.finishSummary('resource', 'two', 'Checking billing regression tests', true), true);
    await control.apply({ type: 'node.move', id: 'shell', position: { x: 90, y: 100 } }, (await control.read()).revision);
    assert.equal(reopened.summary('resource')?.text, 'Checking billing regression tests');
    assert.equal(reopened.summary('resource')?.expectedSummary, 'Original');
    assert.equal(reopened.reserveSummary('resource', 'three', 'Original', policy, now + 120_000), false);
    assert.equal(reopened.reserveSummary('resource', 'three', 'Original', policy, now + 3_600_000), true);
    assert.equal(reopened.reserveSummary('resource', 'four', 'Original', policy, now + 7_200_000), false);
    assert.equal(reopened.reserveSummary('resource', 'four', 'Original', policy, now + 86_400_000), true);
    assert.equal(reopened.reserveSummary('missing', 'unused', 'Original', policy, now + 86_500_000), false);
    await control.apply({ type: 'node.archive', id: 'shell' }, (await control.read()).revision);
    await control.apply({ type: 'node.delete', id: 'shell' }, (await control.read()).revision);
    reopened.reserveSummary('missing', 'unused', 'Original', policy, now + 86_500_000);
    assert.equal(reopened.summary('resource'), undefined);
  } finally { reopened.close(); }
}));

test('v6 summary migration retains graph, camera, checkpoint and existing settings without enabling paid work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-summary-upgrade-')), file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file);
  try {
    await new WorkspaceControl(store).apply({ type: 'project.create', id: 'project', title: 'Retain me', position: { x: 140, y: 80 } }, 0);
    await store.writeView('desktop', { camera: { x: 40, y: 30, zoom: .7 } });
    store.writeRecovery({ phase: 'closed', entries: [] });
    const settings = store.writeSettings({ expectedRevision: 0, value: { keepAwake: true, neighborhoodPadding: 360, claude: { remoteControl: false, arguments: ['--verbose'] } } });
    const before = await store.read(), view = await store.readView('desktop'), recovery = store.readRecovery(); store.close();
    const old = new DatabaseSync(file); old.exec('DROP TABLE rollout_validations; DROP TABLE rollout_events; DROP TABLE provider_validators; DROP TABLE attention_history; DROP TABLE review_sends; DROP TABLE review_finding_events; DROP TABLE github_inbox; DROP TABLE github_inbox_hidden; DROP TABLE provider_observations; DROP TABLE resource_cache; DROP TABLE activity_summaries; DROP TABLE summary_attempts; PRAGMA user_version = 6'); old.close();
    store = new SqliteStore(file); assert.ok(store.backupFile?.includes('backup-v6-'));
    assert.deepEqual(await store.read(), before); assert.deepEqual(await store.readView('desktop'), view); assert.deepEqual(store.readRecovery(), recovery);
    assert.deepEqual(store.readSettings(), settings); assert.equal(store.readSettings().value.summaries.enabled, false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
