import { providerLabels, modelLabels } from '../../../agents/display-names.ts';
import { defineResourcePlugin } from '../../define.ts';

export const agentSession = defineResourcePlugin({
  settingsHelp: 'Run {name} in a real terminal to work on a project. Start a new session or continue an existing conversation; connect items to give the agent context.',
  id: 'agent.session',
  apiVersion: 1,
  schemaVersion: 1,
  name: 'Agent session',
  icon: 'robot',
  providerBrands: { claude: 'claude', codex: 'codex' },
  mapSizes: { defaultSize: 'large', sizes: {
    small: { width: 180, height: 48, summaryLines: 0, description: "Title and activity indicators." },
    medium: { width: 220, height: 84, summaryLines: 1, description: "Title and one activity-summary line." },
    large: { width: 240, height: 112, summaryLines: 2, showType: true, description: "Provider/type and two activity-summary lines." },
  } },
  appearance: { tone: 'teal', shape: 'terminal', size: 'large', editableViewTitle: true },
  preferredView: 'focus',
  view: { variants: { field: 'provider', options: { claude: 'Claude', codex: 'Codex' } } },
  acceptsContext: true,
  activityTitle: { defaults: ['Claude session', 'Codex session'] },
  fields: {
    sessionId: { label: 'Session ID', kind: 'text', required: true },
    provider: { label: 'Provider', kind: 'text', required: true },
  },
  creation: { label: 'Start agent', shortLabel: 'Agent', labelByField: { field: 'provider', labels: { claude: 'Start Claude', codex: 'Start Codex' } }, requires: 'runtime', action: 'agent.create', resume: true, fields: {
    provider: { label: 'Provider', kind: 'select', options: ['claude', 'codex'], optionLabels: providerLabels, optionBrands: { claude: 'claude', codex: 'codex' }, default: 'claude', required: true },
    cwd: { label: 'Working directory', kind: 'directory', fromProject: 'workingDirectory', description: 'Defaults to the project, global default or most recent folder.' },
    model: { label: 'Model', kind: 'select', options: ['opus', 'fable', 'sonnet', 'haiku'], optionsSource: 'agent.models', optionLabels: modelLabels, dependsOn: 'provider', default: 'opus', required: true },
  } },
});
