import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { PROJECT_SUMMARY_DEBOUNCE_MS, PROJECT_SUMMARY_INTERVAL_MS, ProjectSummaries } from './project-summaries.ts';
import type { ActivitySummaryClient, HelperRequest } from '../../src/agents/activity-summary.ts';

type Fixture = { store: SqliteStore; control: WorkspaceControl; apply(...commands: WorkspaceCommand[]): Promise<void>; requests: HelperRequest[]; summaries(options?: { reply?: () => string; hour?: number }): ProjectSummaries; clock: { now: number }; turnOn(extra?: Record<string, unknown>): void };
const running: ProjectSummaries[] = [];
async function fixture(run: (value: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-project-summaries-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), requests: HelperRequest[] = [], clock = { now: Date.parse('2026-10-26T12:00:00.000Z') };
  const apply = async (...commands: WorkspaceCommand[]) => { await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands }); };
  const turnOn = (extra: Record<string, unknown> = {}) => { const current = store.readSettings(); store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, projectSummaries: true, ...extra } } }); };
  const summaries = (options: { reply?: () => string } = {}) => {
    const client: ActivitySummaryClient = { async complete(request) { requests.push(request); return options.reply?.() ?? 'Webhook agent asks about retries; the refund fixer is editing.'; } };
    const helper = new ProjectSummaries(store, control, { client, clock: () => clock.now, allowed: () => true });
    running.push(helper); helper.start(); return helper;
  };
  try {
    await apply({ type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } });
    await apply({ type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'workspace.note', title: 'Webhook agent', data: { text: 'Private note body' }, projectId: 'billing', position: { x: 0, y: 0 } });
    await apply({ type: 'node.update', id: 'agent', attention: 'input' });
    await run({ store, control, apply, requests, summaries, clock, turnOn });
  } finally { for (const helper of running.splice(0)) await helper.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('switched off: nothing is sent and the snapshot is empty', () => fixture(async ({ summaries, requests, clock, store }) => {
  const current = store.readSettings();
  store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, projectSummaries: false } } });
  const helper = summaries();
  clock.now += PROJECT_SUMMARY_DEBOUNCE_MS * 2; await helper.tick();
  assert.equal(requests.length, 0);
  assert.deepEqual(helper.observe().list, []);
}));

test('a project is summarised once its input has been unchanged for a minute, from titles and reasons only', () => fixture(async ({ summaries, requests, clock, turnOn, store }) => {
  turnOn(); const helper = summaries(), before = helper.observe().revision;
  await helper.tick(); assert.equal(requests.length, 0, 'the input is new');
  clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.equal(requests.length, 1);
  const sent = JSON.parse(requests[0].messages[0].content);
  assert.deepEqual([sent.project, sent.needsMe], ['Billing', [{ title: 'Webhook agent', reason: 'Waiting for your input' }]]);
  assert.ok(!requests[0].messages[0].content.includes('Private note body'));
  assert.equal(requests[0].max_tokens, 96); assert.equal(requests[0].model, 'haiku');
  assert.deepEqual(helper.observe().list, [{ projectId: 'billing', status: 'Webhook agent asks about retries; the refund fixer is editing.', model: 'haiku' }]);
  assert.notEqual(helper.observe().revision, before);
  assert.equal(store.projectSummaries()[0].text, `{"status":"Webhook agent asks about retries; the refund fixer is editing."}`);
  clock.now += PROJECT_SUMMARY_INTERVAL_MS * 2; await helper.tick();
  assert.equal(requests.length, 1, 'unchanged input is not sent again');
}));

test('a Next and Status reply is kept as both lines; a Next that names no item is dropped', () => fixture(async ({ summaries, clock, turnOn, apply, store }) => {
  turnOn(); let reply = 'Next: Answer the webhook agent about retries.\nStatus: One question waits on you.';
  const helper = summaries({ reply: () => reply });
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.deepEqual(helper.observe().list, [{ projectId: 'billing', next: 'Answer the webhook agent about retries.', status: 'One question waits on you.', model: 'haiku' }]);
  assert.equal(store.projectSummaries()[0].text, `{"next":"Answer the webhook agent about retries.","status":"One question waits on you."}`);
  reply = 'Next: Take a break.\nStatus: Calm.';
  await apply({ type: 'node.update', id: 'agent', title: 'Webhook agent v2' });
  await helper.tick(); clock.now += PROJECT_SUMMARY_INTERVAL_MS; await helper.tick();
  assert.deepEqual(helper.observe().list, [{ projectId: 'billing', status: 'Calm.', model: 'haiku' }]);
}));

test('a plain-text summary saved before there were two lines reads as Status', () => fixture(async ({ summaries, turnOn, store }) => {
  turnOn();
  store.reserveProjectSummary('billing', 'old', store.readSettings().value.summaries, Date.now(), 0);
  store.finishProjectSummary('billing', 'old', 'Billing waits on your answer.', 'haiku');
  assert.deepEqual(summaries().observe().list, [{ projectId: 'billing', status: 'Billing waits on your answer.', model: 'haiku' }]);
}));

test('changed input waits for the debounce and the ten-minute floor per project', () => fixture(async ({ summaries, requests, clock, turnOn, apply }) => {
  turnOn(); const helper = summaries();
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.equal(requests.length, 1);
  await apply({ type: 'node.update', id: 'agent', title: 'Webhook agent v2' });
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.equal(requests.length, 1, 'within ten minutes of the last attempt');
  clock.now += PROJECT_SUMMARY_INTERVAL_MS; await helper.tick();
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].messages[0].content).needsMe[0].title, 'Webhook agent v2');
}));

test('an agent\'s new recap counts as a project change and is sent in place of its last line', () => fixture(async ({ summaries, requests, clock, turnOn, apply }) => {
  turnOn(); const helper = summaries();
  await apply({ type: 'node.update', id: 'agent', lastLine: 'Done.' });
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.equal(requests.length, 1);
  await apply({ type: 'node.update', id: 'agent', recap: { text: 'I removed the flag; the PR is ready for your review. token=abc123def456', at: '2026-10-26T12:05:00.000Z' } });
  await helper.tick(); clock.now += PROJECT_SUMMARY_INTERVAL_MS; await helper.tick();
  assert.equal(requests.length, 2);
  const row = JSON.parse(requests[1].messages[0].content).needsMe[0];
  assert.equal(row.title, 'Webhook agent'); assert.match(row.said, /^I removed the flag; the PR is ready for your review\./);
  assert.ok(!requests[1].messages[0].content.includes('abc123def456'), 'redacted');
}));

test('muted projects and projects below are never sent; unmuting queues the project', () => fixture(async ({ summaries, requests, clock, turnOn, apply }) => {
  turnOn();
  await apply({ type: 'project.create', id: 'below', title: 'Below', summary: '', position: { x: 4000, y: 0 } });
  await apply({ type: 'node.below', id: 'below' });
  await apply({ type: 'project.mute', id: 'billing', muted: true });
  const helper = summaries();
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS * 2; await helper.tick();
  assert.equal(requests.length, 0);
  await apply({ type: 'project.mute', id: 'billing', muted: false });
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.deepEqual(requests.map(request => JSON.parse(request.messages[0].content).project), ['Billing']);
}));

test('four requests an hour stay with the other helpers', () => fixture(async ({ summaries, requests, clock, turnOn, apply }) => {
  turnOn({ requestsPerHour: 5 });
  await apply({ type: 'project.create', id: 'infra', title: 'Infra', summary: '', position: { x: 4000, y: 0 } });
  const helper = summaries();
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick(); await helper.tick(); await helper.tick();
  assert.equal(requests.length, 1);
}));

test('turning summaries off empties the snapshot; an unusable reply keeps the earlier text', () => fixture(async ({ summaries, requests, clock, turnOn, apply, store }) => {
  turnOn(); let reply = 'Billing waits on your answer.';
  const helper = summaries({ reply: () => reply });
  await helper.tick(); clock.now += PROJECT_SUMMARY_DEBOUNCE_MS; await helper.tick();
  assert.equal(helper.observe().list[0].status, 'Billing waits on your answer.');
  reply = '<b>bad</b>';
  await apply({ type: 'node.update', id: 'agent', title: 'Webhook agent v2' });
  await helper.tick(); clock.now += PROJECT_SUMMARY_INTERVAL_MS; await helper.tick();
  assert.equal(requests.length, 2); assert.equal(helper.observe().list[0].status, 'Billing waits on your answer.');
  const current = store.readSettings();
  store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, projectSummaries: false } } });
  assert.deepEqual(helper.observe().list, []);
}));
