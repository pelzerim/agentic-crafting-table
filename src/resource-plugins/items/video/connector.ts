import type { ResourcePluginConnector } from '../../types.ts';
import { parseVideoSource, videoTitle } from './source.ts';

/** Nothing is fetched: the title is the saved one, else the file name or "YouTube video". */
export const videoConnector: ResourcePluginConnector = {
  async load(resource, signal) {
    signal.throwIfAborted();
    const source = parseVideoSource(resource.data.source);
    if (!source) throw new Error('This video has no file or YouTube link');
    return { title: resource.title.trim() || videoTitle(source), activity: 'idle', attention: 'none', connection: 'connected',
      label: source.kind === 'file' ? 'Video file' : 'YouTube video', observedAt: new Date().toISOString() };
  },
  async getContext(resource) {
    const source = parseVideoSource(resource.data.source);
    return { resourceId: resource.id, title: resource.title, content: `${resource.title} (video: ${String(resource.data.source ?? '')})`,
      ...(source?.kind === 'youtube' ? { sourceUrl: source.url } : {}) };
  },
};
