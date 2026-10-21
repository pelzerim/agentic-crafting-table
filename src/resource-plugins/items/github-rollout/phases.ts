import type { RolloutGate, RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';

/** Where a validation of the phase stands: at a waiting gate, at the end of the run, or between them while jobs still run. */
export type PhaseBoundary = 'gate' | 'end' | 'running';
export interface Phase { boundary: PhaseBoundary; focus: string; jobs: number[] }

const ran = (job: RolloutJob) => !['skipped', 'cancelled', 'neutral'].includes(job.conclusion ?? '');

/** The phase a validation of this run covers now: the jobs that finished having run and that no validation of the attempt
 * was given (`covered`). Before a waiting gate it is named after the gate and the jobs it holds back, so a rollout that
 * gates the same environment once per phase gets one phase per approval; at the end of the run it is the rest of the
 * run. Nothing new finished: no phase. */
export function currentPhase(run: { status: string }, jobs: readonly RolloutJob[], gates: readonly RolloutGate[], covered: readonly number[]): Phase | undefined {
  const done = new Set(covered), fresh = jobs.filter(job => job.status === 'completed' && ran(job) && !done.has(job.id)).sort((a, b) => a.id - b.id);
  if (!fresh.length) return undefined;
  const ids = fresh.map(job => job.id);
  if (gates.length) {
    const held = jobs.filter(job => job.status === 'waiting').sort((a, b) => a.id - b.id);
    return { boundary: 'gate', focus: `before ${gates.map(gate => gate.environment.name).join(', ')}${held.length ? ` (${held.map(job => job.name).join(', ')})` : ''}`, jobs: ids };
  }
  if (run.status === 'completed') return { boundary: 'end', focus: 'whole run', jobs: ids };
  return { boundary: 'running', focus: `through ${fresh.at(-1)!.name}`, jobs: ids };
}
