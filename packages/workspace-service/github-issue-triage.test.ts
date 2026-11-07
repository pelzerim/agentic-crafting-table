import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TriageCoordinator } from './triage.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { ProviderConnection } from '../core/connections.ts';
import { githubIssueTriageAdapter } from '../provider-runtime/github-issue-triage.ts';
import { githubIssueFixture } from '../../tests/fixtures/github-issue.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';

async function fixture(run: (input: { control: WorkspaceControl; triage: TriageCoordinator; github: ReturnType<typeof githubIssueFixture>; settings: { importAssigned: boolean }; apply(commands: WorkspaceCommand[]): Promise<void> }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-github-triage-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const github = githubIssueFixture(), settings = { importAssigned: true };
  const connections: ProviderConnection[] = [{ id: 'github-fixture', providerId: 'github', account: 'fixture-developer', enabled: true, isDefault: true }];
  const triage = new TriageCoordinator(store, control, [githubIssueTriageAdapter(() => github.client)], () => connections, () => ({ 'github.issue': { ...settings } }), async () => {});
  const apply = async (commands: WorkspaceCommand[]) => { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands }); };
  try { await run({ control, triage, github, settings, apply }); } finally { await triage.pause(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const issue = (number: number, extra: object = {}) => ({ owner: 'fixture', repo: 'web', number, title: `Issue ${number}`, updated_at: `2026-10-0${number}T09:00:00Z`, ...extra });

test('assigned GitHub issues wait in the to-do inbox, newest first, without their pull requests and without touching the map', () => fixture(async ({ control, triage, github }) => {
  github.assigned = [issue(1), issue(2), issue(3, { pull_request: {} })];
  await triage.refresh();
  const state = await control.read();
  assert.deepEqual(state.todos.map(todo => [todo.title, todo.horizon]), [['Issue 2', 'inbox'], ['Issue 1', 'inbox']]);
  assert.deepEqual(state.todos[0].triage, { source: 'github', key: 'fixture/web/issues/2', label: 'web#2', url: 'https://github.com/fixture/web/issues/2', status: 'Open',
    item: { pluginId: 'github.issue', connectionId: 'github-fixture', title: 'Issue 2', data: { owner: 'fixture', repo: 'web', number: 2 } } });
  assert.equal(state.nodes.length, 0); assert.equal(state.resources.length, 0);
  const revision = state.revision; await triage.refresh(); assert.equal((await control.read()).revision, revision, 'a repeated read changes nothing');
  github.assigned = [issue(2)]; await triage.refresh();
  assert.deepEqual((await control.read()).todos.map(todo => todo.title), ['Issue 2'], 'an untouched issue leaves the inbox when it is no longer assigned');
}));

test('an issue already on the map is not imported, and a different signed-in account stops the read', () => fixture(async ({ control, triage, github, apply }) => {
  await apply([{ type: 'item.add', id: 'node', resourceId: 'resource', pluginId: 'github.issue', title: 'Issue 1', position: { x: 0, y: 0 }, data: { owner: 'Fixture', repo: 'Web', number: 1 } }]);
  github.assigned = [issue(1)]; await triage.refresh();
  assert.equal((await control.read()).todos.length, 0);
  github.viewer = 'someone-else'; github.assigned = [issue(2)]; await triage.refresh();
  assert.equal((await control.read()).todos.length, 0);
  assert.match(triage.status()[0].error ?? '', /different signed-in account/);
}));

test('the import is off until switched on, so a connected GitHub account adds nothing to the inbox by itself', () => fixture(async ({ control, triage, github, settings }) => {
  assert.equal(createResourcePluginRegistry().pluginSettings({})['github.issue']?.importAssigned, false);
  settings.importAssigned = false; github.assigned = [issue(1)]; await triage.refresh();
  assert.equal((await control.read()).todos.length, 0); assert.deepEqual(triage.status(), []);
}));
