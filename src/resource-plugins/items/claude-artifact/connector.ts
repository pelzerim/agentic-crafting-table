import type { ResourcePluginConnector } from '../../types.ts';
import { defaultArtifactTitle, parseClaudeArtifactUrl } from './url.ts';

/** Artifact pages need the user's claude.ai sign-in, so nothing is fetched here:
 * the title is the one saved by the person or the publishing agent. */
export const claudeArtifactConnector: ResourcePluginConnector = {
  async load(resource, signal) {
    signal.throwIfAborted();
    const parsed = parseClaudeArtifactUrl(resource.data.url);
    if (!parsed) throw new Error('This artifact has no claude.ai link');
    return { title: resource.title.trim() || defaultArtifactTitle(parsed.id), activity: 'idle', attention: 'none', connection: 'connected',
      label: 'Private Claude artifact', observedAt: new Date().toISOString() };
  },
  actions: () => [{ id: 'reference', label: 'Get artifact link', readOnly: true }],
  async execute(resource) { return { url: String(resource.data.url ?? ''), title: resource.title }; },
  async getContext(resource) {
    const url = parseClaudeArtifactUrl(resource.data.url)?.url;
    return { resourceId: resource.id, title: resource.title, content: `${resource.title}${url ? ` (private Claude artifact: ${url})` : ''}`, ...(url ? { sourceUrl: url } : {}) };
  },
};
