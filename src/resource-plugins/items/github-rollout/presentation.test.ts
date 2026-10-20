import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalAttempt, approvalOutcome, approvalUnconfirmed, rolloutActions, rolloutEmptyHint, rolloutIndicators, rolloutTone, validationAgents } from './presentation.ts';
import { CONNECTION_LOST, OUTCOME_UNKNOWN, REQUEST_TIMEOUT } from '../../../../packages/workspace-service/protocol.ts';
import { NEW_VALIDATION_AGENT } from './validation.ts';
import type { Validation, RolloutEvent } from './validation.ts';
import type { RolloutObservation, RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { ResourceSnapshot } from '../../types.ts';

const at = (minute: number) => Date.UTC(2026, 8, 30, 13, minute), iso = (minute: number) => new Date(at(minute)).toISOString();
const job = (id: number, name: string, status: string, conclusion: string | null, started?: number, completed?: number): RolloutJob =>
  ({ id, run_id: 41, name, status, conclusion, started_at: started === undefined ? null : iso(started), completed_at: completed === undefined ? null : iso(completed) });
const snapshot = (attempt: number, jobs: RolloutJob[], state: string, label: string, status = 'in_progress'): ResourceSnapshot => ({ activity: 'working', attention: 'none', connection: 'connected', label, observedAt: iso(30),
  indicators: [{ id: 'rollout-state', label, icon: 'clock', tone: 'blue' }],
  detail: { workflow: 'Rollout', url: 'https://github.com/acme/app/actions/runs/41', followsLatest: true, gates: [], jobs, state,
    run: { id: 41, name: 'Rollout', display_title: 'Ship', run_number: 41, run_attempt: attempt, workflow_id: 9, head_branch: 'main', head_sha: 'a'.repeat(40), status, conclusion: status === 'completed' ? 'success' : null, updated_at: iso(0), repository: { full_name: 'acme/app' } } } satisfies RolloutObservation & { state: string } as never });
const validation = (patch: Partial<Validation>): Validation => ({ id: 'v1', ordinal: 1, agentNodeId: 'claude', agent: { title: 'Claude · validator', provider: 'claude' }, requestId: 'r1',
  scope: { runId: 41, attempt: 2, headSha: 'a'.repeat(40) }, state: 'final', verdict: 'concerns', sequence: 1, reports: 1, requestedAt: at(10), finishedAt: at(12), updatedAt: at(12), ...patch });
const lines = (indicators: ReturnType<typeof rolloutIndicators>) => indicators?.map(cue => `${cue.id}:${cue.label}`);

test('the map card leads with running jobs and their elapsed time', () => {
  const running = snapshot(2, [job(1, 'build / thumbnail-image', 'completed', 'success', 5, 9), job(2, 'e2e / staging smoke-test', 'in_progress', null, 24), job(3, 'deploy / preview-a', 'in_progress', null, 26), job(4, 'deploy / prod', 'queued', null)], 'ongoing', 'Ongoing');
  assert.deepEqual(lines(rolloutIndicators(running, [], [], at(30))), ['rollout-state:Ongoing', 'rollout-jobs:2 running', 'rollout-line:e2e 6m · preview-a 4m']);
  const restarted = snapshot(2, [job(1, 'build / thumbnail-image', 'in_progress', null, 29), job(4, 'deploy / prod', 'queued', null)], 'ongoing', 'Ongoing');
  const events: RolloutEvent[] = [{ runId: 41, attempt: 1, kind: 'run-completed', jobId: 0, environment: '', body: { conclusion: 'failure' }, observedAt: at(20) }];
  assert.deepEqual(lines(rolloutIndicators(restarted, [], events, at(30))), ['rollout-state:Ongoing', 'rollout-jobs:attempt 2', 'rollout-line:thumbnail-image 1m · #1 failed']);
});

test('a verdict that needs you replaces the jobs line; a running validation and a pass show when nothing needs you', () => {
  const waiting = snapshot(2, [job(1, 'build / x', 'completed', 'success', 5, 9), job(2, 'deploy / prod', 'waiting', null)], 'approval', 'Waiting approval', 'waiting');
  const events: RolloutEvent[] = [{ runId: 41, attempt: 2, kind: 'gate-waiting', jobId: 0, environment: 'production', body: { environmentId: 1 }, observedAt: at(17) }];
  assert.deepEqual(lines(rolloutIndicators(waiting, [validation({})], events, at(30))), ['rollout-state:Waiting approval', 'rollout-jobs:gate 13m', 'rollout-verdict:Concerns · Claude']);
  assert.deepEqual(lines(rolloutIndicators(waiting, [validation({ state: 'running', verdict: undefined, finishedAt: undefined, report: { summary: '', checks: [{ id: 'C1', title: 'a', status: 'passed' }, { id: 'C2', title: 'b', status: 'running' }], recommendations: [] } })], events, at(30))),
    ['rollout-state:Waiting approval', 'rollout-jobs:gate 13m', 'rollout-validating:Validating · Claude · 1/2 · No report for 18 min']);
  const passed = snapshot(2, [job(1, 'build / x', 'completed', 'success', 5, 9), job(2, 'deploy / prod', 'completed', 'success', 10, 137)], 'passed', 'Passed', 'completed');
  assert.deepEqual(lines(rolloutIndicators(passed, [validation({ verdict: 'passed' })], [], at(140))), ['rollout-state:Passed', 'rollout-jobs:2h 12m', 'rollout-validated:Validated · Claude']);
  assert.deepEqual(lines(rolloutIndicators(passed, [validation({ scope: { runId: 41, attempt: 1, headSha: 'a'.repeat(40) }, verdict: 'failed' })], [], at(140))), ['rollout-state:Passed', 'rollout-jobs:2h 12m', 'rollout-line:2/2 jobs'], 'stale verdicts never show');
});

test('the card follows the latest validation: an older one left running never hides a newer verdict, a newer running one shows', () => {
  const passed = snapshot(2, [job(1, 'build / x', 'completed', 'success', 5, 9), job(2, 'deploy / prod', 'completed', 'success', 10, 20)], 'passed', 'Passed', 'completed');
  const stuck = validation({ id: 'v1', ordinal: 1, state: 'running', verdict: undefined, finishedAt: undefined, reports: 2, requestedAt: at(10), updatedAt: at(12),
    report: { summary: 'Waiting', checks: [{ id: 'C1', title: 'a', status: 'running' }], recommendations: [] } });
  const done = validation({ id: 'v2', ordinal: 2, agentNodeId: 'codex', verdict: 'passed', requestedAt: at(14), finishedAt: at(18), updatedAt: at(18) });
  assert.deepEqual(lines(rolloutIndicators(passed, [stuck, done], [], at(30))), ['rollout-state:Passed', 'rollout-jobs:15m', 'rollout-validated:Validated · Claude']);
  assert.deepEqual(lines(rolloutIndicators(passed, [{ ...stuck, state: 'no-report' }, done], [], at(30))), ['rollout-state:Passed', 'rollout-jobs:15m', 'rollout-validated:Validated · Claude']);
  const newer = validation({ id: 'v3', ordinal: 3, state: 'running', verdict: undefined, finishedAt: undefined, requestedAt: at(20), updatedAt: at(21), report: undefined });
  assert.deepEqual(lines(rolloutIndicators(passed, [stuck, done, newer], [], at(30))), ['rollout-state:Passed', 'rollout-jobs:15m', 'rollout-validating:Validating · Claude · No report for 9 min']);
});

test('a running validation shows when it last reported and the lead\'s current step, in amber after 3 minutes without a report, ahead of running jobs', () => {
  const done = snapshot(2, [job(1, 'build / x', 'completed', 'success', 5, 9), job(2, 'deploy / prod', 'completed', 'success', 10, 20)], 'passed', 'Passed', 'completed');
  const running = validation({ state: 'running', verdict: undefined, finishedAt: undefined, reports: 2, requestedAt: at(20), updatedAt: at(28),
    report: { at: at(28), summary: 'Interim: **healthy** so far. Waiting for the 10-minute error window.\n\n- p95 flat', checks: [{ id: 'C1', title: 'a', status: 'passed' }, { id: 'C2', title: 'b', status: 'pending' }], recommendations: [] } });
  const cue = (indicators: ReturnType<typeof rolloutIndicators>) => indicators!.find(entry => entry.id === 'rollout-validating')!;
  const fresh = cue(rolloutIndicators(done, [running], [], at(30) + 30_000));
  assert.deepEqual([fresh.label, fresh.tone, fresh.icon], ['Validating · Claude · 1/2 · 2 min ago · Interim: healthy so far.', 'blue', 'clock']);
  const quiet = cue(rolloutIndicators(done, [running], [], at(31)));
  assert.deepEqual([quiet.label, quiet.tone, quiet.icon], ['Validating · Claude · 1/2 · No report for 3 min · Interim: healthy so far.', 'amber', 'alert-triangle']);
  const jobs = snapshot(2, [job(1, 'build / x', 'completed', 'success', 5, 9), job(2, 'deploy / prod', 'in_progress', null, 25)], 'ongoing', 'Ongoing');
  assert.deepEqual(lines(rolloutIndicators(jobs, [running], [], at(29))), ['rollout-state:Ongoing', 'rollout-jobs:1 running', 'rollout-validating:Validating · Claude · 1/2 · 1 min ago · Interim: healthy so far.'], 'a running validation shows over the running jobs');
  const asked = validation({ state: 'requested', verdict: undefined, finishedAt: undefined, reports: 0, requestedAt: at(29), updatedAt: at(29), report: undefined });
  assert.equal(cue(rolloutIndicators(done, [asked], [], at(30))).label, 'Validating · Claude · waiting for the first report');
});

test('a queued rollout card says how many are ahead and whose is next, or which stuck blocker holds it, and stays idle', () => {
  const run = (id: number, status: string, pull: number, mergedBy: string, extra = {}) => ({ id, number: id, status, url: `https://github.com/acme/app/actions/runs/${id}`, pull: { number: pull, title: 'x', mergedBy }, ...extra });
  const queued = (ahead: object[]) => { const value = snapshot(1, [], 'queued', 'Queued', 'queued'); value.activity = 'idle';
    (value.detail as any).queue = { ahead, you: run(41, 'queued', 24, 'you') }; return value; };
  assert.deepEqual(lines(rolloutIndicators(queued([run(99, 'in_progress', 21, 'octo-a'), run(100, 'queued', 23, 'octo-b')]), [], [], at(30))), ['rollout-state:Queued · 2 ahead · next: octo-a #21']);
  assert.deepEqual(lines(rolloutIndicators(queued([run(99, 'waiting', 21, 'octo-a', { stuck: { reason: 'approval' } })]), [], [], at(30))), ['rollout-state:Queued · behind stuck #21 (octo-a)']);
  assert.equal(rolloutIndicators(queued([run(99, 'waiting', 21, 'octo-a', { stuck: { reason: 'approval' } })]), [], [], at(30))![0].tone, 'blue');
});

test('the hint under an empty timeline depends on state and never names a tool', () => {
  assert.equal(rolloutEmptyHint({ jobs: 3, validations: 1 }), 'Click a job to filter');
  assert.equal(rolloutEmptyHint({ jobs: 3, validations: 0 }), 'Click a job to filter · Ask an agent to validate');
  assert.equal(rolloutEmptyHint({ jobs: 0, validations: 0 }), 'Ask an agent to validate');
});

test('rollout states map to chip tones', () => {
  assert.deepEqual(['passed', 'failed', 'approval', 'queued-stuck', 'running', 'queued', 'cancelled', 'waiting'].map(rolloutTone), ['green', 'red', 'amber', 'amber', 'blue', 'blue', 'neutral', 'neutral']);
});

test('a rollout shows the rocket glyph in its own tone, not the GitHub mark', async () => {
  const { githubRollout } = await import('./definition.ts');
  assert.equal(githubRollout.icon, 'rocket');
  assert.equal(githubRollout.brand, undefined);
});

test('the Actions menu lists Approve and validate, Approve, Validate and Validate with…; entries that cannot apply say why and the primary one follows the gate', () => {
  const menu = (state: Parameters<typeof rolloutActions>[0]) => rolloutActions(state).map(action => [action.label, action.primary, action.reason ?? '']);
  const noGate = 'No deployment is waiting for your approval.', blocked = 'Claude Code is not installed. Install and sign in to the Claude CLI, then retry.';
  assert.deepEqual(menu({ gate: true, agents: 2, ready: 1 }), [['Approve and validate', true, ''], ['Approve', false, ''], ['Validate', false, ''], ['Validate with…', false, '']]);
  assert.deepEqual(menu({ gate: true, agents: 0, ready: 0 }), [['Approve and validate', true, ''], ['Approve', false, ''], ['Validate', false, ''], ['Validate with…', false, '']]);
  assert.deepEqual(menu({ gate: false, agents: 0, ready: 0 }), [['Approve and validate', false, noGate], ['Approve', false, noGate], ['Validate', true, ''], ['Validate with…', false, '']]);
  // Validate starts a hidden agent, so only what stops a new one disables it; connected agents still answer Validate with….
  assert.deepEqual(menu({ gate: true, agents: 1, ready: 1, blocked }), [['Approve and validate', false, blocked], ['Approve', true, ''], ['Validate', false, blocked], ['Validate with…', false, '']]);
  assert.deepEqual(menu({ gate: false, agents: 0, ready: 0, blocked }), [['Approve and validate', false, noGate], ['Approve', false, noGate], ['Validate', true, blocked], ['Validate with…', false, blocked]]);
  // A chat validation covering the stage answers Validate without any agent.
  assert.deepEqual(menu({ gate: false, agents: 0, ready: 0, blocked, covered: true }), [['Approve and validate', false, noGate], ['Approve', false, noGate], ['Validate', true, ''], ['Validate with…', false, '']]);
  assert.deepEqual(rolloutActions({ gate: true, agents: 1, ready: 1 }).map(action => action.id), ['approve-validate', 'approve', 'validate', 'validate-with']);
});

test('the validation choices are read as connected agents plus the entry that starts a new one', () => {
  const agent = (id: string, disabled = false) => ({ id, label: id, description: 'Ready · connected', ...(disabled ? { disabled } : {}) }), fresh = { id: NEW_VALIDATION_AGENT, label: 'Start a new agent', description: 'A new Claude session beside this rollout' };
  assert.deepEqual(validationAgents([agent('a'), agent('b', true), fresh]), { agents: 2, ready: 1 });
  assert.deepEqual(validationAgents([fresh]), { agents: 0, ready: 0 });
  assert.deepEqual(validationAgents([{ id: 'attach', label: 'Show V3', description: 'Its report instead of a second validation' }, agent('a'), fresh]), { agents: 1, ready: 1 }, 'showing a chat validation is not an agent');
  assert.deepEqual(validationAgents([agent('a', true), { ...fresh, disabled: true, description: 'This rollout has no run to validate yet. Refresh it and try again.' }]), { agents: 1, ready: 0, blocked: 'This rollout has no run to validate yet. Refresh it and try again.' });
  assert.deepEqual(validationAgents([agent('a')]), { agents: 1, ready: 1, blocked: 'Connect an agent to this rollout, directly or through another item.' });
});

test('only an approval that may have reached GitHub counts as unconfirmed; a refusal does not', () => {
  for (const code of [OUTCOME_UNKNOWN, REQUEST_TIMEOUT, CONNECTION_LOST]) assert.equal(approvalUnconfirmed({ message: 'x', code }), true, code);
  assert.equal(approvalUnconfirmed(Object.assign(new Error('GitHub may have approved this deployment.'), { code: OUTCOME_UNKNOWN })), true);
  for (const failure of [{ message: 'GitHub declined the approval.', code: 'GITHUB_REJECTED' }, { message: 'The operation was aborted due to timeout', code: 'INVALID_REQUEST' }, { message: 'timed out', code: 23 }, new Error('Blocked'), undefined, 'TIMEOUT'])
    assert.equal(approvalUnconfirmed(failure), false, JSON.stringify(failure));
});

test('the gates an approval tried are read from its confirmed input, or not at all', () => {
  assert.deepEqual(approvalAttempt({ runId: '41', attempt: '2', environmentIds: '7,9', value: 'approve' }), { runId: 41, attempt: 2, environmentIds: [7, 9] });
  const malformed: Record<string, string>[] = [{}, { runId: '41', attempt: '2' }, { runId: 'x', attempt: '2', environmentIds: '7' }, { runId: '41', attempt: '0', environmentIds: '7' }, { runId: '41', attempt: '2', environmentIds: '7,' }, { runId: '41', attempt: '2', environmentIds: '' }];
  for (const input of malformed)
    assert.equal(approvalAttempt(input), undefined, JSON.stringify(input));
});

test('an unconfirmed approval went through once a fresh read shows none of its gates waiting on the same run attempt', () => {
  const tried = { runId: 41, attempt: 2, environmentIds: [7, 9] };
  const gate = (id: number) => ({ environment: { id, name: `env-${id}` }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] });
  const seen = (gates: object[], patch: Partial<ResourceSnapshot> = {}, attempt = 2) => { const value = snapshot(attempt, [], 'ongoing', 'Ongoing'); (value.detail as any).gates = gates; return { ...value, ...patch }; };
  assert.equal(approvalOutcome(tried, seen([])), 'approved');
  assert.equal(approvalOutcome(tried, seen([gate(3)])), 'approved', 'another environment waiting is a later gate');
  assert.equal(approvalOutcome(tried, seen([gate(7), gate(9)])), 'waiting');
  assert.equal(approvalOutcome(tried, seen([gate(9)])), 'waiting', 'every tried gate has to be gone');
  assert.equal(approvalOutcome(tried, seen([], {}, 3)), 'moved');
  assert.equal(approvalOutcome({ ...tried, runId: 5 }, seen([])), 'moved');
  assert.equal(approvalOutcome(tried, seen([], { stale: true })), 'unread', 'a stale read predates the approval');
  assert.equal(approvalOutcome(tried, undefined), 'unread');
  const none = seen([]); (none.detail as any).run = undefined;
  assert.equal(approvalOutcome(tried, none), 'moved');
});
