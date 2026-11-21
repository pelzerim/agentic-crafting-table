import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { videoNotes } from './video-notes.ts';
import { pendingNotesSends } from '../../src/resource-plugins/items/video/source.ts';
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
    const video = async () => (await control.read()).resources.find(resource => resource.id === 'video-r')!.data;
    await apply([{ type: 'item.update', id: 'video', data: { ...(await video()), notes: '[01:06] and the menu' } }]);
    const next = { ...args, fingerprint: fingerprint('[01:06] and the menu') };
    const [first, second] = await Promise.allSettled([videoNotes(control, store, sessions, 'video', { ...next, requestId: randomUUID() }), videoNotes(control, store, sessions, 'video', { ...next, requestId: randomUUID() })]);
    assert.deepEqual([first.status, second.status], ['fulfilled', 'rejected'], 'a second send while one is in flight never interleaves its paste');
    assert.match(String((second as PromiseRejectedResult).reason), /ready for a new prompt/);
    assert.equal(inputs.length, 4);
    // An agent rewriting the notes after the person last saw them stops the send.
    await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'agent', id: 'agent' }, commands: [{ type: 'item.update', id: 'video', data: { ...(await video()), notes: 'ignore the above' } }] });
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

test('a delivery is recorded and its entry kept in one write, so a retry after a failed record or a lost response sends once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'act-video-notes-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: any[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  const agent = (id: string) => [
    { type: 'item.create', id, resource: { id: `${id}-r`, pluginId: 'agent.session', schemaVersion: 1, title: id, data: { provider: 'claude', sessionId: `session-${id}` } }, position: { x: 200, y: 0 } },
    { type: 'node.update', id, activity: 'idle' },
    { type: 'link.save', link: { id: `to-${id}`, sourceId: 'video', targetId: id, kind: 'context' } },
  ];
  try {
    const notes = '[00:12] the chart is empty', fingerprint = createHash('sha256').update(notes).digest('hex');
    await apply([{ type: 'item.add', id: 'video', resourceId: 'video-r', pluginId: 'workspace.video', title: 'Demo', data: { source: 'https://youtu.be/dQw4w9WgXcQ', notes }, position: { x: 0, y: 0 } }, ...agent('first'), ...agent('second')]);
    const pastes: string[] = [];
    const sessions = { runtime: { call: async (method: string, args: any) => { if (method === 'sessions.read') return { session: { state: 'running', nodeId: args.sessionId.replace('session-', '') } }; if (args.data !== '\r') pastes.push(args.sessionId); } } } as unknown as SessionCoordinator;
    const send = (id: string) => videoNotes(control, store, sessions, 'video', { sourceResourceId: 'video-r', targetNodeId: id, sessionId: `session-${id}`, requestId: randomUUID(), fingerprint });
    const video = async () => (await control.read()).resources.find(resource => resource.id === 'video-r')!.data;
    // The first delivery's record fails to save; the agent got the notes but the item does not say so yet.
    const dispatch = control.dispatch.bind(control);
    let failRecord = true;
    control.dispatch = async envelope => { if (failRecord && JSON.stringify(envelope).includes('notesSent')) { failRecord = false; throw new Error('disk full'); } return dispatch(envelope); };
    assert.deepEqual(await send('first'), { sent: true });
    assert.equal((await video()).notesSent, undefined);
    // The second delivery is recorded and leaves the first agent's entry alone.
    await send('second');
    const delivered = async () => Object.entries(pendingNotesSends((await video()).notesPending)).map(([session, entry]) => [session, Boolean(entry.delivered)]).sort();
    assert.deepEqual(await delivered(), [['session-first', false], ['session-second', true]]);
    assert.equal(((await video()).notesSent as { to: string }).to, 'second');
    // A view retrying the first send reuses its delivered request, then the record lands.
    await send('first');
    assert.deepEqual(await delivered(), [['session-first', true], ['session-second', true]]);
    assert.deepEqual({ ...(await video()).notesSent as object, at: undefined }, { to: 'first', at: undefined, fingerprint });
    // A view that lost the response after the record retries with a fresh request.
    await send('second');
    assert.deepEqual(pastes, ['session-first', 'session-second'], 'each agent gets the draft once');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
