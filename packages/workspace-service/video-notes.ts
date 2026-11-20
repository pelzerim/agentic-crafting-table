import { FROM_TABLE, promptAgent } from './agent-prompt.ts';
import * as z from 'zod/v4';
import type { WorkspaceControl } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import { relatedResourceItems } from '../core/related-items.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { findById } from '../../src/graph/lookup.ts';
import { VIDEO_TYPE, parseVideoSource } from '../../src/resource-plugins/items/video/source.ts';
// Sessions with a send in flight: a second send would interleave its paste with the first.
const sending = new Set<string>();
const schema = z.object({ sourceResourceId: z.string().min(1), targetNodeId: z.string().min(1), sessionId: z.string().min(1), requestId: z.string().uuid() }).strict();
/** Sends the video's saved notes to a live linked agent, journaled before input so a lost response cannot send them twice. */
export async function videoNotes(control: WorkspaceControl, store: SqliteStore, sessions: SessionCoordinator | undefined, nodeId: string, input: unknown) {
  const args = schema.parse(input), state = await control.read(), node = findById(state.nodes, nodeId);
  const resource = findById(state.resources, node?.resourceId), source = parseVideoSource(resource?.data.source);
  if (!node || isArchived(node, state.nodes) || resource?.pluginId !== VIDEO_TYPE || resource.id !== args.sourceResourceId || !source) throw new Error('These notes belong to another or archived video.');
  const notes = typeof resource.data.notes === 'string' ? resource.data.notes : '';
  if (!notes.trim()) throw new Error('Write some notes before sending them.');
  const target = relatedResourceItems(state, nodeId, control.registry).find(r => r.nodeId === args.targetNodeId && r.resource?.pluginId === 'agent.session');
  if (!target || !sessions || target.resource?.data.sessionId !== args.sessionId) throw new Error('Choose a connected, running agent.');
  if (target.activity !== 'idle' || target.attention === 'input' || sending.has(args.sessionId)) throw new Error('Wait until the agent is ready for a new prompt.');
  sending.add(args.sessionId);
  try {
    const current = await sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId: args.sessionId, after: Number.MAX_SAFE_INTEGER });
    if (findById(state.nodes, current.session.nodeId)?.resourceId !== target.resource.id) throw new Error('The process belongs to a different agent.');
    if (current.session.native && current.session.native.status !== 'idle') throw new Error('Wait until the agent is ready for a new prompt.');
    if (current.session.state !== 'running' || current.session.stopRequestedAt || current.session.readOnly) throw new Error('Resume the agent before sending notes.');
    const fresh = await control.read();
    if (findById(fresh.resources, resource.id)?.data.notes !== notes) throw new Error('The notes changed. Send them again.');
    const stillLinked = relatedResourceItems(fresh, nodeId, control.registry).find(r => r.nodeId === target.nodeId);
    if (stillLinked?.resource?.data.sessionId !== args.sessionId || stillLinked.activity !== 'idle' || stillLinked.attention === 'input') throw new Error('The agent changed. Send the notes again.');
    const job = store.enqueueJob(`video-notes:${args.requestId}`, { action: 'video.notes', nodeId, arguments: { ...args } });
    if (job.state === 'succeeded') return { sent: true };
    if (job.state !== 'queued') throw new Error('Delivery could not be confirmed. Check the agent before sending again.');
    store.transitionJob(job.id, 'queued', 'running');
    const prompt = `Video: ${resource.title}\n${source.kind === 'file' ? `File: ${source.path}` : `URL: ${source.url}`}\nTimes written as [mm:ss] are positions in this video. These are my notes, verbatim:\n<notes>\n${notes}\n</notes>`;
    try {
      await promptAgent(sessions, args.sessionId, `${FROM_TABLE} Please read my notes on the video the pasted text describes:`, prompt);
      store.transitionJob(job.id, 'running', 'succeeded', { result: { sent: true } });
      return { sent: true };
    } catch (error) { store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'Check the agent before sending again.' }); throw error; }
  } finally { sending.delete(args.sessionId); }
}
