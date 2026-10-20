import { isResourceUrl } from '../../../src/resource-plugins/url-input.ts';

type LinkTransfer = Pick<DataTransfer, 'types' | 'getData'>;
const linkTypes = ['text/uri-list', 'text/x-moz-url', 'text/plain'];

/** Drag-over exposes types, but browsers protect the payload until drop. */
export function mayContainUrl(data: LinkTransfer): boolean {
  return !data.types.includes('Files') && linkTypes.some(type => data.types.includes(type));
}

/** Use link identity ahead of its display text. Never interpret HTML or files. */
export function droppedUrl(data: LinkTransfer): string | undefined {
  if (!mayContainUrl(data)) return;
  for (const type of linkTypes) {
    const value = data.getData(type);
    if (!value || value.length > 65536) continue;
    const lines = value.split(/\r?\n/);
    const candidates = type === 'text/uri-list' ? lines.filter(line => !line.trim().startsWith('#'))
      : type === 'text/x-moz-url' ? lines.filter((_line, index) => index % 2 === 0) : [value];
    for (const candidate of candidates) {
      const url = candidate.trim();
      if (!/\s/.test(url) && isResourceUrl(url)) return url;
    }
  }
}
