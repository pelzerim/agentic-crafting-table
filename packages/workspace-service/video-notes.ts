import { FROM_TABLE, promptAgent } from './agent-prompt.ts';
import * as z from 'zod/v4';
import { createHash, randomUUID } from 'node:crypto';
import { HEAD_ATTEMPTS, applyAtHead } from './apply-at-head.ts';
import { canonical, type WorkspaceControl } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import { relatedResourceItems } from '../core/related-items.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { findById } from '../../src/graph/lookup.ts';
import { VIDEO_TYPE, parseVideoSource, pendingNotesSends } from '../../src/resource-plugins/items/video/source.ts';
// Sessions with a send in flight: a second send would interleave its paste with the first.
const sending = new Set<string>();
const schema = z.object({ sourceResourceId: z.string().min(1), targetNodeId: z.string().min(1), sessionId: z.string().min(1), requestId: z.string().uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const CHANGED = 'The notes changed. Check them and send again.';
const fingerprintOf = (notes: string) => createHash('sha256').update(notes).digest('hex');
/** Records the delivery and marks this send's entry delivered in one write, so any retry of the draft reuses the sent request. */
async function confirm(control: WorkspaceControl, nodeId: string, resourceId: string, sessionId: string, requestId: string, notesSent: { to: string; at: string; fingerprint: string }) {
  for (let attempt = 1; ; attempt++) {
    const data = findById((await control.read()).resources, resourceId)?.data;
    const { [sessionId]: mine, ...rest } = pendingNotesSends(data?.notesPending);
    if (!data || mine?.requestId !== requestId || mine.delivered) return;
    try {
      await applyAtHead(control, { commandId: randomUUID(), actor: { kind: 'system', id: 'video-notes' }, commands: [{ type: 'item.update', id: nodeId, data: { ...data, notesSent, notesPending: { ...rest, [sessionId]: { ...mine, delivered: true } } } }] },
        state => { if (canonical(findById(state.resources, resourceId)?.data) !== canonical(data)) throw new Error(CHANGED); });
      return;
    } catch (error) { if ((error as Error).message !== CHANGED || attempt >= HEAD_ATTEMPTS) throw error; }
  }
}
/** Sends the video's saved notes to a live linked agent when they are the draft the person saw. Each unconfirmed send
 * is saved in the item by session before the journaled job, so any view retrying the same draft reuses its request. */
export async function videoNotes(control: WorkspaceControl, store: SqliteStore, sessions: SessionCoordinator | undefined, nodeId: string, input: unknown) {
  const args = schema.parse(input), state = await control.read(), node = findById(state.nodes, nodeId);
  const resource = findById(state.resources, node?.resourceId), source = parseVideoSource(resource?.data.source);
  if (!node || isArchived(node, state.nodes) || resource?.pluginId !== VIDEO_TYPE || resource.id !== args.sourceResourceId || !source) throw new Error('These notes belong to another or archived video.');
  const notes = typeof resource.data.notes === 'string' ? resource.data.notes : '';
  if (!notes.trim()) throw new Error('Write some notes before sending them.');
  if (fingerprintOf(notes) !== args.fingerprint) throw new Error(CHANGED);
  const target = relatedResourceItems(state, nodeId, control.registry).find(r => r.nodeId === args.targetNodeId && r.resource?.pluginId === 'agent.session');
  if (!target || !sessions || target.resource?.data.sessionId !== args.sessionId) throw new Error('Choose a connected, running agent.');
  if (target.activity !== 'idle' || target.attention === 'input' || sending.has(args.sessionId)) throw new Error('Wait until the agent is ready for a new prompt.');
  sending.add(args.sessionId);
  try {
    const current = await sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId: args.sessionId, after: Number.MAX_SAFE_INTEGER });
    if (findById(state.nodes, current.session.nodeId)?.resourceId !== target.resource.id) throw new Error('The process belongs to a different agent.');
    if (current.session.native && current.session.native.status !== 'idle') throw new Error('Wait until the agent is ready for a new prompt.');
    if (current.session.state !== 'running' || current.session.stopRequestedAt || current.session.readOnly) throw new Error('Resume the agent before sending notes.');
    const fresh = await control.read(), data = findById(fresh.resources, resource.id)?.data;
    if (!data || data.notes !== notes) throw new Error(CHANGED);
    const stillLinked = relatedResourceItems(fresh, nodeId, control.registry).find(r => r.nodeId === target.nodeId);
    if (stillLinked?.resource?.data.sessionId !== args.sessionId || stillLinked.activity !== 'idle' || stillLinked.attention === 'input') throw new Error('The agent changed. Send the notes again.');
    const pending = pendingNotesSends(data.notesPending), held = pending[args.sessionId];
    const reuse = held?.targetNodeId === args.targetNodeId && held.fingerprint === args.fingerprint;
    const requestId = reuse ? held.requestId : args.requestId;
    if (!reuse) await applyAtHead(control, { commandId: randomUUID(), actor: { kind: 'system', id: 'video-notes' }, commands: [{ type: 'item.update', id: nodeId, data: { ...data, notesPending: { ...pending, [args.sessionId]: { requestId, targetNodeId: args.targetNodeId, sessionId: args.sessionId, fingerprint: args.fingerprint } } } }] },
      state => { if (canonical(findById(state.resources, resource.id)?.data) !== canonical(data)) throw new Error(CHANGED); });
    const job = store.enqueueJob(`video-notes:${requestId}`, { action: 'video.notes', nodeId, arguments: { ...args, requestId } });
    // Delivered already: a failed record leaves the entry unmarked, so the next retry records it again.
    const confirmed = () => confirm(control, nodeId, resource.id, args.sessionId, requestId, { to: target.title, at: new Date().toISOString(), fingerprint: args.fingerprint }).catch(() => {});
    if (job.state === 'succeeded') { await confirmed(); return { sent: true }; }
    if (job.state !== 'queued') throw new Error('Delivery could not be confirmed. Check the agent before sending again.');
    store.transitionJob(job.id, 'queued', 'running');
    const prompt = `Video: ${resource.title}\n${source.kind === 'file' ? `File: ${source.path}` : `URL: ${source.url}`}\nTimes written as [mm:ss] are positions in this video. These are my notes, verbatim:\n<notes>\n${notes}\n</notes>`;
    try {
      await promptAgent(sessions, args.sessionId, `${FROM_TABLE} Please read my notes on the video the pasted text describes:`, prompt);
      store.transitionJob(job.id, 'running', 'succeeded', { result: { sent: true } });
    } catch (error) { store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'Check the agent before sending again.' }); throw error; }
    await confirmed();
    return { sent: true };
  } finally { sending.delete(args.sessionId); }
}
