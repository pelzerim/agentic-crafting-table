import { FROM_TABLE, promptAgent } from './agent-prompt.ts';
import * as z from 'zod/v4';
import { createHash, randomUUID } from 'node:crypto';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { WorkspaceControl, WorkspaceState, WorkspaceCommand } from '../core/control.ts';
import { canonical } from '../core/control.ts';
import type { SqliteStore, ReviewSend, ReviewFindingEvent } from './sqlite-store.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { ReviewResult } from './reviews.ts';
import { agentReadiness, connectedAgents, heldAtPrompt } from './rollout-validation.ts';
import { isArchived, isBelow, isOffMap } from '../../src/graph/archive.ts';
import { findingsPrompt, findingsRollup, ignoredFindings, parseReviewOutput } from '../../src/pull-requests/review-findings.ts';
import type { FindingStatus, ParsedReview } from '../../src/pull-requests/review-findings.ts';

const ids = z.array(z.string().regex(/^F[0-9]{1,4}$/)).max(200);
const note = z.string().max(2000).optional();
const loop = z.object({ round: z.number().int().min(1).max(5), of: z.number().int().min(1).max(5), branch: z.string().min(1).max(200).optional() }).strict().optional();
export const reviewFindingsInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('preview'), findingIds: ids, agentNodeId: z.string().min(1).optional(), note }).strict(),
  z.object({ operation: z.literal('send'), requestId: z.string().uuid(), reviewSessionId: z.string().min(1), findingIds: ids, agentNodeId: z.string().min(1), note, loop }).strict(),
  z.object({ operation: z.literal('spawn'), requestId: z.string().uuid(), sendId: z.string().uuid(), reviewSessionId: z.string().min(1), findingIds: ids, provider: z.enum(['claude', 'codex']), note, loop }).strict(),
  z.object({ operation: z.literal('cancel'), sendId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('mark'), reviewSessionId: z.string().min(1), findingIds: ids.min(1), status: z.enum(['fixed', 'open']) }).strict(),
  z.object({ operation: z.literal('report'), agentNodeId: z.string().min(1), findingIds: ids.min(1),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/i, 'commit must be a 7–40 character hex SHA').optional(), note: z.string().max(500).optional() }).strict(),
]);
/** Operations that change who works on what; agents may only list and report. */
export const humanReviewFindingOperations = ['send', 'spawn', 'cancel', 'mark'];
/** Starts a native agent item through the same creation path as the map. */
export interface AgentSpawner { create(request: ResourceCreate): Promise<unknown>; model(provider: 'claude' | 'codex'): Promise<string> }
export const derivedId = (requestId: string, part: string) => { const hex = createHash('sha256').update(`${requestId}:${part}`).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const UNCONFIRMED = 'Delivery could not be confirmed. Check the agent before sending again.';

/** Review findings: parsing the finished run, per-finding state, and a durable
 * send queue to connected agents that delivers when the recipient becomes idle. */
export class ReviewFindingsCoordinator {
  private parsed = new Map<string, ParsedReview>();
  private times = new Map<string, { startedAt?: string; endedAt?: string }>();
  private reconciling?: Promise<void>;
  private again = false;
  private recheck?: ReturnType<typeof setTimeout>;
  private closed = false;
  private store: SqliteStore; private control: WorkspaceControl; private result: (nodeId: string) => Promise<ReviewResult>; private sessions: SessionCoordinator | undefined; private changed: () => Promise<void>; private allowed: () => boolean; private spawner?: AgentSpawner;
  constructor(store: SqliteStore, control: WorkspaceControl, result: (nodeId: string) => Promise<ReviewResult>, sessions: SessionCoordinator | undefined, changed: () => Promise<void>, allowed = () => true, spawner?: AgentSpawner) {
    this.store = store; this.control = control; this.result = result; this.sessions = sessions; this.changed = changed; this.allowed = allowed; this.spawner = spawner;
  }

  async run(nodeId: string, input: unknown) {
    const args = reviewFindingsInput.parse(input);
    if (args.operation === 'cancel') return this.cancel(nodeId, args.sendId);
    const review = await this.load(nodeId);
    if (args.operation === 'list') return this.describe(review);
    if (args.operation === 'options') return this.options(review);
    if (args.operation === 'mark') {
      if (args.reviewSessionId !== review.sessionId) throw new Error('This review changed. Reopen it before changing findings.');
      this.known(review, args.findingIds);
      this.store.addReviewFindingEvents(args.findingIds.map(findingId => ({ reviewSessionId: review.sessionId, findingId, status: args.status, actor: 'user', at: Date.now() })));
      await this.settle(); return this.describe(review);
    }
    if (args.operation === 'report') return this.report(review, args);
    if (args.operation === 'spawn') return this.spawn(review, args);
    const agents = (await this.options(review)).agents, agent = agents.find(candidate => candidate.nodeId === args.agentNodeId);
    if (!agent && args.agentNodeId) throw new Error('Choose an agent connected to this review or its pull request.');
    if (!review.parsed) throw new Error('Findings can be sent once the review finishes.');
    if (review.parsed.kind === 'findings' && !args.findingIds.length) throw new Error('Select at least one finding to send.');
    this.known(review, args.findingIds);
    const prompt = findingsPrompt({ ...(review.parsed?.kind === 'findings' ? { review: review.parsed.review } : { markdown: review.parsed?.kind === 'text' ? review.parsed.markdown : '' }),
      findingIds: args.findingIds, reviewNodeId: review.nodeId, repository: review.repository, number: review.number, title: review.prTitle, url: review.url, headSha: review.headSha, baseSha: review.baseSha, note: args.note?.trim() || undefined, ...('loop' in args && args.loop ? { loop: args.loop } : {}) });
    if (args.operation === 'preview') return { prompt };
    if (!agent) throw new Error('Choose an agent connected to this review or its pull request.');
    const existing = this.store.reviewSend(args.requestId);
    if (existing) {
      if (existing.agentNodeId !== agent.nodeId || canonical(existing.findingIds) !== canonical(args.findingIds) || existing.reviewSessionId !== review.sessionId) throw new Error('This send request ID was reused with different findings or recipient.');
      return this.receipt(existing);
    }
    if (args.reviewSessionId !== review.sessionId) throw new Error('This review changed. Reopen it before sending findings.');
    const statuses = this.statuses(review.sessionId), busy = args.findingIds.filter(id => statuses[id] === 'queued');
    if (busy.length) throw new Error(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} already queued for an agent. Cancel that first.`);
    let linked = false;
    if (!agent.direct) {
      const current = await this.control.read();
      await this.control.dispatch({ commandId: `${args.requestId}:link`, expectedRevision: current.revision, actor: { kind: 'user', id: 'review-findings' },
        commands: [{ type: 'link.save', link: { id: randomUUID(), sourceId: review.nodeId, targetId: agent.nodeId, kind: 'context', label: 'Findings' } }] });
      linked = true;
    }
    const { send } = this.store.createReviewSend({ id: args.requestId, reviewNodeId: review.nodeId, reviewSessionId: review.sessionId, agentNodeId: agent.nodeId, findingIds: args.findingIds, note: args.note?.trim() ?? '', prompt, linked }, Date.now());
    if (agent.status === 'idle') await this.deliver(send.id, true);
    await this.settle();
    return this.receipt(this.store.reviewSend(send.id)!);
  }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.closed = false; this.observe(); }
  /** A delivery interrupted by a restart may have reached the terminal; never paste it again. */
  recover() {
    for (const send of this.store.reviewSends({ states: ['delivering'] })) this.store.transitionReviewSend(send.id, ['delivering'], 'uncertain', Date.now(), { status: 'open', error: UNCONFIRMED });
    this.observe();
  }
  /** Pauses queue delivery; `start` resumes it after the workspace reopens. */
  async close() { this.closed = true; clearTimeout(this.recheck); await this.reconciling?.catch(() => {}); }

  /** Delivers queued sends to agents that became idle, fails those whose agent left
   * the map, and keeps each finished review's roll-up current on the map. */
  reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = (async () => { do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.closed); })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async reconcileOnce() {
    let state = await this.control.read(), dirty = false;
    for (const send of this.store.reviewSends({ states: ['queued'] })) {
      if (this.closed) return;
      const node = state.nodes.find(candidate => candidate.id === send.agentNodeId), resource = state.resources.find(candidate => candidate.id === node?.resourceId);
      const gone = !node || resource?.pluginId !== 'agent.session' || typeof resource.data.sessionId !== 'string' ? 'was removed from the map'
        : isBelow(node, state.nodes) ? 'was sent to the Undermap' : isArchived(node, state.nodes) || isOffMap(node, state.nodes) ? 'was archived' : undefined;
      if (gone) { this.store.transitionReviewSend(send.id, ['queued'], 'failed', Date.now(), { status: 'open', error: `${node?.title ?? 'The agent'} ${gone} before it could receive the findings.` }); dirty = true; continue; }
      if (await agentReadiness(this.sessions, state, { nodeId: node!.id, sessionId: String(resource!.data.sessionId) }, sessionId => this.store.agentObservation(sessionId)) === 'idle') { await this.deliver(send.id, false).catch(() => {}); dirty = true; }
    }
    if (dirty) state = await this.control.read();
    const commands: WorkspaceCommand[] = [];
    for (const resource of state.resources.filter(record => record.pluginId === 'code.review' && typeof record.data.sessionId === 'string' && !record.data.phase)) {
      const node = state.nodes.find(candidate => candidate.resourceId === resource.id && !isOffMap(candidate, state.nodes));
      if (!node || node.activity !== 'complete') continue;
      const sessionId = String(resource.data.sessionId), parsed = await this.parse(node.id, sessionId).catch(() => undefined);
      if (!parsed) continue;
      const findings = this.rollup(state, sessionId, parsed), summary = String(findings.summary);
      if (canonical(resource.data.findings ?? null) !== canonical(findings)) commands.push({ type: 'item.update', id: node.id, data: { ...resource.data, findings } });
      if (node.summary !== summary) commands.push({ type: 'node.update', id: node.id, summary });
      if (findings.urgent && node.attentionEvents?.findings !== `findings:${sessionId}`) commands.push({ type: 'attention.set', id: node.id, source: 'findings', reason: 'review', note: 'Review found urgent issues', eventId: `findings:${sessionId}` });
    }
    if (commands.length) {
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'review-findings' }, commands }); dirty = true; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; this.again = true; }
    }
    if (dirty) await this.changed();
    // Agent activity normally arrives with a broadcast; recheck waiting sends in case it did not.
    clearTimeout(this.recheck);
    if (!this.closed && this.store.reviewSends({ states: ['queued'] }).length) { this.recheck = setTimeout(() => this.observe(), 5000); this.recheck.unref?.(); }
  }

  private rollup(state: WorkspaceState, sessionId: string, parsed: ParsedReview) {
    if (parsed.kind === 'text') return { sessionId, format: 'text', summary: 'Result as text', counts: 'Result as text', progress: '', pips: [], mix: [], urgent: false };
    const rollup = findingsRollup(parsed.review, this.statuses(sessionId), ignoredFindings(this.store.reviewFindingEvents(sessionId)));
    const last = this.store.reviewSends({ reviewSessionId: sessionId }).filter(send => ['queued', 'delivering', 'sent'].includes(send.state)).at(-1);
    const recipient = last ? state.nodes.find(node => node.id === last.agentNodeId)?.title : undefined;
    return { sessionId, format: 'findings', summary: `${rollup.counts}\n${rollup.progress}`, ...rollup, ...(recipient ? { recipient } : {}) };
  }

  private async deliver(sendId: string, surface: boolean) {
    const claimed = this.store.transitionReviewSend(sendId, ['queued'], 'delivering', Date.now());
    if (!claimed) return;
    try {
      const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === claimed.agentNodeId);
      const sessionId = state.resources.find(resource => resource.id === node?.resourceId)?.data.sessionId;
      if (!this.sessions || typeof sessionId !== 'string') throw new Error('The agent has no running session.');
      await promptAgent(this.sessions, sessionId, `${FROM_TABLE} Please handle the review findings as the pasted request describes:`, claimed.prompt);
      this.store.transitionReviewSend(sendId, ['delivering'], 'sent', Date.now(), { status: 'sent' });
    } catch (error) {
      this.store.transitionReviewSend(sendId, ['delivering'], 'uncertain', Date.now(), { status: 'open', error: UNCONFIRMED });
      if (surface) throw error;
    }
  }

  private async cancel(nodeId: string, sendId: string) {
    const send = this.store.reviewSend(sendId);
    if (!send || send.reviewNodeId !== nodeId) throw new Error('This send belongs to another review.');
    const cancelled = this.store.transitionReviewSend(sendId, ['queued'], 'cancelled', Date.now(), { status: 'open', actor: 'user' });
    if (!cancelled) throw new Error(send.state === 'sent' ? 'These findings were already delivered to the agent.' : `This send can no longer be cancelled (${send.state}).`);
    await this.settle(); return this.receipt(cancelled);
  }

  private async report(review: Awaited<ReturnType<ReviewFindingsCoordinator['load']>>, args: { agentNodeId: string; findingIds: string[]; commit?: string; note?: string }) {
    this.known(review, args.findingIds);
    const sends = this.store.reviewSends({ reviewSessionId: review.sessionId }).filter(send => send.state === 'sent');
    for (const id of args.findingIds) {
      const last = sends.filter(send => send.findingIds.includes(id)).at(-1);
      if (!last) throw new Error(`${id} was not sent to an agent from this review.`);
      if (last.agentNodeId !== args.agentNodeId) throw new Error(`${id} was not sent to this agent. Only its recipient can report it fixed.`);
    }
    this.store.addReviewFindingEvents(args.findingIds.map(findingId => ({ reviewSessionId: review.sessionId, findingId, status: 'fixed', agentNodeId: args.agentNodeId, actor: 'agent',
      ...(args.commit ? { commit: args.commit.toLowerCase() } : {}), ...(args.note?.trim() ? { note: args.note.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() } : {}), at: Date.now() })));
    await this.settle();
    return { reviewNodeId: review.nodeId, statuses: this.statuses(review.sessionId, review.parsed) };
  }

  /** Where a new agent for this review starts: its project's working directory. */
  private newAgentHome(review: Awaited<ReturnType<ReviewFindingsCoordinator['load']>>) {
    if (!this.spawner) return { reason: 'Agents can’t be started from this workspace.' };
    const project = review.state.nodes.find(node => node.id === review.node.projectId && !node.resourceId);
    if (!project?.workingDirectory) return { reason: 'Set a working directory on this review’s project to start an agent from here.' };
    return { projectId: project.id, cwd: project.workingDirectory };
  }
  /** Starts a new agent linked to this review, then queues the findings for it
   * like any other send; they are delivered once the agent is ready. */
  private async spawn(review: Awaited<ReturnType<ReviewFindingsCoordinator['load']>>, args: { requestId: string; sendId: string; reviewSessionId: string; findingIds: string[]; provider: 'claude' | 'codex'; note?: string; loop?: { round: number; of: number; branch?: string } }): Promise<unknown> {
    const existing = this.store.reviewSend(args.sendId); if (existing) return this.receipt(existing);
    if (!review.parsed) throw new Error('Findings can be sent once the review finishes.');
    if (review.parsed.kind === 'findings' && !args.findingIds.length) throw new Error('Select at least one finding to send.');
    if (args.reviewSessionId !== review.sessionId) throw new Error('This review changed. Reopen it before sending findings.');
    this.known(review, args.findingIds);
    const home = this.newAgentHome(review); if (!home.cwd) throw new Error(home.reason);
    const nodeId = derivedId(args.requestId, 'node'), what = args.findingIds.length ? args.findingIds.join(', ') : 'review';
    if (!review.state.nodes.some(node => node.id === nodeId)) {
      const state = await this.control.read(), model = await this.spawner!.model(args.provider);
      await this.spawner!.create({ requestId: args.requestId, nodeId, resourceId: derivedId(args.requestId, 'resource'), expectedRevision: state.revision, projectId: home.projectId, pluginId: 'agent.session',
        title: `Fix ${what}${review.number ? ` · #${review.number}` : ''}`.slice(0, 120), position: { x: review.node.position.x + 300, y: review.node.position.y },
        connection: { id: derivedId(args.requestId, 'link'), otherId: review.nodeId, kind: 'context', sourceIsNew: false }, data: { provider: args.provider, model, cwd: home.cwd } });
    }
    return this.run(review.nodeId, { operation: 'send', requestId: args.sendId, reviewSessionId: args.reviewSessionId, findingIds: args.findingIds, agentNodeId: nodeId, ...(args.note ? { note: args.note } : {}), ...(args.loop ? { loop: args.loop } : {}) });
  }

  private async settle() { await this.reconcile(); await this.changed(); }
  private receipt(send: ReviewSend) { return { sendId: send.id, state: send.state, linked: send.linked, ...(send.error ? { error: send.error } : {}) }; }
  private known(review: Awaited<ReturnType<ReviewFindingsCoordinator['load']>>, findingIds: string[]) {
    if (review.parsed?.kind !== 'findings') { if (findingIds.length) throw new Error(`This review has no individual findings (${findingIds.join(', ')}).`); return; }
    const known = new Set(review.parsed.review.findings.map(finding => finding.id)), unknown = findingIds.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`Unknown finding ${unknown.join(', ')} in this review.`);
  }

  private statuses(sessionId: string, parsed = this.parsed.get(sessionId)): Record<string, FindingStatus> {
    const result: Record<string, FindingStatus> = Object.fromEntries(parsed?.kind === 'findings' ? parsed.review.findings.map(finding => [finding.id, 'open' as const]) : []);
    for (const event of this.store.reviewFindingEvents(sessionId)) result[event.findingId] = event.status;
    return result;
  }

  private async parse(nodeId: string, sessionId: string) {
    const cached = this.parsed.get(sessionId); if (cached) return cached;
    const result = await this.result(nodeId);
    if (result.state === 'running') return undefined;
    const parsed: ParsedReview = !result.markdown ? { kind: 'text', markdown: '', reason: result.state === 'failed' ? 'The review run ended with an error' : 'The review returned no output' }
      : result.state === 'failed' ? { kind: 'text', markdown: result.markdown, reason: 'The review run ended with an error' } : parseReviewOutput(result.markdown);
    if (parsed.kind === 'text' && result.truncated) parsed.reason += '; only the end of a long output was kept';
    this.parsed.set(sessionId, parsed); this.times.set(sessionId, { startedAt: result.startedAt, endedAt: result.endedAt }); return parsed;
  }

  private async load(nodeId: string) {
    const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId), resource = state.resources.find(candidate => candidate.id === node?.resourceId);
    if (!node || resource?.pluginId !== 'code.review') throw new Error('This item is not a code review.');
    const pr = state.nodes.find(candidate => candidate.id === resource.data.sourcePrId), prData = state.resources.find(candidate => candidate.id === pr?.resourceId)?.data ?? {};
    const sessionId = typeof resource.data.sessionId === 'string' && !resource.data.phase ? resource.data.sessionId : '';
    const running = !sessionId || node.activity === 'working';
    const parsed = running ? undefined : await this.parse(nodeId, sessionId);
    const repository = typeof prData.owner === 'string' && typeof prData.repo === 'string' ? `${prData.owner}/${prData.repo}` : '';
    const number = Number(prData.number) || 0;
    return { state, node, nodeId: node.id, resource, sessionId, parsed, repository, number, prNodeId: pr?.id, prTitle: pr?.title ?? resource.title, url: repository && number ? `https://github.com/${repository}/pull/${number}` : undefined,
      headSha: String(resource.data.headSha ?? ''), baseSha: typeof resource.data.baseSha === 'string' ? resource.data.baseSha : undefined };
  }

  private async options(review: Awaited<ReturnType<ReviewFindingsCoordinator['load']>>) {
    const { state, prNodeId } = review, pr = state.nodes.find(node => node.id === prNodeId);
    const isPr = (id: string) => id === prNodeId || Boolean(pr?.resourceId && state.nodes.find(node => node.id === id)?.resourceId === pr.resourceId);
    const found = connectedAgents(state, review.nodeId, isPr).filter(agent => agent.direct || agent.path.nodes.length === 3 && isPr(agent.path.nodes[1]));
    const agents = await Promise.all(found.map(async agent => {
      const node = state.nodes.find(candidate => candidate.id === agent.nodeId)!, provider = state.resources.find(resource => resource.id === node.resourceId)?.data.provider;
      const status = await agentReadiness(this.sessions, state, agent, sessionId => this.store.agentObservation(sessionId));
      return { nodeId: agent.nodeId, title: agent.title, provider: provider === 'codex' ? 'codex' : 'claude', direct: agent.direct, via: agent.direct ? 'review' : 'pr',
        linkedToPr: agent.direct && state.links.some(link => [link.sourceId, link.targetId].includes(agent.nodeId) && [link.sourceId, link.targetId].some(isPr)),
        status, ...(heldAtPrompt(state, agent.nodeId, status) ? { prompt: true } : {}), summary: node.summary };
    }));
    const rank = (agent: typeof agents[number]) => (agent.direct ? 0 : 2) + (agent.status === 'idle' ? 0 : 1);
    agents.sort((a, b) => rank(a) - rank(b));
    const home = this.newAgentHome(review), provider = review.resource.data.provider === 'codex' ? 'codex' : 'claude';
    return { agents, suggested: agents[0]?.nodeId, prLabel: review.number ? `#${review.number}` : 'the PR', newAgent: { provider, available: Boolean(home.cwd), ...(home.reason ? { reason: home.reason } : {}) } };
  }

  private describe(review: Awaited<ReturnType<ReviewFindingsCoordinator['load']>>) {
    const titles = new Map(review.state.nodes.map(node => [node.id, node.title])), events = review.sessionId ? this.store.reviewFindingEvents(review.sessionId) : [];
    const history: Record<string, (ReviewFindingEvent & { agentTitle?: string })[]> = {};
    for (const event of events) (history[event.findingId] ??= []).push({ ...event, ...(event.agentNodeId ? { agentTitle: titles.get(event.agentNodeId) ?? 'a removed agent' } : {}) });
    const sends = review.sessionId ? this.store.reviewSends({ reviewSessionId: review.sessionId }).map(send => ({ id: send.id, agentNodeId: send.agentNodeId, agentTitle: titles.get(send.agentNodeId) ?? 'a removed agent',
      findingIds: send.findingIds, note: send.note, prompt: send.prompt, state: send.state, ...(send.error ? { error: send.error } : {}), createdAt: send.createdAt, updatedAt: send.updatedAt })) : [];
    const parsed = review.parsed, data = review.resource.data;
    return { state: !parsed ? 'running' : review.node.attention === 'error' || review.node.activity === 'unknown' ? 'failed' : 'complete', reviewSessionId: review.sessionId,
      ...(parsed?.kind === 'findings' ? { format: 'findings', review: parsed.review } : parsed ? { format: 'text', markdown: parsed.markdown, reason: parsed.reason } : {}),
      statuses: this.statuses(review.sessionId, parsed), ignored: [...ignoredFindings(events)], history, sends,
      repository: review.repository, pr: { nodeId: review.prNodeId, title: review.prTitle, number: review.number, url: review.url },
      headSha: review.headSha, baseSha: review.baseSha, provider: data.provider, model: data.model, ...this.times.get(review.sessionId) };
  }
}
