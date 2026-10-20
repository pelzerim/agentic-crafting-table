import type { ResourcePluginConnector } from '../../types.ts';

/** Local task content; completion and membership come from the workspace graph. */
export const todoConnector: ResourcePluginConnector = {
  async load(resource) {
    return { title: resource.title, activity: 'idle', attention: 'none', connection: 'connected', label: 'Local to-do', observedAt: new Date().toISOString() };
  },
  async getContext(resource) {
    return { resourceId: resource.id, title: resource.title, content: `Task: ${resource.title}` };
  },
};
