import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServiceMcpServer } from './service-server.ts';
import { settingsSchema } from '../core/settings.ts';

test('an agent cannot change whether agents may act for the person; its other settings changes still reach the service', async () => {
  const saved = { revision: 4, value: settingsSchema.parse({ agentsActForPerson: false }) }, writes: any[] = [];
  const server = createServiceMcpServer({ async call(method: string, input?: unknown) {
    if (method === 'settings.read') return saved as any;
    if (method === 'settings.write') { writes.push(input); return { revision: 5, value: (input as any).value } as any; }
    throw new Error(`unexpected ${method}`);
  } });
  const client = new Client({ name: 'settings-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const refused = await client.callTool({ name: 'workspace_settings', arguments: { update: { expectedRevision: 4, value: { ...saved.value, agentsActForPerson: true } } } });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /Only the user changes “Agents may act for you”/);
    assert.equal(writes.length, 0, 'nothing reached the service');
    const changed = await client.callTool({ name: 'workspace_settings', arguments: { update: { expectedRevision: 4, value: { ...saved.value, keepAwake: true } } } });
    assert.notEqual(changed.isError, true, JSON.stringify(changed));
    assert.deepEqual(writes.map(write => [write.value.keepAwake, write.value.agentsActForPerson]), [[true, false]]);
    assert.notEqual((await client.callTool({ name: 'workspace_settings', arguments: {} })).isError, true);
  } finally { await client.close(); }
});

test('through the service transport an agent runs an action that acts for the person, but never one only a person may run and never past a blocker', async () => {
  const actions = [{ id: 'pr.merge', label: 'Merge', actsForPerson: true, heedsBlockers: true }, { id: 'image', label: 'Image', readOnly: true, humanOnly: true }];
  const executed: any[] = [];
  const server = createServiceMcpServer({ async call(method: string, input?: any) {
    if (method === 'settings.read') return { revision: 1, value: settingsSchema.parse({}) } as any;
    if (method === 'runtime.run' && input.action === 'resource.actions') return actions as any;
    if (method === 'runtime.run') { executed.push(input.arguments); return { ok: true } as any; }
    throw new Error(`unexpected ${method}`);
  } });
  const client = new Client({ name: 'acting-agent', version: '1' }), [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const run = (args: Record<string, unknown>) => client.callTool({ name: 'workspace_run', arguments: { action: 'resource.action', nodeId: 'pr', arguments: args } });
  const text = (result: any) => (result.content as { text: string }[])[0].text;
  try {
    const past = await run({ actionId: 'pr.merge', input: { value: 'SQUASH', overrideBlockers: 'link-1' } });
    assert.equal(past.isError, true); assert.match(text(past), /does not go ahead past a blocker/);
    const image = await run({ actionId: 'image', input: {} });
    assert.equal(image.isError, true); assert.match(text(image), /needs a person to confirm it in the app/);
    assert.equal(executed.length, 0, 'neither reached the service action');
    const merged = await run({ actionId: 'pr.merge', input: { value: 'SQUASH' } });
    assert.notEqual(merged.isError, true, text(merged));
    assert.deepEqual(executed, [{ actionId: 'pr.merge', input: { value: 'SQUASH' } }]);
  } finally { await client.close(); }
});
