import { defineResourcePlugin } from '../../define.ts';
import { NOTE_DISPLAYS } from '../../../graph/badges.ts';

export const NOTE_PAPERS = ['mint', 'sky', 'lilac', 'peach', 'slate'] as const;
const grow = { field: 'text', min: 3, max: 14, footerField: 'writer' };

/** Plain local text, independent from tasks and external document providers. */
export const noteItem = defineResourcePlugin({
  settingsHelp: 'Write on the map. Click a note to type where you clicked, or drag it by its tape or edge. When you leave it, the first line is bold and lists, checkboxes, code and links render; the title helper names it for zoomed-out views. Notes have no full view.',
  id: 'workspace.note', apiVersion: 1, schemaVersion: 2,
  name: 'Note', icon: 'file-text', preferredView: 'focus',
  view: { mode: 'inline' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 160, height: 88, summaryLines: 0, growLines: grow, description: 'Narrow paper that grows with its text from 3 to 14 lines.' },
    medium: { width: 220, height: 88, summaryLines: 0, growLines: grow, description: 'Medium paper that grows with its text from 3 to 14 lines.' },
    large: { width: 300, height: 88, summaryLines: 0, growLines: grow, description: 'Wide paper that grows with its text from 3 to 14 lines.' },
  } },
  appearance: { tone: 'mint', shape: 'document', size: 'small', width: 160, paper: { textField: 'text', paperField: 'paper' } },
  generatedTitle: { field: 'text' },
  authorship: { field: 'writer' },
  creation: { label: 'Add note', hotkey: 'n' },
  fields: {
    text: { label: 'Text', kind: 'text', multiline: true, rows: 8, required: true },
    paper: { label: 'Paper', kind: 'select', options: NOTE_PAPERS, optionLabels: { mint: 'Mint', sky: 'Sky', lilac: 'Lilac', peach: 'Peach', slate: 'Slate' },
      menu: { label: 'Colour', swatches: Object.fromEntries(NOTE_PAPERS.map(paper => [paper, `var(--act-paper-${paper})`])), fallback: 'mint' } },
    display: { label: 'Show as', kind: 'select', options: NOTE_DISPLAYS, optionLabels: { auto: 'Automatic: one or two words become a badge', badge: 'Badge, up to 24 characters', note: 'Note' },
      form: false, menu: { label: 'Show as', options: ['note', 'badge'], optionLabels: { note: 'Note', badge: 'Badge' } } },
  },
  migrations: [{ fromVersion: 1, toVersion: 2, migrate: data => data }],
  validateData: data => data.writer === undefined || (typeof data.writer === 'object' && data.writer !== null && !Array.isArray(data.writer)
    && data.writer.kind === 'agent' && typeof data.writer.name === 'string' && typeof data.writer.at === 'string'),
});
