import { formatWhen } from '../../format-when.ts';
import type { ViewChip } from '../../view-header.ts';
import type { ResourceRecord } from '../../types.ts';

/** Auto validate is the default; a pull request opts out by storing `autoValidate: false`. */
export const autoValidates = (resource: Pick<ResourceRecord, 'data'>) => resource.data.autoValidate !== false;
/** What remounts the open view. Auto validate is a setting of the view itself, so toggling it does not. */
export function pullViewIdentity(resource: Pick<ResourceRecord, 'connectionId' | 'data'>) {
  const data = { ...resource.data }; delete data.autoValidate;
  return JSON.stringify([resource.connectionId, data]);
}

interface PullFacts { number: number; state: string; merged?: boolean; draft?: boolean; changed_files: number; additions: number; deletions: number; updated_at: string }
const REVIEW: Record<string, string> = { approved: '✓ Approved', 'changes-requested': '△ Changes requested', 'checks-failing': '✕ Checks failing', queued: 'In merge queue', open: 'Review required' };

/** Lifecycle chip, one meta line and the one primary action a pull request's state calls for. */
export function pullHeader(pull: PullFacts | undefined, status: string | undefined, repository: string, now = Date.now()) {
  const chip: ViewChip | undefined = !pull ? undefined : pull.merged ? { label: 'Merged', tone: 'violet' } : pull.state === 'closed' ? { label: 'Closed', tone: 'red' } : pull.draft ? { label: 'Draft', tone: 'neutral' } : { label: 'Open', tone: 'green' };
  const open = Boolean(pull && !pull.merged && pull.state === 'open');
  const meta = pull ? [`#${pull.number}`, repository, open && !pull.draft ? REVIEW[status ?? ''] : undefined,
    `${pull.changed_files} ${pull.changed_files === 1 ? 'file' : 'files'} +${pull.additions} −${pull.deletions}`, `updated ${formatWhen(pull.updated_at, 'relative', now)}`] : [repository];
  const primary = !open || status === 'queued' ? undefined : status === 'approved' ? 'merge' as const : 'review' as const;
  return { chip, meta, primary };
}
