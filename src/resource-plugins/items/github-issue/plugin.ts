import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { GITHUB_ISSUE_PULLS_OPERATION, githubIssue } from './definition.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [githubIssue],
  runtimeOperations: [{ id: GITHUB_ISSUE_PULLS_OPERATION, description: 'Count, or add to the map, the pull requests GitHub links to an issue.', agentPolicy: { operations: { options: 'allow' }, otherwise: 'actsForPerson' } }],
  settings: { typeId: githubIssue.id, label: 'Assigned issues', description: 'Open GitHub issues assigned to you can wait in the inbox at the top of the to-do list. Take one into Next or Later to make it a to-do, or mark it Not for me.',
    connectionHint: 'Connect GitHub in Settings → Connections to import your assigned issues.',
    fields: {
      importAssigned: { label: 'Show my assigned GitHub issues in the to-do inbox', kind: 'boolean', default: false, description: 'Checks GitHub every two minutes. Turning this off stops the import and keeps the to-dos and inbox issues you already have.' },
    } },
};
export default plugin;
