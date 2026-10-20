import { defineResourcePlugin } from '../../define.ts';

/** Completion uses the host node's completedAt, shared with Mark done/reopen. */
export const todoItem = defineResourcePlugin({
  settingsHelp: 'Track a small task with a checkbox and editable text. Click to edit, mark it done, and find it in the to-do list; it never opens a full view.',
  id: 'workspace.todo', apiVersion: 1, schemaVersion: 1,
  name: 'To-do', icon: 'square', preferredView: 'focus',
  view: { mode: 'inline' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 220, height: 48, summaryLines: 0, description: "Checkbox and editable text. Completed tasks retain their text." },
  } },
  appearance: { tone: 'mint', shape: 'rounded', size: 'small', width: 220, showFullTitle: true, editableTitle: true, completedIcon: 'square-check', completionToggle: true },
  creation: { label: 'Add to-do' },
  fields: {},
  // Accept retired v1 notes without exposing a field or erasing historical data.
  validateData: data => data.notes === undefined || typeof data.notes === 'string',
});
