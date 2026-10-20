import * as z from 'zod/v4';
import type { RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';
import { inferStages } from './validation.ts';

/** Staged rollout validation: workflows whose runs are validated once per stage instead of once per attempt.
 * One validation of a staged run: due `delayMs` after every job of `environment` finished; `label` names it on the card. */
export interface StagePlan { key: string; environment: string; delayMs: number; focus: string; label: string }
export interface StageRule { id: string; workflow: RegExp; stages: readonly StagePlan[] }
/** A stage nobody could take this long after it fell due is left alone, so a restart after hours asks nothing. */
export const STAGE_WINDOW_MS = 60 * 60_000;

const slug = z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, 'use lower-case letters, digits and hyphens');
const compiles = (source: string) => { try { new RegExp(source, 'i'); return true; } catch { return false; } };
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** The rollout package's `stageRules` setting: rules that name workflows by a case-insensitive regular expression and list the stages to validate. */
export const stageRulesSchema = z.array(z.object({
  id: slug,
  workflow: z.string().min(1).max(300).refine(compiles, 'workflow must be a valid regular expression'),
  stages: z.array(z.object({
    key: slug,
    environment: z.string().trim().min(1).max(80),
    delayMinutes: z.number().int().min(0).max(24 * 60).optional(),
    focus: z.string().trim().min(1).max(200).optional(),
  }).strict()).min(1).max(10).refine(stages => unique(stages.map(stage => stage.key)), 'stage keys must be unique within a rule'),
}).strict()).max(20).refine(rules => unique(rules.map(rule => rule.id)), 'rule ids must be unique');

const minutes = (count: number) => `${count} minute${count === 1 ? '' : 's'}`;
/** Rules from the setting's JSON text; empty text has none. Throws with the first problem. */
export function parseStageRules(text: string): StageRule[] {
  if (!text.trim()) return [];
  let json: unknown;
  try { json = JSON.parse(text); } catch (error) { throw new Error(`stage rules are not valid JSON (${(error as Error).message})`); }
  const parsed = stageRulesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`stage rules${issue.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue.message}`);
  }
  return parsed.data.map(rule => ({ id: rule.id, workflow: new RegExp(rule.workflow, 'i'), stages: rule.stages.map(stage => {
    const delay = stage.delayMinutes ?? 0;
    return { key: stage.key, environment: stage.environment, delayMs: delay * 60_000,
      focus: stage.focus ?? (delay ? `${stage.environment}, ${minutes(delay)} after it finished` : stage.environment),
      label: delay ? `${stage.environment} +${delay} min` : `${stage.environment} done` };
  }) }));
}
let parsedSetting: { text: string; rules: StageRule[] } | undefined;
/** The configured rules; a saved value that no longer parses has none, so every run keeps one validation per attempt. */
export function stageRulesSetting(value: unknown): StageRule[] {
  if (typeof value !== 'string') return [];
  if (parsedSetting?.text !== value) {
    let rules: StageRule[] = [];
    try { rules = parseStageRules(value); } catch { /* Refused when saved; nothing is staged. */ }
    parsedSetting = { text: value, rules };
  }
  return parsedSetting.rules;
}

/** The rule a run follows, by its workflow's name (a run pinned by id only has its run name); undefined keeps one validation per attempt. */
export function stageRule(observation: { workflow: string; run: { name: string | null } | null }, rules: readonly StageRule[]) {
  const name = (observation.workflow || observation.run?.name || '').trim();
  return name ? rules.find(rule => rule.workflow.test(name)) : undefined;
}

export type EnvironmentStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export interface EnvironmentState { name: string; status: EnvironmentStatus; finishedAt?: number; jobs: RolloutJob[] }
const time = (value?: string | null) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : undefined; };
const ran = (job: RolloutJob) => !['skipped', 'cancelled', 'neutral'].includes(job.conclusion ?? '');
/** The run's environments from its job names, each with its status and, once all its jobs completed, when the last one did. */
export function environmentStates(jobs: readonly RolloutJob[]): EnvironmentState[] {
  return inferStages(jobs).map(({ name, jobs: mine }) => {
    const done = mine.every(job => job.status === 'completed'), ends = mine.map(job => time(job.completed_at)).filter((value): value is number => value !== undefined);
    const status: EnvironmentStatus = !done ? (mine.some(job => job.status === 'in_progress' || job.status === 'completed') ? 'running' : 'pending')
      : mine.some(job => ['failure', 'timed_out', 'startup_failure'].includes(job.conclusion ?? '')) ? 'failed'
        : mine.some(ran) ? 'succeeded' : mine.some(job => job.conclusion === 'cancelled') ? 'cancelled' : 'skipped';
    return { name: name || 'other', status, ...(done && ends.length ? { finishedAt: Math.max(...ends) } : {}), jobs: mine };
  });
}

export interface DueStage extends StagePlan { finishedAt: number; dueAt: number; jobs: number[] }
/** The latest stage of the rule the run has reached: its environment finished with something run and its delay passed. */
export function reachedStage(rule: StageRule, jobs: readonly RolloutJob[], now: number): DueStage | undefined {
  const environments = environmentStates(jobs);
  let due: DueStage | undefined;
  for (const plan of rule.stages) {
    const environment = environments.find(entry => entry.name === plan.environment);
    if (!environment || environment.finishedAt === undefined || !environment.jobs.some(ran)) continue;
    const dueAt = environment.finishedAt + plan.delayMs;
    if (dueAt <= now) due = { ...plan, finishedAt: environment.finishedAt, dueAt, jobs: environment.jobs.map(job => job.id) };
  }
  return due;
}
/** The stage that is due now: the one reached, while its window is still open. A later stage that is due replaces an earlier one nobody took yet. */
export function dueStage(rule: StageRule, jobs: readonly RolloutJob[], now: number): DueStage | undefined {
  const due = reachedStage(rule, jobs, now);
  return due && now - due.dueAt < STAGE_WINDOW_MS ? due : undefined;
}

export interface Component { path: string; files: string[]; total: number }
/** What a change touches: the deepest folder all its files share, else their top folders; with up to ten of the files. */
export function componentOf(files: readonly string[]): Component | undefined {
  if (!files.length) return undefined;
  const folders = files.map(file => file.split('/').slice(0, -1));
  const shared: string[] = [];
  for (let index = 0; folders.every(parts => index < parts.length && parts[index] === folders[0][index]); index++) shared.push(folders[0][index]);
  const tops = [...new Set(folders.map(parts => parts[0]).filter(Boolean))];
  return { path: shared.length ? shared.join('/') : tops.length ? tops.join(', ') : '.', files: files.slice(0, 10), total: files.length };
}
