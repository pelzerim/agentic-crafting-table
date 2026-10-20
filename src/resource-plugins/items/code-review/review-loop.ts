import type { FindingKind, FindingStatus, Severity } from '../../../pull-requests/review-findings.ts';

/** Review loop: armed by a person on a pull request, the service reviews it directly, sends the critical, high and security
 * findings to one fixer, waits for the fix to be reported and pushed, and reviews again, up to a round limit. Each review and
 * each fix request is sent once; any doubt halts, and nothing is reverted. */
export const REVIEW_LOOP_OPERATION = 'review.loop';
export const DEFAULT_LOOP_ROUNDS = 3;
export const MAX_LOOP_ROUNDS = 5;
/** A fixer that has not reported and pushed this long after the request halts the loop. */
export const PUSH_DEADLINE_MS = 45 * 60_000;

export type ReviewLoopState = 'armed' | 'clean' | 'halted' | 'stopped';
export type ReviewLoopStep = 'reviewing' | 'fixing' | 'waiting' | 'clean' | 'halted' | 'stopped';
export type ReviewLoopHalt = 'out-of-rounds' | 'recurring' | 'nothing-fixed' | 'no-push' | 'review-failed' | 'text-only' | 'closed' | 'merged'
  | 'fixer-gone' | 'no-fixer' | 'cancelled' | 'outcome-unknown' | 'error';
export type ReviewProviderId = 'claude' | 'codex';

export interface LoopFix { fingerprint: string; title: string }
export interface ReviewLoopSend { id: string; findingIds: string[]; at: number; recurring?: string[] }
export interface ReviewLoopRound {
  round: number; requestId: string; startedAt: number;
  reviewNodeId?: string; reviewSessionId?: string; headSha?: string;
  /** The fix request, saved before it is sent. */
  send?: ReviewLoopSend;
  /** What the fixer reported fixed in this round, taken when the next round starts. */
  fixed?: LoopFix[];
}
export interface ReviewLoopRecord {
  version: 1; id: string; pullResourceId: string; pullNodeId: string; armedAt: number; updatedAt: number;
  state: ReviewLoopState; step: ReviewLoopStep; detail?: string;
  provider: ReviewProviderId; model: string; maxRounds: number;
  fixerNodeId?: string; fixerTitle?: string;
  rounds: ReviewLoopRound[];
  /** How often a fingerprint fixed in an earlier round came back and was sent again. */
  recurrences: Record<string, number>;
  left?: string;
  halt?: { code: ReviewLoopHalt; reason: string; at: number };
}

export interface LoopFinding { id: string; kind: FindingKind; severity?: Severity; title: string; path?: string; status: FindingStatus; ignored: boolean }
export interface ReviewLoopFacts {
  now: number;
  pull?: { lifecycle: 'open' | 'closed' | 'merged'; head?: string };
  /** The current round's review. */
  review?: { state: 'running' | 'failed' | 'text' | 'findings'; reason?: string; findings: LoopFinding[]; headSha?: string };
  /** The current round's fix request; `reported` are the sent findings the fixer reported fixed. */
  send?: { state: 'missing' | 'queued' | 'delivering' | 'sent' | 'failed' | 'cancelled' | 'uncertain'; error?: string; reported: string[] };
  fixer?: { state: 'ready' | 'working' | 'stopped' | 'gone'; title: string };
  /** Fingerprints of findings the person ignored in any round of this loop. */
  ignored: string[];
}

export type ReviewLoopDecision =
  | { kind: 'wait'; step: ReviewLoopStep; detail?: string }
  | { kind: 'review'; round: number; fixed: LoopFix[] }
  | { kind: 'fix'; round: number; findingIds: string[]; recurring: string[] }
  | { kind: 'halt'; code: ReviewLoopHalt; reason: string }
  | { kind: 'clean'; left: string };

export function armLoop(input: { id: string; pullResourceId: string; pullNodeId: string; provider: ReviewProviderId; model: string; maxRounds: number; now: number }): ReviewLoopRecord {
  if (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > MAX_LOOP_ROUNDS) throw new Error(`A review loop runs 1 to ${MAX_LOOP_ROUNDS} rounds.`);
  return { version: 1, id: input.id, pullResourceId: input.pullResourceId, pullNodeId: input.pullNodeId, armedAt: input.now, updatedAt: input.now, state: 'armed', step: 'reviewing',
    provider: input.provider, model: input.model, maxRounds: input.maxRounds, rounds: [], recurrences: {} };
}

const normalTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The same finding across rounds: its kind, its first file and its title without case, spacing or punctuation. */
export const findingFingerprint = (finding: Pick<LoopFinding, 'kind' | 'title' | 'path'>) => `${finding.kind}|${finding.path ?? ''}|${normalTitle(finding.title)}`;
const isUrgent = (finding: Pick<LoopFinding, 'kind' | 'severity'>) => finding.kind === 'security' || finding.kind === 'bug' && (finding.severity === 'critical' || finding.severity === 'high');
/** What the loop sends: open critical and high bugs and security findings the person has not ignored, in this round or an earlier one. */
export function blocking(findings: readonly LoopFinding[], ignored: readonly string[]) {
  const dropped = new Set(ignored);
  return findings.filter(finding => isUrgent(finding) && finding.status !== 'fixed' && !finding.ignored && !dropped.has(findingFingerprint(finding)));
}

const ORDER = ['critical', 'high', 'medium', 'low', 'security', 'hardening', 'question'] as const;
const key = (finding: Pick<LoopFinding, 'kind' | 'severity'>) => finding.kind === 'bug' ? finding.severity ?? 'low' : finding.kind;
/** “1 critical, 2 high, 1 security”. */
export function countText(findings: readonly Pick<LoopFinding, 'kind' | 'severity'>[]) {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1);
  return ORDER.filter(name => counts.has(name)).map(name => `${counts.get(name)} ${name === 'question' && counts.get(name)! > 1 ? 'questions' : name}`).join(', ');
}

const wait = (step: ReviewLoopStep, detail?: string): ReviewLoopDecision => ({ kind: 'wait', step, ...(detail ? { detail } : {}) });
const halt = (code: ReviewLoopHalt, reason: string): ReviewLoopDecision => ({ kind: 'halt', code, reason });
/** Where each fingerprint was first reported fixed, by round. */
function fixedRounds(record: ReviewLoopRecord, before: number) {
  const found = new Map<string, { round: number; title: string }>();
  for (const round of record.rounds) if (round.round < before) for (const fix of round.fixed ?? []) if (!found.has(fix.fingerprint)) found.set(fix.fingerprint, { round: round.round, title: fix.title });
  return found;
}
/** Findings of the review of `round` that match one an earlier round reported fixed: finding id → that round. */
export function seenIn(record: ReviewLoopRecord, findings: readonly Pick<LoopFinding, 'id' | 'kind' | 'title' | 'path'>[], round: number) {
  const fixed = fixedRounds(record, round), seen: Record<string, number> = {};
  for (const finding of findings) { const earlier = fixed.get(findingFingerprint(finding)); if (earlier) seen[finding.id] = earlier.round; }
  return seen;
}

/** The one next thing to do: start a review, send findings, wait, halt or finish clean. Pure; the service performs it. */
export function decide(record: ReviewLoopRecord, facts: ReviewLoopFacts): ReviewLoopDecision {
  if (record.state !== 'armed') return wait(record.step);
  if (facts.pull?.lifecycle === 'closed') return halt('closed', 'the pull request was closed');
  if (facts.pull?.lifecycle === 'merged') return halt('merged', 'the pull request was merged');
  const current = record.rounds.at(-1);
  if (!current) return { kind: 'review', round: 1, fixed: [] };
  const fixer = facts.fixer?.title ?? record.fixerTitle ?? 'the fixer';
  if (record.fixerNodeId && facts.fixer?.state === 'gone') return halt('fixer-gone', `${fixer} is no longer on the map`);
  return current.send ? fixing(record, current, current.send, facts, fixer) : triage(record, current, facts);
}

function triage(record: ReviewLoopRecord, current: ReviewLoopRound, facts: ReviewLoopFacts): ReviewLoopDecision {
  const review = facts.review, n = current.round;
  if (!review || review.state === 'running') return wait('reviewing');
  if (review.state === 'failed') return halt('review-failed', `the round ${n} review failed${review.reason ? `: ${review.reason}` : ''}`);
  if (review.state === 'text') return halt('text-only', `the round ${n} review returned text, not findings${review.reason ? ` (${review.reason})` : ''}`);
  const open = blocking(review.findings, facts.ignored);
  if (!open.length) return { kind: 'clean', left: countText(review.findings.filter(finding => finding.status !== 'fixed' && !finding.ignored && !facts.ignored.includes(findingFingerprint(finding)))) };
  const fixed = fixedRounds(record, n), recurring: string[] = [];
  for (const finding of open) {
    const fingerprint = findingFingerprint(finding), earlier = fixed.get(fingerprint);
    if (!earlier) continue;
    if ((record.recurrences[fingerprint] ?? 0) >= 1) return halt('recurring', `${earlier.title} came back after being fixed`);
    recurring.push(fingerprint);
  }
  if (n >= record.maxRounds) return halt('out-of-rounds', `out of rounds · ${countText(open)} still open`);
  return { kind: 'fix', round: n, findingIds: open.map(finding => finding.id), recurring };
}

function fixing(record: ReviewLoopRecord, current: ReviewLoopRound, send: ReviewLoopSend, facts: ReviewLoopFacts, fixer: string): ReviewLoopDecision {
  const state = facts.send?.state ?? 'missing';
  if (state === 'missing') return { kind: 'fix', round: current.round, findingIds: send.findingIds, recurring: send.recurring ?? [] };
  if (state === 'uncertain') return halt('outcome-unknown', `the fix request to ${fixer} could not be confirmed; nothing was sent again`);
  if (state === 'failed') return halt('fixer-gone', facts.send?.error ?? `the fix request to ${fixer} failed`);
  if (state === 'cancelled') return halt('cancelled', `the fix request to ${fixer} was cancelled`);
  const reported = facts.send?.reported ?? [], moved = Boolean(facts.pull?.head && current.headSha && facts.pull.head !== current.headSha);
  if (state === 'sent' && reported.length && moved) {
    const findings = facts.review?.findings ?? [];
    return { kind: 'review', round: current.round + 1, fixed: reported.map(id => findings.find(finding => finding.id === id)).filter((finding): finding is LoopFinding => Boolean(finding))
      .map(finding => ({ fingerprint: findingFingerprint(finding), title: finding.title })) };
  }
  if (facts.now - send.at >= PUSH_DEADLINE_MS) return reported.length ? halt('no-push', `${fixer} reported fixes but pushed no new commit within 45 minutes`) : halt('nothing-fixed', `${fixer} reported no fixes within 45 minutes`);
  return reported.length ? wait('waiting', fixer) : wait('fixing', `${fixer} is fixing ${send.findingIds.length}`);
}

/** The record after a decision that does not start anything: the step for the status line, or the end. */
export function settle(record: ReviewLoopRecord, decision: ReviewLoopDecision, now: number): ReviewLoopRecord {
  const next: ReviewLoopRecord = { ...record, updatedAt: now };
  delete next.detail;
  if (decision.kind === 'halt') return { ...next, state: 'halted', step: 'halted', halt: { code: decision.code, reason: decision.reason, at: now } };
  if (decision.kind === 'clean') return { ...next, state: 'clean', step: 'clean', ...(decision.left ? { left: decision.left } : {}) };
  if (decision.kind === 'wait') return { ...next, step: decision.step, ...(decision.detail ? { detail: decision.detail } : {}) };
  return next;
}
/** Starts the next round: what the fixer reported fixed is kept on the round it belongs to. */
export function nextRound(record: ReviewLoopRecord, decision: { round: number; fixed: LoopFix[]; requestId: string }, now: number): ReviewLoopRecord {
  const rounds = record.rounds.map(entry => entry.round === decision.round - 1 ? { ...entry, fixed: decision.fixed } : entry);
  const next: ReviewLoopRecord = { ...record, updatedAt: now, step: 'reviewing', rounds: [...rounds, { round: decision.round, requestId: decision.requestId, startedAt: now }] };
  delete next.detail;
  return next;
}
/** Records the fix request of the current round before it goes out, and the fixer the loop keeps. */
export function withSend(record: ReviewLoopRecord, send: ReviewLoopSend, fixer: { nodeId: string; title: string }, now: number): ReviewLoopRecord {
  const current = record.rounds.at(-1)!, recurrences = { ...record.recurrences };
  if (!current.send) for (const fingerprint of send.recurring ?? []) recurrences[fingerprint] = (recurrences[fingerprint] ?? 0) + 1;
  const stored: ReviewLoopSend = { id: send.id, findingIds: send.findingIds, at: send.at, ...(send.recurring?.length ? { recurring: send.recurring } : {}) };
  return { ...record, updatedAt: now, step: 'fixing', detail: `${fixer.title} is fixing ${send.findingIds.length}`, fixerNodeId: fixer.nodeId, fixerTitle: fixer.title, recurrences,
    rounds: record.rounds.map(entry => entry === current ? { ...entry, send: stored } : entry) };
}

/** What a review of round 2 or later is told about the loop so far. */
export function loopReviewContext(input: { round: number; maxRounds: number; fixed: readonly { title: string; round: number }[]; ignored: readonly { title: string; round: number }[] }) {
  if (input.round < 2) return '';
  const list = (items: readonly { title: string; round: number }[], verb: string) => items.map(item => `- ${item.title} (${verb} in round ${item.round})`).join('\n');
  return [`This is round ${input.round} of ${input.maxRounds} of a review loop on this pull request: each round reviews the whole pull request again after an agent pushed fixes.`,
    input.fixed.length ? `Earlier rounds reported these findings fixed. Check that each fix holds, and report a finding again only if it still applies:\n${list(input.fixed, 'fixed')}` : '',
    input.ignored.length ? `The user chose to ignore these findings; do not raise them again:\n${list(input.ignored, 'ignored')}` : ''].filter(Boolean).join('\n\n');
}

/** “Review loop · reviewing (round 1 of 3)”, as the pull request view shows it. */
export function statusLine(record: Pick<ReviewLoopRecord, 'step' | 'detail' | 'halt' | 'rounds' | 'maxRounds' | 'left' | 'fixerTitle'>): string {
  const n = record.rounds.at(-1)?.round ?? 1, of = `round ${n} of ${record.maxRounds}`;
  const text: Record<ReviewLoopStep, string> = {
    reviewing: `reviewing (${of})`, fixing: `${of} · ${record.detail ?? `${record.fixerTitle ?? 'the fixer'} is fixing`}`, waiting: `waiting for ${record.detail ?? record.fixerTitle ?? 'the fixer'} to push`,
    clean: `clean after ${n} round${n === 1 ? '' : 's'}${record.left ? ` · ${record.left} left for you` : ''}`, halted: `halted: ${record.halt?.reason ?? 'stopped on a doubt'}`, stopped: 'stopped',
  };
  return `Review loop · ${text[record.step]}`;
}
