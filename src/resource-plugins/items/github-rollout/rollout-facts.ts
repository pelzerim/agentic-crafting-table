import { approvableGates } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { RolloutObservation } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { RolloutFacts, RolloutValidationFact } from './auto-deploy.ts';
import type { StageRule } from './stages.ts';
import type { ValidationState, Verdict } from './validation.ts';

/** A validation and an event of a rollout as `rollout.validation` lists them. */
export type ListedValidation = { label: string; state: string; verdict?: string; resolvedBy?: string; stale?: boolean; requestedAt?: number; finishedAt?: number; scope?: { runId?: number; attempt?: number; jobs?: number[]; environments?: string[] } };
export type ListedEvent = { runId?: number; attempt?: number; kind?: string; environment?: string; observedAt?: number };
const validationFact = (view: ListedValidation): RolloutValidationFact => ({ label: view.label, state: view.state as ValidationState, ...(view.verdict ? { verdict: view.verdict as Verdict } : {}), ...(view.resolvedBy ? { resolvedBy: view.resolvedBy } : {}),
  ...(view.scope?.jobs?.length ? { jobs: view.scope.jobs } : {}), ...(view.scope?.environments?.length ? { environments: view.scope.environments } : {}), ...(view.requestedAt !== undefined ? { requestedAt: view.requestedAt } : {}),
  ...(view.scope?.runId !== undefined ? { runId: view.scope.runId } : {}), ...(view.scope?.attempt !== undefined ? { attempt: view.scope.attempt } : {}),
  ...(view.stale ? { stale: true } : {}), ...(view.finishedAt !== undefined ? { finishedAt: view.finishedAt } : {}) });
/** What the phase track and auto deploy read of a rollout: its observation, its listed validations and the gates its attempt met. */
export function rolloutFactsOf(node: { id: string; title: string }, observation: RolloutObservation | undefined, listed: { validations?: readonly ListedValidation[]; events?: readonly ListedEvent[] } | undefined, rule?: StageRule): RolloutFacts {
  if (!observation || !('jobs' in observation) || !observation.run) return { nodeId: node.id, title: node.title, jobs: [], gates: [], validations: [] };
  const run = observation.run, approvable = new Set(approvableGates(observation).map(gate => gate.environment.id));
  const gates = (listed?.events ?? []).filter(event => event.runId === run.id && event.attempt === run.run_attempt && (event.kind === 'gate-waiting' || event.kind === 'gate-approved') && event.environment);
  const gateApprovals = gates.filter(event => event.kind === 'gate-approved' && typeof event.observedAt === 'number').map(event => ({ environment: event.environment!, at: event.observedAt! }));
  return { nodeId: node.id, title: node.title, run: { id: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion, headSha: run.head_sha, number: run.run_number }, jobs: observation.jobs,
    gates: observation.gates.map(gate => ({ id: gate.environment.id, name: gate.environment.name, approvable: approvable.has(gate.environment.id) })), ...(rule ? { rule } : {}),
    gateEnvironments: [...new Set(gates.map(event => event.environment!))], gateApprovals, validations: (listed?.validations ?? []).map(validationFact) };
}
