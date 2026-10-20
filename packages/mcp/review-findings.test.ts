import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServiceMcpServer } from './service-server.ts';
import { createServer } from '../../src/mcp/server.ts';

async function connect(binding: { agentNodeId?: string }) {
  const calls: { method: string; input: any }[] = [];
  const server = createServiceMcpServer({ async call(method: string, input?: unknown) { calls.push({ method, input }); return { ok: true } as any; } }, binding);
  const client = new Client({ name: 'review-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const text = (result: any) => (result.content as { text: string }[])[0].text;
  return { calls, client, text };
}

test('agents cannot send, cancel or change review findings through workspace_run; reading stays available', async () => {
  const { client, calls, text } = await connect({ agentNodeId: 'agent' });
  try {
    for (const operation of ['send', 'cancel', 'mark']) {
      const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation, requestId: crypto.randomUUID(), reviewSessionId: 'run', findingIds: ['F1'], agentNodeId: 'agent' } } });
      assert.equal(refused.isError, true); assert.match(text(refused), /needs a person to confirm it in the app/);
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

test('the compatibility MCP server refuses the same review finding operations', async () => {
  const executed: unknown[] = [];
  const server = createServer(undefined, { async execute(request) { executed.push(request); return {}; } });
  const client = new Client({ name: 'compat-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: 'review', arguments: { operation: 'send' } } });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /needs a person/); assert.equal(executed.length, 0);
  } finally { await client.close(); }
});
