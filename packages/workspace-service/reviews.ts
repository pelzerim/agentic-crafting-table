import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import type { SqliteStore, JobRecord } from './sqlite-store.ts';
import type { WorkspaceControl, WorkspaceCommand } from '../core/control.ts';
import { canonical } from '../core/control.ts';
import type { SessionCoordinator, PreparedSession } from './sessions.ts';
import type { SessionSnapshot, SessionRecord } from '../session-runtime/protocol.ts';
import { agentProvider } from './agent-providers.ts';
import { prepareReviewProcess, probeReview, readReviewProcess } from '../session-runtime/review.ts';
import type { ReviewProcessPlan } from '../session-runtime/review.ts';
import type { ReviewSource, FrozenReviewSource } from '../provider-runtime/review-sources.ts';
import { comparisonInput } from '../provider-runtime/git-comparison.ts';
import { buildReviewLaunch, defaultReviewModels } from '../../src/pull-requests/reviews.ts';
import type { ReviewProvider } from '../../src/pull-requests/reviews.ts';
import type { AgentCapability } from '../session-runtime/agent-plan.ts';
import type { ProjectContext } from '../../src/agents/project-context.ts';
import { isArchived, isOffMap } from '../../src/graph/archive.ts';

export interface ReviewResult { state: 'running' | 'complete' | 'failed'; markdown?: string; truncated?: boolean; startedAt?: string; endedAt?: string }
const REVIEW_RESULT_BYTES = 1024 * 1024;
/** Plain text from a PTY recording: drops CSI/OSC/other escapes and CR artifacts. */
export function terminalText(output: string) {
  return output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '')
    .replace(/\r+\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

// Older durable jobs and MCP clients may omit the resource assertion. Desktop
// requests carry the identity of the PR whose button was actually clicked.
// `reviewNodeId` retries a failed preparation on its existing review item.
// `loop` places a review loop's later round beside the review of the round before and tells it about those rounds.
const loopInput = z.object({ round: z.number().int().min(1).max(5), from: z.string().min(1).optional(), context: z.string().max(12_000).optional() }).strict();
const launchInput = z.object({ requestId: z.string().uuid(), model: z.string().min(1).max(100).optional(), sourceResourceId: z.string().min(1).optional(), reviewNodeId: z.string().min(1).optional(), loop: loopInput.optional() });
interface FrozenRun { sourceData: unknown; source: FrozenReviewSource; sourceResourceId: string; pluginId: string; provider: ReviewProvider; model: string; capability: AgentCapability; nodeId: string; resourceId: string; projectId?: string; project: ProjectContext; position: { x: number; y: number }; startedAt?: string; loop?: z.infer<typeof loopInput> }
type ReviewPhase = 'queued' | 'fetching' | 'starting' | 'failed';
const providerName = (provider: unknown) => provider === 'codex' ? 'Codex' : 'Claude';
const phaseSummary = (phase: ReviewPhase, provider: unknown, error?: string) => ({ queued: 'Preparing review…', fetching: 'Fetching and comparing the PR…', starting: `Starting ${providerName(provider)}…`, failed: `Review failed · ${error}` })[phase];
const removed = () => Object.assign(new Error('The review item was removed before the review started.'), { code: 'REVIEW_REMOVED' });
export interface ReviewRuntime {
  models(provider: ReviewProvider): Promise<{ options: string[]; default: string }>;
  probe(provider: ReviewProvider): Promise<AgentCapability>;
}
const nativeRuntime: ReviewRuntime = {
  models: provider => agentProvider(provider).models(),
  async probe(provider) { const capability = await agentProvider(provider).probe(); return { ...capability, structuredOutput: await probeReview(provider, capability) }; },
};
export class ReviewCoordinator {
  private pending = new Map<string, Promise<SessionSnapshot>>();
  private preparing: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private directory: string; private store: SqliteStore; private control: WorkspaceControl; private sessions: SessionCoordinator;
  private sources: Record<string, ReviewSource>; private changed: () => Promise<void>; private runtime: ReviewRuntime;
  constructor(directory: string, store: SqliteStore, control: WorkspaceControl, sessions: SessionCoordinator,
    sources: Record<string, ReviewSource>, changed: () => Promise<void>, runtime: ReviewRuntime = nativeRuntime) {
    this.directory = directory; this.store = store; this.control = control; this.sessions = sessions; this.sources = sources; this.changed = changed; this.runtime = runtime;
  }
  start(nodeId: string, provider: ReviewProvider, input: unknown, track: (work: () => Promise<unknown>) => Promise<unknown>) {
    if (this.controller.signal.aborted) throw new Error('The workspace is closing. Reopen it before starting a review.');
    const args = launchInput.parse(input);
    const job = this.store.enqueueJob(`review:${args.requestId}`, { action: 'review.prepare', nodeId, arguments: { ...args, provider } });
    if (['queued', 'outcome-unknown'].includes(job.state) && !this.pending.has(job.id)) {
      // Track the whole operation with workspace close, but acknowledge immediately.
      void track(() => this.run(nodeId, provider, args)).catch(error => {
        const current = this.store.getJob(job.id)!;
        if (current.state === 'queued') this.store.transitionJob(job.id, 'queued', 'running');
        const latest = this.store.getJob(job.id)!;
        if (latest.state === 'running') this.store.transitionJob(job.id, 'running', this.controller.signal.aborted ? 'outcome-unknown' : 'failed', { error: (error as Error).message });
      });
    }
    return { requestId: args.requestId };
  }
  /** The finished review as Markdown: Codex's last-message file, or Claude's
   * --print output without terminal control sequences. */
  async result(nodeId: string): Promise<ReviewResult> {
    const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId);
    const resource = state.resources.find(candidate => candidate.id === node?.resourceId);
    if (resource?.pluginId !== 'code.review') throw new Error('This item is not a code review.');
    if (resource.data.phase) return resource.data.phase === 'failed' ? { state: 'failed', markdown: '', truncated: false } : { state: 'running' };
    const sessionId = String(resource.data.sessionId);
    const snapshot = await this.sessions.runtime.call('sessions.read', { sessionId }) as SessionSnapshot, { session } = snapshot;
    if (session.state === 'starting' || session.state === 'running') return { state: 'running' };
    const status = session.state === 'exited' && session.exitCode === 0 ? 'complete' : 'failed', times = { startedAt: session.createdAt, endedAt: session.updatedAt };
    if (resource.data.provider === 'codex') {
      const file = join(this.directory, 'review-launches', sessionId, 'result.md');
      try {
        if (statSync(file).size > REVIEW_RESULT_BYTES) return { state: status, markdown: '', truncated: true, ...times };
        return { state: status, markdown: readFileSync(file, 'utf8').trim(), truncated: false, ...times };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { state: status, markdown: '', truncated: false, ...times }; }
    }
    return { state: status, markdown: terminalText(snapshot.chunks.map(chunk => chunk.data).join('')).slice(-REVIEW_RESULT_BYTES), truncated: snapshot.truncated, ...times };
  }
  status(nodeId: string, requestId?: string) {
    return this.store.listJobs().filter(job => job.input.action === 'review.prepare' && job.input.nodeId === nodeId && (!requestId || job.requestKey === `review:${requestId}`)).map(job => {
      // The review item exists from placement on; aliases reveal the run they joined.
      const owner = typeof job.correlation.aliasOf === 'string' ? this.store.getJob(job.correlation.aliasOf) ?? job : job, run = owner.correlation.run as FrozenRun | undefined;
      const placed = run && owner.correlation.placed === true ? { nodeId: run.nodeId, resourceId: run.resourceId } : typeof job.input.arguments.reviewNodeId === 'string' ? { nodeId: job.input.arguments.reviewNodeId } : {};
      return { requestId: job.input.arguments.requestId, provider: job.input.arguments.provider, model: job.input.arguments.model,
        state: job.state, error: job.error, ...placed, ...(job.result as { nodeId?: string; sessionId?: string; resourceId?: string; reused?: boolean } ?? {}) };
    });
  }
  async options() {
    return Promise.all((['codex', 'claude'] as const).map(async provider => {
      try { const [catalog] = await Promise.all([this.runtime.models(provider), this.runtime.probe(provider)]); return { provider, ...catalog, default: catalog.options.includes(defaultReviewModels[provider]) ? defaultReviewModels[provider] : catalog.default }; }
      catch (error) { return { provider, options: [], error: (error as Error).message }; }
    }));
  }
  run(nodeId: string, provider: ReviewProvider, input: unknown): Promise<SessionSnapshot> {
    const args = launchInput.parse(input);
    // Serialize reservation/active-run lookup, not the potentially long capture.
    const reserve = this.preparing.then(() => this.reserve(nodeId, provider, args));
    this.preparing = reserve.catch(() => {});
    return reserve.then(job => {
      const existing = this.pending.get(job.id); if (existing) return existing;
      const pending = this.execute(job).finally(() => this.pending.delete(job.id)); this.pending.set(job.id, pending); return pending;
    }, async error => { if (args.reviewNodeId) await this.patch(args.reviewNodeId, 'failed', (error as Error).message).catch(() => {}); throw error; });
  }
  private async reserve(nodeId: string, provider: ReviewProvider, args: z.infer<typeof launchInput>) {
    const requestKey = `review:${args.requestId}`, input = { action: 'review.prepare', nodeId, arguments: { ...args, provider } };
    const previous = this.store.listJobs().find(job => job.requestKey === requestKey);
    if (previous) { if (canonical(previous.input) !== canonical(input)) throw new Error('Review request ID was reused with different input'); if (previous.correlation.run || ['failed', 'cancelled', 'succeeded'].includes(previous.state)) return previous; }
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || !resource || isArchived(node, state.nodes)) throw new Error('Open an available pull request before starting a review');
    if (args.sourceResourceId && args.sourceResourceId !== resource.id) throw new Error('The source PR no longer matches this review request. Reopen the PR and start a new review.');
    const target = args.reviewNodeId ? state.nodes.find(node => node.id === args.reviewNodeId) : undefined, targetResource = state.resources.find(resource => resource.id === target?.resourceId);
    if (args.reviewNodeId && (!target || !targetResource || isOffMap(target, state.nodes) || targetResource.pluginId !== 'code.review' || targetResource.data.sourcePrId !== nodeId || !targetResource.data.phase)) throw new Error('This review item can no longer be retried. Start a new review from the pull request.');
    const previousRound = args.loop?.from ? state.nodes.find(node => node.id === args.loop!.from) : undefined;
    if (args.loop?.from && (!previousRound || isOffMap(previousRound, state.nodes) || state.resources.find(resource => resource.id === previousRound.resourceId)?.pluginId !== 'code.review')) throw new Error('The previous round of this review loop is no longer on the map.');
    const source = this.sources[resource.pluginId]; if (!source) throw new Error('This item does not support revision-pinned reviews');
    const [catalog, capability] = await Promise.all([this.runtime.models(provider), this.runtime.probe(provider)]);
    const model = args.model ?? (catalog.options.includes(defaultReviewModels[provider]) ? defaultReviewModels[provider] : catalog.default);
    if (!catalog.options.includes(model)) throw new Error(`Model unavailable for ${provider}: ${model}`);
    const frozen = await source.freeze(resource, AbortSignal.any([this.controller.signal, AbortSignal.timeout(60_000)]));
    const sessions = await this.sessions.runtime.call<SessionRecord[]>('sessions.list');
    // A retry belongs to its own item, so it never joins another active run.
    for (const candidate of args.reviewNodeId || previousRound ? [] : this.store.listJobs().filter(job => job.input.action === 'review.prepare')) {
      const run = candidate.correlation.run as FrozenRun | undefined;
      if (!run || (run.sourceResourceId ?? state.nodes.find(node => node.id === candidate.input.nodeId)?.resourceId) !== resource.id
        || run.provider !== provider || run.model !== model || run.source.connectionId !== frozen.connectionId
        || canonical(run.source.comparison) !== canonical(frozen.comparison)) continue;
      if (this.pending.has(candidate.id) || sessions.some(session => session.nodeId === run.nodeId && ['running', 'starting'].includes(session.state))) {
        if (previous && previous.id !== candidate.id) {
          const waiting = this.store.transitionJob(previous.id, previous.state, 'running', { correlation: { ...candidate.correlation, aliasOf: candidate.id } });
          return waiting;
        }
        return candidate;
      }
    }
    const projectNode = state.nodes.find(item => item.id === node.projectId);
    const run: FrozenRun = { sourceData: resource.data, source: frozen, sourceResourceId: resource.id, pluginId: resource.pluginId, provider, model, capability, nodeId: target?.id ?? randomUUID(), resourceId: targetResource?.id ?? randomUUID(), projectId: node.projectId,
      position: target?.position ?? { x: (previousRound ?? node).position.x + 280, y: (previousRound ?? node).position.y }, startedAt: new Date().toISOString(), ...(args.loop ? { loop: args.loop } : {}), project: { id: projectNode?.id ?? node.id, name: projectNode?.title ?? 'Floating pull request', goal: projectNode?.summary ?? '', repository: frozen.comparison.repository } };
    let job = this.store.enqueueJob(requestKey, input);
    if (job.state === 'outcome-unknown') job = this.store.transitionJob(job.id, 'outcome-unknown', 'queued', { correlation: { ...job.correlation, reconciledAbsent: true } });
    return this.store.transitionJob(job.id, job.state, 'running', { correlation: { run } });
  }
  private async assertBinding(nodeId: string, run: FrozenRun) {
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId);
    const resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || !resource || isArchived(node, state.nodes) || node.projectId !== run.projectId
      || (run.sourceResourceId && resource.id !== run.sourceResourceId) || resource.pluginId !== run.pluginId
      || canonical(resource.data) !== canonical(run.sourceData)
      || (resource.connectionId && resource.connectionId !== run.source.connectionId)) {
      throw new Error('The source PR binding changed while preparing the review. Start a new review.');
    }
    return { state, resource };
  }
  private async execute(original: JobRecord): Promise<SessionSnapshot> {
    let job = this.store.getJob(original.id)!;
    if (job.state === 'succeeded') return this.sessions.runtime.call('sessions.read', { sessionId: (job.result as { sessionId: string }).sessionId });
    if (['failed', 'cancelled'].includes(job.state)) throw new Error(job.error ?? 'This review did not start. Start a new review to retry.');
    if (typeof job.correlation.aliasOf === 'string') {
      const target = this.store.getJob(job.correlation.aliasOf)!;
      const result = await (this.pending.get(target.id) ?? this.execute(target));
      this.store.transitionJob(job.id, job.state, 'succeeded', { result: { nodeId: result.session.nodeId, sessionId: result.session.id, reused: true } }); return result;
    }
    const run = job.correlation.run as FrozenRun | undefined;
    if (!run) throw new Error('Review preparation was interrupted before capturing its request. Start a new review.');
    if (job.state === 'outcome-unknown') job = this.store.transitionJob(job.id, 'outcome-unknown', 'queued', { correlation: { ...job.correlation, reconciledAbsent: true } });
    if (job.state === 'queued') job = this.store.transitionJob(job.id, 'queued', 'running');
    const requestId = String(job.input.arguments.requestId), signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180_000)]);
    try {
      let prepared = job.correlation.prepared as PreparedSession | undefined;
      if (!prepared) {
        await this.show(job, run, 'fetching');
        if (job.correlation.placed !== true) job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { ...job.correlation, placed: true } });
        const comparison = await this.sources[run.pluginId].capture(this.directory, requestId, run.source, signal);
        if (canonical(comparisonInput.parse(comparison)) !== canonical(run.source.comparison)
          || !/^[a-f0-9]{40}$/i.test(comparison.baseSha)) throw new Error('The captured PR comparison does not match this review request. Start a new review.');
        const changes = { pr: { id: job.input.nodeId, repository: comparison.repository, number: comparison.number, title: run.source.title, url: run.source.url, headSha: comparison.headSha, assignees: [], state: 'open' as const }, baseSha: comparison.baseSha, diff: comparison.diff, changedFiles: comparison.changedFiles, description: run.source.description };
        const prompt = buildReviewLaunch(run.project, changes, run.provider, [run.model], requestId, run.model, {}, run.loop?.context).initialPrompt;
        const process = prepareReviewProcess(this.directory, { requestId, nodeId: run.nodeId, provider: run.provider, model: run.model, prompt, comparison, capability: run.capability });
        await this.show(job, run, 'starting');
        job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { ...job.correlation, processId: requestId } });
        const { state, resource: sourceResource } = await this.assertBinding(job.input.nodeId, run); this.assertItem(state, run);
        // Attach the session to the placed item in the same commit as the launch.
        const commands: WorkspaceCommand[] = [{ type: 'item.update', id: run.nodeId, data: { sourceConnectionId: run.source.connectionId ?? '', provider: run.provider, model: run.model, sessionId: requestId, sourcePrId: job.input.nodeId, baseSha: comparison.baseSha, headSha: comparison.headSha, baseTipSha: comparison.baseTipSha, launchMode: 'review', reviewJobId: job.id, cwd: process.launch.cwd } },
          { type: 'node.update', id: run.nodeId, activity: 'working', attention: 'none', summary: 'Reviewing changes' }];
        if (run.source.connectionId && !sourceResource.connectionId) commands.unshift({ type: 'item.bind', id: job.input.nodeId, connectionId: run.source.connectionId });
        prepared = { requestId, expectedRevision: state.revision, nodeId: run.nodeId, action: 'review.create', commands, launch: process.launch };
        job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { ...job.correlation, prepared } });
      }
      signal.throwIfAborted();
      // Earlier jobs created their item in the launch commit instead of placing it first.
      const placedFirst = !prepared.commands.some(command => command.type === 'item.create');
      const current = await this.control.read(), attached = current.resources.find(resource => resource.id === run.resourceId)?.data;
      if (placedFirst && !(attached?.sessionId === requestId && !attached.phase)) this.assertItem(current, run);
      let result: SessionSnapshot | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { result = await this.sessions.launchPrepared(prepared); break; }
        catch (error) {
          if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error;
          // A revision rejection proves no graph receipt or process was committed.
          const { state } = await this.assertBinding(job.input.nodeId, run); if (placedFirst) this.assertItem(state, run);
          prepared = { ...prepared, expectedRevision: state.revision };
          job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { ...job.correlation, prepared } });
        }
      }
      if (!result) throw new Error('The table kept changing while starting this review. Start a new review.');
      this.store.transitionJob(job.id, 'running', 'succeeded', { result: { nodeId: run.nodeId, resourceId: run.resourceId, sessionId: result.session.id } }); return result;
    } catch (error) {
      const code = (error as { code?: string }).code, message = (error as Error).message;
      if (code === 'REVIEW_REMOVED') { this.store.transitionJob(job.id, 'running', 'cancelled', { error: message }); throw error; }
      const uncertain = this.controller.signal.aborted || code === 'LAUNCH_UNCERTAIN';
      this.store.transitionJob(job.id, 'running', uncertain ? 'outcome-unknown' : 'failed', { error: message });
      if (!uncertain) await this.patch(run.nodeId, 'failed', message).catch(() => {});
      throw error;
    }
  }
  private assertItem(state: Awaited<ReturnType<WorkspaceControl['read']>>, run: FrozenRun) {
    const node = state.nodes.find(node => node.id === run.nodeId);
    if (!node || isOffMap(node, state.nodes)) throw removed();
  }
  /** Places the review item on first use, then reports preparation progress on it. A
   * placed item that is gone, archived or in the Undermap stops the review. */
  private async show(job: JobRecord, run: FrozenRun, phase: ReviewPhase) {
    const data = { sourceConnectionId: run.source.connectionId ?? '', provider: run.provider, model: run.model, sourcePrId: job.input.nodeId, headSha: run.source.comparison.headSha, baseTipSha: run.source.comparison.baseTipSha,
      launchMode: 'review', reviewJobId: job.id, phase, preparingSince: run.startedAt ?? job.updatedAt };
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.control.read(), node = state.nodes.find(node => node.id === run.nodeId);
      if (node ? isOffMap(node, state.nodes) : job.correlation.placed === true || job.input.arguments.reviewNodeId) throw removed();
      const later = run.loop?.from ? run.loop : undefined;
      const commands: WorkspaceCommand[] = node ? [{ type: 'item.update', id: run.nodeId, data }] : [
        { type: 'item.create', id: run.nodeId, projectId: run.projectId, position: run.position, resource: { id: run.resourceId, schemaVersion: 1, pluginId: 'code.review', title: `${providerName(run.provider)} review · #${run.source.comparison.number}${later ? ` · round ${later.round}` : ''}`, data } },
        { type: 'link.save', link: { id: randomUUID(), sourceId: later?.from ?? job.input.nodeId, targetId: run.nodeId, kind: 'reference', label: later ? `Round ${later.round}` : 'Review' } }];
      commands.push({ type: 'node.update', id: run.nodeId, activity: 'working', attention: 'none', summary: phaseSummary(phase, run.provider) });
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'reviews' }, commands }); await this.changed(); return; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new Error('The table kept changing while preparing this review. Start a new review.');
  }
  /** Changes the phase of an item that has not launched yet; launched items are left alone. */
  private async patch(nodeId: string, phase: ReviewPhase, error?: string) {
    const message = error?.slice(0, 500);
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
      if (!node || resource?.pluginId !== 'code.review' || !resource.data.phase) return;
      const data = { ...resource.data }, failed = phase === 'failed'; delete data.error;
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'reviews' }, commands: [
          { type: 'item.update', id: nodeId, data: { ...data, phase, ...(failed ? { error: message ?? 'Review preparation failed.' } : {}) } },
          { type: 'node.update', id: nodeId, activity: failed ? 'unknown' : 'working', attention: failed ? 'error' : 'none', ...(failed ? { attentionNote: 'Review setup failed' } : {}), summary: phaseSummary(phase, resource.data.provider, message) }] });
        await this.changed(); return;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  /** Restarts a failed preparation on the same review item under a new request. */
  async retry(nodeId: string, input: unknown, track: (work: () => Promise<unknown>) => Promise<unknown>) {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(input);
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || resource?.pluginId !== 'code.review') throw new Error('This item is not a code review.');
    const source = state.nodes.find(candidate => candidate.id === resource.data.sourcePrId);
    const args = { requestId, model: String(resource.data.model), sourceResourceId: source?.resourceId, reviewNodeId: nodeId }, provider = resource.data.provider as ReviewProvider;
    if (this.store.listJobs().some(job => job.requestKey === `review:${requestId}`)) return this.start(String(resource.data.sourcePrId), provider, args, track);
    // A finished review whose output could not be read as findings runs again on its item.
    const findings = resource.data.findings as { sessionId?: unknown; format?: unknown } | undefined;
    const asText = !resource.data.phase && findings?.format === 'text' && findings.sessionId === resource.data.sessionId && node.activity !== 'working';
    if (resource.data.phase !== 'failed' && !asText) throw new Error('This review is not waiting for a retry.');
    if (isOffMap(node, state.nodes)) throw new Error('Bring this review back to the map before retrying it.');
    if (!source?.resourceId || isArchived(source, state.nodes)) throw new Error('The pull request for this review is no longer on the map. Start a new review from it.');
    if (asText) {
      const data: Record<string, unknown> = { ...resource.data, phase: 'queued', preparingSince: new Date().toISOString() }; delete data.findings;
      await this.control.dispatch({ commandId: `${requestId}:retry`, expectedRevision: state.revision, actor: { kind: 'user', id: 'reviews' }, commands: [
        { type: 'item.update', id: nodeId, data }, { type: 'node.update', id: nodeId, activity: 'working', attention: 'none', summary: phaseSummary('queued', resource.data.provider) }] });
      await this.changed();
    } else await this.patch(nodeId, 'queued');
    return this.start(source.id, provider, args, track);
  }
  async restore(nodeId: string, requestId: string): Promise<SessionSnapshot> {
    z.string().uuid().parse(requestId);
    const state = await this.control.read(), resource = state.resources.find(resource => resource.id === state.nodes.find(node => node.id === nodeId)?.resourceId);
    if (!resource || typeof resource.data.reviewJobId !== 'string') throw new Error('No saved review run for this item');
    const job = this.store.getJob(resource.data.reviewJobId), original = typeof job?.correlation.processId === 'string' ? readReviewProcess(this.directory, job.correlation.processId) : undefined;
    if (!original || original.input.nodeId !== nodeId) throw new Error('Review launch snapshot is unavailable');
    const running = (await this.sessions.runtime.call<SessionRecord[]>('sessions.list')).find(session => session.nodeId === nodeId && ['running', 'starting'].includes(session.state));
    if (running) return this.sessions.runtime.call('sessions.read', { sessionId: running.id });
    const folder = join(this.directory, 'review-resumes'); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `${requestId}.json`);
    let prepared: PreparedSession;
    try { prepared = JSON.parse(readFileSync(file, 'utf8')); if (prepared.nodeId !== nodeId) throw new Error('Review restart ID was reused for another item'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const process = prepareReviewProcess(this.directory, { ...original.input, requestId, predecessorId: String(resource.data.sessionId) });
      prepared = { requestId, expectedRevision: state.revision, nodeId, action: 'review.resume', launch: process.launch,
        commands: [{ type: 'item.update', id: nodeId, data: { ...resource.data, sessionId: requestId } }] };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      writeFileSync(file + '.tmp', JSON.stringify(prepared), { mode: 0o600 }); renameSync(file + '.tmp', file);
      try { return await this.sessions.launchPrepared(prepared); }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; prepared = { ...prepared, expectedRevision: (await this.control.read()).revision }; }
    }
    throw new Error('The table kept changing while restarting the review');
  }
  async recover() {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    for (const job of this.store.listJobs().filter(job => job.input.action === 'review.prepare' && ['queued', 'outcome-unknown'].includes(job.state))) {
      if (this.controller.signal.aborted) return;
      if (this.pending.has(job.id)) continue;
      await this.run(job.input.nodeId, job.input.arguments.provider as ReviewProvider, job.input.arguments).catch(() => {});
    }
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.pending.values(), this.preparing]); }
}
