import { defineResourcePlugin } from '../../define.ts';
import { lastPathPart } from '../../generated-title.ts';

/** An absolute path or one under the home directory, on one line, that does not end at a folder. */
const FILE_PATH = String.raw`^(?:~\/|\/).*[^\/\r\n]$`;

/** A file on this computer, edited in place. The workspace keeps its path and never its content. */
export const textFile = defineResourcePlugin({
  settingsHelp: 'Edit a file on this computer: code with highlighting, Markdown with a preview. The workspace keeps only the path; the text stays in the file, so other programs and agents see every save.',
  id: 'workspace.text', apiVersion: 1, schemaVersion: 1, name: 'Text file', icon: 'file', preferredView: 'focus',
  view: { width: 1040, height: 760, minWidth: 520 },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 180, height: 48, summaryLines: 0, description: 'File name.' },
    medium: { width: 260, height: 96, summaryLines: 0, fields: ['path'], fieldLines: 2, description: 'File name and path.' },
    large: { width: 320, height: 240, summaryLines: 0, nodeView: true, description: 'File name and the start of the file.' },
  } },
  appearance: { tone: 'stone', shape: 'document', size: 'small', width: 180, showFullTitle: true },
  creation: { label: 'Add text file', titleFromPath: 'path' },
  context: { fields: ['path', 'language'] },
  fields: {
    path: { label: 'File', kind: 'file', required: true, pattern: FILE_PATH, placeholder: '/path/to/file.md',
      description: 'An absolute path, or one under ~/. A file that does not exist yet is created by the first save.' },
    language: { label: 'Language', kind: 'text', placeholder: 'From the file name', description: 'Only for a file whose name does not tell, e.g. Markdown, TypeScript or Shell.' },
  },
  matchInput: input => new RegExp(FILE_PATH).test(input) && !input.startsWith('//') && !input.startsWith('/*')
    ? { title: lastPathPart(input)!, data: { path: input } } : undefined,
});
