import type { JsonObject, ResourceSnapshot } from '../../types.ts';
import { CONNECTION_LOST, OUTCOME_UNKNOWN, REQUEST_TIMEOUT } from '../../../../packages/workspace-service/protocol.ts';
import type { ResourceIndicator } from '../../indicators.ts';
import type { RolloutObservation } from '../../../../packages/provider-runtime/github-rollout.ts';
import { activeValidation, annotateValidations, ATTACH_VALIDATION, currentVerdict, duration, jobShortName, liveness, NEW_VALIDATION_AGENT, quietLabel, verdictLabels } from './validation.ts';
import { formatWhen } from '../../format-when.ts';
import type { RolloutEvent, Validation } from './validation.ts';
import { queueLabel } from './queue.ts';
import type { ChipTone } from '../../view-header.ts';

const time = (value?: string | null) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : undefined; };
const agentName = (validation: Validation) => validation.agent.provider ? validation.agent.provider[0].toUpperCase() + validation.agent.provider.slice(1) : validation.agent.title.split(/\s+·\s+/)[0];

/** Map card cues: the state, a jobs summary, then one line that
 * names a verdict needing you, else a validation under way with its last report and
 * current step (amber once it went quiet), else the running jobs with elapsed time,
 * else a passed validation. At most three, leaving room for the paused cue.
 * A queued rollout with runs ahead shows only the queue label. */
export function rolloutIndicators(snapshot: ResourceSnapshot, validations: readonly Validation[], events: readonly RolloutEvent[], now: number): ResourceIndicator[] | undefined {
  const state = snapshot.indicators?.find(cue => cue.id === 'rollout-state'), observation = snapshot.detail as unknown as (RolloutObservation & { state?: string }) | undefined;
  if (!state || !observation?.run) return snapshot.indicators;
  if (observation.state === 'queued' && observation.queue?.ahead.length) return [{ ...state, label: queueLabel(observation.queue), showLabel: true }];
  const { run, jobs } = observation, mine = events.filter(event => event.runId === run.id);
  const running = jobs.filter(job => job.status === 'in_progress'), done = jobs.filter(job => job.status === 'completed');
  const starts = jobs.map(job => time(job.started_at)).filter((value): value is number => value !== undefined), ends = done.map(job => time(job.completed_at)).filter((value): value is number => value !== undefined);
  const gate = mine.filter(event => event.attempt === run.run_attempt && event.kind === 'gate-waiting').map(event => event.observedAt).sort((a, b) => a - b)[0];
  const summary = observation.state === 'approval' && gate !== undefined ? `gate ${duration(now - gate)}`
    : running.length ? run.run_attempt > 1 && !done.length ? `attempt ${run.run_attempt}` : `${running.length} running`
      : run.status === 'completed' && starts.length && ends.length ? duration(Math.max(...ends) - Math.min(...starts)) : `${done.length}/${jobs.length} jobs`;
  const cues: ResourceIndicator[] = [{ ...state, showLabel: true }, { id: 'rollout-jobs', label: summary, icon: 'clock', tone: 'neutral' }];
  const views = annotateValidations(validations, run), verdict = currentVerdict(views), validating = activeValidation(views);
  if (verdict && (verdict.verdict === 'failed' || verdict.verdict === 'concerns'))
    return [...cues, { id: 'rollout-verdict', label: `${verdictLabels[verdict.verdict]} · ${agentName(verdict.validation)}`, icon: verdict.verdict === 'failed' ? 'x' : 'alert-triangle', tone: verdict.verdict === 'failed' ? 'red' : 'amber' }];
  if (validating) {
    const checks = validating.report?.checks ?? [], finished = checks.filter(check => !['running', 'pending'].includes(check.status)).length, live = liveness(validating, now);
    const when = live.quiet ? quietLabel(live.quietMs) : live.reportedAt === undefined ? 'waiting for the first report' : formatWhen(live.reportedAt, 'relative', now);
    const label = [`Validating · ${agentName(validating)}`, checks.length && `${finished}/${checks.length}`, when, live.step].filter(Boolean).join(' · ');
    return [...cues, { id: 'rollout-validating', label: label.length > 120 ? `${label.slice(0, 119)}…` : label, icon: live.quiet ? 'alert-triangle' : 'clock', tone: live.quiet ? 'amber' : 'blue' }];
  }
  if (running.length) {
    const failed = run.run_attempt > 1 && !done.length && mine.some(event => event.attempt === run.run_attempt - 1 && event.kind === 'run-completed' && event.body.conclusion !== 'success');
    const names = running.map(job => `${jobShortName(job.name)} ${duration(now - (time(job.started_at) ?? now))}`).slice(0, 3).join(' · ');
    return [...cues, { id: 'rollout-line', label: `${names}${failed ? ` · #${run.run_attempt - 1} failed` : ''}`.slice(0, 120), icon: 'clock', tone: 'blue' }];
  }
  if (verdict) return [...cues, { id: 'rollout-validated', label: `${verdict.verdict === 'passed' ? 'Validated' : verdictLabels[verdict.verdict]} · ${agentName(verdict.validation)}`, icon: verdict.verdict === 'passed' ? 'check' : 'alert-triangle', tone: verdict.verdict === 'passed' ? 'green' : 'neutral' }];
  const line = observation.state === 'approval' ? `${done.length}/${jobs.length} done` : `${done.length}/${jobs.length} jobs`;
  return jobs.length && line !== summary ? [...cues, { id: 'rollout-line', label: line, icon: 'clock', tone: 'neutral' }] : cues;
}

/** The hint under an empty timeline says what the person can do now, not a fixed line. */
export function rolloutEmptyHint(state: { jobs: number; validations: number }) {
  if (!state.jobs) return 'Ask an agent to validate';
  return state.validations ? 'Click a job to filter' : 'Click a job to filter · Ask an agent to validate';
}

const TONES: Record<string, ChipTone> = { passed: 'green', failed: 'red', cancelled: 'neutral', skipped: 'neutral', 'no-runs': 'neutral', approval: 'amber', waiting: 'neutral', unknown: 'amber', 'queued-stuck': 'amber' };
/** Status chip tone for a rollout state; running and queued read as in progress. Amber is kept for what needs you
 * (an approval), a stuck blocker and a run that cannot be read; waiting on rules or timers is neutral. */
export const rolloutTone = (state: string): ChipTone => TONES[state] ?? 'blue';

export type RolloutActionId = 'approve-validate' | 'approve' | 'validate' | 'validate-with';
export interface RolloutAction { id: RolloutActionId; label: string; primary: boolean; reason?: string }
/** What the validation choices say about agents: how many are connected, how many can take a prompt now, and
 * `blocked`, the reason a new one cannot be started (absent when it can). */
export interface ValidationAgents { agents: number; ready: number; blocked?: string }
export function validationAgents(options: readonly { id: string; disabled?: boolean; description?: string }[]): ValidationAgents {
  const fresh = options.find(option => option.id === NEW_VALIDATION_AGENT), connected = options.filter(option => option !== fresh && option.id !== ATTACH_VALIDATION);
  const blocked = !fresh ? 'Connect an agent to this rollout, directly or through another item.' : fresh.disabled ? fresh.description ?? 'A new agent cannot be started right now.' : undefined;
  return { agents: connected.length, ready: connected.filter(option => !option.disabled).length, ...(blocked ? { blocked } : {}) };
}
/** The rollout view's Actions menu. `gate` is a deployment waiting for this account's approval; `covered`, a chat validation that
 * answers Validate for the stage. Validate and Approve and validate start a hidden validation agent in one click, so only what stops
 * a new one disables them, and the primary entry is Approve and validate while a gate waits (Approve when no agent can start), else
 * Validate; Validate with… lists the connected agents too. An entry with a `reason` cannot apply. */
export function rolloutActions(state: { gate: boolean; covered?: boolean } & ValidationAgents): RolloutAction[] {
  const noGate = state.gate ? undefined : 'No deployment is waiting for your approval.', noStart = state.covered ? undefined : state.blocked;
  const primary: RolloutActionId = state.gate ? noStart ? 'approve' : 'approve-validate' : 'validate';
  const reasons: Record<RolloutActionId, string | undefined> = { 'approve-validate': noGate ?? noStart, approve: noGate, validate: noStart, 'validate-with': state.agents ? undefined : noStart };
  return ([['approve-validate', 'Approve and validate'], ['approve', 'Approve'], ['validate', 'Validate'], ['validate-with', 'Validate with…']] as const).map(([id, label]) => ({ id, label, primary: id === primary, ...(reasons[id] ? { reason: reasons[id] } : {}) }));
}

const UNCONFIRMED: readonly unknown[] = [OUTCOME_UNKNOWN, REQUEST_TIMEOUT, CONNECTION_LOST];
/** Whether a failed approval may still have reached GitHub: the service could not confirm the write, or its reply never arrived. A refusal has another code. */
export const approvalUnconfirmed = (failure: unknown) => typeof failure === 'object' && failure !== null && UNCONFIRMED.includes((failure as { code?: unknown }).code);

export interface ApprovalAttempt { runId: number; attempt: number; environmentIds: number[] }
/** The run attempt and environments an approval's confirmed input named; undefined when it names none. */
export function approvalAttempt(input: JsonObject): ApprovalAttempt | undefined {
  const positive = (value: unknown) => /^[1-9]\d{0,15}$/.test(String(value)) ? Number(value) : undefined;
  const runId = positive(input.runId), attempt = positive(input.attempt), environmentIds = String(input.environmentIds ?? '').split(',').map(positive);
  return runId === undefined || attempt === undefined || environmentIds.includes(undefined) ? undefined : { runId, attempt, environmentIds: environmentIds as number[] };
}
export type ApprovalOutcome = 'approved' | 'waiting' | 'moved' | 'unread';
/** What a re-read says about an unconfirmed approval. Only a fresh read counts: a stale one predates the approval.
 * `moved` is another run or attempt, where a missing gate proves nothing about this approval. */
export function approvalOutcome(tried: ApprovalAttempt, snapshot: Pick<ResourceSnapshot, 'stale' | 'detail'> | undefined): ApprovalOutcome {
  const seen = snapshot?.detail as unknown as Pick<RolloutObservation, 'run' | 'gates'> | undefined;
  if (!snapshot || snapshot.stale || !seen) return 'unread';
  if (seen.run?.id !== tried.runId || seen.run.run_attempt !== tried.attempt) return 'moved';
  return seen.gates.some(gate => tried.environmentIds.includes(gate.environment.id)) ? 'waiting' : 'approved';
}
