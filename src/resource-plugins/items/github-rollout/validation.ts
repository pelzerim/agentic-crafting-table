import * as z from 'zod/v4';
import { clip } from '../../../pull-requests/review-findings.ts';
import type { RolloutObservation, RolloutJob, RolloutRun } from '../../../../packages/provider-runtime/github-rollout.ts';
import { queueRef, queueWho } from './queue.ts';
import { plainLine, reportText, splitLead } from './report-text.ts';

/** Rollout validations:
 * the report an agent posts, the rules that make a verdict current, the stages of a
 * run and the timeline of what the rollout did. Shared by the service and the view. */
export const VERDICTS = ['passed', 'concerns', 'failed', 'inconclusive'] as const;
export const CHECK_STATUSES = ['passed', 'concern', 'failed', 'skipped', 'running', 'pending'] as const;
export type Verdict = typeof VERDICTS[number];
export type CheckStatus = typeof CHECK_STATUSES[number];
export const verdictLabels: Record<Verdict, string> = { passed: 'Passed', concerns: 'Concerns', failed: 'Failed', inconclusive: 'Inconclusive' };
export const LIMITS = { summary: 600, checks: 30, title: 200, observation: 800, target: 80, metrics: 4, evidence: 6, recommendations: 8, recommendation: 300, jobs: 50, environments: 20, bytes: 64 * 1024 } as const;

const ids = z.array(z.number().int().positive().safe()).max(LIMITS.jobs);
const metric = z.object({ label: z.string().max(400), before: z.number().finite(), after: z.number().finite(), unit: z.string().max(60).optional(), window: z.string().max(400).optional(), better: z.enum(['lower', 'higher']).optional() }).strict();
const evidence = z.object({ label: z.string().max(300), url: z.string().max(2048), kind: z.enum(['dashboard', 'logs', 'job', 'run', 'pr', 'other']).optional() }).strict();
const check = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/, 'check ids are short, like "C1"'), title: z.string().min(1).max(2000), status: z.enum(CHECK_STATUSES),
  target: z.string().max(400).optional(), method: z.enum(['metrics', 'logs', 'smoke', 'dashboard', 'code', 'manual']).optional(), observation: z.string().max(8000).optional(),
  metrics: z.array(metric).max(40).optional(), evidence: z.array(evidence).max(60).optional(), jobIds: ids.optional(),
}).strict();
/** hivemind/rollout-validation/v1: what an agent sends; strict, closed objects. */
export const reportShape = {
  validationId: z.string().regex(/^V[1-9][0-9]{0,5}$/, 'use the validation id from the request, like "V4"').optional(),
  sequence: z.number().int().min(1).max(1_000_000), phase: z.enum(['progress', 'final', 'followup']), verdict: z.enum(VERDICTS).optional(),
  summary: z.string().max(6000).default(''),
  scope: z.object({ jobs: ids.optional(), environments: z.array(z.string().min(1).max(200)).max(LIMITS.environments).optional() }).strict().optional(),
  window: z.object({ from: z.string().max(40), to: z.string().max(40) }).strict().optional(),
  checks: z.array(check).max(LIMITS.checks, `at most ${LIMITS.checks} checks per report`).default([]),
  recommendations: z.array(z.object({ text: z.string().min(1).max(3000), blocking: z.boolean().default(false) }).strict()).max(80).default([]),
};
export const reportSchema = z.object(reportShape).strict();
export type ReportInput = z.input<typeof reportSchema>;

export interface ValidationMetric { label: string; before: number; after: number; unit?: string; window?: string; better?: 'lower' | 'higher' }
export interface ValidationEvidence { label: string; url: string; kind?: string }
export interface ValidationCheck { id: string; title: string; status: CheckStatus; target?: string; method?: string; observation?: string; metrics?: ValidationMetric[]; evidence?: ValidationEvidence[]; jobIds?: number[] }
/** `followup` marks a report that amended a final one: when, the verdict it replaced, and how many follow-ups came. `at` is when the report arrived. */
export interface ValidationReport { at?: number; summary: string; verdict?: Verdict; window?: { from: string; to: string }; checks: ValidationCheck[]; recommendations: { text: string; blocking: boolean }[]; followup?: { at: number; previous?: Verdict; count: number } }
/** `stage` names the stage of a staged run the service requested this validation for. */
/** `stage` and `label` (as the card names it) mark a validation of one stage of a staged run. */
export interface ValidationScope { runId: number; attempt: number; headSha: string; focus?: string; jobs?: number[]; environments?: string[]; stage?: string; label?: string }
export type ValidationState = 'requested' | 'running' | 'final' | 'no-report';
/** The choice that starts a session for the validation instead of asking a connected agent. */
export const NEW_VALIDATION_AGENT = 'new-agent';
/** The choice that shows the chat validation already covering the stage instead of asking anyone. */
export const ATTACH_VALIDATION = 'attach';
/** The one-click choice: an idle hidden validation agent of this rollout asked again, else a new hidden one. */
export const VALIDATION_AGENT = 'validation-agent';
/** What Show and Hide call an agent started for a validation. */
export const VALIDATION_AGENT_LABEL = 'validation agent';
/** How long a final chat validation still answers a request for its stage. */
export const REUSE_MS = 15 * 60_000;
export interface Validation {
  id: string; ordinal: number; agentNodeId: string; agent: { title: string; provider?: string }; requestId: string; scope: ValidationScope; state: ValidationState;
  verdict?: Verdict; sequence: number; reports: number; report?: ValidationReport; requestedAt: number; startedAt?: number; finishedAt?: number; updatedAt: number;
}
/** `automatic` marks a validation the service requested under a pull request's Auto validate; `unrequested` one an agent reported under an id nobody
 * requested; `chat` one an agent started by reporting without an id, as when a person asked it in its chat. */
/** `agentHidden`: its agent is kept off the map (Show validation agent); `agentHideable`: its agent was started hidden and is on the map now (Hide validation agent). */
export interface ValidationView extends Validation { label: string; stale: boolean; resolvedBy?: string; current: boolean; automatic?: boolean; unrequested?: boolean; chat?: boolean; agentHidden?: true; agentHideable?: true }

const clean = (value: string, max: number) => clip(value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').trim(), max);
const line = (value: string, max: number) => clean(value.replace(/\s+/g, ' '), max);
/** Opened externally, never fetched: https without credentials only. */
export function safeUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

/** Validates an agent's report and returns the sanitized, clamped snapshot. Job ids
 * outside the scoped attempt (unknown when undefined) are dropped with a warning. */
export function acceptReport(input: unknown, attemptJobs: readonly number[] | undefined) {
  const value = reportSchema.parse(input), warnings: string[] = [], known = new Set(attemptJobs ?? []);
  const closing = value.phase !== 'progress', kind = value.phase === 'followup' ? 'follow-up' : 'final';
  if (closing && !value.verdict) throw new Error(`A ${kind} report needs a verdict: passed, concerns, failed or inconclusive.`);
  if (closing && !value.checks.length) throw new Error(`A ${kind} report needs at least one check.`);
  const jobs = (list: number[] | undefined) => {
    if (!list) return undefined;
    const kept = list.filter(id => known.has(id));
    for (const id of list.filter(id => !known.has(id))) warnings.push(`dropped job ${id}: ${attemptJobs ? 'not in the validated attempt' : "the attempt's jobs are unknown"}`);
    return kept.length ? [...new Set(kept)] : undefined;
  };
  const keep = <T>(list: T[] | undefined, max: number, what: string) => { if (list && list.length > max) warnings.push(`kept the first ${max} ${what}`); return list?.slice(0, max); };
  const checks = value.checks.map(item => {
    const metrics = keep(item.metrics, LIMITS.metrics, `metrics of ${item.id}`)?.map(entry => ({ label: line(entry.label, 80), before: entry.before, after: entry.after,
      ...(entry.unit ? { unit: line(entry.unit, 12) } : {}), ...(entry.window ? { window: line(entry.window, 80) } : {}), ...(entry.better ? { better: entry.better } : {}) }));
    const links = (item.evidence ?? []).filter(entry => safeUrl(entry.url) || (warnings.push(`dropped evidence "${line(entry.label, 60)}" of ${item.id}: only https links without credentials`), false));
    const evidence = keep(links, LIMITS.evidence, `evidence links of ${item.id}`)?.map(entry => ({ label: line(entry.label, 60) || 'Evidence', url: safeUrl(entry.url)!, ...(entry.kind ? { kind: entry.kind } : {}) }));
    const jobIds = jobs(item.jobIds);
    return { id: item.id, title: line(item.title, LIMITS.title) || item.id, status: item.status, ...(item.target ? { target: line(item.target, LIMITS.target) } : {}), ...(item.method ? { method: item.method } : {}),
      ...(item.observation ? { observation: reportText(item.observation, LIMITS.observation) } : {}), ...(metrics?.length ? { metrics } : {}), ...(evidence?.length ? { evidence } : {}), ...(jobIds ? { jobIds } : {}) };
  });
  const recommendations = keep(value.recommendations, LIMITS.recommendations, 'recommendations')!.map(entry => ({ text: line(entry.text, LIMITS.recommendation), blocking: entry.blocking }));
  const report: ValidationReport = { summary: reportText(value.summary, LIMITS.summary), ...(closing ? { verdict: value.verdict } : {}), ...(value.window ? { window: { from: line(value.window.from, 40), to: line(value.window.to, 40) } } : {}), checks, recommendations };
  if (new TextEncoder().encode(JSON.stringify(report)).length > LIMITS.bytes) throw new Error('The report is larger than 64 KB. Shorten observations or send fewer checks.');
  const environments = value.scope?.environments?.map(name => line(name, 80)).filter(Boolean), scoped = jobs(value.scope?.jobs);
  return { validationId: value.validationId, sequence: value.sequence, phase: value.phase, report, warnings,
    scope: { ...(scoped ? { jobs: scoped } : {}), ...(environments?.length ? { environments: [...new Set(environments)] } : {}) } as { jobs?: number[]; environments?: string[] } };
}

const finishedAt = (validation: Validation) => validation.finishedAt ?? validation.updatedAt;
/** Stale: about another run, attempt or commit than the latest observation. Resolved:
 * a newer final validation of the same attempt exists, whatever either one looked at;
 * for one that never reported a final, newer means requested later (a higher ordinal).
 * Only the newest final, non-stale validation is current. */
export function annotateValidations(validations: readonly Validation[], run: Pick<RolloutRun, 'id' | 'run_attempt' | 'head_sha'> | null | undefined): ValidationView[] {
  const sorted = [...validations].sort((a, b) => a.ordinal - b.ordinal);
  const views = sorted.map(validation => ({ ...validation, label: `V${validation.ordinal}`, stale: !run || validation.scope.runId !== run.id || validation.scope.attempt !== run.run_attempt || validation.scope.headSha !== run.head_sha, current: false } as ValidationView));
  for (const view of views) {
    if (view.stale) continue;
    if (view.state !== 'final') {
      const later = views.filter(other => other.state === 'final' && !other.stale && other.ordinal > view.ordinal).sort((a, b) => finishedAt(b) - finishedAt(a) || b.ordinal - a.ordinal)[0];
      if (later) view.resolvedBy = later.label;
      continue;
    }
    const newer = views.filter(other => other !== view && other.state === 'final' && !other.stale && (finishedAt(other) > finishedAt(view) || finishedAt(other) === finishedAt(view) && other.ordinal > view.ordinal));
    const latest = newer.sort((a, b) => finishedAt(b) - finishedAt(a) || b.ordinal - a.ordinal)[0];
    if (latest) view.resolvedBy = latest.label; else view.current = true;
  }
  return views;
}
/** The validation still under way that the card and the view show: requested or running, not stale and not resolved by a later final one. */
export const activeValidation = (views: readonly ValidationView[]) =>
  views.filter(view => !view.stale && !view.resolvedBy && (view.state === 'running' || view.state === 'requested')).sort((a, b) => b.updatedAt - a.updatedAt)[0];
/** A validation under way that has not reported for this long is flagged on the card and in the view. */
export const QUIET_AFTER_MS = 3 * 60_000;
/** How a validation under way is doing: when its lead last reported (none before the first report), how long it has been quiet since
 * that report or the request, and the lead's current step, the first sentence of the latest summary on one line. */
export function liveness(validation: Validation, now: number) {
  const reportedAt = validation.reports ? validation.report?.at ?? validation.updatedAt : undefined, quietMs = Math.max(0, now - (reportedAt ?? validation.updatedAt));
  const summary = validation.report?.summary ?? '', step = clip(plainLine(splitLead(summary).lead || summary.split('\n')[0]), 80);
  return { ...(reportedAt === undefined ? {} : { reportedAt }), quietMs, quiet: quietMs >= QUIET_AFTER_MS, ...(step ? { step } : {}) };
}
/** “No report for 3 min”. */
export const quietLabel = (quietMs: number) => `No report for ${Math.floor(quietMs / 60_000)} min`;
/** The rollout's verdict: the newest current one. */
export function currentVerdict(views: readonly ValidationView[]) {
  const current = views.filter(view => view.current && view.verdict).sort((a, b) => finishedAt(b) - finishedAt(a) || b.ordinal - a.ordinal);
  return current[0] ? { verdict: current[0].verdict!, validation: current[0] } : undefined;
}
/** Needs me per validating agent (source `validation:<agent>`): failed → error,
 * concerns → validation; anything else withdraws it without marking it seen. */
export function validationAttention(views: readonly ValidationView[]) {
  const result = new Map<string, { reason: 'error' | 'validation'; note: string; eventId: string } | { reason: null }>();
  for (const agent of new Set(views.map(view => view.agentNodeId))) {
    const worst = currentVerdict(views.filter(view => view.agentNodeId === agent))?.validation;
    result.set(agent, worst?.verdict === 'failed' || worst?.verdict === 'concerns' ? { reason: worst.verdict === 'failed' ? 'error' : 'validation', note: worst.verdict === 'failed' ? 'Validation failed' : 'Validation found concerns', eventId: `${worst.id}:${worst.verdict}` } : { reason: null });
  }
  return result;
}

const stageWords = ['build', 'test', 'staging', 'stage', 'canary', 'preview', 'production', 'prod'];
const stageAlias: Record<string, string> = { prod: 'production', stage: 'staging' };
const generic = new Set(['deploy', 'build', 'run', 'release', 'apply', 'job']);
/** A job's stage: the earliest environment or stage word in its name, then the
 * prefix before “/”, otherwise none (GitHub's API exposes no `needs` graph). */
export function stageOf(name: string, environments: readonly string[] = []) {
  const lower = name.toLowerCase(), words = [...new Set([...environments.map(entry => entry.toLowerCase()), ...stageWords])];
  let best: { index: number; word: string } | undefined;
  for (const word of words) {
    const match = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).exec(lower);
    if (!match) continue;
    const index = match.index + match[1].length;
    if (!best || index < best.index || index === best.index && word.length > best.word.length) best = { index, word };
  }
  if (best) return stageAlias[best.word] ?? best.word;
  const slash = name.indexOf('/');
  return slash > 0 ? name.slice(0, slash).trim().toLowerCase() : '';
}
export function inferStages<T extends Pick<RolloutJob, 'id' | 'name'>>(jobs: readonly T[], environments: readonly string[] = []) {
  const stages: { name: string; jobs: T[] }[] = [];
  for (const job of jobs) { const name = stageOf(job.name, environments); let stage = stages.find(entry => entry.name === name); if (!stage) stages.push(stage = { name, jobs: [] }); stage.jobs.push(job); }
  return stages;
}
/** Unfinished stages (or ones holding a pending gate) and unfinished jobs come
 * first; finished ones follow in their original order. */
export function activeFirst<T extends { status: string }>(stages: readonly { name: string; jobs: T[] }[], pendingGate: (stage: string) => boolean = () => false) {
  const open = (job: T) => job.status !== 'completed';
  const jobs = stages.map(stage => ({ ...stage, jobs: [...stage.jobs.filter(open), ...stage.jobs.filter(job => !open(job))] }));
  const active = (stage: { name: string; jobs: T[] }) => stage.jobs.some(open) || pendingGate(stage.name);
  return [...jobs.filter(active), ...jobs.filter(stage => !active(stage))];
}
export function jobShortName(name: string) {
  const [prefix, ...rest] = name.split('/').map(part => part.trim());
  const after = rest.join(' / ').split(/\s+/)[0];
  return clip(rest.length && generic.has(prefix.toLowerCase()) && after ? after : prefix || name, 16);
}

export type EventKind = 'attempt-started' | 'gate-waiting' | 'gate-approved' | 'run-completed' | 'jobs-snapshot' | 'queued-behind';
export interface SnapshotJob { id: number; name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }
export interface RolloutEvent { runId: number; attempt: number; kind: EventKind; jobId: number; environment: string; actor?: string; body: Record<string, unknown>; observedAt: number }
export interface AppApproval { runId: number; attempt: number; environmentIds: number[]; at: number }
const time = (value?: string | null) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : undefined; };
const snapshotJobs = (jobs: readonly RolloutJob[]): SnapshotJob[] => jobs.map(job => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, started_at: job.started_at ?? null, completed_at: job.completed_at ?? null }));

/** New persisted transitions seen in this observation. Job starts and finishes come
 * from job timestamps; the job snapshot keeps an attempt readable after a re-run.
 * Each run a queued attempt waited behind is kept (job id = that run's id). */
export function observedEvents(observation: RolloutObservation, known: readonly RolloutEvent[], now: number, approvals: readonly AppApproval[]): RolloutEvent[] {
  const { run, jobs, gates } = observation; if (!run) return [];
  const mine = known.filter(event => event.runId === run.id && event.attempt === run.run_attempt), has = (kind: EventKind, environment = '') => mine.some(event => event.kind === kind && event.environment === environment);
  const base = { runId: run.id, attempt: run.run_attempt, jobId: 0, environment: '' }, events: RolloutEvent[] = [];
  const starts = jobs.map(job => time(job.started_at)).filter((value): value is number => value !== undefined);
  if (!has('attempt-started')) events.push({ ...base, kind: 'attempt-started', body: {}, observedAt: Math.min(now, ...starts) });
  for (const gate of gates) if (!has('gate-waiting', gate.environment.name)) events.push({ ...base, kind: 'gate-waiting', environment: gate.environment.name, body: { environmentId: gate.environment.id }, observedAt: now });
  const failedRun = run.status === 'completed' && run.conclusion !== 'success';
  for (const waiting of mine.filter(event => event.kind === 'gate-waiting')) {
    if (gates.some(gate => gate.environment.name === waiting.environment) || has('gate-approved', waiting.environment)) continue;
    const approval = approvals.find(entry => entry.runId === run.id && entry.attempt === run.run_attempt && entry.environmentIds.includes(Number(waiting.body.environmentId)));
    if (!approval && failedRun) continue;
    events.push({ ...base, kind: 'gate-approved', environment: waiting.environment, ...(approval ? { actor: 'you' } : {}), body: { environmentId: waiting.body.environmentId }, observedAt: approval?.at ?? now });
  }
  if (run.status === 'completed' && !has('run-completed')) {
    const ends = jobs.map(job => time(job.completed_at)).filter((value): value is number => value !== undefined);
    events.push({ ...base, kind: 'run-completed', body: { conclusion: run.conclusion }, observedAt: ends.length ? Math.max(...ends) : now });
  }
  const since = observation.queue?.you.startedAt ?? observation.queue?.you.createdAt;
  for (const entry of observation.queue?.ahead ?? []) if (!mine.some(event => event.kind === 'queued-behind' && event.jobId === entry.id))
    events.push({ ...base, kind: 'queued-behind', jobId: entry.id, body: { ref: queueRef(entry), who: queueWho(entry), ...(since ? { since } : {}) }, observedAt: now });
  const snapshot = snapshotJobs(jobs), previous = mine.filter(event => event.kind === 'jobs-snapshot').at(-1);
  if (JSON.stringify(previous?.body.jobs) !== JSON.stringify(snapshot)) events.push({ ...base, kind: 'jobs-snapshot', body: { jobs: snapshot as unknown as Record<string, unknown>[] }, observedAt: now });
  return events;
}

export type TimelineEntry = { key: string; at: number; rank: number; jobName?: string } & (
  | { kind: 'job'; job: SnapshotJob; what: 'started' | 'finished'; duration?: number }
  | { kind: 'gate'; environment: string; what: 'waiting' | 'approved'; actor?: string; pending: boolean }
  | { kind: 'attempt'; attempt: number; stale: ValidationView[] }
  | { kind: 'run'; conclusion: string; done: number; total: number; duration?: number }
  | { kind: 'queued'; blockers: string[]; waited?: number }
  | { kind: 'validation'; validation: ValidationView; covered: string[] }
  | { kind: 'auto'; what: 'armed' | 'validate' | 'approve' | 'halted' | 'done' | 'stopped'; text: string });
export interface TimelineGroup { runId: number; attempt: number; current: boolean; label: string; summary: string; jobs: SnapshotJob[]; entries: TimelineEntry[]; conclusion?: string }

/** Job names a validation is about: its narrowed jobs, the jobs its checks read, or
 * the jobs of its environments' stages. A whole-run validation names none. */
export function coveredJobs(validation: Validation, jobs: readonly SnapshotJob[], environments: readonly string[] = []) {
  const ids = new Set([...validation.scope.jobs ?? [], ...(validation.report?.checks ?? []).flatMap(check => check.jobIds ?? [])]);
  const stages = new Set((validation.scope.environments ?? []).map(name => stageOf(name, environments)));
  return jobs.filter(job => ids.has(job.id) || stages.size && stages.has(stageOf(job.name, environments))).map(job => job.name);
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The feed: one group per run attempt (current first), entries newest first. */
export function rolloutTimeline(observation: RolloutObservation, events: readonly RolloutEvent[], validations: readonly ValidationView[]): TimelineGroup[] {
  const run = observation.run, keys = new Map<string, { runId: number; attempt: number }>();
  const add = (runId: number, attempt: number) => keys.set(`${runId}:${attempt}`, { runId, attempt });
  for (const event of events) add(event.runId, event.attempt);
  for (const validation of validations) add(validation.scope.runId, validation.scope.attempt);
  if (run) add(run.id, run.run_attempt);
  const environments = [...new Set([...observation.gates.map(gate => gate.environment.name), ...events.filter(event => event.environment).map(event => event.environment)])];
  const groups = [...keys.values()].map(({ runId, attempt }) => {
    const mine = events.filter(event => event.runId === runId && event.attempt === attempt), current = run?.id === runId && run.run_attempt === attempt;
    const jobs = current ? snapshotJobs(observation.jobs) : ((mine.filter(event => event.kind === 'jobs-snapshot').at(-1)?.body.jobs ?? []) as SnapshotJob[]);
    const entries: TimelineEntry[] = [];
    for (const job of jobs) {
      const started = time(job.started_at), completed = time(job.completed_at);
      if (started !== undefined) entries.push({ key: `job:${job.id}:started`, kind: 'job', job, what: 'started', at: started, rank: 2, jobName: job.name });
      if (completed !== undefined && job.status === 'completed') entries.push({ key: `job:${job.id}:finished`, kind: 'job', job, what: 'finished', at: completed, rank: 3, jobName: job.name, ...(started !== undefined ? { duration: completed - started } : {}) });
    }
    for (const event of mine) {
      if (event.kind === 'gate-waiting' || event.kind === 'gate-approved') entries.push({ key: `gate:${event.environment}:${event.kind}`, kind: 'gate', environment: event.environment, what: event.kind === 'gate-waiting' ? 'waiting' : 'approved', ...(event.actor ? { actor: event.actor } : {}),
        pending: current && event.kind === 'gate-waiting' && observation.gates.some(gate => gate.environment.name === event.environment), at: event.observedAt, rank: 1 });
      if (event.kind === 'attempt-started' && attempt > 1) entries.push({ key: 'attempt', kind: 'attempt', attempt, at: event.observedAt, rank: 0,
        stale: validations.filter(view => view.scope.runId === runId && view.scope.attempt < attempt && view.state === 'final' && (view.verdict === 'failed' || view.verdict === 'concerns')) });
      if (event.kind === 'run-completed') {
        const starts = jobs.map(job => time(job.started_at)).filter((value): value is number => value !== undefined);
        entries.push({ key: 'run', kind: 'run', conclusion: String(event.body.conclusion ?? 'completed'), done: jobs.filter(job => job.status === 'completed').length, total: jobs.length, at: event.observedAt, rank: 5,
          ...(starts.length ? { duration: event.observedAt - Math.min(...starts) } : {}) });
      }
    }
    const behind = mine.filter(event => event.kind === 'queued-behind');
    if (behind.length) {
      const since = time(behind[0].body.since as string) ?? Math.min(...behind.map(event => event.observedAt)), starts = jobs.map(job => time(job.started_at)).filter((value): value is number => value !== undefined && value >= since);
      entries.push({ key: 'queued', kind: 'queued', blockers: behind.map(event => `${event.body.ref} (${event.body.who})`), at: since, rank: 0, ...(starts.length ? { waited: Math.min(...starts) - since } : {}) });
    }
    for (const validation of validations.filter(view => view.scope.runId === runId && view.scope.attempt === attempt))
      entries.push({ key: `validation:${validation.id}`, kind: 'validation', validation, covered: coveredJobs(validation, jobs, environments), at: validation.state === 'final' ? finishedAt(validation) : validation.updatedAt, rank: 4 });
    entries.sort((a, b) => b.at - a.at || b.rank - a.rank);
    const conclusion = mine.find(event => event.kind === 'run-completed')?.body.conclusion as string | undefined;
    const failed = jobs.find(job => ['failure', 'timed_out', 'cancelled'].includes(job.conclusion ?? ''));
    const outcome = failed ? `${failed.conclusion === 'cancelled' ? 'cancelled' : 'failed'}${stageOf(failed.name, environments) ? ` at ${stageOf(failed.name, environments)}` : ''}` : conclusion ?? (current ? 'current' : 'replaced');
    const label = current ? `Attempt ${attempt} · current` : run && run.id !== runId ? `Run ${runId} · attempt ${attempt} · superseded` : `Attempt ${attempt} · ${outcome} · superseded`;
    const staleCount = entries.filter(entry => entry.kind === 'validation').length, eventCount = entries.length - staleCount;
    return { runId, attempt, current, label, jobs, entries, ...(conclusion ? { conclusion } : failed ? { conclusion: 'failure' } : {}),
      summary: `${plural(eventCount, 'event')}${staleCount ? ` and ${plural(staleCount, current ? 'validation' : 'stale validation')}` : ''}` };
  });
  return groups.sort((a, b) => Number(b.current) - Number(a.current) || b.runId - a.runId || b.attempt - a.attempt);
}

/** “6m”, “2h 12m”, “<1m”. */
export function duration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
