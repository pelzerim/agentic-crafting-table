import { defineResourcePlugin } from '../../define.ts';

export const terminalSession = defineResourcePlugin({
  settingsHelp: 'Open a shell in your project folder to run commands. Shell configuration and command history are managed by your normal shell. Stopped terminals stay readable; choose New shell to start again.',
  id: 'terminal.session', apiVersion: 1, schemaVersion: 1,
  name: 'Terminal', icon: 'square-terminal', preferredView: 'focus',
  mapSizes: { defaultSize: 'large', sizes: {
    small: { width: 180, height: 48, summaryLines: 0, description: "Title and activity indicators." },
    medium: { width: 220, height: 84, summaryLines: 1, description: "Title and one activity-summary line." },
    large: { width: 240, height: 112, summaryLines: 1, fields: ['cwd'], fieldLines: 1, description: "Activity summary and working directory." },
  } },
  appearance: { tone: 'neutral', shape: 'terminal', size: 'large' },
  acceptsContext: false,
  fields: {
    sessionId: { label: 'Session ID', kind: 'text', required: true },
    workspaceId: { label: 'Workspace ID', kind: 'text', required: true },
    shell: { label: 'Shell', kind: 'text', required: true },
    cwd: { label: 'Working directory', kind: 'text', required: true },
  },
  creation: { label: 'Start terminal', requires: 'runtime', action: 'terminal.create', fields: { cwd: { label: 'Working directory', kind: 'directory', required: true, fromProject: 'workingDirectory', description: 'Defaults to the project, global default or most recent folder.' } } },
});
