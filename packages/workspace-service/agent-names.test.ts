import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentNames, adoptedName, pendingName } from './agent-names.ts';
import type { NativeNameIo } from './agent-names.ts';
import { MemoryStore, WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { SessionRecord } from '../session-runtime/protocol.ts';

const DEFAULTS = ['Claude session', 'Codex session'];

/** Claude transcripts and Codex threads in memory; a Claude rename changes the transcript as appending does. */
function nativeFixture() {
  const claude = new Map<string, { name?: string; mtimeMs: number }>(), codex = new Map<string, string>();
  const calls: string[] = [];
  const io: NativeNameIo = {
    async findClaude(id) { return claude.has(id) ? id : undefined; },
    async statClaude(file) { const entry = claude.get(file); if (!entry) throw new Error('gone'); return { mtimeMs: entry.mtimeMs, size: 1 }; },
    async readClaude(file) { calls.push(`read ${file}`); return claude.get(file)?.name; },
    async renameClaude(id, name) { calls.push(`claude ${name}`); const entry = claude.get(id); if (!entry) throw new Error('not saved'); claude.set(id, { name, mtimeMs: entry.mtimeMs + 1 }); },
    async renameCodex(names) { calls.push(...names.map(({ name }) => `codex ${name}`)); for (const { id, name } of names) codex.set(id, name); return names.map(({ id }) => id); },
  };
  return { io, calls, claude, codex, cliRename(id: string, name: string) { const entry = claude.get(id)!; claude.set(id, { name, mtimeMs: entry.mtimeMs + 1 }); } };
}

async function setup() {
  const control = new WorkspaceControl(new MemoryStore()), native = nativeFixture(), records: SessionRecord[] = [], runtimeCalls: { method: string; args: any }[] = [];
  const runtime = { async call<T>(method: string, args?: any): Promise<T> {
    runtimeCalls.push({ method, args });
    if (method === 'sessions.list') return records as T;
    if (method === 'sessions.rename') { const record = records.find(record => record.id === args.sessionId)!; record.native = { ...record.native!, name: args.name }; return {} as T; }
    throw new Error('Unknown supervisor method');
  } };
  const names = new AgentNames(control, runtime, async () => {}, () => true, native.io);
  const agent = async (id: string, title: string, provider: 'claude' | 'codex', options: { running?: boolean; nativeName?: string; claudeName?: string; driverName?: string } = {}) => {
    const nativeSessionId = randomUUID(), sessionId = randomUUID(), state = await control.read();
    await control.apply({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title, position: { x: state.nodes.length * 400, y: 0 },
      data: { provider, sessionId, nativeSessionId, cwd: '/work', ...(options.nativeName ? { nativeName: options.nativeName } : {}) } }, state.revision);
    if (provider === 'claude') native.claude.set(nativeSessionId, { ...(options.claudeName ? { name: options.claudeName } : {}), mtimeMs: 1 });
    if (options.running) records.push({ id: sessionId, requestId: sessionId, nodeId: id, workspaceId: 'w', cwd: '/work', state: 'running', cols: 80, rows: 24, createdAt: '', updatedAt: '',
      ...(provider === 'codex' ? { native: { provider: 'codex' as const, nativeSessionId, status: 'idle' as const, observedAt: '', ...(options.driverName ? { name: options.driverName } : {}) } } : {}) });
    return nativeSessionId;
  };
  const read = async (id: string) => { const state = await control.read(), node = state.nodes.find(node => node.id === id)!; return { title: node.title, synced: state.resources.find(resource => resource.id === node.resourceId)!.data.nativeName }; };
  const rename = async (id: string, title: string) => control.apply({ type: 'node.update', id, title } as WorkspaceCommand, (await control.read()).revision);
  return { control, names, native, records, runtimeCalls, agent, read, rename };
}

test('the table name wins the first agreement unless it is a creation default; a later CLI name is taken', () => {
  assert.equal(adoptedName('Fix login', undefined, 'Table context offer', DEFAULTS), undefined);
  assert.equal(adoptedName('Claude session', undefined, 'Release notes', DEFAULTS), 'Release notes');
  assert.equal(adoptedName('Fix login', 'Fix login', 'Release notes', DEFAULTS), 'Release notes');
  assert.equal(adoptedName('Fix login', 'Fix login', 'Fix login', DEFAULTS), undefined);
  assert.equal(pendingName('Claude session', undefined, DEFAULTS), undefined);
  assert.equal(pendingName('  Fix   login ', undefined, DEFAULTS), 'Fix login');
  assert.equal(pendingName('Fix login', 'Fix login', DEFAULTS), undefined);
});

test('a stopped Claude conversation takes the table name; a running one waits for its prompt hook', async () => {
  const { names, native, agent, read, rename } = await setup();
  const stopped = await agent('stopped', 'Fix login', 'claude');
  await agent('running', 'Deploy notes', 'claude', { running: true });
  await agent('fresh', 'Claude session', 'claude');
  await names.tick();
  assert.deepEqual(native.calls.filter(call => call.startsWith('claude')), ['claude Fix login']);
  assert.equal(native.claude.get(stopped)!.name, 'Fix login');
  assert.deepEqual(await read('stopped'), { title: 'Fix login', synced: 'Fix login' });
  assert.deepEqual(await read('running'), { title: 'Deploy notes', synced: undefined });
  assert.deepEqual(await read('fresh'), { title: 'Claude session', synced: undefined });
  native.calls.length = 0; await names.tick();
  assert.deepEqual(native.calls.filter(call => call.startsWith('claude')), [], 'an agreed name is not written again');
  await rename('stopped', 'Fix login redirect'); await names.tick();
  assert.equal(native.claude.get(stopped)!.name, 'Fix login redirect');
});

test('a /rename typed in Claude renames the item; the AI title Claude made up does not', async () => {
  const { names, native, agent, read } = await setup();
  const named = await agent('named', 'Fix login', 'claude', { running: true, nativeName: 'Fix login', claudeName: 'Fix login' });
  await agent('untitled', 'Claude session', 'claude', { claudeName: 'Release notes' });
  await names.tick();
  assert.deepEqual(await read('untitled'), { title: 'Release notes', synced: 'Release notes' });
  native.cliRename(named, 'Login redirect loop'); await names.tick();
  assert.deepEqual(await read('named'), { title: 'Login redirect loop', synced: 'Login redirect loop' });
  const reads = native.calls.filter(call => call.startsWith('read')).length; await names.tick();
  assert.equal(native.calls.filter(call => call.startsWith('read')).length, reads, 'an unchanged transcript is not read again');
});

test('Codex threads are named through their running terminal, or on disk when stopped; a /rename there comes back', async () => {
  const { names, native, records, runtimeCalls, agent, read } = await setup();
  const stopped = await agent('stopped', 'Fix login', 'codex');
  await agent('running', 'Deploy notes', 'codex', { running: true });
  await names.tick();
  assert.equal(native.codex.get(stopped), 'Fix login');
  assert.deepEqual(runtimeCalls.filter(call => call.method === 'sessions.rename').map(call => call.args.name), ['Deploy notes']);
  assert.deepEqual(await read('running'), { title: 'Deploy notes', synced: 'Deploy notes' });
  records[0].native!.name = 'Ship deploy notes'; await names.tick();
  assert.deepEqual(await read('running'), { title: 'Ship deploy notes', synced: 'Ship deploy notes' });
});

test('a supervisor without live renames names a running Codex thread on disk', async () => {
  const { names, native, records, agent } = await setup();
  const id = await agent('running', 'Deploy notes', 'codex', { running: true });
  const runtime = (names as any).runtime;
  (names as any).runtime = { call: (method: string, args: unknown) => method === 'sessions.rename' ? Promise.reject(new Error('Unknown supervisor method')) : runtime.call(method, args) };
  await names.tick();
  assert.equal(native.codex.get(id), 'Deploy notes');
  assert.equal(records[0].native!.name, undefined);
});

test('a rename on the table while a name was being sent is not undone by the name the CLI now holds', async () => {
  const { control, names, native, agent, read, rename } = await setup();
  const id = await agent('agent', 'Fix login', 'claude');
  const renameClaude = native.io.renameClaude;
  native.io.renameClaude = async (...args) => { await renameClaude(...args); await rename('agent', 'Fix login redirect'); };
  await names.tick();
  assert.deepEqual(await read('agent'), { title: 'Fix login redirect', synced: 'Fix login' });
  native.io.renameClaude = renameClaude; await names.tick();
  assert.equal(native.claude.get(id)!.name, 'Fix login redirect');
  assert.deepEqual(await read('agent'), { title: 'Fix login redirect', synced: 'Fix login redirect' });
  assert.ok((await control.read()).revision > 0);
});
