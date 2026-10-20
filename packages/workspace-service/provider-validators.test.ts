import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, VALIDATOR_ROWS } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { GitHubClient } from '../provider-runtime/github.ts';
import { githubTransport } from '../provider-runtime/github-transport.ts';
import { resetRequestBudgets, useValidatorStore } from '../provider-runtime/request-budget.ts';
import { pullFixture } from '../../tests/fixtures/github.ts';

const directory = () => mkdtempSync(join(tmpdir(), 'craft-validators-'));
const identity = { owner: 'fixture', repo: 'billing', number: 42 }, credentials = { accounts: async () => [], token: async () => 'fixture-token' };

test('validators and their bodies survive a restart, so the first read after reopening is a 304', async () => {
  const folder = directory(), file = join(folder, 'workspace.sqlite'), sent: (string | null)[] = [];
  const fetcher = (async (_url: string | URL, init?: RequestInit) => {
    const tag = new Headers(init?.headers).get('if-none-match'); sent.push(tag);
    return tag === '"v1"' ? new Response(null, { status: 304, headers: { etag: '"v1"' } }) : Response.json(pullFixture, { headers: { etag: '"v1"' } });
  }) as typeof fetch;
  let store = new SqliteStore(file);
  try {
    resetRequestBudgets(); useValidatorStore(store);
    await new GitHubClient(githubTransport('fixture-developer', credentials, fetcher)).pull(identity, AbortSignal.timeout(5000));
    store.close(); store = new SqliteStore(file); useValidatorStore(store);
    const pull = await new GitHubClient(githubTransport('fixture-developer', credentials, fetcher)).pull(identity, AbortSignal.timeout(5000));
    assert.equal(pull.title, pullFixture.title); assert.deepEqual(sent, [null, '"v1"']);
    assert.equal(store.validator('github', 'fixture-developer', '/repos/fixture/billing/pulls/42')?.etag, '"v1"');
    assert.equal((await store.snapshot()).state.resources.length, 0, 'validators never enter the workspace snapshot');
  } finally { useValidatorStore(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('the validator cache is a bounded LRU per account', () => {
  const folder = directory(), store = new SqliteStore(join(folder, 'workspace.sqlite'));
  try {
    for (let index = 0; index < VALIDATOR_ROWS; index++) store.saveValidator('github', 'bounded', `/path/${index}`, { etag: `"${index}"`, body: index }, index);
    store.touchValidator('github', 'bounded', '/path/0', VALIDATOR_ROWS);
    store.saveValidator('github', 'other', '/path/0', { etag: '"other"', body: 'other' }, 1);
    store.saveValidator('github', 'bounded', '/path/next', { etag: '"next"', body: 'next' }, VALIDATOR_ROWS + 1);
    assert.equal(store.validator('github', 'bounded', '/path/1'), undefined, 'the least recently used entry is evicted at the row bound');
    assert.equal(store.validator('github', 'bounded', '/path/0')?.body, 0, 'a recently used entry stays');
    assert.equal(store.validator('github', 'bounded', '/path/next')?.etag, '"next"');
    assert.equal(store.validator('github', 'other', '/path/0')?.body, 'other', 'accounts are bounded independently');
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('v12 workspaces gain the validator table without changing their graph', async () => {
  const folder = directory(), file = join(folder, 'workspace.sqlite');
  let store = new SqliteStore(file);
  try {
    await new WorkspaceControl(store).apply({ type: 'project.create', id: 'kept', title: 'Kept project', summary: '', position: { x: 1, y: 2 } }, 0);
    const before = await store.read(); store.close();
    const old = new DatabaseSync(file); old.exec('DROP TABLE rollout_validations; DROP TABLE rollout_events; DROP TABLE provider_validators; ALTER TABLE attention_history DROP COLUMN notes; PRAGMA user_version = 12;'); old.close();
    store = new SqliteStore(file);
    assert.ok(store.backupFile?.includes('backup-v12-')); assert.deepEqual(await store.read(), before);
    store.saveValidator('github', 'migrated', '/user', { etag: '"u"', body: { login: 'migrated' } }, 1);
    assert.deepEqual(store.validator('github', 'migrated', '/user'), { etag: '"u"', body: { login: 'migrated' } });
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});
