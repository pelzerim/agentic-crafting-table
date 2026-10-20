import { PULL_CUES } from '../../../../packages/provider-runtime/github-status.ts';
import type { PullStatus } from '../../../../packages/provider-runtime/github-status.ts';
import type { PullLifecycle, PullStateChange } from '../../../../packages/provider-runtime/github.ts';
import { taggedTitle, titleProblem, titleTag } from './show-ship.ts';
import type { ShowShipTag } from './show-ship.ts';
import type { JsonObject, ResourceOptimism, ResourceSnapshot } from '../../types.ts';

interface PullFacts { number?: number; title?: string; state?: string; draft?: boolean; merged?: boolean }
const facts = (snapshot: ResourceSnapshot) => snapshot.detail?.pull as PullFacts | undefined;
const lifecycle = (pull: PullFacts): PullLifecycle => pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open';
const reference = (snapshot: ResourceSnapshot) => `#${facts(snapshot)?.number ?? '?'}`;

/** The saved read with the pull request changed as the write asks and its status cue leading again. */
function expect(snapshot: ResourceSnapshot, change: PullFacts, status: PullStatus): ResourceSnapshot {
  const pull = { ...facts(snapshot), ...change }, indicators = [{ id: 'review-state', ...PULL_CUES[status] }, ...(snapshot.indicators ?? []).filter(cue => cue.id !== 'review-state')];
  return { ...snapshot, ...(change.title ? { title: change.title } : {}), activity: pull.state === 'closed' ? 'complete' : 'idle', label: indicators.map(cue => cue.label).join(' · '), indicators,
    detail: { ...snapshot.detail, pull: pull as JsonObject, status } };
}
function optimism(snapshot: ResourceSnapshot, expected: ResourceSnapshot, subject: string, pending: string, landed: (pull: PullFacts, read: ResourceSnapshot) => boolean): ResourceOptimism | undefined {
  if (!facts(snapshot)) return undefined;
  return { snapshot: expected, subject, pending, landed: read => { const pull = facts(read); return pull ? landed(pull, read) : undefined; } };
}

/** Merge or queue: Merged (Queued) at once; a merged read confirms either, a queued one the queue. */
export function mergeOptimism(snapshot: ResourceSnapshot, input: JsonObject) {
  if (input.value === 'QUEUE') return optimism(snapshot, expect(snapshot, {}, 'queued'), `Adding ${reference(snapshot)} to the merge queue`, 'Queued · confirming',
    (pull, read) => pull.merged === true || read.detail?.status === 'queued');
  return optimism(snapshot, expect(snapshot, { merged: true, state: 'closed' }, 'merged'), `Merge of ${reference(snapshot)}`, 'Merged · confirming', pull => pull.merged === true);
}

const STATE_SUBJECT: Record<PullStateChange, (reference: string) => string> = {
  ready: reference => `Marking ${reference} ready for review`, draft: reference => `Converting ${reference} to a draft`, close: reference => `Closing ${reference}`, reopen: reference => `Reopening ${reference}`,
};
/** Draft/ready, close and reopen: the lifecycle the change asks for. Review outcomes stay as they were read. */
export function stateOptimism(snapshot: ResourceSnapshot, input: JsonObject) {
  const change = input.value as PullStateChange, saved = String(snapshot.detail?.status), status: PullStatus = saved in PULL_CUES ? saved as PullStatus : 'open';
  if (!(change in STATE_SUBJECT)) return undefined;
  const [patch, next, target]: [PullFacts, PullStatus, PullLifecycle] = change === 'close' ? [{ state: 'closed' }, 'closed', 'closed'] : change === 'reopen' ? [{ state: 'open' }, 'open', 'open']
    : change === 'draft' ? [{ draft: true }, ['open', 'checks-failing'].includes(status) ? 'draft' : status, 'draft'] : [{ draft: false }, status === 'draft' ? 'open' : status, 'open'];
  return optimism(snapshot, expect(snapshot, patch, next), STATE_SUBJECT[change](reference(snapshot)), `${PULL_CUES[next].label} · confirming`, pull => lifecycle(pull) === target);
}

/** Show/Ship: the tagged title at once; a read with that title confirms it. Choosing the current tag expects nothing. */
export function showShipOptimism(snapshot: ResourceSnapshot, input: JsonObject) {
  const expectedTitle = input.expectedTitle, tag = input.value === 'none' ? '' : input.value as ShowShipTag;
  if (typeof expectedTitle !== 'string' || !['', 'show', 'ship'].includes(tag) || titleTag(expectedTitle).tag === tag) return undefined;
  const title = taggedTitle(expectedTitle, tag);
  if (titleProblem(title)) return undefined;
  const expected = { ...snapshot, title, detail: { ...snapshot.detail, pull: { ...facts(snapshot), title } as JsonObject } };
  return optimism(snapshot, expected, `Retitle of ${reference(snapshot)}`,
    tag ? `Tagged [${tag}] · confirming` : 'Tag removed · confirming', (pull, read) => (read.title ?? pull.title) === title);
}
