import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServiceMcpServer } from './service-server.ts';
import { createServer } from '../../src/mcp/server.ts';

async function connect(binding: { agentNodeId?: string }) {
  const calls: { method: string; input: any }[] = [];
  const server = createServiceMcpServer({ async call(method: string, input?: unknown) { calls.push({ method, input }); return { ok: true } as any; } }, binding);
  const client = new Client({ name: 'validation-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const text = (result: any) => (result.content as { text: string }[])[0].text;
  return { calls, client, text };
}
const report = { rolloutNodeId: 'rollout', validationId: 'V1', sequence: 2, phase: 'final', verdict: 'concerns', summary: 'Responses slower', checks: [{ id: 'C1', title: 'Upload p95', status: 'concern', metrics: [{ label: 'p95', before: 2.1, after: 2.9, unit: 's' }] }],
  recommendations: [{ text: 'Hold release', blocking: true }] };

test('the validation report tool forwards as the bound agent only, and refuses without a launch binding', async () => {
  const bound = await connect({ agentNodeId: 'claude' });
  try {
    const result = await bound.client.callTool({ name: 'workspace_report_validation', arguments: report });
    assert.notEqual(result.isError, true, bound.text(result));
    const { rolloutNodeId, ...rest } = report;
    assert.deepEqual(bound.calls, [{ method: 'runtime.run', input: { action: 'rollout.validation', nodeId: rolloutNodeId, arguments: { operation: 'report', agentNodeId: 'claude', ...rest } } }]);
    const tooMany = await bound.client.callTool({ name: 'workspace_report_validation', arguments: { ...report, checks: Array.from({ length: 31 }, (_, i) => ({ id: `C${i}`, title: 'x', status: 'passed' })) } });
    assert.equal(tooMany.isError, true); assert.match(bound.text(tooMany), /30/); assert.equal(bound.calls.length, 1);
    const extra = await bound.client.callTool({ name: 'workspace_report_validation', arguments: { ...report, agentNodeId: 'someone-else' } });
    assert.equal(extra.isError, true); assert.equal(bound.calls.length, 1, 'the reporting agent cannot be chosen by the caller');
    const { validationId, ...unnamed } = report;
    assert.notEqual((await bound.client.callTool({ name: 'workspace_report_validation', arguments: unnamed })).isError, true, 'a report asked for in chat has no id yet');
    assert.equal(bound.calls[1].input.arguments.validationId, undefined);
  } finally { await bound.client.close(); }
  const unbound = await connect({});
  try {
    const refused = await unbound.client.callTool({ name: 'workspace_report_validation', arguments: report });
    assert.equal(refused.isError, true); assert.match(unbound.text(refused), /launched from the table/); assert.equal(unbound.calls.length, 0);
  } finally { await unbound.client.close(); }
});

test('agents cannot trigger validations or ask for reports through workspace_run; options and the list stay readable', async () => {
  const { client, calls, text } = await connect({ agentNodeId: 'claude' });
  try {
    for (const operation of ['trigger', 'ask']) {
      const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'rollout.validation', nodeId: 'rollout', arguments: { operation, value: 'claude', requestId: crypto.randomUUID(), validationId: 'V1' } } });
      assert.equal(refused.isError, true); assert.match(text(refused), /needs a person to confirm it in the app/);
    }
    const forged = await client.callTool({ name: 'workspace_run', arguments: { action: 'rollout.validation', nodeId: 'rollout', arguments: { operation: 'report', agentNodeId: 'codex', validationId: 'V1' } } });
    assert.equal(forged.isError, true); assert.match(text(forged), /workspace_report_validation/);
    assert.equal(calls.length, 0, 'nothing reached the service');
    for (const operation of ['options', 'list']) assert.notEqual((await client.callTool({ name: 'workspace_run', arguments: { action: 'rollout.validation', nodeId: 'rollout', arguments: { operation } } })).isError, true);
    assert.equal(calls.length, 2);
  } finally { await client.close(); }
  const executed: unknown[] = [];
  const server = createServer(undefined, { async execute(request) { executed.push(request); return {}; } });
  const compat = new Client({ name: 'compat-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), compat.connect(clientSide)]);
  try {
    const refused = await compat.callTool({ name: 'workspace_run', arguments: { action: 'rollout.validation', nodeId: 'rollout', arguments: { operation: 'trigger' } } });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /needs a person/); assert.equal(executed.length, 0);
  } finally { await compat.close(); }
});
