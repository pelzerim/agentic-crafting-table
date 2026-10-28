import { defineResourcePlugin } from '../../define.ts';
import type { JsonObject } from '../../types.ts';
import { AUTO_DEPLOY_OPERATION } from './auto-deploy.ts';

export function rolloutInput(input: string): JsonObject | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) return;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/actions\/(?:runs\/([1-9]\d*)(?:\/(?:job\/[1-9]\d*|attempts\/[1-9]\d*))?|workflows\/([\w.-]+))\/?$/.exec(url.pathname);
    if (!match) return;
    const [, owner, repo, run, workflow] = match;
    if ([owner, repo, workflow].some(value => value === '.' || value === '..')) return;
    if (run) return Number.isSafeInteger(Number(run)) ? { owner, repo, runId: Number(run) } : undefined;
    const query = url.searchParams.get('query'), branch = url.searchParams.get('branch');
    if (query && !/^branch:[^\s]+$/.test(query)) return; // Do not silently broaden a filtered feed.
    return { owner, repo, workflow, ...(query || branch ? { branch: query?.slice(7) ?? branch! } : {}) };
  } catch { return; }
}
export const githubRollout = defineResourcePlugin({
  settingsHelp: 'Watch a GitHub Actions deployment or infrastructure rollout. Add a run, job or workflow URL to track progress, failures and pending approvals.',
  id: 'github.rollout', apiVersion: 1, schemaVersion: 1, name: 'Rollout', icon: 'rocket',
  preferredView: 'inspector', view: { mode: 'focus', width: 900, height: 660 },
  appearance: { tone: 'blue', shape: 'server', size: 'medium' },
  mapSizes: { defaultSize: 'medium', sizes: {
    small: { width: 200, height: 60, summaryLines: 0, description: 'Workflow title and rollout state.' },
    medium: { width: 200, height: 84, summaryLines: 1, description: 'Workflow title, rollout state and job progress.' },
    large: { width: 280, height: 132, summaryLines: 2, fields: ['repo', 'branch'], fieldLines: 1, presentationPips: true, description: 'Status, progress, phases, repository and branch filter.' },
  } },
  manualAcknowledge: true,
  webLink: { label: 'Open on GitHub', template: ['https://github.com/{owner}/{repo}/actions/runs/{runId}', 'https://github.com/{owner}/{repo}/actions/workflows/{workflow}?query=branch%3A{branch}', 'https://github.com/{owner}/{repo}/actions/workflows/{workflow}'] },
  contextMenu: [{ id: 'validate', label: 'Trigger validation', children: [], choices: { load: 'options', apply: 'trigger', runtime: 'rollout.validation', loadingLabel: 'Finding connected agents…' } },
    { id: 'autoDeploy', label: 'Auto deploy from here…', children: [], choices: { load: 'options', apply: 'set', runtime: AUTO_DEPLOY_OPERATION, loadingLabel: 'Checking auto deploy…' } },
    { id: 'approve', label: 'Approve', children: [], choices: { load: 'rollout.approval.options', apply: 'rollout.approve', loadingLabel: 'Checking approvals…', irreversible: true } }], connectionProvider: 'github', context: { fields: ['owner', 'repo', 'runId', 'workflow', 'branch'] },
  providerIdentity: data => `${String(data.owner).toLowerCase()}/${String(data.repo).toLowerCase()}/${data.runId ? `run/${data.runId}` : `workflow/${data.workflow}/branch/${data.branch ?? ''}`}`,
  matchInput(input) { const data = rolloutInput(input); return data ? { title: `${data.owner}/${data.repo} rollout`, data } : undefined; },
  fields: {
    owner: { label: 'Owner', kind: 'text', required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' },
    repo: { label: 'Repository', kind: 'text', required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' },
    runId: { label: 'Run ID', kind: 'number', integer: true, min: 1 },
    workflow: { label: 'Workflow filename or ID', kind: 'text', pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$' },
    branch: { label: 'Branch filter', kind: 'text', pattern: '^\\S{1,250}$' },
  },
  validateData: data => Boolean(data.runId) !== Boolean(data.workflow) && (!data.runId || data.branch === undefined),
  creation: { label: 'Watch rollout', shortLabel: 'Rollout', action: 'resource.attach', mode: 'url', urlPlaceholder: 'GitHub Actions run, job or workflow URL' },
});
