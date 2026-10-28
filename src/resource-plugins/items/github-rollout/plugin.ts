import * as z from 'zod/v4';
import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubRollout } from './definition.ts';
import { reportShape } from './validation.ts';
import { parseStageRules } from './stages.ts';
import { AUTO_DEPLOY_OPERATION } from './auto-deploy.ts';

const STAGE_RULES_EXAMPLE = JSON.stringify([{ id: 'web-release', workflow: '^release$', stages: [
  { key: 'preview', environment: 'preview' },
  { key: 'live', environment: 'live', delayMinutes: 10 },
] }], null, 2);

const plugin: PluginDefinitionsModule = {
  definitions: [githubRollout],
  settings: { typeId: githubRollout.id, label: 'Rollout stages',
    description: 'Runs of a staged workflow are validated once per stage (when an environment finishes, optionally after a delay) instead of once per attempt. Every other workflow keeps one validation per attempt.',
    fields: { stageRules: { label: 'Rollout stage rules', kind: 'text', multiline: true, rows: 10, default: '', placeholder: STAGE_RULES_EXAMPLE,
      description: 'A JSON list of rules. Each rule matches workflow names with a case-insensitive regular expression and lists its stages: an environment from the job names, with optional delayMinutes and focus. Leave empty to stage no workflow.' } },
    validate: values => { parseStageRules(typeof values.stageRules === 'string' ? values.stageRules : ''); } },
  runtimeOperations: [{ id: 'rollout.validation', description: 'List, trigger or report validations of a rollout by connected agents.',
    agentPolicy: { operations: { report: { redirect: 'Report rollout validations with workspace_report_validation.' }, options: 'allow', list: 'allow' }, otherwise: 'humanOnly' } },
  { id: AUTO_DEPLOY_OPERATION, description: 'Read the auto deploy of a pull request or of a rollout it follows: its step, why it halted, and on a rollout its phase track and what it did. Only a person starts or stops it.',
    agentPolicy: { operations: { status: 'allow', options: 'allow' }, otherwise: 'humanOnly' } }],
  mcpTools: [{
    name: 'workspace_report_validation',
    description: 'Post progress, the final result or a follow-up of a rollout validation you were asked to run. Pass the rollout item ID and the validationId from the request. Each call replaces the previous report and needs a higher sequence; a final report needs a verdict and at least one check, and ends the validation; a "followup" report amends a final one the same way and may change its verdict. A report for an id nobody requested is recorded as an unrequested validation. Without a validationId (a validation someone asked for in your chat) the report goes to your open validation of this rollout, or starts one with the next id for the stage the rollout has reached; send later reports with the id the receipt names. Only the agent the validation was requested from can report it. Observes only: never approve, rerun or cancel.',
    inputSchema: z.object({ rolloutNodeId: z.string().min(1).max(200), ...reportShape }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    requiresAgent: 'Only an agent launched from the table can report a validation.',
    request: ({ rolloutNodeId, ...report }, binding) => ({ action: 'rollout.validation', nodeId: String(rolloutNodeId), arguments: { operation: 'report', agentNodeId: binding.agentNodeId ?? '', ...report } }),
  }],
};
export default plugin;
