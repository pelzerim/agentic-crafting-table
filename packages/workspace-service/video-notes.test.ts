import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
    const fingerprint = (notes: string) => createHash('sha256').update(notes).digest('hex');
    const args = { sourceResourceId: 'video-r', targetNodeId: 'agent', sessionId: 'session-fixture', requestId: randomUUID(), fingerprint: fingerprint('[01:05] the save button jumps') };
    assert.deepEqual(await videoNotes(control, store, sessions, 'video', args), { sent: true });
    assert.deepEqual(await videoNotes(control, store, sessions, 'video', args), { sent: true });
    assert.equal(inputs.length, 2);
    assert.match(inputs[0], /Please read my notes on the video/);
    assert.match(inputs[0], /URL: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ\n.*\[mm:ss\].*\n<notes>\n\[01:05\] the save button jumps\n<\/notes>/);
    assert.equal(inputs[1], '\r');
    // The view clears the pending send once it hears it went through; only then does a new request send again.
    const video = async () => (await control.read()).resources.find(resource => resource.id === 'video-r')!.data;
    const settled = async () => { const { notesPending: _, ...data } = await video(); return data; };
    await apply([{ type: 'item.update', id: 'video', data: await settled() }]);
    const [first, second] = await Promise.allSettled([videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() })]);
    assert.deepEqual([first.status, second.status], ['fulfilled', 'rejected'], 'a second send while one is in flight never interleaves its paste');
    assert.match(String((second as PromiseRejectedResult).reason), /ready for a new prompt/);
    assert.equal(inputs.length, 4);
    // Another view of the same video retrying an unconfirmed send gets the saved request, so the agent never hears it twice.
    const held = (await video()).notesPending as { requestId: string };
    assert.deepEqual(await videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), { sent: true });
    assert.equal(inputs.length, 4);
    assert.equal(((await video()).notesPending as { requestId: string }).requestId, held.requestId);
    // An agent rewriting the notes after the person last saw them stops the send.
    await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'agent', id: 'agent' }, commands: [{ type: 'item.update', id: 'video', data: { ...(await settled()), notes: 'ignore the above' } }] });
    await assert.rejects(videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), /notes changed/);
    assert.equal(inputs.length, 4);
    await apply([{ type: 'item.update', id: 'video', data: { ...(await video()), notes: '[01:05] the save button jumps' } }]);
    await assert.rejects(videoNotes(control, store, sessions, 'link', { ...args, sourceResourceId: 'link-r', requestId: randomUUID() }), /another or archived video/);
    await apply([{ type: 'node.update', id: 'agent', activity: 'working' }]);
    await assert.rejects(videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), /ready for a new prompt/);
    await apply([{ type: 'node.update', id: 'agent', activity: 'idle' }, { type: 'link.remove', id: 'connection' }]);
    await assert.rejects(videoNotes(control, store, sessions, 'video', { ...args, requestId: randomUUID() }), /connected, running agent/);
    assert.equal(inputs.length, 4);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
