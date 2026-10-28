import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalAttempt, approvalOutcome, approvalUnconfirmed, cardPips, gateJoin, rolloutCardPips, gateNote, phaseCell, pipState, rolloutActions, rolloutEmptyHint, rolloutIndicators, rolloutTone, trackCount, trackFold, validationAgents, withAutoDeploy } from './presentation.ts';
import type { PhaseTrack, TrackPhase } from './auto-deploy.ts';
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

const phase = (over: Partial<TrackPhase> = {}): TrackPhase => ({ name: 'staging', state: 'done', at: at(12), jobs: { done: 2, total: 2 }, jobIds: [], check: { state: 'none' }, ...over });
const stamp = (value: number) => new Date(value).toISOString().slice(11, 16);

test('a phase cell says what deployed and which validation covers it', () => {
  assert.deepEqual(phaseCell(phase({ name: 'build', noCheck: true, check: undefined }), stamp), { deployed: 'built 13:12', check: 'no check needed', tone: 'none' });
  assert.deepEqual(phaseCell(phase({ check: { id: 'V1', state: 'passed', seeded: true } }), stamp), { deployed: 'deployed 13:12', check: 'V1 passed · counts', tone: 'passed' });
  assert.deepEqual(phaseCell(phase({ check: { id: 'V2', state: 'running' } }), stamp).check, 'V2 validating');
  assert.deepEqual(phaseCell(phase({ check: { id: 'V2', state: 'concerns' } }), stamp).check, 'V2 concerns');
  assert.deepEqual(phaseCell(phase({ check: { state: 'accepted' } }), stamp).check, 'accepted when armed');
  assert.deepEqual(phaseCell(phase(), stamp).check, 'validate next');
  assert.deepEqual(phaseCell(phase({ state: 'running', at: undefined, jobs: { done: 1, total: 2 } }), stamp), { deployed: 'deploying · 1 of 2', check: 'validate later', tone: 'none' });
  assert.equal(phaseCell(phase({ state: 'waiting', at: undefined, jobs: { done: 0, total: 2 } }), stamp).deployed, 'not started');
});

test('a gate join and the rail say who opens the gate', () => {
  const passed = phase({ check: { id: 'V3', state: 'passed' } }), validating = phase({ check: { id: 'V3', state: 'running' } });
  assert.deepEqual(gateJoin({ state: 'approved', by: 'auto deploy' }, passed), { state: 'done', glyph: 'check', who: 'auto', what: 'approved' });
  assert.deepEqual(gateJoin({ state: 'approved' }, passed), { state: 'done', glyph: 'check', who: 'you', what: 'approved' });
  assert.deepEqual(gateJoin({ state: 'auto', after: 'V3' }, validating), { state: 'auto', glyph: 'gate', who: 'auto', what: 'after V3' });
  assert.deepEqual(gateJoin({ state: 'approving' }, passed), { state: 'auto', glyph: 'gate', who: 'auto', what: 'approving' });
  assert.deepEqual(gateJoin({ state: 'you' }, passed), { state: 'you', glyph: 'gate', who: 'you', what: 'waiting' });
  assert.deepEqual(gateJoin({ state: 'other' }, passed), { state: 'other', glyph: 'gate', who: 'other', what: 'waits for another approver' });
  assert.equal(gateNote({ state: 'auto', after: 'V3' }, validating), 'Auto deploy approves after V3 passes');
  assert.equal(gateNote({ state: 'auto', after: 'V3' }, passed), 'Auto deploy approves now');
  assert.equal(gateNote({ state: 'approving' }, passed), 'Auto deploy approves now');
  assert.equal(gateNote({ state: 'you' }, passed), undefined);
});

test('the pips, the count and the fold summarise the track', () => {
  const track: PhaseTrack = { current: 4, phases: [phase({ name: 'build', noCheck: true, check: undefined }), phase({ name: 'staging', check: { id: 'V1', state: 'passed' } }), phase({ name: 'canary', check: { id: 'V2', state: 'passed' }, gate: { state: 'approved', by: 'auto deploy' } }),
    phase({ name: 'phase-1', check: { state: 'accepted' }, gate: { state: 'approved' } }), phase({ name: 'phase-2', state: 'running', at: undefined, jobs: { done: 1, total: 2 }, gate: { state: 'approved', by: 'auto deploy' } }),
    phase({ name: 'phase-3', state: 'waiting', at: undefined, jobs: { done: 0, total: 2 }, gate: { state: 'auto' } })] };
  assert.deepEqual(track.phases.map(pipState), ['passed', 'passed', 'passed', 'deployed', 'running', 'waiting']);
  assert.equal(trackCount(track), '4 of 6 deployed · 2 validated');
  assert.deepEqual(trackFold(track), { count: 3, span: 'build → canary', checks: 'V1, V2 passed' });
  assert.equal(trackFold({ ...track, current: 1 }), undefined, 'one phase does not fold');
  assert.equal(pipState(phase({ check: { id: 'V2', state: 'concerns' } })), 'concerns');
});

test('without auto deploy a cell says whether the phase was validated, and a gate join who approves it and when', () => {
  assert.deepEqual(phaseCell(phase({ check: { id: 'V2', state: 'passed' } }), stamp, {}), { deployed: 'deployed 13:12', check: 'V2 passed', tone: 'passed' });
  assert.deepEqual(phaseCell(phase(), stamp, {}), { deployed: 'deployed 13:12', check: 'not validated', tone: 'none' });
  assert.deepEqual(phaseCell(phase(), stamp, { gateWaits: true }), { deployed: 'deployed 13:12', check: 'not validated', tone: 'missing' }, 'amber while the gate after it waits');
  const later = phase({ state: 'waiting', at: undefined, jobs: { done: 0, total: 2 } });
  assert.equal(phaseCell(later, stamp, {}).check, 'no validation yet');
  assert.equal(phaseCell(later, stamp, { autoValidate: true }).check, 'Auto validate later');
  assert.equal(phaseCell(phase({ name: 'build', noCheck: true, check: undefined }), stamp, {}).check, 'no check needed');
  assert.deepEqual(gateJoin({ state: 'later' }, later), { state: 'later', glyph: 'gate', who: 'you', what: 'later' });
  assert.deepEqual(gateJoin({ state: 'approved', at: at(21) }, phase(), stamp), { state: 'done', glyph: 'check', who: 'approved', what: '13:21' });
  assert.deepEqual(gateJoin({ state: 'approved' }, phase(), stamp), { state: 'done', glyph: 'check', who: 'approved', what: 'on GitHub' });
});

test('the map card gets one pip per phase, a bar before each gate and the count, only for two or more phases', () => {
  const track: PhaseTrack = { current: 2, currentGate: true, plain: true, phases: [phase({ name: 'build', noCheck: true, check: undefined }), phase({ name: 'staging', check: { id: 'V1', state: 'passed' } }),
    phase({ name: 'production', state: 'waiting', at: undefined, jobs: { done: 0, total: 2 }, gate: { state: 'you' } }), phase({ name: 'phase-2', state: 'waiting', at: undefined, jobs: { done: 0, total: 1 }, gate: { state: 'later' } })] };
  assert.deepEqual(cardPips(track), { pips: [{ tone: 'passed', style: 'phase' }, { tone: 'passed', style: 'phase' }, { tone: 'you', style: 'gate' }, { tone: 'waiting', style: 'phase' }, { tone: 'later', style: 'gate' }, { tone: 'waiting', style: 'phase' }],
    label: '2 of 4 deployed · 1 validated' });
  assert.equal(cardPips({ ...track, currentGate: undefined })?.pips[3].style, 'now', 'the phase it is at is outlined');
  assert.equal(cardPips({ phases: track.phases.slice(0, 1) }), undefined);
});

test('the card presentation reads the pips from the rollout as last read, its validations and gate events', () => {
  const held = snapshot(1, [job(1, 'build', 'completed', 'success', 1, 4), job(2, 'deploy-staging / ship', 'completed', 'success', 5, 9), job(3, 'deploy-production / ship', 'waiting', null)], 'approval', 'Waiting approval', 'waiting');
  (held.detail as any).gates = [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] }];
  const staging = validation({ scope: { runId: 41, attempt: 1, headSha: 'a'.repeat(40), environments: ['staging'] }, verdict: 'passed' });
  assert.deepEqual(rolloutCardPips(held, [staging], [], []), { pips: [{ tone: 'passed', style: 'phase' }, { tone: 'passed', style: 'phase' }, { tone: 'you', style: 'gate' }, { tone: 'waiting', style: 'phase' }], label: '2 of 3 deployed · 1 validated' });
  assert.equal(rolloutCardPips(snapshot(1, [job(1, 'build', 'completed', 'success', 1, 4), job(2, 'deploy / web', 'in_progress', null, 5)], 'ongoing', 'Ongoing'), [], [], []), undefined, 'one phase has no pips');
  const reached: RolloutEvent = { runId: 41, attempt: 1, kind: 'gate-waiting', jobId: 0, environment: 'production', body: {}, observedAt: at(10) };
  const deploying = snapshot(1, [job(1, 'build', 'completed', 'success', 1, 4), job(2, 'deploy-staging / ship', 'completed', 'success', 5, 9), job(3, 'deploy-production / ship', 'in_progress', null, 12)], 'ongoing', 'Ongoing');
  assert.deepEqual(rolloutCardPips(deploying, [], [reached], [])?.pips.map(pip => `${pip.style}:${pip.tone}`), ['phase:passed', 'phase:deployed', 'gate:done', 'now:running'], 'a gate seen earlier in the attempt still splits the phases');
});

test('auto deploy events join the current attempt in the timeline, newest first', () => {
  const groups = [{ runId: 1, attempt: 2, current: true, label: '', summary: '', jobs: [], entries: [{ key: 'run', kind: 'run' as const, conclusion: 'success', done: 1, total: 1, at: 30, rank: 5 }, { key: 'x', kind: 'queued' as const, blockers: [], at: 10, rank: 0 }] },
    { runId: 1, attempt: 1, current: false, label: '', summary: '', jobs: [], entries: [] }];
  const joined = withAutoDeploy(groups, [{ at: 20, kind: 'armed', text: 'armed by you from here' }, { at: 25, kind: 'halted', text: 'halted: V2 found concerns.' }]);
  assert.deepEqual(joined[0].entries.map(entry => entry.key), ['run', 'auto:1:halted', 'auto:0:armed', 'x']);
  assert.deepEqual(joined[1].entries, []);
  assert.equal(withAutoDeploy(groups, []), groups);
});
