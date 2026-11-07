import type { JsonValue, ResourcePluginConnector, ResourceRecord, ResourceSnapshot } from '../../types.ts';
import type { ResourceIndicator } from '../../indicators.ts';
import { ISSUE_STATES, issueLifecycle } from '../../../../packages/provider-runtime/github.ts';
import type { GitHubClient, GitHubComment, GitHubIssue, IssueLifecycle, IssueStateChoice, PullIdentity } from '../../../../packages/provider-runtime/github.ts';

export const ISSUE_STATE_LABELS: Record<IssueLifecycle, string> = { open: 'Open', completed: 'Closed', not_planned: 'Not planned', duplicate: 'Duplicate' };
const CHOICE_LABELS: Record<IssueStateChoice, string> = { open: 'Open', completed: 'Close as completed', not_planned: 'Close as not planned' };
const CUE: Record<IssueLifecycle, Pick<ResourceIndicator, 'tone' | 'icon'>> = { open: { tone: 'green', icon: 'clock' }, completed: { tone: 'violet', icon: 'check' }, not_planned: { tone: 'neutral', icon: 'x' }, duplicate: { tone: 'neutral', icon: 'x' } };
export type IssueComment = { id: number; author: string; authorType?: string; body: string; date: string };

/** The latest comments that fit 100 entries and 1 MiB, oldest first, with the full count. */
function issueComments(comments: GitHubComment[]) {
  const kept: IssueComment[] = [], encoder = new TextEncoder(); let bytes = 0;
  for (const value of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id).reverse()) {
    const entry = { id: value.id, author: value.user?.login ?? 'Deleted user', ...(value.user?.type ? { authorType: value.user.type } : {}), body: value.body, date: value.created_at };
    const size = encoder.encode(JSON.stringify(entry)).length;
    if (kept.length >= 100 || bytes + size > 1024 * 1024) break;
    kept.push(entry); bytes += size;
  }
  return { comments: kept.reverse(), commentsTotal: comments.length };
}

function snapshot(key: PullIdentity, issue: GitHubIssue, comments: GitHubComment[]): ResourceSnapshot {
  const lifecycle = issueLifecycle(issue), label = ISSUE_STATE_LABELS[lifecycle], closed = lifecycle !== 'open';
  return { title: issue.title, done: closed, activity: closed ? 'complete' : 'idle', attention: 'none', connection: 'connected', observedAt: new Date().toISOString(), label,
    indicators: [{ id: 'state', label, ...CUE[lifecycle], showLabel: true, ...(closed ? { stage: 'done' as const } : {}) }],
    detail: { number: issue.number, title: issue.title, body: issue.body ?? '', state: issue.state, lifecycle, author: issue.user?.login ?? 'Deleted user',
      labels: issue.labels.map(label => label.name), assignees: issue.assignees.map(user => user.login), createdAt: issue.created_at, updatedAt: issue.updated_at, ...(issue.closed_at ? { closedAt: issue.closed_at } : {}),
      url: `https://github.com/${key.owner}/${key.repo}/issues/${issue.number}`, ...issueComments(comments) } };
}

export function githubIssueConnector(clientFor: (resource: ResourceRecord) => GitHubClient): ResourcePluginConnector {
  const identity = (resource: ResourceRecord): PullIdentity => ({ owner: String(resource.data.owner), repo: String(resource.data.repo), number: Number(resource.data.number) });
  const read = async (resource: ResourceRecord, signal: AbortSignal) => {
    const client = clientFor(resource), key = identity(resource), issue = await client.issue(key, signal);
    // Sequential reads stop at rate-limit/auth failures; an issue without comments needs no second read.
    return snapshot(key, issue, issue.comments ? await client.comments(key, signal) : []);
  };
  const changed = async (resource: ResourceRecord, signal: AbortSignal, done: string) => {
    try { return await read(resource, signal); }
    catch { throw Object.assign(new Error(`${done}, but refresh failed. Check GitHub before trying again.`), { outcomeUnknown: true }); }
  };
  return {
    pollIntervalMs: 60_000,
    load: read,
    actions: () => [
      { id: 'issue.state.options', label: 'Available states', readOnly: true },
      { id: 'issue.state.set', label: 'Change GitHub issue state', readOnly: false, updatesSnapshot: true,
        description: 'Close the issue as completed or not planned, or reopen it, on GitHub. Use fresh options and a unique requestId; never retry an uncertain request with a new ID.',
        inputFields: Object.fromEntries(['value', 'expectedState', 'sourceResourceId', 'requestId'].map(key => [key, { label: key, kind: 'text' as const, required: true }])) },
      { id: 'issue.state.complete', label: 'Mirror Mark done to GitHub', readOnly: false, updatesSnapshot: true, completion: true,
        description: 'Mark done closes the issue as completed; Reopen reopens it.' },
      { id: 'issue.pulls', label: 'Linked pull requests', readOnly: true, description: 'Pull requests that close or mention this issue on GitHub.' },
    ],
    async execute(resource, actionId, signal, input = {}): Promise<JsonValue> {
      const client = clientFor(resource), key = identity(resource);
      if (actionId === 'issue.pulls') return { pulls: (await client.issuePulls(key, signal)).map(pull => ({ ...pull })) };
      if (actionId === 'issue.state.options') {
        const current = issueLifecycle(await client.issue(key, signal));
        return { current, context: { expectedState: current, sourceResourceId: resource.id }, options: ISSUE_STATES.map(state => ({ id: state, label: CHOICE_LABELS[state] })) };
      }
      if (!['issue.state.set', 'issue.state.complete'].includes(actionId) || input.sourceResourceId !== resource.id) throw new Error('This GitHub issue action belongs to another item.');
      const issue = await client.issue(key, signal), current = issueLifecycle(issue);
      if (actionId === 'issue.state.complete') {
        const done = input.done === 'true';
        if ((current !== 'open') === done) return { snapshot: await read(resource, signal) } as unknown as JsonValue;
        await client.setIssueState(key, done ? 'completed' : 'open', signal);
        return { snapshot: await changed(resource, signal, done ? 'Issue closed' : 'Issue reopened') } as unknown as JsonValue;
      }
      const value = input.value as IssueStateChoice;
      if (!ISSUE_STATES.includes(value)) throw new Error('Choose open, completed or not planned.');
      if (input.expectedState !== current) throw new Error('This issue changed on GitHub. Refresh it and choose again.');
      if (value === current) return { snapshot: await read(resource, signal) } as unknown as JsonValue;
      await client.setIssueState(key, value, signal);
      return { snapshot: await changed(resource, signal, value === 'open' ? 'Issue reopened' : 'Issue closed') } as unknown as JsonValue;
    },
    async getContext(resource, signal) {
      const key = identity(resource), loaded = await read(resource, signal), detail = loaded.detail as { body: string; updatedAt: string; labels: string[]; comments: IssueComment[]; commentsTotal: number; url: string };
      const comments = detail.comments.slice(-20).map(comment => `${comment.author} · ${comment.date}\n${comment.body}`);
      const content = [loaded.title, `GitHub issue ${key.owner}/${key.repo}#${key.number} · ${loaded.label} · ${detail.updatedAt}${detail.labels.length ? ` · ${detail.labels.join(', ')}` : ''}`, detail.body,
        ...(comments.length ? [`Comments (latest ${comments.length} of ${detail.commentsTotal}):`, ...comments] : [])].join('\n\n');
      return { resourceId: resource.id, title: loaded.title ?? resource.title, sourceUrl: detail.url, content: content.length > 32_000 ? content.slice(0, 31_940) + '\n[Context excerpt ends here; open the issue for the rest.]' : content };
    },
  };
}
