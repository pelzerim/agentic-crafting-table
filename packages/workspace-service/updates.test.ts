import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { UpdateChecker, parseRemoteTags } from './updates.ts';
import type { UpdateCheckerOptions } from './updates.ts';
import type { GitRunner } from './plugin-git.ts';

const NOW = Date.UTC(2026, 9, 21, 9), DAY = 24 * 60 * 60 * 1000;
const pack = { id: 'acme', name: 'Acme internal', version: '1.1.0', source: { kind: 'git' as const, url: 'git@github.com:acme/act-acme-plugins.git', ref: 'v1.1.0' } };
const lsRemote = (tags: string[]) => tags.map((tag, index) => `${String(index).padStart(40, '0')}\trefs/tags/${tag}`).join('\n') + '\n';

async function fixture(run: (context: { store: SqliteStore; checker: (options?: Partial<UpdateCheckerOptions>) => UpdateChecker; calls: { tags: number; git: string[][] }; clock: { now: number } }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'act-updates-')), store = new SqliteStore(join(directory, 'workspace.sqlite'), { reminderSeeds: [] });
  const calls = { tags: 0, git: [] as string[][] }, clock = { now: NOW };
  const git: GitRunner = async args => { calls.git.push([...args]); return lsRemote(['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.2.0^{}']); };
  const checker = (options: Partial<UpdateCheckerOptions> = {}) => new UpdateChecker(store, {
    version: '0.1.0', tags: async () => { calls.tags++; return ['v0.1.0', 'v0.2.0', 'nightly']; }, plugins: () => [pack], git, clock: () => clock.now, allowed: () => true, ...options,
  });
  try { await run({ store, checker, calls, clock }); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
const setCheck = (store: SqliteStore, check: boolean) => { const current = store.readSettings(); store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, updates: { check } } }); };

test('ls-remote output yields tag names without the peeled duplicates', () => {
  assert.deepEqual(parseRemoteTags(lsRemote(['v1.0.0', 'v1.1.0^{}', 'v1.1.0'])), ['v1.0.0', 'v1.1.0']);
  assert.deepEqual(parseRemoteTags(''), []);
});

test('a check compares the app and each git-installed pack with its newest release tag', () => fixture(async ({ checker, calls, clock }) => {
  const service = checker();
  assert.deepEqual(service.status(), { app: { current: '0.1.0', available: false }, plugins: [], checking: false }, 'nothing is known before the first check');
  await service.check();
  assert.deepEqual(service.status(), {
    app: { current: '0.1.0', latest: 'v0.2.0', available: true, checkedAt: clock.now },
    plugins: [{ id: 'acme', name: 'Acme internal', source: pack.source.url, current: '1.1.0', latest: 'v1.2.0', available: true, checkedAt: clock.now }],
    checking: false,
  });
  assert.equal(calls.tags, 1);
  assert.deepEqual(calls.git, [['ls-remote', '--tags', '--refs', '--', pack.source.url]]);
}));

test('an up-to-date app and pack, and packs from folders, offer nothing', () => fixture(async ({ checker }) => {
  const service = checker({ version: '0.2.0', plugins: () => [{ ...pack, version: '1.2.0' }, { id: 'local', name: 'Local', version: '0.0.1', source: { kind: 'folder', path: '/tmp/local' } }] });
  await service.check();
  const status = service.status();
  assert.deepEqual([status.app.latest, status.app.available], ['v0.2.0', false]);
  assert.deepEqual(status.plugins.map(plugin => [plugin.id, plugin.latest, plugin.available]), [['acme', 'v1.2.0', false]]);
}));

test('a failing source records its error and leaves the others checked', () => fixture(async ({ checker, clock }) => {
  const service = checker({ tags: async () => { throw new Error('HTTP 503'); }, git: async () => { throw new Error('Could not read from remote repository.'); } });
  await service.check();
  const status = service.status();
  assert.deepEqual(status.app, { current: '0.1.0', available: false, checkedAt: clock.now, error: 'HTTP 503' });
  assert.deepEqual(status.plugins[0].error, 'Could not read from remote repository.');
  assert.equal(status.plugins[0].available, false);
}));

test('the background tick checks once a day while the setting is on; Check now always checks', () => fixture(async ({ store, checker, calls, clock }) => {
  const service = checker();
  await service.tick(); assert.equal(calls.tags, 1);
  clock.now += DAY / 2; await service.tick(); assert.equal(calls.tags, 1, 'half a day later nothing happens');
  clock.now += DAY / 2; await service.tick(); assert.equal(calls.tags, 2, 'a day after the last check it looks again');
  setCheck(store, false);
  clock.now += DAY; await service.tick(); assert.equal(calls.tags, 2, 'off: the tick is silent');
  await service.check(); assert.equal(calls.tags, 3, 'a check the person asks for runs anyway');
}));

test('a check in flight is shared, and closing stops the background timer', () => fixture(async ({ checker, calls }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = checker({ tags: async () => { calls.tags++; await gate; return ['v0.3.0']; } });
  const first = service.check(), second = service.check();
  assert.equal(service.status().checking, true);
  release(); await Promise.all([first, second]);
  assert.equal(calls.tags, 1);
  assert.equal(service.status().app.latest, 'v0.3.0');
  service.start(); await service.close();
}));

test('without a tags source of its own the checker reads the GitHub tags API', () => fixture(async ({ checker }) => {
  const realFetch = globalThis.fetch, urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(JSON.stringify([{ name: 'v0.5.0' }]), { headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  try {
    const service = checker({ tags: undefined });
    await service.check();
    assert.deepEqual([service.status().app.latest, service.status().app.available], ['v0.5.0', true]);
    assert.match(urls[0], /^https:\/\/api\.github\.com\/repos\/.+\/tags/);
  } finally { globalThis.fetch = realFetch; }
}));
