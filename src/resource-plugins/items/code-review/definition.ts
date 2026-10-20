import { defineResourcePlugin } from '../../define.ts';

export const codeReview = defineResourcePlugin({
  settingsHelp: 'Inspect a one-off Claude or Codex review attached to its pull request. Start it from the PR, then open this item to triage its findings and send the ones worth fixing to a connected agent.',
  id: 'code.review', apiVersion: 1, schemaVersion: 1,
  name: 'Code review', icon: 'review', preferredView: 'focus',
  view: { width: 1040, height: 720, minWidth: 750 },
  providerBrands: { claude: 'claude', codex: 'codex' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 150, height: 48, summaryLines: 0, description: "Review title and progress/attention." },
    medium: { width: 240, height: 112, summaryLines: 2, pips: 'findings.pips', description: "Findings by severity, what was sent, fixed and ignored, or the review's progress." },
  } },
  appearance: { tone: 'copper', shape: 'artifact', size: 'small', brandTint: true },
  acceptsContext: false,
  context: { parentField: 'sourcePrId', fields: ['provider', 'model', 'baseSha', 'headSha'] },
  fields: {
    provider: { label: 'Provider', kind: 'select', required: true, options: ['claude', 'codex'] },
    sessionId: { label: 'Session ID', kind: 'text', pattern: '\\S' },
    sourcePrId: { label: 'Source PR ID', kind: 'text', required: true },
    baseSha: { label: 'Base revision', kind: 'text', pattern: '\\S' },
    headSha: { label: 'Head revision', kind: 'text', required: true },
    model: { label: 'Model', kind: 'text', required: true },
  },
});
