import { defineResourcePlugin } from '../../define.ts';
import { AUTO_DEPLOY_OPERATION } from '../github-rollout/auto-deploy.ts';
import { REVIEW_LOOP_OPERATION } from '../code-review/review-loop.ts';

export const githubPullRequest = defineResourcePlugin({
  settingsHelp: 'Follow a GitHub pull request and its conversation. Add its URL, connect related work, and launch reviews or send comment fixes to a connected agent.',
  id: 'github.pull-request',
  apiVersion: 1,
  schemaVersion: 1,
  name: 'GitHub pull request',
  icon: 'git-pull-request',
  brand: 'github',
  context: { fields: ['owner', 'repo', 'number'] },
  contextMenu: [{ id: 'review', label: 'Trigger review', selection: { label: 'Review selection', children: ['review.claude', 'review.codex', 'review.both'] }, children: [
    { id: 'review.claude', label: 'Claude', description: 'One-off Claude review · Opus by default' },
    { id: 'review.codex', label: 'Codex', description: 'One-off Codex review · Astra by default' },
    { id: 'review.both', label: 'Claude + Codex', description: 'A Claude and a Codex review at the same time', runs: ['review.claude', 'review.codex'] },
    { id: 'review.workflow', label: '/review', description: 'Posts /review on GitHub and watches for the result' },
  ] }, { id: 'reviewLoop', label: 'Review loop', children: [], choices: { load: 'options', apply: 'set', runtime: REVIEW_LOOP_OPERATION, loadingLabel: 'Checking the review loop…' } },
  { id: 'architecture', label: 'Explain architecture', children: [
    { id: 'architecture.explain', label: 'Claude', description: 'Read-only analysis · publishes one private claude.ai artifact' },
  ] }, { id: 'merge', label: 'Merge', children: [], choices: { load: 'pr.merge.options', apply: 'pr.merge', loadingLabel: 'Checking merge options…', irreversible: true, pickConfirms: true } },
    { id: 'autoDeploy', label: 'Auto deploy', children: [], choices: { load: 'options', apply: 'set', runtime: AUTO_DEPLOY_OPERATION, loadingLabel: 'Checking auto deploy…' } },
    { id: 'state', label: 'Change state', children: [], choices: { load: 'pr.state.options', apply: 'pr.state', loadingLabel: 'Checking the pull request…' } },
    { id: 'showShip', label: 'Show/Ship', children: [], choices: { load: 'pr.showShip.options', apply: 'pr.showShip', loadingLabel: 'Checking the title…' }, when: { plugin: 'github.pull-request', setting: 'showShip' } }],
  mapSizes: { defaultSize: 'medium', sizes: {
    small: { width: 200, height: 48, summaryLines: 0, description: "Title and attention indicators." },
    medium: { width: 200, height: 84, summaryLines: 1, description: "Title and current PR status." },
    large: { width: 280, height: 132, summaryLines: 2, fields: ['repo'], fieldLines: 1, description: "Longer status and repository." },
  } },
  appearance: { tone: 'violet', shape: 'branch', size: 'medium' },
  overview: { pipeline: { singular: 'PR', plural: 'PRs' } },
  preferredView: 'inspector',
  view: { width: 1040, height: 720, frameTitle: '{owner}/{repo} #{number}', reference: '#{number}' },
  webLink: { label: 'Open on GitHub', template: 'https://github.com/{owner}/{repo}/pull/{number}' },
  connectionProvider: 'github',
  providerIdentity: data => `${String(data.owner).toLowerCase()}/${String(data.repo).toLowerCase()}/pull/${data.number}`,
  matchInput(input) {
    let url: URL;
    try { url = new URL(input); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return undefined;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/files|\/commits|\/checks)?\/?$/.exec(url.pathname);
    if (!match) return undefined;
    const [, owner, repo, number] = match;
    return {
      title: `${owner}/${repo} #${number}`,
      data: { owner, repo, number: Number(number) },
    };
  },
  fields: {
    owner: { label: 'Owner', kind: 'text', required: true, pattern: '^[\\w.-]+$' },
    repo: { label: 'Repository', kind: 'text', required: true, pattern: '^[\\w.-]+$' },
    number: { label: 'PR number', kind: 'number', required: true, integer: true, min: 1 },
  },
  creation: { label: 'Attach PR', shortLabel: 'PR', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://github.com/owner/repository/pull/123' },
});
