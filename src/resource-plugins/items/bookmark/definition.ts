import { defineResourcePlugin } from '../../define.ts';

/** A provider-free example to copy when adding a new item. */
export const bookmark = defineResourcePlugin({
  settingsHelp: 'A saved web reference with its original URL and notes. Open or edit existing bookmarks; use From URL for new web links.',
  id: 'web.bookmark', apiVersion: 1, schemaVersion: 1, name: 'Bookmark', icon: 'bookmark',
  preferredView: 'focus', creation: { label: 'Add bookmark', group: 'url' }, webLink: { label: 'Open in browser', template: '{url}' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 150, height: 48, summaryLines: 0, description: "Bookmark title." },
    medium: { width: 240, height: 112, summaryLines: 0, fields: ['url', 'notes'], fieldLines: 3, description: "Title, URL and saved notes." },
  } },
  appearance: { tone: 'blue', shape: 'document', size: 'small' },
  fields: {
    url: { label: 'URL', kind: 'url', required: true },
    notes: { label: 'Notes', kind: 'text', multiline: true },
  },
  // Legacy field creation and saved notes stay compatible; its picker shortcut joins From URL.
  // No universal URL matcher: a pasted GitHub PR should remain a PR suggestion.
});
