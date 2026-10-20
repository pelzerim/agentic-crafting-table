import type { ResourcePluginViews } from '../../types.ts';
import { parseWebUrl } from './definition.ts';

export const webLinkViews: ResourcePluginViews = {
  mountDetail(container, resource) {
    const link = container.ownerDocument.createElement('a');
    const url = parseWebUrl(String(resource.data.url));
    if (!url) throw new Error('Invalid web URL');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = resource.title;
    container.append(link);
    return {
      update(snapshot) { if (snapshot.title) link.textContent = snapshot.title; },
      dispose() { link.remove(); },
    };
  },
};
