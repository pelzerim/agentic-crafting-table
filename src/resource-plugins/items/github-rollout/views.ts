import type { ResourcePluginViews } from '../../types.ts';
import { mountRolloutTimeline } from './timeline-view.ts';

export const githubRolloutViews: ResourcePluginViews = {
  identity: resource => JSON.stringify([resource.connectionId, resource.data]),
  mountDetail: (container, resource, services) => mountRolloutTimeline(container, resource, services),
};
