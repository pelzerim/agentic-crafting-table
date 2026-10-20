import test from 'node:test';
import assert from 'node:assert/strict';
import { armLoop, blocking, countText, decide, findingFingerprint, loopReviewContext, nextRound, PUSH_DEADLINE_MS, seenIn, settle, statusLine, withSend } from './review-loop.ts';
import type { LoopFinding, ReviewLoopDecision, ReviewLoopFacts, ReviewLoopRecord } from './review-loop.ts';

const T0 = Date.parse('2026-10-08T10:00:00Z'), MIN = 60_000, head1 = 'a'.repeat(40), head2 = 'b'.repeat(40);
const finding = (id: string, over: Partial<LoopFinding> = {}): LoopFinding => ({ id, kind: 'bug', severity: 'high', title: `Problem ${id}`, path: 'src/cart.ts', status: 'open', ignored: false, ...over });
const facts = (over: Partial<ReviewLoopFacts> = {}): ReviewLoopFacts => ({ now: T0, pull: { lifecycle: 'open', head: head1 }, ignored: [], ...over });
const armed = (over: Partial<ReviewLoopRecord> = {}): ReviewLoopRecord => ({ ...armLoop({ id: 'loop-1', pullResourceId: 'pr-r', pullNodeId: 'pr', provider: 'claude', model: 'opus', maxRounds: 3, now: T0 }), ...over });
const reviewing = (round = 1, over: Partial<ReviewLoopRecord> = {}) => {
  let record = armed(over);
  for (let n = 1; n <= round; n++) record = nextRound(record, { round: n, requestId: `review-${n}`, fixed: [] }, T0);
  return { ...record, rounds: record.rounds.map(entry => ({ ...entry, reviewNodeId: `review-${entry.round}`, headSha: entry.round === 1 ? head1 : head2 })) };
};
const sent = (record: ReviewLoopRecord, ids: string[], at = T0) => withSend(record, { id: `send-${record.rounds.length}`, findingIds: ids, at }, { title: 'Claude · impl', nodeId: 'impl' }, T0);
const review = (findings: LoopFinding[], headSha = head1): ReviewLoopFacts['review'] => ({ state: 'findings', findings, headSha });
const halts = (decision: ReviewLoopDecision, code: string, reason?: RegExp) => {
  assert.equal(decision.kind, 'halt', JSON.stringify(decision));
  assert.equal((decision as { code: string }).code, code);
  if (reason) assert.match((decision as { reason: string }).reason, reason);
};
const waits = (decision: ReviewLoopDecision, step: string, detail?: string) => { assert.deepEqual(decision.kind === 'wait' ? [decision.step, decision.detail] : decision, [step, detail]); };

test('arming keeps the reviewer, the round limit and starts with round 1', () => {
  const record = armed();
  assert.deepEqual([record.state, record.step, record.provider, record.model, record.maxRounds, record.rounds], ['armed', 'reviewing', 'claude', 'opus', 3, []]);
  assert.deepEqual(decide(record, facts()), { kind: 'review', round: 1, fixed: [] });
  assert.throws(() => armLoop({ id: 'x', pullResourceId: 'pr-r', pullNodeId: 'pr', provider: 'claude', model: 'opus', maxRounds: 6, now: T0 }), /1 to 5/);
  const started = nextRound(record, { round: 1, requestId: 'review-1', fixed: [] }, T0);
  assert.deepEqual(started.rounds, [{ round: 1, requestId: 'review-1', startedAt: T0 }]);
  assert.equal(statusLine(started), 'Review loop · reviewing (round 1 of 3)');
});

test('reviewing waits for the review, then triage counts critical and high bugs and every security finding, minus ignored ones', () => {
  const record = reviewing(1);
  waits(decide(record, facts()), 'reviewing');
  waits(decide(record, facts({ review: { state: 'running', findings: [] } })), 'reviewing');
  const mixed = [finding('F1', { severity: 'critical' }), finding('F2'), finding('F3', { severity: 'medium' }), finding('F4', { severity: 'low' }),
    finding('F5', { kind: 'security', severity: undefined }), finding('F6', { kind: 'hardening', severity: undefined }), finding('F7', { kind: 'question', severity: undefined }),
    finding('F8', { ignored: true }), finding('F9', { kind: 'security', severity: 'low', ignored: true })];
  assert.deepEqual(blocking(mixed, []).map(item => item.id), ['F1', 'F2', 'F5']);
  assert.deepEqual(decide(record, facts({ review: review(mixed) })), { kind: 'fix', round: 1, findingIds: ['F1', 'F2', 'F5'], recurring: [] });
  const ignoredEarlier = finding('F2', { title: 'Problem  f2!' });
  assert.deepEqual(blocking([ignoredEarlier], [findingFingerprint(finding('F2'))]).map(item => item.id), [], 'a finding ignored in an earlier round stays ignored when raised again');
  assert.deepEqual(blocking([finding('F1', { status: 'fixed' })], []), [], 'a finding already reported fixed is not open');
});

test('clean when nothing blocking is open; medium and low are left for the person', () => {
  const record = reviewing(2), left = [finding('F1', { severity: 'medium' }), finding('F2', { severity: 'medium' }), finding('F3', { severity: 'low' }), finding('F4', { kind: 'question', severity: undefined }), finding('F5', { ignored: true })];
  const decision = decide(record, facts({ review: review(left, head2) }));
  assert.deepEqual(decision, { kind: 'clean', left: '2 medium, 1 low, 1 question' });
  const done = settle(record, decision, T0);
  assert.deepEqual([done.state, done.step], ['clean', 'clean']);
  assert.equal(statusLine(done), 'Review loop · clean after 2 rounds · 2 medium, 1 low, 1 question left for you');
  assert.equal(statusLine(settle(reviewing(1), decide(reviewing(1), facts({ review: review([]) })), T0)), 'Review loop · clean after 1 round');
});

test('out of rounds halts with what is still open; earlier rounds send instead', () => {
  const last = reviewing(3), open = [finding('F1'), finding('F2', { severity: 'medium' })];
  halts(decide(last, facts({ review: review(open, head2) })), 'out-of-rounds', /^out of rounds · 1 high still open$/);
  assert.equal(statusLine(settle(last, decide(last, facts({ review: review(open, head2) })), T0)), 'Review loop · halted: out of rounds · 1 high still open');
  assert.equal(decide(reviewing(2), facts({ review: review(open, head2) })).kind, 'fix');
  const one = reviewing(1, { maxRounds: 1 });
  halts(decide(one, facts({ review: review([finding('F1', { kind: 'security', severity: undefined })]) })), 'out-of-rounds', /1 security still open/);
  assert.equal(countText([finding('F1', { severity: 'critical' }), finding('F2'), finding('F3'), finding('F4', { kind: 'security', severity: undefined })]), '1 critical, 2 high, 1 security');
});

test('a review that fails or returns text only halts', () => {
  halts(decide(reviewing(1), facts({ review: { state: 'failed', reason: 'Model unavailable', findings: [] } })), 'review-failed', /round 1 review failed: Model unavailable/);
  halts(decide(reviewing(2), facts({ review: { state: 'text', reason: 'no findings JSON', findings: [] } })), 'text-only', /round 2 review returned text/);
});

test('a closed or merged pull request halts at any step', () => {
  halts(decide(armed(), facts({ pull: { lifecycle: 'closed', head: head1 } })), 'closed', /closed/);
  halts(decide(sent(reviewing(1), ['F1']), facts({ pull: { lifecycle: 'merged', head: head1 } })), 'merged', /merged/);
});

test('fixing: queued and sent requests wait for the fixer; a report plus a new head starts the next round with what was fixed', () => {
  const record = sent(reviewing(1), ['F1', 'F2']), findings = [finding('F1'), finding('F2', { title: 'Totals drift' })];
  assert.equal(record.fixerNodeId, 'impl');
  assert.equal(statusLine(settle(record, decide(record, facts({ review: review(findings), send: { state: 'queued', reported: [] } })), T0)), 'Review loop · round 1 of 3 · Claude · impl is fixing 2');
  waits(decide(record, facts({ review: review(findings), send: { state: 'sent', reported: [] }, pull: { lifecycle: 'open', head: head2 } })), 'fixing', 'Claude · impl is fixing 2');
  const reported = decide(record, facts({ review: review(findings), send: { state: 'sent', reported: ['F2'] } }));
  waits(reported, 'waiting', 'Claude · impl');
  assert.equal(statusLine(settle(record, reported, T0)), 'Review loop · waiting for Claude · impl to push');
  const next = decide(record, facts({ review: review(findings), send: { state: 'sent', reported: ['F2'] }, pull: { lifecycle: 'open', head: head2 } }));
  assert.deepEqual(next, { kind: 'review', round: 2, fixed: [{ fingerprint: findingFingerprint(findings[1]), title: 'Totals drift' }] });
  const started = nextRound(record, { ...next as Extract<ReviewLoopDecision, { kind: 'review' }>, requestId: 'review-2' }, T0 + MIN);
  assert.deepEqual(started.rounds[0].fixed, [{ fingerprint: findingFingerprint(findings[1]), title: 'Totals drift' }]);
  assert.deepEqual([started.rounds.length, started.step, statusLine(started)], [2, 'reviewing', 'Review loop · reviewing (round 2 of 3)']);
});

test('a fix request with an unknown outcome, a failed or cancelled one, or a fixer that left the map halts; one never journaled is sent again', () => {
  const record = sent(reviewing(1), ['F1']), findings = [finding('F1')];
  halts(decide(record, facts({ review: review(findings), send: { state: 'uncertain', reported: [] } })), 'outcome-unknown', /could not be confirmed/);
  halts(decide(record, facts({ review: review(findings), send: { state: 'failed', error: 'Claude · impl was archived before it could receive the findings.', reported: [] } })), 'fixer-gone', /archived/);
  halts(decide(record, facts({ review: review(findings), send: { state: 'cancelled', reported: [] } })), 'cancelled', /cancelled/);
  halts(decide(record, facts({ review: review(findings), send: { state: 'queued', reported: [] }, fixer: { state: 'gone', title: 'Claude · impl' } })), 'fixer-gone', /no longer on the map/);
  assert.deepEqual(decide(record, facts({ review: review(findings), send: { state: 'missing', reported: [] } })), { kind: 'fix', round: 1, findingIds: ['F1'], recurring: [] });
});

test('45 minutes after sending: nothing reported halts, reported without a push halts', () => {
  const record = sent(reviewing(1), ['F1']), findings = [finding('F1')], late = T0 + PUSH_DEADLINE_MS;
  waits(decide(record, facts({ now: late - 1, review: review(findings), send: { state: 'sent', reported: [] } })), 'fixing', 'Claude · impl is fixing 1');
  halts(decide(record, facts({ now: late, review: review(findings), send: { state: 'sent', reported: [] } })), 'nothing-fixed', /reported no fixes within 45 minutes/);
  halts(decide(record, facts({ now: late, review: review(findings), send: { state: 'queued', reported: [] } })), 'nothing-fixed');
  halts(decide(record, facts({ now: late, review: review(findings), send: { state: 'sent', reported: ['F1'] } })), 'no-push', /pushed no new commit within 45 minutes/);
});

test('a finding fixed in an earlier round that comes back is marked and sent once; its second return halts', () => {
  const fixed = finding('F3', { title: 'Totals drift' }), fingerprint = findingFingerprint(fixed);
  const round2 = { ...reviewing(2), rounds: reviewing(2).rounds.map(entry => entry.round === 1 ? { ...entry, fixed: [{ fingerprint, title: 'Totals drift' }] } : entry) };
  const again = finding('F1', { title: 'Totals  drift.' });
  const decision = decide(round2, facts({ review: review([again], head2) }));
  assert.deepEqual(decision, { kind: 'fix', round: 2, findingIds: ['F1'], recurring: [fingerprint] });
  const marked = withSend(round2, { id: 'send-2', findingIds: ['F1'], at: T0, recurring: [fingerprint] }, { title: 'Claude · impl', nodeId: 'impl' }, T0);
  assert.deepEqual(marked.recurrences, { [fingerprint]: 1 });
  assert.deepEqual(seenIn(marked, [again], 2), { F1: 1 });
  assert.deepEqual(seenIn(marked, [again], 1), {}, 'only earlier rounds count');
  const round3 = { ...nextRound(marked, { round: 3, requestId: 'review-3', fixed: [{ fingerprint, title: 'Totals drift' }] }, T0) };
  const back = decide(round3, facts({ review: review([finding('F2', { title: 'totals drift' })], head2) }));
  halts(back, 'recurring', /^Totals drift came back after being fixed$/);
  assert.equal(statusLine(settle(round3, back, T0)), 'Review loop · halted: Totals drift came back after being fixed');
  assert.notEqual(findingFingerprint(finding('F1', { path: 'src/other.ts' })), findingFingerprint(finding('F1')), 'the file is part of the fingerprint');
  assert.notEqual(findingFingerprint(finding('F1', { kind: 'security' })), findingFingerprint(finding('F1')), 'the kind is part of the fingerprint');
});

test('the review prompt of later rounds names what was fixed and what the person ignored', () => {
  assert.equal(loopReviewContext({ round: 1, maxRounds: 3, fixed: [], ignored: [] }), '');
  const text = loopReviewContext({ round: 2, maxRounds: 3, fixed: [{ title: 'Totals drift', round: 1 }], ignored: [{ title: 'Rename the helper', round: 1 }] });
  assert.match(text, /round 2 of 3/);
  assert.match(text, /Totals drift \(fixed in round 1\)/);
  assert.match(text, /check that each fix holds/i);
  assert.match(text, /Rename the helper/);
  assert.match(text, /do not raise them again/i);
});

test('a stopped, clean or halted record decides nothing more', () => {
  for (const state of ['stopped', 'clean', 'halted'] as const) waits(decide(armed({ state, step: state }), facts()), state);
  assert.equal(statusLine(armed({ state: 'stopped', step: 'stopped' })), 'Review loop · stopped');
});
