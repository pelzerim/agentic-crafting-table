import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServiceMcpServer } from './service-server.ts';
import { createServer } from '../../src/mcp/server.ts';

/** `calls` leaves out reads of the settings, which the server makes only to decide a request the setting governs. */
async function connect(binding: { agentNodeId?: string }, agentsActForPerson = true) {
  const calls: { method: string; input: any }[] = [];
  const server = createServiceMcpServer({ async call(method: string, input?: unknown) {
    if (method === 'settings.read') return { revision: 1, value: { agentsActForPerson } } as any;
    calls.push({ method, input }); return { ok: true } as any;
  } }, binding);
  const client = new Client({ name: 'review-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const text = (result: any) => (result.content as { text: string }[])[0].text;
  return { calls, client, text };
}

test('agents send, cancel and change review findings through workspace_run only while agents may act for the person; reading stays available', async () => {
  const acting = await connect({ agentNodeId: 'agent' });
  try {
    for (const operation of ['send', 'cancel', 'spawn']) {
      const sent = await acting.client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation, requestId: crypto.randomUUID(), reviewSessionId: 'run', findingIds: ['F1'], agentNodeId: 'agent' } } });
      assert.notEqual(sent.isError, true, acting.text(sent));
    }
    assert.deepEqual(acting.calls.map(call => [call.method, call.input.arguments.operation]), [['runtime.run', 'send'], ['runtime.run', 'cancel'], ['runtime.run', 'spawn']]);
    const marked = await acting.client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation: 'mark', reviewSessionId: 'run', findingIds: ['F1'], status: 'fixed' } } });
    assert.equal(marked.isError, true); assert.match(acting.text(marked), /needs a person to confirm it in the app/); assert.equal(acting.calls.length, 3, 'marking a finding fixed stays the person’s');
  } finally { await acting.client.close(); }
  const { client, calls, text } = await connect({ agentNodeId: 'agent' }, false);
  try {
    for (const operation of ['send', 'cancel', 'spawn']) {
      const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation, requestId: crypto.randomUUID(), reviewSessionId: 'run', findingIds: ['F1'], agentNodeId: 'agent' } } });
      assert.equal(refused.isError, true); assert.match(text(refused), /“Agents may act for you” is off in Settings/);
    }
    const forged = await client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation: 'report', agentNodeId: 'someone-else', findingIds: ['F1'] } } });
    assert.equal(forged.isError, true); assert.match(text(forged), /workspace_report_review_fixes/);
    assert.equal(calls.length, 0, 'nothing reached the service');
    assert.notEqual((await client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation: 'list' } } })).isError, true);
    assert.equal(calls.length, 1);
  } finally { await client.close(); }
});

test('the fix report tool reports as the bound agent only', async () => {
  const bound = await connect({ agentNodeId: 'agent' });
  try {
    const result = await bound.client.callTool({ name: 'workspace_report_review_fixes', arguments: { reviewNodeId: 'review', findingIds: ['F1', 'F3'], commit: 'abc1234', note: 'Done' } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(bound.calls, [{ method: 'runtime.run', input: { action: 'review.findings', nodeId: 'review', arguments: { operation: 'report', agentNodeId: 'agent', findingIds: ['F1', 'F3'], commit: 'abc1234', note: 'Done' } } }]);
    const invalid = await bound.client.callTool({ name: 'workspace_report_review_fixes', arguments: { reviewNodeId: 'review', findingIds: ['F1'], commit: 'main' } });
    assert.equal(invalid.isError, true); assert.equal(bound.calls.length, 1);
  } finally { await bound.client.close(); }
  const unbound = await connect({});
  try {
    const refused = await unbound.client.callTool({ name: 'workspace_report_review_fixes', arguments: { reviewNodeId: 'review', findingIds: ['F1'] } });
    assert.equal(refused.isError, true); assert.match(unbound.text(refused), /launched from the table/); assert.equal(unbound.calls.length, 0);
  } finally { await unbound.client.close(); }
});

test('the compatibility MCP server refuses the same review finding operations while agents may not act for the person', async () => {
  const executed: unknown[] = [];
  const server = createServer(undefined, { async execute(request) { executed.push(request); return {}; } }, undefined, false);
  const client = new Client({ name: 'compat-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation: 'send' } } });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /“Agents may act for you” is off in Settings/); assert.equal(executed.length, 0);
  } finally { await client.close(); }
});
