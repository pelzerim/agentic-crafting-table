import { randomUUID } from 'node:crypto';
import { completionAttention } from '../core/completion-attention.ts';
import * as z from 'zod/v4';
import { canonical } from '../core/control.ts';
import type { WorkspaceControl, WorkspaceCommand, CommandEnvelope } from '../core/control.ts';
import type { SqliteStore, JobRecord } from './sqlite-store.ts';
import type { WorkflowSource, WorkflowBinding } from '../provider-runtime/workflow-sources.ts';
import type { WorkflowPreflight, WorkflowProgress, WorkflowCandidate } from '../provider-runtime/github-workflow.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { inBackground } from '../provider-runtime/request-budget.ts';

const request = z.object({ requestId: z.string().uuid(), sourceResourceId: z.string().min(1).optional() });
const terminal = (job: JobRecord) => ['succeeded', 'failed', 'cancelled'].includes(job.state);
/** A binding journaled before contracts were frozen with it matches on everything else. */
const sameBinding = (a: WorkflowBinding, b: WorkflowBinding) => canonical({ ...a, contract: a.contract ?? b.contract }) === canonical({ ...b, contract: b.contract ?? a.contract });
const ACTION = 'review.workflow';
interface Journal {
  pluginId: string; sourceResourceId: string; binding: WorkflowBinding;
  nodeId: string; resourceId: string; linkId: string; projectId?: string; position: { x: number; y: number };
  create?: CommandEnvelope; itemCreated?: boolean; preflight?: WorkflowPreflight;
  attemptedAt?: string; triggerId?: number; deadline?: number; candidates?: number[]; candidateDetails?: WorkflowCandidate[];
  progress?: WorkflowProgress; nextAt?: number; failures?: number; aliasOf?: string;
}
export class WorkflowReviewCoordinator {
  private store: SqliteStore; private control: WorkspaceControl; private sources: Record<string, WorkflowSource>;
  private changed: () => Promise<void>; private enabled: () => boolean; private now: () => number;
  private paused = true; private timer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private reserving: Promise<unknown> = Promise.resolve();
  constructor(store: SqliteStore, control: WorkspaceControl, sources: Record<string, WorkflowSource>, changed: () => Promise<void>, enabled = () => true, now = Date.now) {
    this.store = store; this.control = control; this.sources = sources; this.changed = changed; this.enabled = enabled; this.now = now;
  }
  private journal(job: JobRecord) { return job.correlation as unknown as Journal; }
  private save(job: JobRecord, patch: Partial<Journal>, state = job.state, error?: string) {
    return this.store.transitionJob(job.id, job.state, state, { correlation: { ...job.correlation, ...patch }, ...(error !== undefined ? { error } : {}) });
  }
  private async source(nodeId: string) {
    const state = await this.control.read(), node = state.nodes.find(n => n.id === nodeId), resource = state.resources.find(r => r.id === node?.resourceId);
    if (!node || !resource || isArchived(node, state.nodes)) throw new Error('Open an available pull request to request a workflow review.');
    if (!this.sources[resource.pluginId]) throw new Error('Workflow reviews are unavailable for this provider.');
    const binding = this.sources[resource.pluginId].freeze(resource); return { state, node, resource, binding };
  }
  async options(nodeId: string) {
    try { const { resource, binding } = await this.source(nodeId); return await this.sources[resource.pluginId].client(binding).capability(binding.identity, AbortSignal.timeout(60_000)); }
    catch (error) { return { supported: false, reason: (error as Error).message }; }
  }
  async start(nodeId: string, input: unknown) {
    if (this.paused || !this.enabled()) throw new Error('Reopen the workspace before requesting a workflow review.');
    const args = request.parse(input);
    const reservation = this.reserving.then(async () => {
      const requestKey = `workflow:${args.requestId}`, previous = this.store.listJobs().find(j => j.requestKey === requestKey);
      const jobInput = { action: ACTION, nodeId, arguments: args };
      if (previous) {
        if (canonical(previous.input) !== canonical(jobInput)) throw new Error('Workflow request ID was reused with different input.');
        return previous;
      }
      const { node, resource, binding } = await this.source(nodeId);
      if (args.sourceResourceId && args.sourceResourceId !== resource.id) throw new Error('The source PR no longer matches this workflow request. Reopen the PR and start a new review.');
      const active = this.store.listJobs().find(j => j.input.action === ACTION && !terminal(j) && !this.journal(j).aliasOf && sameBinding(this.journal(j).binding, binding));
      let job = this.store.enqueueJob(requestKey, jobInput);
      const journal: Journal = active ? { ...this.journal(active), aliasOf: active.id }
        : { pluginId: resource.pluginId, sourceResourceId: resource.id, binding, nodeId: randomUUID(), resourceId: randomUUID(), linkId: randomUUID(), projectId: node.projectId, position: { x: node.position.x + 280, y: node.position.y } };
      job = this.save(job, journal, 'running');
      return this.save(job, {}, 'waiting');
    });
    this.reserving = reservation.catch(() => {});
    const job = await reservation; this.schedule(0);
    return { requestId: args.requestId, nodeId: this.journal(job).itemCreated ? this.journal(job).nodeId : undefined };
  }
  async status(nodeId: string, requestId?: string) {
    const state = await this.control.read(), resourceId = state.nodes.find(n => n.id === nodeId)?.resourceId;
    return this.store.listJobs().filter(job => job.input.action === ACTION && (this.journal(job).nodeId === nodeId ? !this.journal(job).aliasOf : job.input.nodeId === nodeId || (!!resourceId && this.journal(job).sourceResourceId === resourceId)) && (!requestId || job.input.arguments.requestId === requestId)).slice(-50).map(job => {
      const alias = this.journal(job).aliasOf, resolved = alias ? this.store.getJob(alias) ?? job : job, journal = this.journal(resolved);
      return { requestId: job.input.arguments.requestId as string, jobId: resolved.id, nodeId: journal.itemCreated ? journal.nodeId : undefined,
        ...journal.progress, report: journal.nodeId === nodeId ? journal.progress?.report : undefined, state: resolved.state, status: resolved.state === 'outcome-unknown' ? 'needs-confirmation' : resolved.state === 'cancelled' ? 'cancelled' : resolved.state === 'failed' ? (['failed', 'timed-out', 'ambiguous'].includes(journal.progress?.status ?? '') ? journal.progress!.status : 'failed') : journal.progress?.status ?? 'preparing',
        error: resolved.error, tracking: journal.preflight?.tracking, triggerId: journal.triggerId, candidates: journal.candidates ?? [], candidateDetails: journal.candidateDetails ?? [], nextAt: journal.nextAt,
        repository: journal.binding ? `${journal.binding.identity.owner}/${journal.binding.identity.repo}` : '', prNumber: journal.binding?.identity.number ?? 0 };
    });
  }
  resume() { this.paused = false; this.schedule(0); }
  private schedule(delay = 1000) {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref();
  }
  async pause() {
    this.paused = true; clearTimeout(this.timer); await this.reserving;
    for (const pending of this.pending.values()) pending.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(p => p.promise));
  }
  async tick() {
    if (this.paused || !this.enabled()) return;
    for (const job of this.store.listJobs().filter(j => j.input.action === ACTION && !terminal(j) && !this.journal(j).aliasOf)) {
      if (this.paused || !this.enabled()) break;
      if ((this.journal(job).nextAt ?? 0) <= this.now()) await inBackground(() => this.poll(job.id));
    }
  }
  private poll(id: string): Promise<void> {
    const previous = this.pending.get(id); if (previous) return previous.promise;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const promise = this.advance(id, signal).finally(() => this.pending.delete(id)); this.pending.set(id, { controller, promise }); return promise;
  }
  private async assertSource(job: JobRecord) {
    const journal = this.journal(job), current = await this.source(job.input.nodeId);
    if (current.resource.id !== journal.sourceResourceId || !sameBinding(current.binding, journal.binding)) throw new Error('The source PR or account changed before posting. Start a new request.');
  }
  private async ensureItem(job: JobRecord) {
    let journal = this.journal(job);
    if (journal.itemCreated) return job;
    if (!journal.create) {
      const state = await this.control.read();
      const commands: WorkspaceCommand[] = [{ type: 'item.create', id: journal.nodeId, projectId: journal.projectId, position: journal.position,
        resource: { id: journal.resourceId, pluginId: 'github.review-run', schemaVersion: 1, title: `Workflow review · #${journal.binding.identity.number}`,
          data: { requestId: String(job.input.arguments.requestId), sourcePrId: job.input.nodeId, repository: `${journal.binding.identity.owner}/${journal.binding.identity.repo}` } } },
      { type: 'link.save', link: { id: journal.linkId, sourceId: job.input.nodeId, targetId: journal.nodeId, kind: 'reference', label: 'Workflow review' } }];
      const create: CommandEnvelope = { commandId: `workflow-item:${job.id}`, expectedRevision: state.revision, actor: { kind: 'provider', id: 'workflow-review' }, commands };
      job = this.save(job, { create }); journal = this.journal(job);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await this.control.dispatch(journal.create!); return this.save(job, { itemCreated: true }); }
      catch (error) {
        if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error;
        job = this.save(job, { create: { ...journal.create!, expectedRevision: (await this.control.read()).revision } }); journal = this.journal(job);
      }
    }
    throw new Error('The workspace is busy; retry workflow preparation.');
  }
  private async advance(id: string, signal: AbortSignal) {
    let job = this.store.getJob(id)!; let posting = false;
    if (terminal(job)) return;
    if (!this.journal(job).binding) {
      if (job.state === 'queued') job = this.save(job, {}, 'running');
      this.save(job, {}, 'failed', 'Preparation was interrupted before capturing the request. Nothing was posted.');
      await this.changed(); return;
    }
    try {
      let journal = this.journal(job);
      const source = this.sources[journal.pluginId]; if (!source) throw new Error('This workflow provider is unavailable.');
      const client = source.client(journal.binding);
      if (job.state === 'outcome-unknown' && !journal.attemptedAt) job = this.store.transitionJob(id, job.state, 'queued', { correlation: { reconciledAbsent: true } });
      if (job.state === 'queued') { job = this.save(job, {}, 'running'); job = this.save(job, {}, 'waiting'); }
      if (journal.triggerId && job.state === 'outcome-unknown') job = this.save(job, {}, 'waiting');
      if (journal.attemptedAt && !journal.triggerId) {
        if (job.state !== 'outcome-unknown') job = this.save(job, {}, 'outcome-unknown');
        const candidateDetails = await client.candidateDetails(journal.binding.identity, journal.preflight!, journal.attemptedAt, signal);
        job = this.save(job, { candidateDetails, candidates: candidateDetails.map(candidate => candidate.id), nextAt: this.now() + 30_000 }, 'outcome-unknown', 'The comment may have been posted. Select its trigger explicitly, or confirm no trigger was posted.');
      } else if (!journal.triggerId) {
        await this.assertSource(job);
        const preflight = await client.preflight(journal.binding.identity, signal); signal.throwIfAborted();
        if (preflight.author !== journal.binding.account) throw new Error('The authenticated GitHub account changed.');
        job = await this.ensureItem(job); await this.assertSource(job); signal.throwIfAborted();
        const attemptedAt = new Date(this.now()).toISOString();
        // The durable journal is committed before the only external side effect.
        job = this.save(job, { preflight, attemptedAt, deadline: this.now() + 60 * 60_000, progress: { status: 'queued' } }, 'running');
        posting = true;
        const triggerId = await client.post(journal.binding.identity, preflight.author, signal);
        posting = false;
        job = this.save(job, { triggerId, nextAt: this.now() + 2000 }, 'waiting');
      } else {
        job = this.save(job, {}, 'running');
        const progress = await client.observe(journal.binding.identity, journal.triggerId, journal.attemptedAt!, signal, journal.progress, this.now() >= journal.deadline!, journal.preflight!.workflowId, journal.preflight!.tracking);
        signal.throwIfAborted();
        const next = progress.status === 'complete' ? 'succeeded' : progress.status === 'cancelled' ? 'cancelled' : ['failed', 'timed-out', 'ambiguous'].includes(progress.status) ? 'failed' : 'waiting';
        job = this.save(job, { progress: { ...journal.progress, ...progress }, nextAt: this.now() + (progress.status === 'not-observed' ? 5000 : 15_000), failures: 0 }, next,
          next === 'failed' ? progress.reason ?? (progress.status === 'timed-out' ? 'The review did not produce a report before its deadline.' : 'The workflow review failed.') : undefined);
      }
    } catch (failure) {
      job = this.store.getJob(id)!; if (terminal(job)) return;
      const journal = this.journal(job), error = failure as Error & { code?: string; retryAt?: number };
      if (journal.attemptedAt && !journal.triggerId) {
        const uncertain = !posting || error.code === 'GITHUB_POST_UNCERTAIN' || signal.aborted || !['GITHUB_AUTH', 'GITHUB_FORBIDDEN', 'GITHUB_NOT_FOUND', 'GITHUB_RATE_LIMIT'].includes(error.code ?? '');
        job = this.save(job, { nextAt: this.now() + 5000 }, uncertain ? 'outcome-unknown' : 'failed', uncertain ? 'The comment outcome is unknown. Reconcile it before requesting another review.' : error.message);
      } else if (journal.triggerId) {
        const failures = (journal.failures ?? 0) + 1, deadline = this.now() >= journal.deadline!;
        job = this.save(job, { failures, nextAt: Math.max(this.now() + Math.min(120_000, 5000 * 2 ** Math.min(failures, 5)), error.retryAt ?? 0) }, deadline ? 'failed' : 'waiting', deadline ? 'The workflow watch deadline expired while its provider was unavailable.' : error.message);
      } else if (signal.aborted) {
        // No POST attempt journal exists, so preparation may safely resume.
        job = this.save(job, { nextAt: this.now() + 1000 }, 'waiting');
      } else job = this.save(job, {}, 'failed', error.message);
    }
    await this.project(job); await this.changed();
  }
  private async project(job: JobRecord) {
    const journal = this.journal(job); if (!journal.itemCreated) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.control.read(), node = state.nodes.find(n => n.id === journal.nodeId && n.resourceId === journal.resourceId); if (!node) return;
      const attention = ['failed', 'outcome-unknown'].includes(job.state) ? 'error' : undefined;
      const activity = job.state === 'succeeded' ? 'complete' : terminal(job) || job.state === 'outcome-unknown' ? 'idle' : 'working';
      const summary = job.state === 'outcome-unknown' ? 'Confirm the /review trigger' : job.state === 'failed' ? job.error ?? 'Workflow review failed' : job.state === 'cancelled' ? 'Stopped watching' : journal.progress?.status === 'complete' ? 'Review ready' : journal.triggerId ? 'Watching /review' : 'Preparing /review';
      const finished = job.state === 'succeeded' ? completionAttention(node, `workflow:${job.id}`, 'Workflow review ready') : [];
      const note = job.state === 'outcome-unknown' ? 'Confirm the /review trigger' : attention ? 'Workflow review failed' : undefined;
      if (node.summary === summary && node.activity === activity && node.attentionSources?.workflow === attention && node.attentionNotes?.workflow === note && !finished.length) return;
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'workflow-review' }, commands: [
        { type: 'node.update', id: node.id, activity, summary: summary.slice(0, 4000) }, { type: 'attention.set', id: node.id, source: 'workflow', reason: attention ?? null, ...(note ? { note } : {}) },
        ...finished,
      ] }); return; } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  private target(nodeId: string, requestId: string) {
    const job = this.store.listJobs().find(job => job.input.action === ACTION && (job.input.nodeId === nodeId || this.journal(job).nodeId === nodeId) && job.input.arguments.requestId === requestId);
    if (!job) throw new Error('Workflow request not found.'); return this.journal(job).aliasOf ? this.store.getJob(this.journal(job).aliasOf!)! : job;
  }
  async reconcile(nodeId: string, input: unknown) {
    const args = request.extend({ triggerId: z.number().int().positive().safe().nullable() }).parse(input);
    if (this.paused || !this.enabled()) throw new Error('Reopen the workspace before reconciling a workflow.');
    let job = this.target(nodeId, args.requestId);
    this.pending.get(job.id)?.controller.abort(); await this.pending.get(job.id)?.promise;
    job = this.store.getJob(job.id)!; const journal = this.journal(job);
    if (job.state !== 'outcome-unknown' || journal.triggerId) throw new Error('This request is not awaiting trigger confirmation.');
    if (args.triggerId === null) job = this.save(job, {}, 'cancelled', 'User confirmed no trigger. A new request requires a deliberate new action.');
    else {
      const candidates = await this.sources[journal.pluginId].client(journal.binding).candidates(journal.binding.identity, journal.preflight!, journal.attemptedAt!, AbortSignal.timeout(90_000));
      if (!candidates.includes(args.triggerId)) throw new Error('That comment is not an eligible trigger for this request.');
      job = this.save(job, { triggerId: args.triggerId, candidates: [], candidateDetails: [], nextAt: this.now(), progress: { status: 'queued' } }, 'waiting', '');
    }
    await this.project(job); await this.changed(); this.schedule(0); return this.status(nodeId, args.requestId);
  }
  async stop(nodeId: string, input: unknown) {
    const args = request.parse(input); let job = this.target(nodeId, args.requestId);
    this.pending.get(job.id)?.controller.abort(); await this.pending.get(job.id)?.promise; job = this.store.getJob(job.id)!;
    if (job.state === 'outcome-unknown') throw new Error('Confirm the unknown trigger before abandoning this request.');
    if (!terminal(job)) { job = this.save(job, {}, 'cancelled', 'Stopped local watching. Any GitHub workflow may still be running.'); await this.project(job); await this.changed(); }
    return this.status(nodeId, args.requestId);
  }
  async recover() {
    for (const job of this.store.listJobs().filter(j => j.input.action === ACTION && !this.journal(j).aliasOf)) await this.project(job);
    this.resume();
  }
}
