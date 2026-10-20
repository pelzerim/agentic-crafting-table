import { defineResourcePlugin } from '../../define.ts';

export function parseWebUrl(input: string): URL | undefined {
  try {
    const url = new URL(input.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

export const webLink = defineResourcePlugin({
  settingsHelp: 'Keep a website alongside your work. Add its URL with From URL; clicking the item opens the page in your browser.',
  id: 'web.link', apiVersion: 1, schemaVersion: 1, name: 'Web link', icon: 'globe',
  preferredView: 'focus', activation: { kind: 'browser', urlField: 'url' }, webLink: { label: 'Open in browser', template: '{url}' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 200, height: 48, summaryLines: 0, description: "Title and site icon." },
    medium: { width: 240, height: 96, summaryLines: 0, fields: ['url'], fieldLines: 2, description: "Title and URL." },
  } },
  appearance: { tone: 'blue', shape: 'rounded', size: 'small', width: 200, showFullTitle: true },
  creation: { label: 'Add web link', action: 'resource.attach', mode: 'url', urlFallback: true, urlPlaceholder: 'https://example.com' },
  fields: { url: { label: 'URL', kind: 'url', required: true } },
  validateData: data => typeof data.url === 'string' && Boolean(parseWebUrl(data.url)),
  matchInput(input) {
    const url = parseWebUrl(input);
    return url ? { title: url.hostname, data: { url: url.href } } : undefined;
  },
});
