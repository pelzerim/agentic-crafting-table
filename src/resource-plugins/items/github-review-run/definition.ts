import { defineResourcePlugin } from '../../define.ts';

export const githubReviewRun = defineResourcePlugin({
  settingsHelp: 'Track a repository review triggered by a /review comment. Start it from a PR and use this item to follow the workflow and open its result.',
  id: 'github.review-run', apiVersion: 1, schemaVersion: 1,
  name: 'Workflow review', icon: 'review', preferredView: 'focus',
  brand: 'github',
  context: { parentField: 'sourcePrId', fields: ['repository'] },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 150, height: 48, summaryLines: 0, description: "Review title and progress/attention." },
    medium: { width: 240, height: 112, summaryLines: 2, fields: ['repository'], fieldLines: 1, description: "Saved workflow state and repository." },
  } },
  appearance: { tone: 'violet', shape: 'branch', size: 'small', brandTint: true },
  fields: {
    requestId: { label: 'Request ID', kind: 'text', required: true },
    sourcePrId: { label: 'Source PR ID', kind: 'text', required: true },
    repository: { label: 'Repository', kind: 'text', required: true },
  },
});
