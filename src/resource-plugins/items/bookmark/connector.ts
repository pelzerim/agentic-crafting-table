import type { ResourcePluginConnector } from '../../types.ts';

/** Local metadata only. Reading this item never fetches its URL. */
export const bookmarkConnector: ResourcePluginConnector = {
  async load(resource) {
    return { activity: 'idle', attention: 'none', connection: 'connected', label: String(resource.data.url), observedAt: new Date().toISOString() };
  },
  actions: () => [{ id: 'reference', label: 'Get reference', readOnly: true }],
  async execute(resource) { return { text: `${resource.title}: ${resource.data.url}` }; },
  async getContext(resource) {
    return { resourceId: resource.id, title: resource.title, content: String(resource.data.notes ?? ''), sourceUrl: String(resource.data.url) };
  },
};
