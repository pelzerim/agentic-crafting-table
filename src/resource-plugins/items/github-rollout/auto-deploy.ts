import type { RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { HeadChecks, PullLifecycle, PullMergeMethod, PullMergeReadiness } from '../../../../packages/provider-runtime/github.ts';
import type { ValidationState, Verdict } from './validation.ts';
import { environmentStates } from './stages.ts';
import type { StageRule } from './stages.ts';

/** Auto deploy: armed by a person on a pull request, the service tags it [ship], merges it once GitHub would, follows the
 * rollouts its merge starts, validates every phase and approves the next gate only after a passing validation.
 * Every write is sent once; any doubt halts, and nothing is ever rolled back. */
export const AUTO_DEPLOY_OPERATION = 'github.rollout.autoDeploy';
export const FIX_ATTEMPTS = 2;
/** A validation without a final verdict this long after it was requested halts. */
export const VALIDATION_DEADLINE_MS = 60 * 60_000;
/** An agent asked to fix CI that pushes no new commit this long halts. */
export const FIX_DEADLINE_MS = 45 * 60_000;
/** A merge whose deploy run does not show up this long halts. */
export const ROLLOUT_DEADLINE_MS = 30 * 60_000;
/** GitHub's merge state lags behind green checks for a while; a block that outlasts this is a rule only a person can clear. */
export const BLOCKED_GRACE_MS = 10 * 60_000;

export type AutoDeployState = 'armed' | 'done' | 'halted' | 'stopped';
export type AutoDeployStep = 'tagging' | 'waiting-checks' | 'fixing-ci' | 'merging' | 'merge-queue' | 'waiting-rollout' | 'deploying' | 'delayed' | 'validating' | 'approving' | 'waiting-gate' | 'done' | 'halted' | 'stopped';
export type HaltCode = 'closed' | 'draft' | 'changes-requested' | 'review-required' | 'conflicts' | 'behind' | 'blocked' | 'ci-failing' | 'fix-stalled' | 'left-queue' | 'declined' | 'outcome-unknown'
  | 'no-rollout' | 'deploy-failed' | 'validation-failed' | 'validation-concerns' | 'validation-inconclusive' | 'no-verdict' | 'agent-unavailable' | 'error';

/** A write is recorded `sending` before it goes out and `sent` once GitHub confirmed it; a `sending` one found later is never sent again. */
export interface AutoDeployWrite { key: string; kind: 'tag' | 'merge' | 'approve' | 'fix'; requestId: string; at: number; state: 'sending' | 'sent' }
/** One validation of a phase: `agent` is the trigger value it was asked with, so asking again after a restart is the same journaled request. */
export interface AutoDeployCheck { key: string; rolloutNodeId: string; label: string; requestId: string; agent?: string; validationId?: string; requestedAt: number; jobs?: number[] }
export interface AutoDeployFix { head: string; at: number; agentNodeId?: string }
export interface AutoDeployRecord {
  version: 1; id: string; pullResourceId: string; pullNodeId: string; armedAt: number; updatedAt: number;
  state: AutoDeployState; step: AutoDeployStep; detail?: string;
  base?: string; mergedAt?: number; blockedSince?: number;
  writes: AutoDeployWrite[]; fixes: AutoDeployFix[]; checks: AutoDeployCheck[];
  halt?: { code: HaltCode; reason: string; at: number };
}

export interface PullFacts extends Pick<PullMergeReadiness, 'head' | 'base' | 'title' | 'reviewDecision' | 'queued' | 'queueEnabled' | 'pullRequestId'> {
  lifecycle: PullLifecycle; tag: string; mergeStateStatus: PullMergeReadiness['mergeStateStatus']; checks: HeadChecks; failing: string[]; method: PullMergeMethod | null;
}
export interface RolloutValidationFact { label: string; state: ValidationState; verdict?: Verdict; resolvedBy?: string }
export interface RolloutFacts {
  nodeId: string; title: string; run?: { id: number; attempt: number; status: string; conclusion: string | null; headSha: string };
  jobs: RolloutJob[]; gates: { id: number; name: string; approvable: boolean }[]; rule?: StageRule; validations: RolloutValidationFact[];
}
export interface AutoDeployFacts { now: number; tagging: boolean; pull?: PullFacts; rollouts: RolloutFacts[] }

export type AutoDeployDecision =
  | { kind: 'wait'; step: AutoDeployStep; detail?: string }
  | { kind: 'tag'; title: string }
  | { kind: 'merge'; method: PullMergeMethod; pullRequestId: string; head: string }
  | { kind: 'fix'; attempt: number; head: string; failing: string[] }
  | { kind: 'validate'; key: string; rolloutNodeId: string; label: string; jobs: number[] }
  | { kind: 'approve'; key: string; rolloutNodeId: string; runId: number; attempt: number; environmentIds: number[]; names: string }
  | { kind: 'halt'; code: HaltCode; reason: string }
  | { kind: 'done' };

export function armRecord(input: { id: string; pullResourceId: string; pullNodeId: string; now: number }): AutoDeployRecord {
  return { version: 1, id: input.id, pullResourceId: input.pullResourceId, pullNodeId: input.pullNodeId, armedAt: input.now, updatedAt: input.now, state: 'armed', step: 'waiting-checks', writes: [], fixes: [], checks: [] };
}

const wait = (step: AutoDeployStep, detail?: string): AutoDeployDecision => ({ kind: 'wait', step, ...(detail ? { detail } : {}) });
const halt = (code: HaltCode, reason: string): AutoDeployDecision => ({ kind: 'halt', code, reason });
export const sent = (record: AutoDeployRecord, key: string) => record.writes.some(write => write.key === key && write.state === 'sent');
const UNCONFIRMED: Record<AutoDeployWrite['kind'], string> = {
  tag: 'The [ship] tag could not be confirmed.', merge: 'The merge could not be confirmed.', approve: 'The approval could not be confirmed.', fix: 'The fix request to the agent could not be confirmed.',
};
const FAILED_JOB = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);
const ran = (job: RolloutJob) => !['skipped', 'cancelled', 'neutral'].includes(job.conclusion ?? '');
/** The jobs a gate holds back. A phased rollout gates the same environment once per phase, so the gate's identity
 * is its environments plus these jobs; without any, the environments alone. */
const held = (jobs: readonly RolloutJob[]) => jobs.filter(job => job.status === 'waiting').sort((a, b) => a.id - b.id);
const gateKey = (ids: number[], jobs: readonly RolloutJob[]) => { const waiting = held(jobs); return `${ids.join(',')}${waiting.length ? `@${waiting.map(job => job.id).join(',')}` : ''}`; };
const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;

/** What the facts say happened since the last pass: the merge, and since when GitHub reports the pull request blocked. */
export function observe(record: AutoDeployRecord, facts: AutoDeployFacts): AutoDeployRecord {
  const pull = facts.pull;
  if (!pull) return record;
  const next = { ...record, base: pull.base };
  if (pull.lifecycle === 'merged' && next.mergedAt === undefined) next.mergedAt = facts.now;
  if (pull.mergeStateStatus === 'BLOCKED' && pull.lifecycle === 'open') next.blockedSince ??= facts.now;
  else delete next.blockedSince;
  return next;
}

/** The one next thing to do: a write, an agent request, a wait or a halt. Pure; the service performs it. */
export function decide(record: AutoDeployRecord, facts: AutoDeployFacts): AutoDeployDecision {
  if (record.state !== 'armed') return wait(record.step);
  const unsure = record.writes.find(write => write.state === 'sending');
  if (unsure) return halt('outcome-unknown', `${UNCONFIRMED[unsure.kind]} Check GitHub; nothing more was sent.`);
  return record.mergedAt === undefined ? beforeMerge(record, facts) : afterMerge(record, facts);
}

function beforeMerge(record: AutoDeployRecord, facts: AutoDeployFacts): AutoDeployDecision {
  const pull = facts.pull;
  if (!pull) return wait('waiting-checks', 'reading the pull request');
  if (pull.lifecycle === 'closed') return halt('closed', 'The pull request was closed.');
  if (pull.lifecycle === 'draft') return halt('draft', 'The pull request is a draft.');
  if (facts.tagging && pull.tag !== 'ship' && !sent(record, 'tag')) return { kind: 'tag', title: pull.title };
  if (pull.queued) return wait('merge-queue');
  if (sent(record, 'merge')) return pull.queueEnabled ? halt('left-queue', 'The pull request left the merge queue without merging.') : wait('merging');
  if (pull.reviewDecision === 'CHANGES_REQUESTED') return halt('changes-requested', 'A reviewer requested changes; only a person can resolve that.');
  if (pull.mergeStateStatus === 'DIRTY') return halt('conflicts', `The branch has merge conflicts with ${pull.base}.`);
  if (pull.checks === 'failing') {
    const current = record.fixes.find(fix => fix.head === pull.head);
    if (current) return facts.now - current.at >= FIX_DEADLINE_MS ? halt('fix-stalled', 'The agent fixing CI pushed no new commit within 45 minutes.') : wait('fixing-ci', `${record.fixes.length}/${FIX_ATTEMPTS}`);
    if (record.fixes.length >= FIX_ATTEMPTS) return halt('ci-failing', `Checks still fail after ${FIX_ATTEMPTS} fix attempts${pull.failing.length ? `: ${pull.failing.join(', ')}` : ''}.`);
    return { kind: 'fix', attempt: record.fixes.length + 1, head: pull.head, failing: pull.failing };
  }
  if (pull.checks === 'pending' || pull.mergeStateStatus === 'UNKNOWN') return wait('waiting-checks');
  if (pull.reviewDecision === 'REVIEW_REQUIRED') return halt('review-required', 'A required review is missing; only a person can approve the pull request.');
  if (pull.mergeStateStatus === 'BEHIND' && !pull.queueEnabled) return halt('behind', `The branch is out of date with ${pull.base}.`);
  if (pull.mergeStateStatus === 'BLOCKED') return record.blockedSince !== undefined && facts.now - record.blockedSince >= BLOCKED_GRACE_MS
    ? halt('blocked', 'GitHub still reports the pull request blocked by a rule other than checks and reviews.') : wait('waiting-checks');
  if (!pull.method) return halt('declined', 'GitHub offers no way to merge this pull request.');
  return { kind: 'merge', method: pull.method, pullRequestId: pull.pullRequestId, head: pull.head };
}

const WAIT_ORDER: AutoDeployStep[] = ['validating', 'approving', 'delayed', 'waiting-gate', 'deploying', 'waiting-rollout'];
function afterMerge(record: AutoDeployRecord, facts: AutoDeployFacts): AutoDeployDecision {
  if (!facts.rollouts.some(rollout => rollout.run)) {
    return facts.now - record.mergedAt! >= ROLLOUT_DEADLINE_MS ? halt('no-rollout', 'No deploy run appeared within 30 minutes of the merge.') : wait('waiting-rollout');
  }
  const waits: Extract<AutoDeployDecision, { kind: 'wait' }>[] = [];
  for (const rollout of facts.rollouts) {
    const next = phase(record, rollout, facts.now);
    if (next.kind === 'wait') waits.push(next);
    else if (next.kind !== 'done') return next;
  }
  return waits.sort((a, b) => WAIT_ORDER.indexOf(a.step) - WAIT_ORDER.indexOf(b.step))[0] ?? { kind: 'done' };
}

interface Point { key: string; label: string; dueAt: number }
/** Where a rollout is validated. With a stage rule: each stage whose environment finished with something run, once its delay passed (or
 * the whole run when it finishes without any). Without: every set of gates that waits after something ran, then the whole run once it finished. */
function points(rollout: RolloutFacts): Point[] {
  const run = rollout.run!, completed = run.status === 'completed', found: Point[] = [];
  if (rollout.rule) {
    const environments = environmentStates(rollout.jobs);
    for (const plan of rollout.rule.stages) {
      const environment = environments.find(entry => entry.name === plan.environment);
      if (environment?.finishedAt !== undefined && environment.jobs.some(ran)) found.push({ key: `stage:${plan.key}`, label: plan.environment, dueAt: environment.finishedAt + plan.delayMs });
    }
  } else if (rollout.gates.length && rollout.jobs.some(job => job.status === 'completed' && ran(job))) {
    const ids = rollout.gates.map(gate => gate.id).sort((a, b) => a - b), waiting = held(rollout.jobs);
    found.push({ key: `gate:${gateKey(ids, rollout.jobs)}`, label: `before ${rollout.gates.map(gate => gate.name).join(', ')}${waiting.length ? ` (${waiting.map(job => job.name).join(', ')})` : ''}`, dueAt: 0 });
  }
  if (completed && !(rollout.rule && found.length)) found.push({ key: 'final', label: 'whole run', dueAt: 0 });
  return found;
}

type Answer = Verdict | 'pending' | 'no-report' | 'missing';
function answer(check: AutoDeployCheck, validations: readonly RolloutValidationFact[]): Answer {
  if (!check.validationId) return 'pending';
  let current = validations.find(entry => entry.label === check.validationId);
  for (let hops = 0; current?.resolvedBy && hops < 20; hops++) current = validations.find(entry => entry.label === current!.resolvedBy) ?? current;
  if (!current) return 'missing';
  return current.state === 'final' ? current.verdict ?? 'inconclusive' : current.state === 'no-report' ? 'no-report' : 'pending';
}
const HALTS: Record<Exclude<Answer, 'passed' | 'pending'>, [HaltCode, string]> = {
  failed: ['validation-failed', 'failed'], concerns: ['validation-concerns', 'found concerns'], inconclusive: ['validation-inconclusive', 'was inconclusive'],
  'no-report': ['no-verdict', 'sent no report'], missing: ['no-verdict', 'is no longer on the rollout'],
};

/** What this phase's validation covers: the jobs that ran to completion and no earlier validation of the rollout was given. */
function uncovered(record: AutoDeployRecord, rollout: RolloutFacts) {
  const covered = new Set(record.checks.filter(check => check.rolloutNodeId === rollout.nodeId).flatMap(check => check.jobs ?? []));
  return rollout.jobs.filter(job => job.status === 'completed' && ran(job) && !covered.has(job.id)).map(job => job.id).sort((a, b) => a - b);
}

function phase(record: AutoDeployRecord, rollout: RolloutFacts, now: number): AutoDeployDecision {
  const run = rollout.run;
  if (!run) return wait('waiting-rollout');
  if (run.status === 'completed' && run.conclusion !== 'success') return halt('deploy-failed', `${rollout.title}: the deploy run ended ${run.conclusion ?? 'without a conclusion'}.`);
  const broken = rollout.jobs.find(job => job.status === 'completed' && FAILED_JOB.has(job.conclusion ?? ''));
  if (broken) return halt('deploy-failed', `${rollout.title}: job ${broken.name} ${broken.conclusion === 'cancelled' ? 'was cancelled' : 'failed'}.`);
  for (const point of points(rollout)) {
    const key = `${rollout.nodeId}:${run.id}:${run.attempt}:${point.key}`, check = record.checks.find(entry => entry.key === key);
    if (!check) return point.dueAt > now ? wait('delayed', `${point.label} · ${minutes(point.dueAt - now)}`) : { kind: 'validate', key, rolloutNodeId: rollout.nodeId, label: point.label, jobs: uncovered(record, rollout) };
    const result = answer(check, rollout.validations), name = `${check.validationId ? `Validation ${check.validationId}` : 'The validation'} of ${point.label}`;
    if (result === 'passed') continue;
    if (result === 'pending') return now - check.requestedAt >= VALIDATION_DEADLINE_MS ? halt('no-verdict', `${name} gave no verdict within an hour.`) : wait('validating', point.label);
    const [code, text] = HALTS[result];
    return halt(code, `${name} ${text}.`);
  }
  const approvable = rollout.gates.filter(gate => gate.approvable);
  if (approvable.length) {
    const ids = approvable.map(gate => gate.id).sort((a, b) => a - b), names = approvable.map(gate => gate.name).join(', '), key = `approve:${rollout.nodeId}:${run.id}:${run.attempt}:${gateKey(ids, rollout.jobs)}`;
    return sent(record, key) ? wait('deploying', names) : { kind: 'approve', key, rolloutNodeId: rollout.nodeId, runId: run.id, attempt: run.attempt, environmentIds: ids, names };
  }
  if (rollout.gates.length) return wait('waiting-gate', rollout.gates.map(gate => gate.name).join(', '));
  if (run.status !== 'completed') {
    const environments = environmentStates(rollout.jobs), current = environments.find(entry => entry.status === 'running') ?? environments.find(entry => entry.status === 'pending');
    return wait('deploying', current?.name ?? rollout.title);
  }
  return { kind: 'done' };
}

const STEP_OF: Record<Exclude<AutoDeployDecision['kind'], 'wait' | 'halt' | 'done'>, AutoDeployStep> = { tag: 'tagging', merge: 'merging', fix: 'fixing-ci', validate: 'validating', approve: 'approving' };
/** The record after a decision: the step and its detail for the status line; a halt or done ends it. */
export function settle(record: AutoDeployRecord, decision: AutoDeployDecision, now: number): AutoDeployRecord {
  const next: AutoDeployRecord = { ...record, updatedAt: now };
  delete next.detail;
  if (decision.kind === 'halt') return { ...next, state: 'halted', step: 'halted', halt: { code: decision.code, reason: decision.reason, at: now } };
  if (decision.kind === 'done') return { ...next, state: 'done', step: 'done' };
  if (decision.kind === 'wait') return { ...next, step: decision.step, ...(decision.detail ? { detail: decision.detail } : {}) };
  const detail = decision.kind === 'fix' ? `${decision.attempt}/${FIX_ATTEMPTS}` : decision.kind === 'validate' ? decision.label : decision.kind === 'approve' ? decision.names : undefined;
  return { ...next, step: STEP_OF[decision.kind], ...(detail ? { detail } : {}) };
}

/** “Auto deploy · validating preview”, as the pull request view and the rollout view show it. */
export function statusLine(record: Pick<AutoDeployRecord, 'step' | 'detail' | 'halt'>): string {
  const detail = record.detail ?? '';
  const text: Record<AutoDeployStep, string> = {
    tagging: 'tagging [ship]', 'waiting-checks': 'waiting for checks', 'fixing-ci': `fixing CI (${detail || `1/${FIX_ATTEMPTS}`})`, merging: 'merging', 'merge-queue': 'in the merge queue',
    'waiting-rollout': 'waiting for the deploy run', deploying: detail ? `deploying ${detail}` : 'deploying', delayed: `waiting out ${detail}`, validating: detail ? `validating ${detail}` : 'validating',
    approving: detail ? `approving ${detail}` : 'approving', 'waiting-gate': `${detail || 'a gate'} waits for another approver`, done: 'done', halted: `halted: ${record.halt?.reason ?? 'stopped on a doubt'}`, stopped: 'stopped',
  };
  return `Auto deploy · ${text[record.step]}`;
}
