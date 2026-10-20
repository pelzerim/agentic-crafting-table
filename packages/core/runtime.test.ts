import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRuntimeRefusal, hostRuntimeOperations, runtimeOperationDeclarations, runtimeRequestSchema, runtimeSchema } from './runtime.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { createPluginPackageRegistry } from '../../src/resource-plugins/builtins.ts';

const previouslyExposed = ['agent.start', 'agent.resume', 'agent.reply', 'agent.context', 'agent.context.ack', 'agent.context.inject', 'agent.title', 'terminal.start', 'terminal.startup', 'terminal.input', 'session.read', 'skill.run', 'pr.comments', 'pr.review.options', 'pr.review.status', 'review.result', 'review.retry', 'review.findings', 'rollout.validation', 'pr.review.codex', 'pr.review.claude', 'pr.review.workflow', 'pr.architecture', 'resource.read', 'resource.actions', 'resource.action', 'resource.content', 'resource.context', 'resource.viewed', 'resource.opened', 'notion.page.comments', 'plot', 'github.rollout.autoDeploy', 'review.loop'];

test('the runtime vocabulary keeps every operation id agents and the renderer already use', () => {
  const ids = runtimeOperationDeclarations().map(declaration => declaration.id);
  assert.deepEqual([...ids].sort(), [...previouslyExposed].sort());
  for (const action of previouslyExposed) assert.equal(runtimeSchema.parse({ action, nodeId: 'n' }).action, action);
  assert.throws(() => runtimeSchema.parse({ action: 'unknown.operation', nodeId: 'n' }));
});

test('rollout validation is declared by the github.rollout package, not the host', () => {
  assert.equal(hostRuntimeOperations.some(operation => operation.id === 'rollout.validation'), false);
  assert.deepEqual(createPluginPackageRegistry().runtimeOperations().map(operation => [operation.owner, operation.id]), [['github.rollout', 'rollout.validation'], ['github.rollout', 'github.rollout.autoDeploy'], ['notion.page', 'notion.page.comments']]);
});

test('agent policies come from declarations: allow, human only, or a redirect per operation', () => {
  assert.equal(agentRuntimeRefusal({ action: 'agent.title', arguments: {} }), humanOnlyMessage);
  assert.equal(agentRuntimeRefusal({ action: 'plot', arguments: { operation: 'rename' } }), humanOnlyMessage);
  assert.equal(agentRuntimeRefusal({ action: 'resource.read', arguments: {} }), undefined);
  for (const operation of ['options', 'list']) assert.equal(agentRuntimeRefusal({ action: 'rollout.validation', arguments: { operation } }), undefined);
  assert.equal(agentRuntimeRefusal({ action: 'rollout.validation', arguments: { operation: 'report' } }), 'Report rollout validations with workspace_report_validation.');
  for (const operation of ['trigger', 'cancel', undefined, 'constructor']) assert.equal(agentRuntimeRefusal({ action: 'rollout.validation', arguments: operation ? { operation } : {} }), humanOnlyMessage);
  for (const operation of ['list', 'options', 'preview']) assert.equal(agentRuntimeRefusal({ action: 'review.findings', arguments: { operation } }), undefined);
  assert.equal(agentRuntimeRefusal({ action: 'review.findings', arguments: { operation: 'report' } }), 'Report fixed review findings with workspace_report_review_fixes.');
  assert.equal(agentRuntimeRefusal({ action: 'review.findings', arguments: { operation: 'send' } }), humanOnlyMessage);
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
