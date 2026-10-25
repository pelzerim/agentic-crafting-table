import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { AutoReviews } from './auto-review.ts';

type Pull = { state: 'open' | 'closed'; merged?: boolean; draft?: boolean };
function fixture(directory = mkdtempSync(join(tmpdir(), 'craft-auto-review-'))) {
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const pulls = new Map<string, Pull>(), started: [string, string, string][] = [];
  const apply = async (...commands: WorkspaceCommand[]) => { await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands }); };
  const create = () => new AutoReviews({ storage: store.pluginStorage('code.review'), store, control, changed: async () => {},
    resources: { async cached(nodeId) { const pull = pulls.get(nodeId); return pull ? { detail: { pull } } : null; } },
    reviews: { start(nodeId, provider, input) { started.push([nodeId, provider, String(input.requestId)]); } } });
  const settings = (enabled: boolean, agents: string[] = ['claude']) => { const saved = store.readSettings(); store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, autoReview: { enabled, agents } } as never }); };
  const pr = (id: string, number: number, pull: Pull = { state: 'open' }): WorkspaceCommand => { pulls.set(id, pull); return { type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: `PR ${number}`, data: { owner: 'acme', repo: 'app', number }, position: { x: number * 300, y: 0 } }; };
  return { directory, store, control, pulls, started, apply, create, settings, pr, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const providers = (started: [string, string, string][]) => started.map(([node, provider]) => `${node}:${provider}`);

test('nothing is reviewed while the setting is off', async () => {
  const f = fixture();
  try {
    const reviews = f.create();
    await f.apply(f.pr('pr-1', 1)); await reviews.reconcile();
    assert.deepEqual(f.started, []);
  } finally { f.close(); }
});

test('turned on, pull requests already on the map are left alone and each new one gets one review per chosen agent, once', async () => {
  const f = fixture();
  try {
    const reviews = f.create();
    await f.apply(f.pr('old', 1)); f.settings(true, ['claude', 'codex']);
    await reviews.reconcile();
    assert.deepEqual(f.started, [], 'the pull requests on the map when it was turned on are the baseline');
    await f.apply(f.pr('new', 2, { state: 'open', draft: true })); await reviews.reconcile(); await reviews.reconcile();
    assert.deepEqual(providers(f.started), ['new:claude', 'new:codex'], 'a draft counts; every chosen agent reviews it once');
    assert.equal(new Set((f.started as [string, string, string][]).map(([, , requestId]) => requestId)).size, 2);
  } finally { f.close(); }
});

test('a new pull request waits until it is known open; closed and merged ones are never reviewed', async () => {
  const f = fixture();
  try {
    const reviews = f.create();
    f.settings(true); await reviews.reconcile();
    await f.apply(f.pr('later', 3)); f.pulls.delete('later');
    await reviews.reconcile();
    assert.deepEqual(f.started, [], 'not read yet');
    f.pulls.set('later', { state: 'open' }); await reviews.reconcile();
    assert.deepEqual(providers(f.started), ['later:claude']);
    await f.apply(f.pr('closed', 4, { state: 'closed' }), f.pr('merged', 5, { state: 'closed', merged: true }));
    await reviews.reconcile();
    f.pulls.set('closed', { state: 'open' }); await reviews.reconcile();
    assert.deepEqual(providers(f.started), ['later:claude'], 'a pull request first seen closed is settled for good');
  } finally { f.close(); }
});

test('pull requests added while it was off stay unreviewed when it is turned on again, and a restart repeats nothing', async () => {
  const f = fixture();
  try {
    let reviews = f.create();
    f.settings(true); await reviews.reconcile();
    await f.apply(f.pr('first', 6)); await reviews.reconcile();
    f.settings(false); await reviews.reconcile();
    await f.apply(f.pr('while-off', 7)); await reviews.reconcile();
    f.settings(true); await reviews.reconcile();
    assert.deepEqual(providers(f.started), ['first:claude']);
    reviews = f.create(); await reviews.reconcile();
    await f.apply({ type: 'item.add', id: 'first-again', resourceId: 'first-r', pluginId: 'github.pull-request', title: 'PR 6', data: { owner: 'acme', repo: 'app', number: 6 }, position: { x: 0, y: 900 } } as WorkspaceCommand);
    f.pulls.set('first-again', { state: 'open' }); await reviews.reconcile();
    assert.deepEqual(providers(f.started), ['first:claude'], 'another node of a reviewed pull request is not reviewed again');
  } finally { f.close(); }
});

test('no chosen agent starts nothing, and the review engine missing starts nothing', async () => {
  const f = fixture();
  try {
    const reviews = f.create();
    f.settings(true, []); await reviews.reconcile();
    await f.apply(f.pr('pr-8', 8)); await reviews.reconcile();
    assert.deepEqual(f.started, []);
  } finally { f.close(); }
});
