import { defineResourcePlugin } from '../../define.ts';
import { VIDEO_TYPE, parseVideoSource, videoTitle } from './source.ts';

/** A video file on this computer or a YouTube video, played inside the item. The workspace keeps only the path or link. */
export const video = defineResourcePlugin({
  settingsHelp: 'Watch a video next to your work: a file on this computer (.mp4, .mov, .m4v or .webm) or a YouTube link. Paste or drop either on the map; the video plays inside the item.',
  id: VIDEO_TYPE, apiVersion: 1, schemaVersion: 1, name: 'Video', icon: 'video', preferredView: 'focus',
  view: { width: 1120, height: 700, minWidth: 480 },
  webLink: { label: 'Open on YouTube', template: '{source}' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 180, height: 48, summaryLines: 0, description: 'Video title.' },
  } },
  appearance: { tone: 'rose', shape: 'rounded', size: 'small', width: 180, showFullTitle: true },
  creation: { label: 'Add video', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://www.youtube.com/watch?v=…' },
  context: { fields: ['source'] },
  fields: { source: { label: 'Video', kind: 'file', required: true } },
  providerIdentity: data => {
    const source = parseVideoSource(data.source);
    return source?.kind === 'youtube' ? `youtube:${source.id}` : source ? `file:${source.path}` : undefined;
  },
  validateData: data => Boolean(parseVideoSource(data.source)),
  matchInput(input) {
    const source = parseVideoSource(input);
    return source ? { title: videoTitle(source), data: { source: source.kind === 'file' ? source.path : input.trim() } } : undefined;
  },
});
