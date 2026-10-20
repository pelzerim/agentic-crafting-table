import type { ResourcePluginConnector } from '../../types.ts';

/** Local reads/context only: no network, credentials or process execution. */
export const noteConnector: ResourcePluginConnector = {
  async load(resource) {
    return { title: resource.title, activity: 'idle', attention: 'none', connection: 'connected', label: 'Local note',
      detail: { text: String(resource.data.text) }, observedAt: new Date().toISOString() };
  },
  async getContext(resource) {
    return { resourceId: resource.id, title: resource.title, content: String(resource.data.text) };
  },
};
