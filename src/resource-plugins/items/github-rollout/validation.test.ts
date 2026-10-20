import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptReport, annotateValidations, currentVerdict, validationAttention, inferStages, activeFirst, observedEvents, rolloutTimeline, jobShortName } from './validation.ts';
import type { Validation, RolloutEvent } from './validation.ts';
import type { RolloutObservation, RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';

const at = (minute: number) => Date.UTC(2026, 8, 30, 13, minute);
const iso = (minute: number) => new Date(at(minute)).toISOString();
const job = (id: number, name: string, status: string, conclusion: string | null, started?: number, completed?: number): RolloutJob =>
  ({ id, run_id: 41, name, status, conclusion, started_at: started === undefined ? null : iso(started), completed_at: completed === undefined ? null : iso(completed) });
const run = (attempt: number, status = 'in_progress', conclusion: string | null = null) => ({ id: 41, name: 'Rollout', display_title: 'Ship', run_number: 41, run_attempt: attempt, workflow_id: 9,
  head_branch: 'main', head_sha: '4be91c0'.padEnd(40, 'a'), status, conclusion, updated_at: iso(0), repository: { full_name: 'acme/app' } });
const observation = (attempt: number, jobs: RolloutJob[], gates: RolloutObservation['gates'] = [], status?: string, conclusion?: string | null): RolloutObservation =>
  ({ workflow: 'Rollout', run: run(attempt, status, conclusion), jobs, gates, url: 'https://github.com/acme/app/actions/runs/41', followsLatest: true });
const scope = (attempt: number, extra: object = {}) => ({ runId: 41, attempt, headSha: '4be91c0'.padEnd(40, 'a'), ...extra });
const validation = (ordinal: number, patch: Partial<Validation>): Validation => ({ id: `v${ordinal}`, ordinal, agentNodeId: 'claude', agent: { title: 'Claude · validator', provider: 'claude' }, requestId: `r${ordinal}`,
  scope: scope(2), state: 'final', verdict: 'passed', sequence: 1, reports: 1, requestedAt: at(ordinal), finishedAt: at(ordinal + 1), updatedAt: at(ordinal + 1), ...patch });
const check = (id: string, status = 'passed', extra: object = {}) => ({ id, title: `Check ${id}`, status, ...extra });

test('a report is validated against the schema limits: final needs a verdict and a check, checks over 30 are refused', () => {
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 1, phase: 'final', summary: 'ok', checks: [check('C1')] }, [1]), /verdict/);
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 1, phase: 'final', verdict: 'passed', summary: 'ok', checks: [] }, [1]), /at least one check/);
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 1, phase: 'progress', summary: '', checks: Array.from({ length: 31 }, (_, i) => check(`C${i}`)) }, [1]), /30/);
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 0, phase: 'progress', summary: '', checks: [] }, [1]));
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 1, phase: 'progress', summary: '', checks: [], approve: true }, [1]));
});

test('a report is sanitized and clamped: control characters stripped, text clipped at a word, extra metrics/evidence/recommendations dropped with warnings, only https evidence', () => {
  const long = 'word '.repeat(300);
  const { report, warnings } = acceptReport({ validationId: 'V1', sequence: 2, phase: 'progress', summary: `Preview\u0007 ${long}`, checks: [
    check('C1', 'concern', { title: long, observation: long.repeat(2), metrics: Array.from({ length: 6 }, (_, i) => ({ label: `m${i}`, before: 1, after: 2 })),
      evidence: [{ label: 'Grafana', url: 'https://grafana.example.com/d/1' }, { label: 'plain', url: 'http://grafana.example.com' }, { label: 'creds', url: 'https://user:secret@example.com' },
        ...Array.from({ length: 6 }, (_, i) => ({ label: `e${i}`, url: `https://logs.example.com/${i}` }))] }),
  ], recommendations: Array.from({ length: 10 }, (_, i) => ({ text: `Hold ${i}`, blocking: i === 0 })) }, [1]);
  assert.ok(report.summary.length <= 600 && report.summary.endsWith('…')); assert.doesNotMatch(report.summary, /\u0007/);
  assert.ok(report.checks[0].title.length <= 200); assert.ok(report.checks[0].observation!.length <= 800);
  assert.equal(report.checks[0].metrics!.length, 4); assert.equal(report.checks[0].evidence!.length, 6);
  assert.deepEqual(report.checks[0].evidence!.map(item => item.url).slice(0, 2), ['https://grafana.example.com/d/1', 'https://logs.example.com/0']);
  assert.equal(report.recommendations.length, 8);
  assert.ok(warnings.some(text => /metrics/.test(text)) && warnings.some(text => /evidence/.test(text)) && warnings.some(text => /recommendations/.test(text)) && warnings.some(text => /https/.test(text)));
});

test('scope narrows only to jobs in the scoped attempt; unknown job ids are dropped with a warning', () => {
  const { scope, report, warnings } = acceptReport({ validationId: 'V2', sequence: 1, phase: 'final', verdict: 'concerns', summary: 'Preview slower', scope: { jobs: [301, 999], environments: ['production'] },
    checks: [check('C1', 'concern', { jobIds: [301, 998] })] }, [300, 301]);
  assert.deepEqual(scope, { jobs: [301], environments: ['production'] });
  assert.deepEqual(report.checks[0].jobIds, [301]);
  assert.deepEqual(warnings.filter(text => /dropped job/.test(text)).length, 2);
  assert.equal(acceptReport({ validationId: 'V2', sequence: 1, phase: 'final', verdict: 'passed', summary: 'x', scope: { jobs: [1] }, checks: [check('C1')] }, undefined).scope.jobs, undefined);
});

test('stale is computed from the latest observation; the newest final validation of the attempt resolves every older one, whatever their scopes, and is the rollout verdict', () => {
  const list = [
    validation(1, { scope: scope(1), verdict: 'failed' }),
    validation(2, { scope: scope(2, { jobs: [301] }), verdict: 'concerns' }),
    validation(3, { agentNodeId: 'codex', scope: scope(2, { jobs: [201] }), verdict: 'passed' }),
    validation(4, { agentNodeId: 'codex', state: 'running', verdict: undefined, finishedAt: undefined }),
  ];
  const views = annotateValidations(list, run(2));
  assert.deepEqual(views.map(view => [view.label, view.stale, view.resolvedBy ?? '', view.current]), [['V1', true, '', false], ['V2', false, 'V3', false], ['V3', false, '', true], ['V4', false, '', false]]);
  assert.equal(currentVerdict(views)?.validation.label, 'V3', 'a later pass on other jobs replaces the earlier concerns');
  const later = annotateValidations([...list, validation(5, { agentNodeId: 'codex', verdict: 'passed', finishedAt: at(20) })], run(2));
  assert.equal(later.find(view => view.label === 'V2')!.resolvedBy, 'V5');
  assert.equal(later.find(view => view.label === 'V3')!.resolvedBy, 'V5');
  assert.equal(currentVerdict(later)?.validation.label, 'V5');
  const worse = annotateValidations([...list, validation(5, { agentNodeId: 'codex', verdict: 'passed', finishedAt: at(20) }), validation(6, { scope: scope(2, { jobs: [301] }), verdict: 'failed', finishedAt: at(25) })], run(2));
  assert.deepEqual([currentVerdict(worse)?.validation.label, currentVerdict(worse)?.verdict], ['V6', 'failed'], 'the latest wins in both directions');
  assert.ok(annotateValidations(list, { ...run(2), head_sha: 'b'.repeat(40) }).every(view => view.stale), 'a different commit makes every validation stale');
  assert.equal(currentVerdict(annotateValidations([list[0]], run(2))), undefined);
});

test('a validation still open when a later-requested one of the same attempt is final is resolved by it; one requested after the final stays open', () => {
  const list = [
    validation(1, { state: 'running', verdict: undefined, finishedAt: undefined, reports: 2, updatedAt: at(4) }),
    validation(2, { agentNodeId: 'codex', verdict: 'passed', requestedAt: at(5), finishedAt: at(20), updatedAt: at(20) }),
    validation(3, { state: 'requested', verdict: undefined, finishedAt: undefined, reports: 0, requestedAt: at(25), updatedAt: at(25) }),
    validation(4, { scope: scope(1), state: 'running', verdict: undefined, finishedAt: undefined }),
  ];
  const views = annotateValidations(list, run(2));
  assert.deepEqual(views.map(view => [view.label, view.state, view.stale, view.resolvedBy ?? '', view.current]),
    [['V1', 'running', false, 'V2', false], ['V2', 'final', false, '', true], ['V3', 'requested', false, '', false], ['V4', 'running', true, '', false]]);
  assert.equal(annotateValidations([list[0], validation(2, { agentNodeId: 'codex', state: 'no-report', verdict: undefined, finishedAt: undefined })], run(2))[0].resolvedBy, undefined, 'only a final validation resolves');
  assert.equal(annotateValidations([{ ...list[0], state: 'no-report' }, list[1]], run(2))[0].resolvedBy, 'V2', 'a No report one is resolved too');
  assert.equal(currentVerdict(views)?.validation.label, 'V2');
});

test('Needs me is derived per agent: failed raises error, concerns raise validation, passed/stale/resolved withdraw, inconclusive stays quiet', () => {
  const attention = (list: Validation[], attempt = 2) => Object.fromEntries(validationAttention(annotateValidations(list, run(attempt))));
  assert.deepEqual(attention([validation(1, { verdict: 'failed' })]), { claude: { reason: 'error', note: 'Validation failed', eventId: 'v1:failed' } });
  assert.deepEqual(attention([validation(1, { verdict: 'concerns' })]), { claude: { reason: 'validation', note: 'Validation found concerns', eventId: 'v1:concerns' } });
  assert.deepEqual(attention([validation(1, { verdict: 'inconclusive' })]), { claude: { reason: null } });
  assert.deepEqual(attention([validation(1, { verdict: 'failed' })], 3), { claude: { reason: null } }, 'a new attempt withdraws it');
  assert.deepEqual(attention([validation(1, { verdict: 'concerns' }), validation(2, { agentNodeId: 'codex', verdict: 'passed' })]), { claude: { reason: null }, codex: { reason: null } }, 'a later pass on the same scope resolves it');
  assert.deepEqual(attention([validation(1, { state: 'running', verdict: undefined })]), { claude: { reason: null } });
});

test('stages come from environment names, then the job-name prefix, otherwise one flat list', () => {
  const jobs = [job(1, 'build / thumbnail-image', 'completed', 'success'), job(2, 'deploy / staging-a', 'completed', 'success'), job(3, 'e2e / staging smoke-test', 'in_progress', null),
    job(4, 'deploy / preview-a', 'in_progress', null), job(5, 'verify / preview 10 min', 'queued', null), job(6, 'deploy / prod-a', 'queued', null)];
  assert.deepEqual(inferStages(jobs, ['production']).map(stage => [stage.name, stage.jobs.map(item => item.id)]), [['build', [1]], ['staging', [2, 3]], ['preview', [4, 5]], ['production', [6]]]);
  assert.deepEqual(inferStages([job(1, 'lint / types', 'queued', null), job(2, 'lint / style', 'queued', null), job(3, 'publish', 'queued', null)], []).map(stage => stage.name), ['lint', '']);
  assert.deepEqual([jobShortName('e2e / staging smoke-test'), jobShortName('deploy / preview-a'), jobShortName('build / thumbnail-image')], ['e2e', 'preview-a', 'thumbnail-image']);
});

test('events are derived from successive observations: attempt starts, gates waiting and approved (by you when approved in the app), run completion, and a job snapshot per attempt', () => {
  const first = observation(1, [job(201, 'deploy / preview-a', 'completed', 'failure', 41, 48)], [], 'completed', 'failure');
  const one = observedEvents(first, [], at(49), []);
  assert.deepEqual(one.map(event => [event.kind, event.attempt, event.observedAt]), [['attempt-started', 1, at(41)], ['run-completed', 1, at(48)], ['jobs-snapshot', 1, at(49)]]);
  const second = observation(2, [job(301, 'deploy / preview-a', 'completed', 'success', 6, 11), job(302, 'deploy / prod-a', 'waiting', null)],
    [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] }], 'waiting');
  const two = observedEvents(second, one, at(12), []);
  assert.deepEqual(two.map(event => [event.kind, event.attempt, event.environment]), [['attempt-started', 2, ''], ['gate-waiting', 2, 'production'], ['jobs-snapshot', 2, '']]);
  const known = [...one, ...two], approved = observation(2, second.jobs.map(item => item.id === 302 ? { ...item, status: 'in_progress', started_at: iso(31) } : item), [], 'in_progress');
  const three = observedEvents(approved, known, at(32), [{ runId: 41, attempt: 2, environmentIds: [7], at: at(31) }]);
  assert.deepEqual(three.filter(event => event.kind !== 'jobs-snapshot').map(event => [event.kind, event.actor, event.observedAt]), [['gate-approved', 'you', at(31)]]);
  assert.deepEqual(observedEvents(approved, [...known, ...three], at(33), []).filter(event => event.kind !== 'jobs-snapshot'), [], 'nothing new is recorded twice');
  assert.equal(observedEvents(approved, known, at(32), []).find(event => event.kind === 'gate-approved')!.actor, undefined, 'approved on GitHub');
});

test('the timeline groups events by attempt, newest first, with superseded attempts from their job snapshot and their validations marked stale', () => {
  const first = observation(1, [job(201, 'deploy / preview-a', 'completed', 'failure', 41, 48)], [], 'completed', 'failure');
  const events: RolloutEvent[] = [...observedEvents(first, [], at(49), [])];
  const current = observation(2, [job(301, 'build / thumbnail-image', 'in_progress', null, 6)]);
  events.push(...observedEvents(current, events, at(7), []));
  const views = annotateValidations([validation(1, { scope: scope(1), verdict: 'failed', requestedAt: at(48), finishedAt: at(53) })], current.run);
  const groups = rolloutTimeline(current, events, views);
  assert.deepEqual(groups.map(group => [group.attempt, group.current]), [[2, true], [1, false]]);
  assert.deepEqual(groups[0].entries.map(entry => entry.kind === 'job' ? `${entry.job.name} ${entry.what}` : entry.kind), ['build / thumbnail-image started', 'attempt']);
  const attempt = groups[0].entries.find(entry => entry.kind === 'attempt')!;
  assert.deepEqual(attempt.kind === 'attempt' && attempt.stale.map(view => view.label), ['V1']);
  assert.deepEqual(groups[1].entries.map(entry => entry.kind === 'job' ? `${entry.job.name} ${entry.what}` : entry.kind), ['validation', 'run', 'deploy / preview-a finished', 'deploy / preview-a started']);
  assert.match(groups[1].label, /Attempt 1 · failed at preview/);
});

test('what a queued run waited behind is recorded once per blocker and shown as one timeline event with the wait', () => {
  const blocker = (id: number, number: number, who: string) => ({ id, number: id, status: 'in_progress', url: `https://github.com/acme/app/actions/runs/${id}`, pull: { number, title: 'x', mergedBy: who } });
  const waiting = { ...observation(1, [], [], 'queued'), queue: { ahead: [blocker(99, 21, 'octo-a')], you: { id: 41, number: 41, status: 'queued', url: 'https://github.com/acme/app/actions/runs/41', startedAt: iso(2) } } };
  const first = observedEvents(waiting, [], at(3), []);
  assert.deepEqual(first.filter(event => event.kind === 'queued-behind').map(event => [event.jobId, event.body]), [[99, { ref: '#21', who: 'octo-a', since: iso(2) }]]);
  const later = { ...waiting, queue: { ...waiting.queue, ahead: [blocker(99, 21, 'octo-a'), blocker(100, 23, 'octo-b')] } };
  const second = observedEvents(later, first, at(20), []);
  assert.deepEqual(second.filter(event => event.kind === 'queued-behind').map(event => event.jobId), [100]);
  const started = observation(1, [job(301, 'deploy / preview-a', 'in_progress', null, 33)]);
  const events = [...first, ...second, ...observedEvents(started, [...first, ...second], at(34), [])];
  assert.equal(events.filter(event => event.kind === 'queued-behind').length, 2);
  const queued = rolloutTimeline(started, events, [])[0].entries.filter(entry => entry.kind === 'queued');
  assert.deepEqual(queued.map(entry => entry.kind === 'queued' && [entry.blockers, entry.waited, entry.at]), [[['#21 (octo-a)', '#23 (octo-b)'], 31 * 60_000, at(2)]]);
});

test('the jobs rail lists unfinished stages and jobs first, keeping order otherwise', () => {
  const job = (id: number, name: string, status: string) => ({ id, name, status });
  const stages = [
    { name: 'build', jobs: [job(1, 'build / a', 'completed'), job(2, 'build / b', 'completed')] },
    { name: 'staging', jobs: [job(3, 'staging / x', 'completed'), job(4, 'staging / y', 'in_progress')] },
    { name: 'production', jobs: [job(5, 'production / p', 'completed'), job(6, 'production / q', 'waiting'), job(7, 'production / r', 'queued')] },
    { name: 'gate-only', jobs: [] as ReturnType<typeof job>[] },
  ];
  const ordered = activeFirst(stages, name => name === 'gate-only');
  assert.deepEqual(ordered.map(stage => stage.name), ['staging', 'production', 'gate-only', 'build']);
  assert.deepEqual(ordered[1].jobs.map(entry => entry.id), [6, 7, 5]);
  assert.deepEqual(ordered[0].jobs.map(entry => entry.id), [4, 3]);
  assert.deepEqual(ordered[3].jobs.map(entry => entry.id), [1, 2]);
});

test('a report keeps the paragraphs and list lines of its summary and observations; titles and recommendations stay one line', () => {
  const { report } = acceptReport({ validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Preview healthy.\r\n\r\nOne concern:\n- memory  per instance', checks: [
    check('C1', 'concern', { title: 'Memory\nper instance', observation: 'Memory grew.\n\n\n\n- before 8 MB\n- after 22 MB' })], recommendations: [{ text: 'Hold\nthe gate', blocking: true }] }, [1]);
  assert.equal(report.summary, 'Preview healthy.\n\nOne concern:\n- memory per instance');
  assert.equal(report.checks[0].observation, 'Memory grew.\n\n- before 8 MB\n- after 22 MB');
  assert.equal(report.checks[0].title, 'Memory per instance'); assert.equal(report.recommendations[0].text, 'Hold the gate');
});

test('a follow-up report amends a final one: it needs a verdict and a check like a final report, and keeps its verdict', () => {
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 4, phase: 'followup', summary: 'Later', checks: [check('C1')] }, [1]), /verdict/);
  assert.throws(() => acceptReport({ validationId: 'V1', sequence: 4, phase: 'followup', verdict: 'concerns', summary: 'Later', checks: [] }, [1]), /at least one check/);
  const accepted = acceptReport({ validationId: 'V1', sequence: 4, phase: 'followup', verdict: 'concerns', summary: 'Latency crept up later.', checks: [check('C1', 'concern')] }, [1]);
  assert.deepEqual([accepted.phase, accepted.report.verdict], ['followup', 'concerns']);
});
