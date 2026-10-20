import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CodexRpc, CodexMetadata } from './codex-client.ts';

function fixture(timeout = 500) {
  const input = new PassThrough(), output = new PassThrough(); let disposed = false;
  const frames: any[] = [];
  output.on('data', data => frames.push(JSON.parse(String(data))));
  const rpc = new CodexRpc(input, output, () => { disposed = true; }, timeout);
  return { input, output, rpc, frames, disposed: () => disposed, respond(id: number, result: unknown) { input.write(JSON.stringify({ id, result }) + '\n'); } };
}
test('Codex metadata handshake, out-of-order replies and projection never expose transcript bodies', async () => {
  const f = fixture(), client = new CodexMetadata(f.rpc);
  try {
    const init = f.rpc.initialize(); assert.equal(f.frames[0].method, 'initialize'); f.respond(1, { userAgent: 'codex' }); await init;
    assert.equal(f.frames[1].method, 'initialized');
    const models = client.models(), sessions = client.sessions({ query: 'billing' });
    f.respond(3, { data: [{ id: '11111111-1111-4111-8111-111111111111', cwd: '/fixture', name: 'Billing', preview: 'Summary', updatedAt: 100, status: { type: 'idle' }, turns: [{ text: 'PRIVATE TRANSCRIPT' }] }], nextCursor: 'next-page' });
    f.respond(2, { data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'ignored' }], baseInstructions: 'PRIVATE INSTRUCTIONS' }] });
    assert.equal((await sessions).nextCursor, 'next-page'); assert.equal((await models).data[0].model, 'gpt-6-astra');
    assert.ok(!JSON.stringify(await sessions).includes('PRIVATE')); assert.ok(!JSON.stringify(await models).includes('PRIVATE'));
    assert.equal(f.frames.find(frame => frame.method === 'thread/list').params.useStateDbOnly, true);
    const read = client.session('11111111-1111-4111-8111-111111111111');
    assert.equal(f.frames.at(-1).params.includeTurns, false); f.respond(4, { thread: (await sessions).data[0] }); await read;
    const skills = client.skills('/fixture');
    assert.deepEqual(f.frames.at(-1).params, { cwds: ['/fixture'], forceReload: true });
    f.respond(5, { data: [{ cwd: '/fixture', skills: [{ name: 'inspect', description: 'Inspect project', path: '/fixture/SKILL.md', scope: 'repo', enabled: true, body: 'PRIVATE SKILL BODY' }], errors: [] }] });
    assert.equal((await skills).data[0].skills[0].name, 'inspect'); assert.ok(!JSON.stringify(await skills).includes('PRIVATE'));
  } finally { f.rpc.close(); } assert.equal(f.disposed(), true);
});
test('Codex observer refuses approvals, bounds frames and rejects pending calls on disconnect', async () => {
  const f = fixture(); const events: unknown[] = []; f.rpc.on('notification', event => events.push(event));
  f.input.write('{"method":"thread/status/changed","params":'); f.input.write('{"status":"idle"}}\n');
  assert.equal(events.length, 1);
  f.input.write('{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}\n');
  assert.equal(f.frames.at(-1).error.code, -32601);
  const pending = f.rpc.request('thread/read'); const rejected = assert.rejects(pending, /size limit/);
  f.input.write('x'.repeat(8 * 1024 * 1024 + 1)); await rejected; assert.equal(f.disposed(), true);
  await assert.rejects(f.rpc.request('read'), /closed/);
});
test('Codex timeout and invalid protocol responses remain errors instead of empty success', async () => {
  const f = fixture(10);
  await assert.rejects(f.rpc.request('thread/list'), /timed out/);
  const pending = f.rpc.request('model/list'), rejected = assert.rejects(pending, /invalid protocol/);
  f.input.write('not json\n'); await rejected; assert.equal(f.disposed(), true);
});
