import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewContextAction, runArchitectureAction } from './context-actions.ts';
import { githubPullRequest } from './definition.ts';
import type { ResourceRecord, JsonObject, JsonValue } from '../../types.ts';

const resource: ResourceRecord = { id: 'source-pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Source PR', data: { owner: 'fixture', repo: 'billing', number: 42 } };
for (const provider of ['claude', 'codex']) test(`${provider} menu launch freezes its source and reconciles a lost reply without resending`, async () => {
  const calls: { action: string; input?: JsonObject }[] = [];
  const result = await runReviewContextAction(`review.${provider}`, resource, { async runAction(action, input) {
    calls.push({ action, input });
    if (action !== 'pr.review.status') throw new Error('Lost reply');
    return [{ requestId: input!.requestId, state: 'succeeded', nodeId: 'review-item' }];
  } }, new AbortController().signal);
  assert.deepEqual(result, { nodeId: 'review-item' }); assert.equal(calls.length, 2);
  assert.equal(calls[0].action, `pr.review.${provider}`); assert.equal(calls[0].input?.sourceResourceId, resource.id);
  assert.equal(calls[0].input?.model, undefined, 'backend chooses the current default');
  assert.equal(calls[1].input?.requestId, calls[0].input?.requestId);
});

test('workflow menu checks support and reuses the same request for start/status', async () => {
  const calls: { action: string; input?: JsonObject }[] = [];
  assert.deepEqual(await runReviewContextAction('review.workflow', resource, { async runAction(action, input): Promise<JsonValue> {
    calls.push({ action, input });
    if (input?.operation === 'options') return { supported: true };
    if (input?.operation === 'start') return { requestId: input.requestId };
    return [{ requestId: input!.requestId, state: 'outcome-unknown', nodeId: 'workflow-item' }];
  } }, new AbortController().signal), { nodeId: 'workflow-item' });
  assert.deepEqual(calls.map(call => call.input?.operation), ['options', 'start', 'status']);
  assert.ok(calls.every(call => call.action === 'pr.review.workflow'));
  assert.equal(calls[1].input?.sourceResourceId, resource.id);
  assert.equal(calls[2].input?.requestId, calls[1].input?.requestId);
});

test('unsupported workflows and failed native preparation report errors instead of claiming a review started', async () => {
  const calls: string[] = [];
  await assert.rejects(runReviewContextAction('review.workflow', resource, { async runAction(_action, input) {
    calls.push(String(input?.operation)); return { supported: false, reason: 'Install the repository workflow' };
  } }, new AbortController().signal), /Install the repository workflow/);
  assert.deepEqual(calls, ['options']);
  await assert.rejects(runReviewContextAction('review.claude', resource, { async runAction(action, input) {
    return action === 'pr.review.status' ? [{ requestId: input!.requestId, state: 'failed', error: 'Native CLI unavailable' }] : {};
  } }, new AbortController().signal), /Native CLI unavailable/);
});

test('closing the renderer stops polling, not the durable review', async () => {
  const controller = new AbortController(), calls: string[] = [];
  const result = runReviewContextAction('review.codex', resource, { async runAction(action, input) {
    calls.push(action);
    if (action === 'pr.review.status') { setTimeout(() => controller.abort(new Error('closed')), 10); return [{ requestId: input!.requestId, state: 'running' }]; }
    return {};
  } }, controller.signal);
  await assert.rejects(result, /closed/); assert.deepEqual(calls, ['pr.review.codex', 'pr.review.status']);
  await assert.rejects(runReviewContextAction('review.workflow', resource, { async runAction() { throw new Error('must not run'); } }, controller.signal), /closed/);
});

test('Explain architecture is declared once and launches through the shared action, focusing the started session', async () => {
  assert.deepEqual(githubPullRequest.contextMenu?.find(group => group.id === 'architecture')?.children.map(child => child.id), ['architecture.explain']);
  const calls: { action: string; input?: JsonObject }[] = [];
  const result = await runReviewContextAction('architecture.explain', resource, { async runAction(action, input): Promise<JsonValue> {
    calls.push({ action, input });
    if (input?.operation === 'options') return { canLaunch: true };
    if (input?.operation === 'launch') throw new Error('Lost reply');
    return [{ requestId: input!.requestId, state: calls.length > 3 ? 'launched' : 'pending', nodeId: 'architecture-agent' }];
  } }, new AbortController().signal);
  assert.deepEqual(result, { nodeId: 'architecture-agent' });
  assert.ok(calls.every(call => call.action === 'pr.architecture'));
  assert.deepEqual(calls.slice(0, 3).map(call => call.input?.operation), ['options', 'launch', 'status']);
  assert.equal(new Set(calls.slice(1).map(call => call.input?.requestId)).size, 1, 'a lost reply is reconciled, never resent');
});

test('Explain architecture reports why it cannot launch or why the launch failed', async () => {
  await assert.rejects(runArchitectureAction({ async runAction() { return { canLaunch: false, reason: 'Native Claude sessions are not configured' }; } }, new AbortController().signal), /not configured/);
  await assert.rejects(runArchitectureAction({ async runAction(_action, input): Promise<JsonValue> {
    if (input?.operation === 'options') return { canLaunch: true };
    if (input?.operation === 'launch') return { requestId: input.requestId };
    return [{ requestId: input!.requestId, state: 'failed', error: 'Claude could not start' }];
  } }, new AbortController().signal), /Claude could not start/);
});
