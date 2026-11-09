import { defineResourcePlugin } from '../../define.ts';

/** Count, or add to the map, the pull requests GitHub links to an issue. */
export const GITHUB_ISSUE_PULLS_OPERATION = 'github.issue.pulls';
export const githubIssue = defineResourcePlugin({
  settingsHelp: 'Keep a GitHub issue on the table. Add its URL to sync its title, description, comments and state; close or reopen it, or turn it into a local to-do.',
  id: 'github.issue', apiVersion: 1, schemaVersion: 1,
  name: 'GitHub issue', icon: 'circle-dot', brand: 'github', preferredView: 'inspector',
  connectionProvider: 'github', todoSupport: true,
  context: { fields: ['owner', 'repo', 'number'] },
  view: { frameTitle: '{owner}/{repo} #{number}', reference: '#{number}' },
  webLink: { label: 'Open on GitHub', template: 'https://github.com/{owner}/{repo}/issues/{number}' },
  contextMenu: [{ id: 'state', label: 'Change state', children: [], choices: { load: 'issue.state.options', apply: 'issue.state.set', loadingLabel: 'Checking the issue…' } },
    { id: 'pulls', label: 'Linked pull requests', children: [{ id: 'pulls.add', label: 'Add to the map', description: 'Every pull request GitHub links to this issue, beside it' }] }],
  providerIdentity: data => `${String(data.owner).toLowerCase()}/${String(data.repo).toLowerCase()}/issues/${data.number}`,
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 240, height: 64, minHeight: 48, summaryLines: 0, description: 'Issue number, title and state.' },
    medium: { width: 260, height: 84, summaryLines: 1, description: 'Number, title and state.' },
  } },
  appearance: { tone: 'mint', shape: 'ticket', size: 'small', width: 240, showFullTitle: true },
  overview: { tally: { singular: 'issue', plural: 'issues' } },
  matchInput(input) {
    let url: URL;
    try { url = new URL(input); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return undefined;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return undefined;
    const [, owner, repo, number] = match;
    return { title: `${owner}/${repo} #${number}`, data: { owner, repo, number: Number(number) } };
  },
  fields: {
    owner: { label: 'Owner', kind: 'text', required: true, pattern: '^[\\w.-]+$' },
    repo: { label: 'Repository', kind: 'text', required: true, pattern: '^[\\w.-]+$' },
    number: { label: 'Issue number', kind: 'number', required: true, integer: true, min: 1 },
  },
  creation: { label: 'Attach issue', shortLabel: 'Issue', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://github.com/owner/repository/issues/123' },
});
