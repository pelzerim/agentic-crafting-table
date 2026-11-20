import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { videoNotes } from './video-notes.ts';
import type { SessionCoordinator } from './sessions.ts';

test('notes reach a linked idle agent once per request, never a busy or unlinked one, and only from a video', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'act-video-notes-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: any[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  try {
    await apply([
      { type: 'item.add', id: 'video', resourceId: 'video-r', pluginId: 'workspace.video', title: 'Demo', data: { source: 'https://youtu.be/dQw4w9WgXcQ', notes: '[01:05] the save button jumps' }, position: { x: 0, y: 0 } },
      { type: 'item.add', id: 'link', resourceId: 'link-r', pluginId: 'web.link', title: 'Docs', data: { url: 'https://example.com/' }, position: { x: 0, y: 200 } },
      { type: 'item.create', id: 'agent', resource: { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Claude', data: { provider: 'claude', sessionId: 'session-fixture' } }, position: { x: 200, y: 0 } },
      { type: 'node.update', id: 'agent', activity: 'idle' },
      { type: 'link.save', link: { id: 'connection', sourceId: 'video', targetId: 'agent', kind: 'context' } },
    ]);
    const inputs: string[] = [];
    const sessions = { runtime: { call: async (method: string, args: any) => { if (method === 'sessions.read') return { session: { state: 'running', nodeId: 'agent' } }; inputs.push(args.data); } } } as unknown as SessionCoordinator;
    const args = { sourceResourceId: 'video-r', targetNodeId: 'agent', sessionId: 'session-fixture', requestId: randomUUID() };
    assert.deepEqual(await videoNotes(control, store, sessions, 'video', args), { sent: true });
    assert.deepEqual(await videoNotes(control, store, sessions, 'video', args), { sent: true });
    assert.equal(inputs.length, 2);
    assert.match(inputs[0], /Please read my notes on the video/);
    assert.match(inputs[0], /URL: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ\n.*\[mm:ss\].*\n<notes>\n\[01:05\] the save button jumps\n<\/notes>/);
    assert.equal(inputs[1], '\r');
    const [first, second] = await Promise.allSettled([videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() })]);
    assert.deepEqual([first.status, second.status], ['fulfilled', 'rejected'], 'a second send while one is in flight never interleaves its paste');
    assert.match(String((second as PromiseRejectedResult).reason), /ready for a new prompt/);
    assert.equal(inputs.length, 4);
    await assert.rejects(videoNotes(control, store, sessions, 'link', { ...args, sourceResourceId: 'link-r', requestId: randomUUID() }), /another or archived video/);
    await apply([{ type: 'node.update', id: 'agent', activity: 'working' }]);
    await assert.rejects(videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), /ready for a new prompt/);
    await apply([{ type: 'node.update', id: 'agent', activity: 'idle' }, { type: 'link.remove', id: 'connection' }]);
    await assert.rejects(videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), /connected, running agent/);
    assert.equal(inputs.length, 4);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
