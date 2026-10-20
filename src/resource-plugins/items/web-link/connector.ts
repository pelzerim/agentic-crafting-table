import type { ResourcePluginConnector } from '../../types.ts';
import { parseWebUrl } from './definition.ts';
import { readPublicPageTitle } from './metadata.ts';

export function createWebLinkConnector(readTitle = readPublicPageTitle): ResourcePluginConnector {
  return {
    async load(resource, signal) {
      signal.throwIfAborted();
      const url = parseWebUrl(String(resource.data.url));
      if (!url) throw new Error('Invalid web URL');
      let title: string | undefined;
      try { title = (await readTitle(url.href, signal))?.trim(); }
      catch (error) { if (signal.aborted) throw error; }
      signal.throwIfAborted();
      return { title: title || url.hostname, activity: 'idle', attention: 'none', connection: 'connected',
        label: title ? url.hostname : `${url.hostname} · page title unavailable`, observedAt: new Date().toISOString() };
    },
    actions: () => [{ id: 'reference', label: 'Get web link', readOnly: true }],
    async execute(resource) { return { url: String(resource.data.url), title: resource.title }; },
    async getContext(resource) {
      return { resourceId: resource.id, title: resource.title, content: resource.title, sourceUrl: String(resource.data.url) };
    },
  };
}

export const webLinkConnector = createWebLinkConnector();
