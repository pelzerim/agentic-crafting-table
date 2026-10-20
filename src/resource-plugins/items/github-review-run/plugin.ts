import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubReviewRun } from './definition.ts';
import { validateReportMarker, workflowReviewSettingsFields } from '../../../pull-requests/workflow-contract.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [githubReviewRun],
  settings: { typeId: githubReviewRun.id, label: '/review workflow', description: 'Which repository workflow answers a /review comment on a pull request, and how its result is recognised. Requests already running keep the values they started with.', fields: workflowReviewSettingsFields, validate: validateReportMarker },
};
export default plugin;
