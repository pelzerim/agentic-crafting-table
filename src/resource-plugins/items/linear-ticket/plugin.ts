import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { LINEAR_PULLS_OPERATION, linearTicket } from './definition.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [linearTicket],
  runtimeOperations: [{ id: LINEAR_PULLS_OPERATION, description: 'Count, or add to the map, the GitHub pull requests linked to a Linear ticket.', agentPolicy: { operations: { options: 'allow' }, otherwise: 'humanOnly' } }],
  settings: { typeId: linearTicket.id, label: 'Assigned tickets', description: 'Open tickets assigned to you in Linear wait in the From Linear inbox at the top of the to-do list. Take one into Next or Later to make it a to-do, or mark it Not for me.',
    connectionHint: 'Connect Linear in Settings → Connections to import your assigned tickets.',
    fields: {
      importAssigned: { label: 'Show my assigned Linear tickets in the to-do inbox', kind: 'boolean', default: true, description: 'Checks Linear every two minutes. Turning this off stops the import and keeps the to-dos and inbox tickets you already have.' },
      triageStateTypes: { label: 'Ticket statuses that go to the inbox', kind: 'multiselect', options: ['triage', 'backlog', 'unstarted', 'started'], optionLabels: { triage: 'Triage', backlog: 'Backlog', unstarted: 'Todo', started: 'In progress' },
        default: ['triage', 'backlog', 'unstarted', 'started'], enabledBy: 'importAssigned',
        description: 'Done, canceled and duplicate tickets are never imported. A ticket nobody has taken leaves the inbox when it no longer matches.',
        emptyHint: 'No status is selected, so nothing is imported. The to-dos you already have stay.' },
      triagePriority: { label: 'Minimum priority', kind: 'select', options: ['any', 'medium', 'high'], optionLabels: { any: 'Any', medium: 'Urgent, High and Medium', high: 'Urgent and High' }, default: 'any', enabledBy: 'importAssigned',
        description: 'Tickets without a priority are imported only with Any.' },
    } },
};
export default plugin;
