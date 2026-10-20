import { randomUUID } from 'node:crypto';
import type { WorkspaceControl, WorkspaceCommand, WorkspaceState } from '../core/control.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { defaultArtifactTitle, parseClaudeArtifactUrl } from '../../src/resource-plugins/items/claude-artifact/url.ts';
import type { ClaudeArtifactUrl } from '../../src/resource-plugins/items/claude-artifact/url.ts';

export interface PublishedArtifact { nodeId: string; processSessionId: string; nativeSessionId: string; url: string; title?: string }

const linked = (state: WorkspaceState, a: string, b: string) => state.links.some(link => (link.sourceId === a && link.targetId === b) || (link.sourceId === b && link.targetId === a));
const identity = (artifact: ClaudeArtifactUrl) => `${artifact.kind}:${artifact.id}`;

/** The PR an agent's artifact explains: an architecture run's own source, otherwise
 * the one pull request the agent is connected to. Several connected PRs are ambiguous. */
function sourcePullRequest(state: WorkspaceState, agentId: string, architecture: { sourcePrId?: unknown } | undefined) {
  const available = (id: unknown) => {
    const node = state.nodes.find(node => node.id === id);
    return node && !isArchived(node, state.nodes) && state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'github.pull-request' ? node : undefined;
  };
  if (architecture?.sourcePrId) return available(architecture.sourcePrId);
  const connected = [...new Set(state.links.flatMap(link => link.sourceId === agentId ? [link.targetId] : link.targetId === agentId ? [link.sourceId] : []))].map(available).filter(Boolean);
  return connected.length === 1 ? connected[0] : undefined;
}

/** Puts an artifact a table-managed Claude session published next to it, connected to
 * the agent and its source PR. The same artifact URL always resolves to the same item. */
export async function attachPublishedArtifact(control: WorkspaceControl, changed: () => Promise<void>, published: PublishedArtifact) {
  const artifact = parseClaudeArtifactUrl(published.url);
  if (!artifact) throw new Error('Not a claude.ai artifact URL');
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await control.read(), agent = state.nodes.find(node => node.id === published.nodeId);
    const session = state.resources.find(resource => resource.id === agent?.resourceId);
    if (!agent || !session || isArchived(agent, state.nodes) || session.data.sessionId !== published.processSessionId
      || session.data.nativeSessionId !== published.nativeSessionId || session.data.provider !== 'claude') return { ignored: true };
    const architecture = session.data.architecture as { sourcePrId?: unknown; headSha?: unknown } | undefined;
    const pr = sourcePullRequest(state, agent.id, architecture);
    const matches = new Set(state.resources.filter(resource => resource.pluginId === 'claude.artifact' && (() => {
      const saved = parseClaudeArtifactUrl(resource.data.url); return saved && identity(saved) === identity(artifact);
    })()).map(resource => resource.id));
    const candidates = state.nodes.filter(node => node.resourceId && matches.has(node.resourceId) && !isArchived(node, state.nodes));
    const existing = candidates.find(node => node.projectId === agent.projectId) ?? candidates[0];
    const commands: WorkspaceCommand[] = [];
    let targetId: string;
    if (existing) {
      targetId = existing.id;
      if (published.title && existing.title === defaultArtifactTitle(artifact.id)) commands.push({ type: 'node.update', id: existing.id, title: published.title });
    } else {
      targetId = randomUUID();
      const placed = state.links.filter(link => link.sourceId === agent.id && state.resources.find(resource => resource.id === state.nodes.find(node => node.id === link.targetId)?.resourceId)?.pluginId === 'claude.artifact').length;
      commands.push({ type: 'item.create', id: targetId, ...(agent.projectId ? { projectId: agent.projectId } : {}), position: { x: agent.position.x, y: agent.position.y + 150 + placed * 70 },
        resource: { id: randomUUID(), pluginId: 'claude.artifact', schemaVersion: 2, title: published.title ?? defaultArtifactTitle(artifact.id), data: {
          url: artifact.url, artifactId: artifact.id, sessionId: published.processSessionId,
          ...(pr ? { sourcePrId: pr.id } : {}), ...(pr && typeof architecture?.headSha === 'string' ? { headSha: architecture.headSha } : {}) } } });
    }
    if (!linked(state, agent.id, targetId)) commands.push({ type: 'link.save', link: { id: randomUUID(), sourceId: agent.id, targetId, kind: 'reference', label: 'Artifact' } });
    if (pr && !linked(state, pr.id, targetId)) commands.push({ type: 'link.save', link: { id: randomUUID(), sourceId: pr.id, targetId, kind: 'reference', label: 'Artifact' } });
    if (!commands.length) return { nodeId: targetId };
    try {
      await control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: published.processSessionId }, commands });
      await changed(); return { nodeId: targetId };
    } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
  }
  throw new Error('The table kept changing while adding the published artifact');
}
