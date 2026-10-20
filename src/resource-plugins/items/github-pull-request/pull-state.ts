import { pullLifecycle, stateChanges } from '../../../../packages/provider-runtime/github.ts';
import type { PullLifecycle, PullMergeState, PullStateChange } from '../../../../packages/provider-runtime/github.ts';
import type { ResourceChoices } from '../../types.ts';

export const PULL_LIFECYCLES: readonly PullLifecycle[] = ['open', 'draft', 'closed', 'merged'];
export const PULL_STATE_CHANGES: readonly PullStateChange[] = ['ready', 'draft', 'close', 'reopen'];
export const PULL_STATE_DONE: Record<PullStateChange, string> = { ready: 'Marked ready for review', draft: 'Converted to draft', close: 'Closed', reopen: 'Reopened' };
const quote = (title: string) => `“${title.length > 120 ? `${title.slice(0, 119)}…` : title}”`;

/** Close/reopen and draft/ready transitions GitHub allows for this PR now. */
export function pullStateChoices(pull: Pick<PullMergeState['pullRequest'], 'number' | 'title' | 'state' | 'isDraft' | 'merged'>): { refusal: string } | { prompt: string; options: ResourceChoices['options'] } {
  const lifecycle = pullLifecycle(pull);
  if (lifecycle === 'merged') return { refusal: 'Merged pull requests can’t be closed, reopened or converted to a draft.' };
  const option = (id: PullStateChange): ResourceChoices['options'][number] => id === 'close' ? { id, label: 'Close pull request…', confirm: {
    prompt: `Close #${pull.number} ${quote(pull.title)}?`, note: 'You can reopen it later.', action: 'Close pull request',
    text: { field: 'comment', label: 'Comment (optional)', placeholder: 'Posted on the pull request before it closes', maxLength: 60_000 } } }
    : { id, label: { ready: 'Mark ready for review', draft: 'Convert to draft', reopen: 'Reopen pull request' }[id] };
  return { prompt: `Change #${pull.number} ${quote(pull.title)} on GitHub?`, options: stateChanges(lifecycle).map(option) };
}
