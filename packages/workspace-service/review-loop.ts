import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import type { WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { PluginStorage } from '../plugin-sdk/host.ts';
import { derivedId } from './review-findings.ts';
import { stableUuid } from './resources.ts';
import { agentReadiness, connectedAgents } from './rollout-validation.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import { clip } from '../../src/pull-requests/review-findings.ts';
import type { FindingStatus, ReviewFindings } from '../../src/pull-requests/review-findings.ts';
import { defaultReviewModels } from '../../src/pull-requests/reviews.ts';
import type { JsonObject, JsonValue } from '../../src/resource-plugins/types.ts';
import { armLoop, decide, DEFAULT_LOOP_ROUNDS, findingFingerprint, loopReviewContext, MAX_LOOP_ROUNDS, nextRound, seenIn, settle, statusLine, withSend } from '../../src/resource-plugins/items/code-review/review-loop.ts';
import type { LoopFinding, ReviewLoopDecision, ReviewLoopFacts, ReviewLoopRecord, ReviewProviderId } from '../../src/resource-plugins/items/code-review/review-loop.ts';

/** The code.review package's plugin storage collection holding one record per pull request resource. */
export const REVIEW_LOOP_COLLECTION = 'review-loop';
const ARM_VALUES = Array.from({ length: MAX_LOOP_ROUNDS }, (_, index) => `arm:${index + 1}`) as [string, ...string[]];
export const reviewLoopInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('set'), value: z.enum([...ARM_VALUES, 'stop']), sourceResourceId: z.string().min(1), requestId: z.string().uuid(),
    provider: z.enum(['claude', 'codex']).optional(), model: z.string().min(1).max(100).optional() }).strict(),
]);
const ATTENTION = 'review-loop';
/** Steps one pass takes at most for a record, so a pass that keeps acting still ends. */
const STEPS_PER_PASS = 6;

/** The direct review engine as the loop uses it: start a review of the pull request, read a request's job, list the reviewers. */
export interface LoopReviews {
  start(prNodeId: string, provider: ReviewProviderId, input: JsonObject): unknown;
  status(prNodeId: string, requestId: string): { state: string; error?: string | null; nodeId?: string; sessionId?: string }[];
  options(): Promise<{ provider: string; options: string[]; default?: string; error?: string }[]>;
}
/** The review findings operation (`review.findings`) on a review item. */
export interface LoopFindings { run(nodeId: string, input: JsonObject): Promise<unknown> }
export interface ReviewLoopOptions {
  storage: PluginStorage; store: Pick<SqliteStore, 'reviewSend' | 'agentObservation' | 'agentBackground'>; control: WorkspaceControl;
  resources: { cached(nodeId: string): Promise<{ detail?: unknown } | null> }; reviews?: LoopReviews; findings?: LoopFindings; sessions?: SessionCoordinator;
  changed: () => Promise<void>; now?: () => number; allowed?: () => boolean;
}
interface Listed { state: 'running' | 'complete' | 'failed'; reviewSessionId: string; format?: 'findings' | 'text'; review?: ReviewFindings; reason?: string; statuses: Record<string, FindingStatus>; ignored: string[]; headSha?: string }
interface Recipients { agents: { nodeId: string; title: string; status: string }[]; newAgent?: { available: boolean; reason?: string } }
interface PullRead { lifecycle: 'open' | 'closed' | 'merged'; head?: string; branch?: string }
type Node = WorkspaceState['nodes'][number];

const errorText = (error: unknown) => clip(String((error as Error)?.message ?? error), 300);
const providerName = (provider: string) => provider === 'codex' ? 'Codex' : 'Claude';
const loopFindings = (listed: Listed | undefined): LoopFinding[] => listed?.review?.findings.map(finding => ({ id: finding.id, kind: finding.kind, ...(finding.severity ? { severity: finding.severity } : {}), title: finding.title,
  ...(finding.locations[0] ? { path: finding.locations[0].path } : {}), status: listed.statuses[finding.id] ?? 'open', ignored: listed.ignored.includes(finding.id) })) ?? [];

/** Review loops of pull requests: a person arms one, this service runs it. Each pass reads the pull request, the current round's
 * review and fix request, lets the pure decision function choose the next step and performs it through the existing direct review
 * and findings paths. The record is saved before a review starts or findings go out, so a restart never repeats either. */
export class ReviewLoops {
  private options: ReviewLoopOptions; private now: () => number; private allowed: () => boolean;
  private reconciling?: Promise<void>; private again = false; private timer?: ReturnType<typeof setInterval>; private closed = false;
  constructor(options: ReviewLoopOptions) { this.options = options; this.now = options.now ?? Date.now; this.allowed = options.allowed ?? (() => true); }

  async run(nodeId: string, input: unknown): Promise<unknown> {
    const args = reviewLoopInput.parse(input), state = await this.options.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId);
    const resource = state.resources.find(record => record.id === node?.resourceId);
    if (!node || !resource || isOffMap(node, state.nodes)) throw new Error('Open a pull request on the map to start a review loop.');
    if (resource.pluginId === 'code.review' && args.operation === 'status') return this.reviewStatus(state, node);
    if (resource.pluginId !== 'github.pull-request') throw new Error('A review loop starts from a pull request.');
    const record = this.read(resource.id);
    if (args.operation === 'status') return this.view(record);
    if (args.operation === 'options') return this.choices(state, node, resource, record);
    if (args.sourceResourceId !== resource.id) throw new Error('This review loop belongs to another item. Reopen the menu.');
    if (args.value !== 'stop') {
      if (record?.state === 'armed') return this.view(record);
      if (!this.options.reviews || !this.options.findings) throw new Error('Direct reviews are not available in this workspace.');
      const refusal = this.refusal(await this.pull(node.id));
      if (refusal) throw new Error(refusal);
      const reviewer = await this.reviewer(args.provider, args.model);
      const armed = armLoop({ id: args.requestId, pullResourceId: resource.id, pullNodeId: node.id, provider: reviewer.provider, model: reviewer.model, maxRounds: Number(args.value.slice(4)), now: this.now() });
      this.save(armed);
      await this.attention(armed); await this.options.changed(); this.observe();
      return this.view(armed);
    }
    if (record?.state !== 'armed') return this.view(record);
    const stopped: ReviewLoopRecord = { ...record, state: 'stopped', step: 'stopped', updatedAt: this.now() };
    delete stopped.detail;
    this.save(stopped); await this.attention(stopped); await this.options.changed();
    return this.view(stopped);
  }

  private view(record: ReviewLoopRecord | undefined) {
    if (!record) return { state: 'off' };
    return { state: record.state, step: record.step, ...(record.detail ? { detail: record.detail } : {}), line: statusLine(record), armedAt: record.armedAt, updatedAt: record.updatedAt,
      provider: record.provider, model: record.model, maxRounds: record.maxRounds, round: record.rounds.at(-1)?.round ?? 0,
      rounds: record.rounds.map(entry => ({ round: entry.round, ...(entry.reviewNodeId ? { reviewNodeId: entry.reviewNodeId } : {}) })),
      ...(record.fixerNodeId ? { fixerNodeId: record.fixerNodeId } : {}), ...(record.halt ? { halt: record.halt } : {}) };
  }
  /** A review that belongs to a loop: the loop, which round it is and which of its findings an earlier round reported fixed. */
  private async reviewStatus(state: WorkspaceState, node: Node) {
    for (const entry of this.options.storage.list(REVIEW_LOOP_COLLECTION)) {
      const record = entry.value as unknown as ReviewLoopRecord, round = record.rounds.find(candidate => candidate.reviewNodeId === node.id);
      if (!round) continue;
      const pull = this.pullNode(state, record), listed = await this.list(node.id).catch(() => undefined);
      const number = Number(state.resources.find(resource => resource.id === record.pullResourceId)?.data.number) || undefined;
      return { ...this.view(record), round: round.round, seen: seenIn(record, loopFindings(listed), round.round), ...(pull ? { pullNodeId: pull.id } : {}), ...(number ? { pullNumber: number } : {}) };
    }
    return { state: 'off' };
  }
  private async choices(state: WorkspaceState, node: Node, resource: WorkspaceState['resources'][number], record: ReviewLoopRecord | undefined) {
    if (record?.state === 'armed') {
      return { current: '', prompt: statusLine(record), context: { sourceResourceId: resource.id }, options: [{ id: 'stop', label: 'Stop review loop', description: 'No further reviews or fix requests are sent. Work already sent is not undone.' }] };
    }
    const number = Number(resource.data.number), pull = await this.pull(node.id), reviewer = await this.reviewer();
    const refusal = !this.options.reviews || !this.options.findings ? 'Direct reviews are not available in this workspace.' : this.refusal(pull);
    const fixer = await this.fixerPreview(state, node);
    const context = { sourceResourceId: resource.id, provider: reviewer.provider, model: reviewer.model };
    const rounds = [DEFAULT_LOOP_ROUNDS, ...Array.from({ length: MAX_LOOP_ROUNDS }, (_, index) => index + 1).filter(count => count !== DEFAULT_LOOP_ROUNDS)];
    const options = rounds.map(count => {
      const note = `Reviewer: ${providerName(reviewer.provider)} · ${reviewer.model}. Fixer: ${fixer}. Up to ${count} reviews and ${count} fix requests. The fixer pushes to ${pull?.branch ?? 'the pull request’s branch'}. Nothing is merged or approved.`;
      return { id: `arm:${count}`, label: `Up to ${count} round${count === 1 ? '' : 's'}`, ...(refusal ? { description: refusal, disabled: true }
        : { ...(count === DEFAULT_LOOP_ROUNDS ? { description: 'Default' } : {}), confirm: { prompt: clip(`Start a review loop on #${number}?`, 500), note: clip(note, 300), action: 'Start review loop' } }) };
    });
    return { current: '', prompt: record ? statusLine(record) : `Review loop on #${number}`, context, options };
  }
  private refusal(pull: PullRead | undefined) { return pull?.lifecycle === 'merged' ? 'The pull request is already merged.' : pull?.lifecycle === 'closed' ? 'The pull request is closed.' : undefined; }
  private async reviewer(provider?: ReviewProviderId, model?: string): Promise<{ provider: ReviewProviderId; model: string }> {
    const chosen = provider ?? 'claude';
    if (model) return { provider: chosen, model };
    const catalog = (await this.options.reviews?.options().catch(() => []) ?? []).find(entry => entry.provider === chosen);
    return { provider: chosen, model: catalog?.default ?? defaultReviewModels[chosen] };
  }
  /** Who would fix: a ready agent connected to the pull request, else a new agent in its project's folder. */
  private async fixerPreview(state: WorkspaceState, node: Node) {
    for (const agent of connectedAgents(state, node.id)) if (await this.readiness(state, agent) === 'idle') return agent.title;
    const project = state.nodes.find(candidate => candidate.id === node.projectId && !candidate.resourceId);
    return project?.workingDirectory ? `new agent in ${project.title}` : 'none ready (connect an agent or set the project’s working directory)';
  }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.closed = false; clearInterval(this.timer); this.timer = setInterval(() => this.observe(), 15_000); this.timer.unref?.(); this.observe(); }
  async close() { this.closed = true; clearInterval(this.timer); await this.reconciling?.catch(() => {}); }
  /** One pass over every armed loop; a pass asked for while one runs runs once more after it. */
  reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = (async () => { do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.closed); })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async reconcileOnce() {
    for (const entry of this.options.storage.list(REVIEW_LOOP_COLLECTION)) {
      const record = entry.value as unknown as ReviewLoopRecord;
      if (record.state !== 'armed') continue;
      try { await this.advance(record.pullResourceId); }
      catch (error) { await this.finish(this.read(record.pullResourceId), { kind: 'halt', code: 'error', reason: clip(`stopped on an error: ${errorText(error)}`, 300) }).catch(() => {}); }
    }
  }

  /** Takes steps for one pull request until it has to wait. */
  private async advance(pullResourceId: string) {
    for (let step = 0; step < STEPS_PER_PASS && !this.closed; step++) {
      let record = this.read(pullResourceId);
      if (record?.state !== 'armed') return;
      const state = await this.options.control.read(), pr = this.pullNode(state, record);
      if (!pr) { await this.finish(record, { kind: 'halt', code: 'closed', reason: 'the pull request is no longer on the map' }); return; }
      record = await this.bind(pr, record);
      const read = await this.facts(state, pr, record), decision = decide(record, read.facts);
      if (decision.kind === 'wait' || decision.kind === 'halt' || decision.kind === 'clean') { await this.finish(record, decision); return; }
      if (decision.kind === 'review') { if (!await this.review(pr, record, decision, read.ignored)) return; continue; }
      await this.fix(state, pr, record, decision, read); return;
    }
  }

  /** Ties the current round to the review item its request placed; a request the review engine never journaled is started again
   * with the same request id, which the engine runs at most once. */
  private async bind(pr: Node, record: ReviewLoopRecord) {
    const current = record.rounds.at(-1);
    if (!current || current.reviewNodeId) return record;
    const job = this.options.reviews?.status(pr.id, current.requestId)[0];
    if (!job) { await this.launch(pr, record, current.round, []); return record; }
    if (!job.nodeId) return record;
    const next = { ...record, rounds: record.rounds.map(entry => entry === current ? { ...entry, reviewNodeId: job.nodeId } : entry) };
    this.saveArmed(next);
    return next;
  }

  private async facts(state: WorkspaceState, pr: Node, record: ReviewLoopRecord) {
    const pull = await this.pull(pr.id), current = record.rounds.at(-1);
    const facts: ReviewLoopFacts = { now: this.now(), ...(pull ? { pull: { lifecycle: pull.lifecycle, ...(pull.head ? { head: pull.head } : {}) } } : {}), ignored: [] };
    const ignored: { fingerprint: string; title: string; round: number }[] = [];
    let listed: Listed | undefined;
    for (const round of record.rounds) {
      if (!round.reviewNodeId) continue;
      const entry = round === current ? listed = await this.list(round.reviewNodeId).catch(() => undefined) : await this.list(round.reviewNodeId).catch(() => undefined);
      for (const finding of loopFindings(entry).filter(item => item.ignored)) ignored.push({ fingerprint: findingFingerprint(finding), title: finding.title, round: round.round });
    }
    facts.ignored = [...new Set(ignored.map(entry => entry.fingerprint))];
    if (current) {
      const job = this.options.reviews?.status(pr.id, current.requestId)[0], node = current.reviewNodeId ? state.nodes.find(candidate => candidate.id === current.reviewNodeId) : undefined;
      if (job && ['failed', 'cancelled'].includes(job.state)) facts.review = { state: 'failed', reason: job.error ?? 'it did not start', findings: [] };
      else if (current.reviewNodeId && (!node || isOffMap(node, state.nodes))) facts.review = { state: 'failed', reason: 'its review item was removed from the map', findings: [] };
      else if (current.reviewNodeId && listed) facts.review = listed.state === 'running' ? { state: 'running', findings: [] } : listed.state === 'failed' ? { state: 'failed', reason: 'the run ended with an error', findings: [] }
        : listed.format !== 'findings' ? { state: 'text', ...(listed.reason ? { reason: listed.reason } : {}), findings: [] } : { state: 'findings', findings: loopFindings(listed), ...(listed.headSha ? { headSha: listed.headSha } : {}) };
      if (current.send) {
        const send = this.options.store.reviewSend(current.send.id), statuses = listed?.statuses ?? {};
        facts.send = { state: send?.state ?? 'missing', ...(send?.error ? { error: send.error } : {}), reported: current.send.findingIds.filter(id => statuses[id] === 'fixed' && !listed?.ignored.includes(id)) };
      }
    }
    if (record.fixerNodeId) {
      const node = state.nodes.find(candidate => candidate.id === record.fixerNodeId), sessionId = state.resources.find(resource => resource.id === node?.resourceId)?.data.sessionId;
      facts.fixer = !node || isOffMap(node, state.nodes) ? { state: 'gone', title: node?.title ?? record.fixerTitle ?? 'The fixer' }
        : { state: typeof sessionId === 'string' && await this.readiness(state, { nodeId: node.id, sessionId }) === 'idle' ? 'ready' : 'working', title: node.title };
    }
    if (current && listed && (current.reviewSessionId !== listed.reviewSessionId || !current.headSha) && listed.reviewSessionId) {
      Object.assign(current, { reviewSessionId: listed.reviewSessionId, ...(listed.headSha ? { headSha: listed.headSha } : {}) });
      this.saveArmed(record);
    }
    return { facts, listed, branch: pull?.branch, ignored };
  }

  /** Starts the next round's review: recorded first, then requested once under an id derived from the loop and the round. */
  private async review(pr: Node, record: ReviewLoopRecord, decision: Extract<ReviewLoopDecision, { kind: 'review' }>, ignored: { title: string; round: number }[]) {
    const requestId = stableUuid(`review-loop:${record.id}:review:${decision.round}`), started = nextRound(record, { ...decision, requestId }, this.now());
    if (!this.saveArmed(started)) return false;
    await this.options.changed();
    return this.launch(pr, started, decision.round, ignored);
  }
  private async launch(pr: Node, record: ReviewLoopRecord, round: number, ignored: { title: string; round: number }[]) {
    const entry = record.rounds.find(candidate => candidate.round === round)!, previous = record.rounds.find(candidate => candidate.round === round - 1);
    const fixed = record.rounds.filter(candidate => candidate.round < round).flatMap(candidate => (candidate.fixed ?? []).map(fix => ({ title: fix.title, round: candidate.round })));
    const context = loopReviewContext({ round, maxRounds: record.maxRounds, fixed, ignored });
    try {
      if (!this.options.reviews) throw new Error('Direct reviews are not available in this workspace.');
      await this.options.reviews.start(pr.id, record.provider, { requestId: entry.requestId, model: record.model, sourceResourceId: record.pullResourceId,
        ...(previous?.reviewNodeId ? { loop: { round, from: previous.reviewNodeId, ...(context ? { context } : {}) } } : {}) });
      return true;
    } catch (error) {
      await this.finish(this.read(record.pullResourceId) ?? record, { kind: 'halt', code: 'review-failed', reason: clip(`the round ${round} review could not start: ${errorText(error)}`, 300) });
      return false;
    }
  }

  /** Sends the current round's findings to the loop's fixer: the one it already has, else a ready agent connected to the review or its
   * pull request, else a new agent of the reviewer's provider in the project folder. Recorded first; the send itself is journaled. */
  private async fix(state: WorkspaceState, pr: Node, record: ReviewLoopRecord, decision: Extract<ReviewLoopDecision, { kind: 'fix' }>, read: { listed?: Listed; branch?: string }) {
    const current = record.rounds.at(-1)!, reviewNodeId = current.reviewNodeId!, findings = this.options.findings!;
    const recipients = await findings.run(reviewNodeId, { operation: 'options' }) as unknown as Recipients;
    let fixer = record.fixerNodeId ? { nodeId: record.fixerNodeId, title: record.fixerTitle ?? 'the fixer' } : undefined, spawn: string | undefined;
    if (!fixer) {
      const ready = recipients.agents.find(agent => agent.status === 'idle');
      if (ready) fixer = { nodeId: ready.nodeId, title: ready.title };
      else if (recipients.newAgent?.available) { spawn = stableUuid(`review-loop:${record.id}:fixer`); fixer = { nodeId: derivedId(spawn, 'node'), title: 'a new agent' }; }
      else { await this.finish(record, { kind: 'halt', code: 'no-fixer', reason: clip(`no agent can fix the findings: ${recipients.newAgent?.reason ?? 'none is connected and ready'}`, 300) }); return; }
    } else if (!recipients.agents.some(agent => agent.nodeId === fixer!.nodeId)) await this.connect(state, record, reviewNodeId, fixer.nodeId, current.round);
    const sendId = current.send?.id ?? stableUuid(`review-loop:${record.id}:send:${current.round}`);
    const sending = withSend(record, { id: sendId, findingIds: decision.findingIds, at: current.send?.at ?? this.now(), ...(decision.recurring.length ? { recurring: decision.recurring } : {}) }, fixer, this.now());
    if (!this.saveArmed(sending)) return;
    await this.options.changed();
    const loop = { round: current.round, of: record.maxRounds, ...(read.branch ? { branch: clip(read.branch, 200) } : {}) }, reviewSessionId = read.listed?.reviewSessionId ?? current.reviewSessionId ?? '';
    try {
      await findings.run(reviewNodeId, spawn ? { operation: 'spawn', requestId: spawn, sendId, reviewSessionId, findingIds: decision.findingIds, provider: record.provider, loop }
        : { operation: 'send', requestId: sendId, reviewSessionId, findingIds: decision.findingIds, agentNodeId: fixer.nodeId, loop });
    } catch (error) {
      if (!this.options.store.reviewSend(sendId)) await this.finish(this.read(record.pullResourceId) ?? sending, { kind: 'halt', code: 'error', reason: clip(`the findings could not be sent to ${fixer.title}: ${errorText(error)}`, 300) });
    }
    if (spawn) {
      const latest = this.read(record.pullResourceId), title = (await this.options.control.read()).nodes.find(node => node.id === fixer!.nodeId)?.title;
      if (latest?.state === 'armed' && title) this.saveArmed({ ...latest, fixerTitle: title, ...(latest.step === 'fixing' ? { detail: `${title} is fixing ${decision.findingIds.length}` } : {}) });
    }
    await this.options.changed();
  }
  /** A fixer the findings path would not offer for this round's review (it was connected to an earlier round) is linked to it. */
  private async connect(state: WorkspaceState, record: ReviewLoopRecord, reviewNodeId: string, fixerNodeId: string, round: number) {
    if (state.links.some(link => [link.sourceId, link.targetId].includes(reviewNodeId) && [link.sourceId, link.targetId].includes(fixerNodeId))) return;
    await this.options.control.dispatch({ commandId: stableUuid(`review-loop:${record.id}:link:${round}`), expectedRevision: state.revision, actor: { kind: 'system', id: ATTENTION },
      commands: [{ type: 'link.save', link: { id: stableUuid(`review-loop:${record.id}:link:${round}:id`), sourceId: reviewNodeId, targetId: fixerNodeId, kind: 'context', label: 'Findings' } }] });
  }

  private async list(nodeId: string) { return await this.options.findings!.run(nodeId, { operation: 'list' }) as unknown as Listed; }
  private async readiness(state: WorkspaceState, agent: { nodeId: string; sessionId: string }) {
    return agentReadiness(this.options.sessions, state, agent, sessionId => this.options.store.agentObservation(sessionId), this.now, sessionId => this.options.store.agentBackground(sessionId));
  }
  private async pull(nodeId: string): Promise<PullRead | undefined> {
    const pull = ((await this.options.resources.cached(nodeId).catch(() => null))?.detail as { pull?: { merged?: boolean; state?: string; head?: { sha?: unknown; ref?: unknown } } } | undefined)?.pull;
    if (!pull) return undefined;
    return { lifecycle: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open', ...(typeof pull.head?.sha === 'string' ? { head: pull.head.sha } : {}), ...(typeof pull.head?.ref === 'string' ? { branch: pull.head.ref } : {}) };
  }

  /** Saves the record after a decision that ends the step, and keeps the pull request's Needs me in line with it. */
  private async finish(record: ReviewLoopRecord | undefined, decision: ReviewLoopDecision) {
    if (!record) return;
    const latest = this.read(record.pullResourceId);
    if (latest && latest.id !== record.id) return;
    const base = latest && latest.state !== 'armed' ? latest : record;
    const next = base.state === 'armed' ? settle(base, decision, this.now()) : base;
    const changed = JSON.stringify({ ...next, updatedAt: 0 }) !== JSON.stringify({ ...(latest ?? {}), updatedAt: 0 });
    if (changed) this.save(next);
    await this.attention(next);
    if (changed) await this.options.changed();
  }
  private async attention(record: ReviewLoopRecord) {
    const want = record.state === 'halted' ? { reason: 'error' as const, note: 'Review loop halted', eventId: `${record.id}:halted` }
      : record.state === 'clean' ? { reason: 'finished' as const, note: 'Review loop clean', eventId: `${record.id}:clean` } : undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.options.control.read(), node = this.pullNode(state, record);
      if (!node) return;
      const current = node.attentionSources?.[ATTENTION] ?? null;
      if (want ? current === want.reason && node.attentionEvents?.[ATTENTION] === want.eventId : current === null) return;
      const command: WorkspaceCommand = want ? { type: 'attention.set', id: node.id, source: ATTENTION, reason: want.reason, note: want.note, eventId: want.eventId } : { type: 'attention.set', id: node.id, source: ATTENTION, reason: null };
      try { await this.options.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: ATTENTION }, commands: [command] }); return; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }

  private pullNode(state: WorkspaceState, record: Pick<ReviewLoopRecord, 'pullNodeId' | 'pullResourceId'>) {
    const onMap = (node: Node | undefined) => node && !isOffMap(node, state.nodes) ? node : undefined;
    return onMap(state.nodes.find(node => node.id === record.pullNodeId && node.resourceId === record.pullResourceId)) ?? state.nodes.find(node => node.resourceId === record.pullResourceId && !isOffMap(node, state.nodes));
  }
  private read(pullResourceId: string) { return this.options.storage.get(REVIEW_LOOP_COLLECTION, pullResourceId)?.value as unknown as ReviewLoopRecord | undefined; }
  private save(record: ReviewLoopRecord) { this.options.storage.put(REVIEW_LOOP_COLLECTION, record.pullResourceId, record as unknown as JsonValue); }
  /** Saves a step only while this loop is still the armed one: a Stop or a new loop that came in meanwhile wins. */
  private saveArmed(record: ReviewLoopRecord) {
    const latest = this.read(record.pullResourceId);
    if (latest?.state !== 'armed' || latest.id !== record.id) return false;
    this.save(record); return true;
  }
}
