import type { ViewChip } from './view-header.ts';

const title = (value: string) => value ? value[0].toUpperCase() + value.slice(1).replaceAll('-', ' ') : 'Unknown';

/** A terminal or agent session state as a label and tone. */
export function sessionChip(state: string | undefined, stopping = false): ViewChip {
  if (stopping && (state === 'starting' || state === 'running')) return { label: 'Stopping…', tone: 'neutral' };
  switch (state) {
    case undefined: return { label: 'Connecting…', tone: 'neutral' };
    case 'starting': return { label: 'Starting', tone: 'blue' };
    case 'running': return { label: 'Running', tone: 'green' };
    case 'exited': return { label: 'Exited', tone: 'neutral' };
    case 'failed': return { label: 'Failed', tone: 'red' };
    case 'lost': return { label: 'Lost', tone: 'amber' };
    default: return { label: title(state), tone: 'neutral' };
  }
}

const WORKFLOW: Record<string, ViewChip> = {
  preparing: { label: 'Requested', tone: 'blue' }, 'not-observed': { label: 'Requested', tone: 'blue' }, queued: { label: 'Queued', tone: 'blue' },
  running: { label: 'Running', tone: 'green' }, 'awaiting-result': { label: 'Awaiting result', tone: 'blue' }, complete: { label: 'Complete', tone: 'green' },
  'needs-confirmation': { label: 'Unconfirmed', tone: 'amber' }, ambiguous: { label: 'Ambiguous', tone: 'amber' },
  failed: { label: 'Failed', tone: 'red' }, 'timed-out': { label: 'Timed out', tone: 'red' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
/** A workflow review status as a label and tone. */
export function workflowReviewChip(status: string): ViewChip {
  return WORKFLOW[status] ?? { label: title(status), tone: 'neutral' };
}
