import type { RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { HeadChecks, PullLifecycle, PullMergeMethod, PullMergeReadiness } from '../../../../packages/provider-runtime/github.ts';
import type { ValidationState, Verdict } from './validation.ts';
import { environmentStates } from './stages.ts';
import { stageOf } from './validation.ts';
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
export type HaltCode = 'closed' | 'draft' | 'changes-requested' | 'review-required' | 'conflicts' | 'behind' | 'blocked' | 'ci-failing' | 'fix-stalled' | 'declined' | 'outcome-unknown'
  | 'no-rollout' | 'deploy-failed' | 'validation-failed' | 'validation-concerns' | 'validation-inconclusive' | 'no-verdict' | 'agent-unavailable' | 'error';

/** A write is recorded `sending` before it goes out and `sent` once GitHub confirmed it; a `sending` one found later is never sent again.
 * `label` names what an approval opened, for the rollout's timeline. */
export interface AutoDeployWrite { key: string; kind: 'tag' | 'merge' | 'approve' | 'fix'; requestId: string; at: number; state: 'sending' | 'sent'; label?: string }
/** One validation of a phase: `agent` is the trigger value it was asked with, so asking again after a restart is the same journaled request.
 * A check seeded when a running rollout was taken over either names a passing validation that already covered its jobs (`seeded`) or
 * counts what deployed before arming as accepted without a validation (`accepted`). */
export interface AutoDeployCheck { key: string; rolloutNodeId: string; label: string; requestId: string; agent?: string; validationId?: string; requestedAt: number; jobs?: number[]; seeded?: true; accepted?: true }
export interface AutoDeployFix { head: string; at: number; agentNodeId?: string }
/** How a takeover treats the phases that deployed before it was armed: validate those no passing validation covers, or accept them. */
export type CatchUp = 'validate' | 'accept';
/** Auto deploy armed on a rollout that was already running: the rollouts it follows, and which validations counted when it was armed. */
export interface AutoDeployTakeover { at: number; catchUp: CatchUp; rolloutNodeIds: string[]; counts?: string[] }
/** Keyed by the pull request (`pullResourceId`), or, for a rollout no pull request on the map discovered, by the rollout (`rolloutResourceId`). */
export interface AutoDeployRecord {
  version: 1; id: string; pullResourceId?: string; pullNodeId?: string; rolloutResourceId?: string; rolloutNodeId?: string; armedAt: number; updatedAt: number;
  state: AutoDeployState; step: AutoDeployStep; detail?: string;
  base?: string; mergedAt?: number; blockedSince?: number; takeover?: AutoDeployTakeover;
  writes: AutoDeployWrite[]; fixes: AutoDeployFix[]; checks: AutoDeployCheck[];
  halt?: { code: HaltCode; reason: string; at: number };
}
/** The storage key of a record: its pull request's resource, else its rollout's. */
export const recordKey = (record: Pick<AutoDeployRecord, 'id' | 'pullResourceId' | 'rolloutResourceId'>) => record.pullResourceId ?? record.rolloutResourceId ?? record.id;

export interface PullFacts extends Pick<PullMergeReadiness, 'head' | 'base' | 'title' | 'reviewDecision' | 'queued' | 'queueEnabled' | 'pullRequestId'> {
  lifecycle: PullLifecycle; tag: string; mergeStateStatus: PullMergeReadiness['mergeStateStatus']; checks: HeadChecks; failing: string[]; method: PullMergeMethod | null;
}
/** A validation of the rollout: its run attempt and the jobs it was scoped to, when known, say what a passing one covers. */
/** `environments` and `requestedAt` say what one scoped to environments, or to the whole run, is about. */
export interface RolloutValidationFact { label: string; state: ValidationState; verdict?: Verdict; resolvedBy?: string; jobs?: number[]; environments?: string[]; runId?: number; attempt?: number; stale?: boolean; requestedAt?: number; finishedAt?: number }
/** `gateEnvironments` are the environments that held this attempt at a gate so far, waiting or approved; `gateApprovals` when each
 * environment's gate was approved, as far as it is known; `autoValidate`, a pull request's Auto validate covers the rollout. */
export interface RolloutFacts {
  nodeId: string; title: string; run?: { id: number; attempt: number; status: string; conclusion: string | null; headSha: string; number?: number };
  jobs: RolloutJob[]; gates: { id: number; name: string; approvable: boolean }[]; rule?: StageRule; validations: RolloutValidationFact[]; gateEnvironments?: string[];
  gateApprovals?: { environment: string; at: number }[]; autoValidate?: boolean;
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
  | { kind: 'stop'; reason: string }
  | { kind: 'done' };

type ArmInput = { id: string; now: number; takeover?: Omit<AutoDeployTakeover, 'at' | 'counts'> } & ({ pullResourceId: string; pullNodeId: string } | { rolloutResourceId: string; rolloutNodeId: string; takeover: Omit<AutoDeployTakeover, 'at' | 'counts'> });
/** A new record. On a pull request it starts before the merge; a takeover of running rollouts starts after it, following those rollouts. */
export function armRecord(input: ArmInput): AutoDeployRecord {
  const owner = 'pullResourceId' in input ? { pullResourceId: input.pullResourceId, pullNodeId: input.pullNodeId } : { rolloutResourceId: input.rolloutResourceId, rolloutNodeId: input.rolloutNodeId };
  const base = { version: 1 as const, id: input.id, ...owner, armedAt: input.now, updatedAt: input.now, state: 'armed' as const };
  if (!input.takeover) return { ...base, step: 'waiting-checks', writes: [], fixes: [], checks: [] };
  return { ...base, step: 'deploying', mergedAt: input.now, takeover: { at: input.now, catchUp: input.takeover.catchUp, rolloutNodeIds: [...input.takeover.rolloutNodeIds] }, writes: [], fixes: [], checks: [] };
}

/** Why a running rollout cannot be taken over, or undefined when it can. */
export function takeoverRefusal(rollout: Pick<RolloutFacts, 'run'>): string | undefined {
  const run = rollout.run;
  if (!run) return 'Waiting for the deploy run.';
  if (run.status !== 'completed') return undefined;
  return run.conclusion === 'success' ? 'Already deployed.' : 'The run failed. Re-run it on GitHub first.';
}

/** The checks a takeover starts with. Every passing, current validation of the attempt that was scoped to jobs counts for those jobs.
 * `validate`: a phase already due that they cover in full counts as passed; every other due phase is validated by `decide` before a
 * gate is approved. `accept`: whatever else deployed before arming counts as accepted, and every phase already due as passed. */
export function seedCatchUp(record: AutoDeployRecord, rollouts: readonly RolloutFacts[], now: number): AutoDeployRecord {
  const next: AutoDeployRecord = { ...record, checks: [...record.checks] }, counts: string[] = [];
  const has = (key: string) => next.checks.some(entry => entry.key === key);
  for (const rollout of rollouts) {
    const run = rollout.run;
    if (!run) continue;
    const prefix = `${rollout.nodeId}:${run.id}:${run.attempt}`;
    const seed = (key: string, label: string, extra: Partial<AutoDeployCheck>) => { if (!has(key)) next.checks.push({ key, rolloutNodeId: rollout.nodeId, label, requestId: `${record.id}:seed:${key}`, requestedAt: now, ...extra }); };
    const due = points(rollout).filter(point => point.dueAt <= now);
    const completed = new Set(rollout.jobs.filter(job => job.status === 'completed' && ran(job)).map(job => job.id));
    for (const validation of rollout.validations) {
      if (validation.state !== 'final' || validation.verdict !== 'passed' || validation.stale || validation.resolvedBy || validation.runId !== run.id || validation.attempt !== run.attempt) continue;
      const jobs = (validation.jobs ?? []).filter(id => completed.has(id)).sort((a, b) => a - b);
      if (!jobs.length) continue;
      seed(`${prefix}:seed:${validation.label}`, validation.label, { validationId: validation.label, jobs, seeded: true });
      counts.push(validation.label);
    }
    if (record.takeover?.catchUp === 'accept') {
      const jobs = uncovered(next, rollout);
      if (jobs.length) seed(`${prefix}:accepted`, 'accepted when armed', { accepted: true, jobs });
      for (const point of due) seed(`${prefix}:${point.key}`, point.label, { accepted: true, jobs: [] });
      continue;
    }
    const counted = next.checks.filter(entry => entry.rolloutNodeId === rollout.nodeId && entry.seeded).at(-1);
    for (const point of due) {
      if (!counted || uncovered(next, rollout).length) break;
      seed(`${prefix}:${point.key}`, point.label, { validationId: counted.validationId!, jobs: [], seeded: true });
    }
  }
  return counts.length && next.takeover ? { ...next, takeover: { ...next.takeover, counts } } : next;
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
  if (sent(record, 'merge')) return pull.queueEnabled ? { kind: 'stop', reason: 'The pull request was taken out of the merge queue.' } : wait('merging');
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
  if (check.accepted) return 'passed';
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

const STEP_OF: Record<Exclude<AutoDeployDecision['kind'], 'wait' | 'halt' | 'stop' | 'done'>, AutoDeployStep> = { tag: 'tagging', merge: 'merging', fix: 'fixing-ci', validate: 'validating', approve: 'approving' };
/** The record after a decision: the step and its detail for the status line; a halt, stop or done ends it. A stop is a person's
 * doing on GitHub, so it asks nothing of them. */
export function settle(record: AutoDeployRecord, decision: AutoDeployDecision, now: number): AutoDeployRecord {
  const next: AutoDeployRecord = { ...record, updatedAt: now };
  delete next.detail;
  if (decision.kind === 'halt') return { ...next, state: 'halted', step: 'halted', halt: { code: decision.code, reason: decision.reason, at: now } };
  if (decision.kind === 'stop') return { ...next, state: 'stopped', step: 'stopped', detail: decision.reason };
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

export type PhaseCheckState = 'passed' | 'running' | 'concerns' | 'failed' | 'accepted' | 'none';
export type PhaseGateState = 'approved' | 'approving' | 'auto' | 'you' | 'other' | 'later';
/** One phase of a rollout: whether it deployed, which validation covers it (`seeded`: one that counted when auto deploy was
 * armed) and, for a gated phase, who opens its gate (`after`: the validation of the phase before it that the approval waits for;
 * `at`: when a gate of a rollout without auto deploy was approved). `jobIds` are the phase's jobs. */
export interface TrackPhase {
  name: string; state: 'done' | 'running' | 'waiting'; at?: number; jobs: { done: number; total: number }; jobIds: number[];
  check?: { id?: string; state: PhaseCheckState; seeded?: true }; noCheck?: true;
  gate?: { state: PhaseGateState; by?: 'you' | 'auto deploy'; after?: string; at?: number };
}
/** `current` is the phase auto deploy works on, or without it the one the rollout is at; `currentGate` says it is that phase's gate.
 * `plain`: read from the rollout alone, with no auto deploy record; `autoValidate`: a pull request's Auto validate covers the rollout. */
export interface PhaseTrack { phases: TrackPhase[]; current?: number; currentGate?: true; plain?: true; autoValidate?: true }

const DEPLOY_STAGES = new Set(['staging', 'canary', 'preview', 'production']);
/** A job's name without the reusable-workflow part and matrix values: the workflow job it belongs to. */
const jobKey = (name: string) => name.split(' / ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
const heldIds = (key: string) => (/@([\d,]+)$/.exec(key)?.[1] ?? '').split(',').filter(Boolean).map(Number);
const CHECK_OF: Record<Answer, PhaseCheckState> = { passed: 'passed', pending: 'running', concerns: 'concerns', failed: 'failed', inconclusive: 'failed', 'no-report': 'failed', missing: 'failed' };

interface Grouped { stage: string; keys: string[]; jobs: RolloutJob[]; setup?: true; gated?: boolean; label?: string }
/** The rollout's phases in order: build and setup jobs before the first deployment as one phase that needs no check, then one phase per
 * environment, a new one at every gate (so an environment that gates several phases has one phase each). With a stage rule, its stages
 * in order, including those not reached yet. Without gates or a rule, the whole run is one phase, as it is validated once at the end. */
function trackEnvironments(rollout: RolloutFacts) {
  const gateEnvironments = [...new Set([...rollout.gates.map(gate => gate.name), ...(rollout.gateEnvironments ?? [])])];
  const ruleEnvironments = [...new Set(rollout.rule?.stages.map(stage => stage.environment) ?? [])];
  return { gateEnvironments, ruleEnvironments, environments: [...ruleEnvironments, ...gateEnvironments] };
}
function groupPhases(record: AutoDeployRecord | undefined, rollout: RolloutFacts): Grouped[] {
  const { gateEnvironments, ruleEnvironments, environments } = trackEnvironments(rollout), gatedStages = new Set(gateEnvironments.map(name => stageOf(name, environments)));
  const known = new Set([...(record?.writes ?? []).filter(write => write.kind === 'approve').flatMap(write => heldIds(write.key)), ...(record?.checks ?? []).filter(entry => entry.rolloutNodeId === rollout.nodeId).flatMap(entry => heldIds(entry.key))]);
  const jobs = [...rollout.jobs].sort((a, b) => a.id - b.id);
  if (!rollout.rule && !gateEnvironments.length && !known.size) return jobs.length ? [{ stage: 'whole run', keys: [], jobs }] : [];
  const deploying = (stage: string) => DEPLOY_STAGES.has(stage) || environments.some(name => stageOf(name, environments) === stage);
  if (!rollout.rule) return inferredPhases(jobs, environments, gateEnvironments, job => rollout.gates.length > 0 && job.status === 'waiting' || known.has(job.id), deploying);
  const groups: Grouped[] = [];
  if (rollout.rule) for (const name of ruleEnvironments) groups.push({ stage: stageOf(name, environments), keys: [], jobs: [], gated: gatedStages.has(stageOf(name, environments)) });
  for (const job of jobs) {
    const stage = stageOf(job.name, environments), key = jobKey(job.name);
    const gated = rollout.gates.length > 0 && job.status === 'waiting' || known.has(job.id) || gatedStages.has(stage);
    const started = groups.some(group => !group.setup && group.jobs.length);
    if (!started && !gated && !(rollout.rule ? groups.some(group => group.stage === stage) : deploying(stage))) {
      const setup = groups.find(group => group.setup) ?? (groups.unshift({ stage: 'build', keys: [], jobs: [], setup: true }), groups[0]);
      setup.jobs.push(job); continue;
    }
    if (rollout.rule) {
      const own = groups.find(group => !group.setup && group.stage === stage) ?? [...groups].reverse().find(group => !group.setup && group.jobs.length);
      if (own) { own.jobs.push(job); if (!own.keys.includes(key)) own.keys.push(key); continue; }
    }
    const last = groups.at(-1);
    if (last && !last.setup && last.stage === stage && (!gated || last.keys.includes(key))) { last.jobs.push(job); if (!last.keys.includes(key)) last.keys.push(key); continue; }
    groups.push({ stage, keys: [key], jobs: [job], gated });
  }
  return groups;
}

const BUILD_STEP = /(^|[^a-z])(build|lint|manifest|version|regions|setup|plan)([^a-z]|$)/, DEV_STAGE = /(^|[^a-z])(dev|development)([^a-z]|$)/;
const phaseLabel = (name: string) => /phase[-_ ]?\d+/i.exec(name)?.[0].toLowerCase();
/** Phases of a rollout without a stage rule. Parallel jobs interleave their ids, so jobs are grouped by stage wherever they fall:
 * a job whose first name part is a build step (`staging-build`, `runtime-version`) is build, `dev` is a stage, and a stage splits
 * by `phase-N` labels, with unlabelled jobs joining the labelled phase nearest by id. Jobs before the first deployment that name
 * no deploying stage are build too. Stages are ordered by their last job, since a stage's preparation can start early. */
function inferredPhases(jobs: readonly RolloutJob[], environments: readonly string[], gateEnvironments: readonly string[], held: (job: RolloutJob) => boolean, deploying: (stage: string) => boolean): Grouped[] {
  const gatedStages = new Set(gateEnvironments.map(name => stageOf(name)));
  const named = (name: string) => { const top = name.split(' / ')[0].toLowerCase(); return BUILD_STEP.test(top) ? 'build' : DEV_STAGE.test(top) ? 'dev' : stageOf(name, environments); };
  const deploys = (stage: string) => stage === 'dev' || stage !== 'build' && deploying(stage);
  const firstDeploy = jobs.find(job => deploys(named(job.name)))?.id ?? Infinity;
  const placed = jobs.map(job => { const stage = named(job.name); return { job, stage: stage === 'build' || job.id < firstDeploy && !deploys(stage) ? 'build' : stage || 'jobs', label: phaseLabel(job.name) }; });
  const groups: Grouped[] = [];
  const groupFor = (stage: string, label?: string) => groups.find(group => group.stage === stage && group.label === label)
    ?? (groups.push({ stage, keys: [], jobs: [], ...(label ? { label } : {}), ...(stage === 'build' ? { setup: true as const } : {}) }), groups.at(-1)!);
  for (const entry of placed) if (entry.label) groupFor(entry.stage, entry.label).jobs.push(entry.job);
  const distance = (group: Grouped, job: RolloutJob) => Math.min(...group.jobs.map(other => Math.abs(other.id - job.id)));
  for (const entry of placed) {
    if (entry.label) continue;
    const nearest = groups.filter(group => group.stage === entry.stage && group.label).sort((a, b) => distance(a, entry.job) - distance(b, entry.job))[0];
    (nearest ?? groupFor(entry.stage)).jobs.push(entry.job);
  }
  for (const group of groups) {
    group.jobs.sort((a, b) => a.id - b.id);
    group.keys = [...new Set(group.jobs.map(job => jobKey(job.name)))];
    if (!group.setup) group.gated = group.jobs.some(held) || gatedStages.has(group.stage);
  }
  return groups.sort((a, b) => Number(Boolean(b.setup)) - Number(Boolean(a.setup)) || a.jobs.at(-1)!.id - b.jobs.at(-1)!.id);
}

const startedAt = (job: RolloutJob) => Date.parse(job.started_at ?? '');
const hadRun = (job: RolloutJob) => job.status === 'completed' || job.status === 'in_progress';

/** Without a record, a phase's check is the newest validation of the current attempt that covers it: scoped to its jobs, to its
 * environment, or to the whole run, which covers the last phase that had run when it was requested. A request a later final
 * validation resolved no longer counts. */
function plainChecks(groups: readonly Grouped[], rollout: RolloutFacts, validations: readonly RolloutValidationFact[]): (RolloutValidationFact | undefined)[] {
  const run = rollout.run, { environments } = trackEnvironments(rollout);
  const current = validations.filter(entry => run && entry.runId === run.id && entry.attempt === run.attempt && !entry.stale && !(entry.state !== 'final' && entry.resolvedBy));
  const lastRun = (before: number | undefined) => groups.map((group, index) => ({ group, index }))
    .filter(({ group }) => !group.setup && group.jobs.some(job => hadRun(job) && (before === undefined || startedAt(job) <= before))).at(-1)?.index;
  const covers = (entry: RolloutValidationFact, group: Grouped, index: number) => {
    if (entry.jobs?.length) return group.jobs.some(job => entry.jobs!.includes(job.id));
    if (entry.environments?.length) {
      const stages = new Set(entry.environments.map(name => stageOf(name, environments)));
      return stages.has(group.stage) || group.jobs.some(job => stages.has(stageOf(job.name, environments)));
    }
    return lastRun(entry.requestedAt) === index;
  };
  return groups.map((group, index) => group.setup ? undefined : current.filter(entry => covers(entry, group, index)).at(-1));
}
const plainAnswer = (entry: RolloutValidationFact): Answer => entry.state === 'final' ? entry.verdict ?? 'inconclusive' : entry.state === 'no-report' ? 'no-report' : 'pending';

/** When each gate a person approved was opened: an approval of its environment reported no later than the phase started, each used
 * once and in order, else the phase's first job starting. */
function approvalTimes(groups: readonly Grouped[], rollout: RolloutFacts) {
  const { environments } = trackEnvironments(rollout), used = new Set<number>(), approvals = [...rollout.gateApprovals ?? []].sort((a, b) => a.at - b.at);
  return groups.map(group => {
    const starts = group.jobs.map(startedAt).filter(Number.isFinite), start = starts.length ? Math.min(...starts) : undefined;
    const found = approvals.findIndex((entry, index) => !used.has(index) && stageOf(entry.environment, environments) === group.stage && (start === undefined || entry.at <= start));
    if (found >= 0) { used.add(found); return approvals[found].at; }
    return start;
  });
}

/** The phase track of a rollout: from the auto deploy record following it and the rollout as last read, or without a record from the
 * rollout alone (its validations and its gates on GitHub). Without a record a rollout of one phase has no track. */
export function phaseTrack(record: AutoDeployRecord | undefined, rollout: RolloutFacts, validations: readonly RolloutValidationFact[] = rollout.validations): PhaseTrack {
  const groups = groupPhases(record, rollout), run = rollout.run, armed = record?.state === 'armed';
  if (!record && groups.length < 2) return { phases: [], plain: true };
  const prefix = run ? `${rollout.nodeId}:${run.id}:${run.attempt}:` : undefined;
  const checks = (record?.checks ?? []).filter(entry => entry.rolloutNodeId === rollout.nodeId && prefix !== undefined && entry.key.startsWith(prefix));
  const plain = record ? undefined : plainChecks(groups, rollout, validations);
  const repeated = (stage: string) => groups.filter(group => group.stage === stage).length > 1;
  const phases = groups.map((group, index): TrackPhase => {
    const done = group.jobs.filter(job => job.status === 'completed').length, ids = new Set(group.jobs.map(job => job.id));
    const state = group.jobs.length && done === group.jobs.length ? 'done' : group.jobs.some(job => job.status === 'in_progress' || job.status === 'completed') ? 'running' : 'waiting';
    const ends = group.jobs.map(job => Date.parse(job.completed_at ?? '')).filter(Number.isFinite);
    const label = group.keys.map(key => /phase[-_ ]?\d+/i.exec(key)?.[0]).find(Boolean) ?? group.keys[0];
    const name = group.setup ? 'build' : group.label ? group.stage.includes(group.label) ? group.label : `${group.stage} · ${group.label}` : repeated(group.stage) && label ? `${group.stage} · ${label}` : group.stage || group.keys[0] || 'jobs';
    const phase: TrackPhase = { name, state, ...(state === 'done' && ends.length ? { at: Math.max(...ends) } : {}), jobs: { done, total: group.jobs.length }, jobIds: [...ids].sort((a, b) => a - b) };
    if (group.setup) return { ...phase, noCheck: true };
    if (plain) {
      const found = plain[index];
      phase.check = found ? { id: found.label, state: CHECK_OF[plainAnswer(found)] } : { state: 'none' };
      return phase;
    }
    const covering = checks.filter(entry => (entry.jobs ?? []).some(id => ids.has(id))).at(-1);
    phase.check = !covering ? { state: 'none' } : covering.accepted ? { state: 'accepted' }
      : { ...(covering.validationId ? { id: covering.validationId } : {}), state: CHECK_OF[answer(covering, validations)], ...(covering.seeded ? { seeded: true as const } : {}) };
    return phase;
  });
  const approvedAt = record ? [] : approvalTimes(groups, rollout);
  groups.forEach((group, index) => {
    if (!group.gated) return;
    const phase = phases[index], held = rollout.gates.length > 0 && group.jobs.some(job => job.status === 'waiting');
    const after = phases[index - 1]?.check?.id;
    if (held) {
      const state: PhaseGateState = !rollout.gates.some(gate => gate.approvable) ? 'other' : !armed ? 'you' : record!.step === 'approving' ? 'approving' : 'auto';
      phase.gate = { state, ...(after && (state === 'auto' || state === 'approving') ? { after } : {}) };
    } else if (phase.state !== 'waiting') {
      const ids = new Set(group.jobs.map(job => job.id)), mine = record?.writes.some(write => write.kind === 'approve' && write.state === 'sent' && heldIds(write.key).some(id => ids.has(id)));
      phase.gate = { state: 'approved', ...(mine ? { by: 'auto deploy' as const } : {}), ...(approvedAt[index] !== undefined ? { at: approvedAt[index] } : {}) };
    } else phase.gate = !record ? { state: 'later' } : { state: armed ? 'auto' : 'you', ...(armed && after ? { after } : {}) };
  });
  const track: PhaseTrack = { phases };
  const held = phases.findIndex(phase => phase.gate && phase.gate.state !== 'approved' && groups[phases.indexOf(phase)].jobs.some(job => job.status === 'waiting'));
  if (!record) {
    track.plain = true;
    if (rollout.autoValidate) track.autoValidate = true;
    const running = phases.findIndex(phase => phase.state === 'running'), validating = phases.map(phase => phase.check?.state).lastIndexOf('running');
    const open = phases.findIndex(phase => phase.state !== 'done');
    if (held >= 0 && rollout.gates.length) { track.current = held; track.currentGate = true; }
    else if (running >= 0) track.current = running;
    else if (validating >= 0) track.current = validating;
    else if (run?.status !== 'completed' && open >= 0) track.current = open;
    return track;
  }
  if (record.state !== 'armed' && record.state !== 'halted' || !phases.length) return track;
  const firstOpen = phases.findIndex(phase => phase.state !== 'done'), fallback = firstOpen < 0 ? phases.length - 1 : firstOpen;
  const atGate = () => { track.current = held; track.currentGate = true; };
  if (record.state === 'halted') {
    const doubt = phases.findIndex(phase => phase.check?.state === 'concerns' || phase.check?.state === 'failed');
    if (doubt >= 0) track.current = doubt; else if (held >= 0) atGate(); else track.current = fallback;
    return track;
  }
  const running = phases.findIndex(phase => phase.state === 'running'), lastDone = phases.map(phase => phase.state).lastIndexOf('done');
  const validating = phases.map(phase => phase.check?.state).lastIndexOf('running');
  if (record.step === 'validating' && validating >= 0) track.current = validating;
  else if ((record.step === 'approving' || record.step === 'waiting-gate') && held >= 0) atGate();
  else if (record.step === 'deploying' && running >= 0) track.current = running;
  else if (record.step === 'deploying' && held >= 0) atGate();
  else if (record.step === 'delayed' && lastDone >= 0) track.current = lastDone;
  else track.current = fallback;
  return track;
}

/** What auto deploy does after the current phase: “approve production”, “validate staging”, “deploy phase-2” or “done”. */
export function trackNext(track: PhaseTrack): string {
  if (track.current === undefined) return '';
  const phases = track.phases, index = track.current, phase = phases[index];
  if (track.currentGate) return `deploy ${phase.name}`;
  if (phase.state !== 'done' && !phase.noCheck) return `validate ${phase.name}`;
  const next = phases[index + 1];
  if (!next) return 'done';
  return next.gate && next.gate.state !== 'approved' ? `approve ${next.name}` : `deploy ${next.name}`;
}

export interface AutoDeployEvent { at: number; kind: 'armed' | 'validate' | 'approve' | 'halted' | 'done' | 'stopped'; text: string }
/** What auto deploy did, oldest first, for the rollout's timeline: armed, each validation it asked for, each approval it sent, and how it ended. */
export function autoDeployEvents(record: AutoDeployRecord): AutoDeployEvent[] {
  const takeover = record.takeover, counts = takeover?.counts ?? [];
  const caughtUp = takeover?.catchUp === 'accept' ? ' · what already deployed counts as accepted' : counts.length ? ` · ${counts.join(', ')} ${counts.length === 1 ? 'counts' : 'count'}` : '';
  const events: AutoDeployEvent[] = [{ at: record.armedAt, kind: 'armed', text: `armed by you${takeover ? ' from here' : ''}${caughtUp}` }];
  for (const check of record.checks) if (!check.seeded && !check.accepted) events.push({ at: check.requestedAt, kind: 'validate', text: `asked Claude to validate ${check.label}${check.validationId ? ` · ${check.validationId}` : ''}` });
  for (const write of record.writes) if (write.kind === 'approve' && write.state === 'sent') events.push({ at: write.at, kind: 'approve', text: `approved ${write.label ?? 'the gate'}` });
  if (record.state === 'halted') events.push({ at: record.halt?.at ?? record.updatedAt, kind: 'halted', text: `halted: ${record.halt?.reason ?? 'stopped on a doubt'}` });
  if (record.state === 'done') events.push({ at: record.updatedAt, kind: 'done', text: 'done' });
  if (record.state === 'stopped') events.push({ at: record.updatedAt, kind: 'stopped', text: `stopped${record.detail ? `: ${record.detail}` : ''}` });
  return events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).map(entry => entry.event);
}
