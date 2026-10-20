import * as z from 'zod/v4';
import type { WorkspaceState } from '../core/control.ts';
import { isBelow } from '../../src/graph/archive.ts';
import type { SavedSessionOption } from '../../src/resource-plugins/types.ts';

export const savedSessionsSchema = z.object({ pluginId: z.string().min(1).max(200), query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), provider: z.string().max(100).default('claude'), cursor: z.string().max(4000).optional() });

/** Only the host reads native metadata. No transcript bodies cross into the renderer. */
export async function discoverClaudeSessions(state: WorkspaceState, query = '', offset = 0) {
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
  const native = await listSessions({ includeProgrammatic: true });
  const options = new Map<string, SavedSessionOption>();
  for (const session of native) options.set(session.sessionId, {
    id: session.sessionId, title: (session.customTitle || session.summary || 'Claude session').replace(/\s+/g, ' ').slice(0, 240),
    cwd: session.cwd ?? '', modifiedAt: session.lastModified, branch: session.gitBranch,
    ...(!session.cwd ? { unavailable: 'The saved conversation has no working directory.' } : {}),
  });
  for (const node of state.nodes) {
    const resource = state.resources.find(resource => resource.id === node.resourceId);
    if (resource?.data.provider !== 'claude' || typeof resource.data.nativeSessionId !== 'string') continue;
    const id = resource.data.nativeSessionId, prior = options.get(id);
    options.set(id, { ...prior, id, title: node.title, cwd: String(resource.data.cwd ?? prior?.cwd ?? ''), nodeId: node.id,
      projectTitle: state.nodes.find(project => project.id === node.projectId)?.title,
      modifiedAt: prior?.modifiedAt ?? 0, ...(node.archivedAt ? { unavailable: 'Restore this archived item before resuming it.' } : isBelow(node, state.nodes) ? { unavailable: 'Bring this item back from Undermap before resuming it.' } : {}) });
  }
  const search = query.toLocaleLowerCase();
  const sorted = [...options.values()].filter(session => `${session.title} ${session.cwd} ${session.branch ?? ''}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id));
  return { sessions: sorted.slice(offset, offset + 50), total: sorted.length, ...(offset + 50 < sorted.length ? { nextOffset: offset + 50 } : {}) };
}

export async function resolveClaudeSession(id: string) {
  z.string().uuid().parse(id);
  const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
  const saved = await getSessionInfo(id);
  if (!saved) throw new Error('This Claude conversation is no longer available on this computer. Refresh the session list.');
  if (!saved.cwd) throw new Error('The saved Claude conversation has no working directory.');
  return { nativeSessionId: id, cwd: saved.cwd };
}

export const creationOptionsSchema = z.object({ pluginId: z.string().min(1).max(200), field: z.string().min(1).max(200), values: z.record(z.string(), z.json()).default({}) });
