import { defineResourcePlugin } from '@agent-crafting-table/plugin-sdk/index.ts';
import type { JsonObject } from '@agent-crafting-table/plugin-sdk/index.ts';

export const TYPE_ID = 'reading-list.link';
export const READ_STATE = 'reading-list.read-state';
export const UNREAD = 'reading-list.unread';
export const MAX_TAGS = 5;

/** "design, Long Read ,," → ["design", "long-read"]. Tags are lowercase words joined by dashes. */
export function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map(tag => tag.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
}

export function validTags(data: JsonObject): boolean {
  const tags = parseTags(data.tags);
  return tags.length <= MAX_TAGS && tags.every(tag => /^[a-z0-9][a-z0-9-]{0,23}$/.test(tag));
}

export const readingLink = defineResourcePlugin({
  id: TYPE_ID, apiVersion: 1, schemaVersion: 1,
  name: 'Reading link', icon: 'bookmark',
  settingsHelp: 'A page to read later, with a note and tags. The app checks the link and tells you when it breaks.',
  preferredView: 'inspector', view: { width: 560, height: 420 },
  appearance: { tone: 'stone', shape: 'document', size: 'small' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 200, height: 48, summaryLines: 0, description: 'Title and Needs me.' },
    medium: { width: 240, height: 84, summaryLines: 1, description: 'Adds read state and site.' },
    large: { width: 260, height: 124, summaryLines: 1, fields: ['tags', 'note'], fieldLines: 2, description: 'Adds tags and the note.' },
  } },
  creation: { label: 'Add to reading list', shortLabel: 'Reading' },
  webLink: { label: 'Open in browser', template: '{url}' },
  contextMenu: [{ id: 'read-state', label: 'Read state', children: [], choices: { load: 'options', apply: 'set', runtime: READ_STATE } }],
  context: { fields: ['url', 'tags'] },
  fields: {
    url: { label: 'URL', kind: 'url', required: true, pattern: '^https://\\S+$', description: 'An https:// page.' },
    note: { label: 'Note', kind: 'text', multiline: true, rows: 3, description: 'Why you saved it.' },
    tags: { label: 'Tags', kind: 'text', description: `Comma-separated, up to ${MAX_TAGS}.` },
  },
  validateData: validTags,
});
