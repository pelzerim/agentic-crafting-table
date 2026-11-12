import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRuntimeRefusal, hostRuntimeOperations, runtimeOperationDeclarations, runtimeRequestSchema, runtimeSchema } from './runtime.ts';
import { agentActionRefusal, agentBlockerOverrideMessage, agentsMayNotActMessage, humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { settingsSchema } from './settings.ts';
import { createPluginPackageRegistry } from '../../src/resource-plugins/builtins.ts';

const previouslyExposed = ['linear.ticket.pulls', 'github.issue.pulls', 'agent.start', 'agent.resume', 'agent.reply', 'agent.context', 'agent.context.ack', 'agent.context.inject', 'agent.title', 'terminal.start', 'terminal.startup', 'terminal.input', 'session.read', 'skill.run', 'pr.comments', 'pr.review.options', 'pr.review.status', 'review.result', 'review.retry', 'review.findings', 'rollout.validation', 'pr.review.codex', 'pr.review.claude', 'pr.review.workflow', 'pr.architecture', 'resource.read', 'resource.actions', 'resource.action', 'resource.content', 'resource.context', 'resource.viewed', 'resource.opened', 'notion.page.comments', 'plot', 'github.rollout.autoDeploy', 'review.loop'];

test('the runtime vocabulary keeps every operation id agents and the renderer already use', () => {
  const ids = runtimeOperationDeclarations().map(declaration => declaration.id);
  assert.deepEqual([...ids].sort(), [...previouslyExposed].sort());
  for (const action of previouslyExposed) assert.equal(runtimeSchema.parse({ action, nodeId: 'n' }).action, action);
  assert.throws(() => runtimeSchema.parse({ action: 'unknown.operation', nodeId: 'n' }));
});

test('rollout validation is declared by the github.rollout package, not the host', () => {
  assert.equal(hostRuntimeOperations.some(operation => operation.id === 'rollout.validation'), false);
  assert.deepEqual(createPluginPackageRegistry().runtimeOperations().map(operation => [operation.owner, operation.id]), [['github.rollout', 'rollout.validation'], ['github.rollout', 'github.rollout.autoDeploy'], ['linear.ticket', 'linear.ticket.pulls'], ['notion.page', 'notion.page.comments'], ['github.issue', 'github.issue.pulls']]);
});

test('agent policies come from declarations: allow, human only, or a redirect per operation', () => {
  assert.equal(agentRuntimeRefusal({ action: 'agent.title', arguments: {} }), humanOnlyMessage);
  assert.equal(agentRuntimeRefusal({ action: 'plot', arguments: { operation: 'rename' } }), humanOnlyMessage);
  assert.equal(agentRuntimeRefusal({ action: 'resource.read', arguments: {} }), undefined);
  for (const operation of ['options', 'list']) assert.equal(agentRuntimeRefusal({ action: 'rollout.validation', arguments: { operation } }), undefined);
  assert.equal(agentRuntimeRefusal({ action: 'rollout.validation', arguments: { operation: 'report' } }), 'Report rollout validations with workspace_report_validation.');

  for (const operation of ['list', 'options', 'preview']) assert.equal(agentRuntimeRefusal({ action: 'review.findings', arguments: { operation } }), undefined);
  assert.equal(agentRuntimeRefusal({ action: 'review.findings', arguments: { operation: 'report' } }), 'Report fixed review findings with workspace_report_review_fixes.');
});

test('an operation that acts for the person runs for an agent while the setting allows it, and is refused with the setting named while it does not', () => {
  assert.equal(settingsSchema.parse({}).agentsActForPerson, true);
  const acting: [string, string | undefined][] = [['rollout.validation', 'trigger'], ['rollout.validation', 'cancel'], ['rollout.validation', undefined], ['rollout.validation', 'constructor'],
    ['review.findings', 'send'], ['review.findings', 'spawn'], ['review.findings', 'cancel'], ['review.loop', 'set'], ['pr.architecture', 'launch'], ['github.rollout.autoDeploy', 'set'], ['github.issue.pulls', 'add'], ['linear.ticket.pulls', 'add']];
  for (const [action, operation] of acting) {
    const request: { action: string; arguments: Record<string, string> } = { action, arguments: operation ? { operation } : {} };
    assert.equal(agentRuntimeRefusal(request), undefined, `${action} ${operation} with the setting at its default`);
    assert.equal(agentRuntimeRefusal(request, undefined, true), undefined, `${action} ${operation} with the setting on`);
    assert.equal(agentRuntimeRefusal(request, undefined, false), agentsMayNotActMessage, `${action} ${operation} with the setting off`);
  }
  assert.match(agentsMayNotActMessage, /Agents may act for you/);
  for (const allowed of [true, false]) {
    assert.equal(agentRuntimeRefusal({ action: 'agent.title', arguments: {} }, undefined, allowed), humanOnlyMessage);
    assert.equal(agentRuntimeRefusal({ action: 'plot', arguments: { operation: 'rename' } }, undefined, allowed), humanOnlyMessage);
    assert.equal(agentRuntimeRefusal({ action: 'resource.opened', arguments: {} }, undefined, allowed), humanOnlyMessage);
    assert.equal(agentRuntimeRefusal({ action: 'review.loop', arguments: { operation: 'status' } }, undefined, allowed), undefined);
    for (const operation of ['show', 'hide']) assert.equal(agentRuntimeRefusal({ action: 'rollout.validation', arguments: { operation } }, undefined, allowed), humanOnlyMessage, `an agent never shows or hides a validation agent (${operation})`);
    assert.equal(agentRuntimeRefusal({ action: 'review.findings', arguments: { operation: 'mark' } }, undefined, allowed), humanOnlyMessage, 'only the person overrides whether a finding is fixed');
  }
});

test('an item action is refused for an agent by its own flag: never when only a person may, and by the setting when it acts for the person', () => {
  assert.equal(agentActionRefusal({ humanOnly: true }, true), humanOnlyMessage);
  assert.equal(agentActionRefusal({ humanOnly: true, actsForPerson: true }, true), humanOnlyMessage);
  assert.equal(agentActionRefusal({ actsForPerson: true }, true), undefined);
  assert.equal(agentActionRefusal({ actsForPerson: true }, false), agentsMayNotActMessage);
  assert.equal(agentActionRefusal({}, false), undefined);
  assert.equal(agentActionRefusal(undefined, false), undefined);
});

test('an agent never goes ahead past a blocker: the acknowledgement the options carry for a person is refused from an agent', () => {
  const merge = { actsForPerson: true, heedsBlockers: true };
  assert.equal(agentActionRefusal(merge, true, { value: 'SQUASH', overrideBlockers: 'link-1,link-2' }), agentBlockerOverrideMessage);
  assert.equal(agentActionRefusal(merge, true, { value: 'SQUASH', overrideBlockers: '' }), undefined);
  assert.equal(agentActionRefusal(merge, true, { value: 'SQUASH' }), undefined);
  assert.equal(agentActionRefusal(merge, false, { overrideBlockers: 'link-1' }), agentsMayNotActMessage, 'the setting is named first');
  assert.equal(agentActionRefusal({ actsForPerson: true }, true, { overrideBlockers: 'link-1' }), undefined, 'an action that heeds no blockers gives the field no meaning');
});

test('a new package operation needs no host branch for its schema or agent policy', () => {
  const declarations = [...hostRuntimeOperations, { id: 'acme.deploy', agentPolicy: { operations: { status: 'allow' as const }, otherwise: { redirect: 'Use acme_deploy.' } } }];
  assert.equal(runtimeRequestSchema(declarations).parse({ action: 'acme.deploy', nodeId: 'n' }).action, 'acme.deploy');
  assert.equal(agentRuntimeRefusal({ action: 'acme.deploy', arguments: { operation: 'status' } }, declarations), undefined);
  assert.equal(agentRuntimeRefusal({ action: 'acme.deploy', arguments: { operation: 'start' } }, declarations), 'Use acme_deploy.');
});

test('only a person in the app records opening a provider page; agents may read unread counts', () => {
  assert.equal(agentRuntimeRefusal({ action: 'resource.opened', arguments: {} }), humanOnlyMessage);
  assert.equal(agentRuntimeRefusal({ action: 'notion.page.comments', arguments: {} }), undefined);
});
