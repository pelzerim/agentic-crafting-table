import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import type { WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { PluginStorage } from '../plugin-sdk/host.ts';
import type { PullMergeReadiness } from '../provider-runtime/github.ts';
import { approvableGates } from '../provider-runtime/github-rollout.ts';
import type { RolloutObservation } from '../provider-runtime/github-rollout.ts';
import { rolloutDiscoveryKey } from '../provider-runtime/github-status.ts';
import { FROM_TABLE, promptAgent } from './agent-prompt.ts';
import type { HostedAgents } from './agents.ts';
import { discoveredLinkId, stableUuid } from './resources.ts';
import type { ResourceCoordinator } from './resources.ts';
import { agentReadiness, connectedAgents } from './rollout-validation.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import { clip } from '../../src/pull-requests/review-findings.ts';
import { titleTag } from '../../src/resource-plugins/items/github-pull-request/show-ship.ts';
import type { JsonObject, JsonValue } from '../../src/resource-plugins/types.ts';
import { armRecord, decide, FIX_ATTEMPTS, observe, settle, statusLine } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import type { AutoDeployDecision, AutoDeployFacts, AutoDeployRecord, PullFacts, RolloutFacts } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import { stageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import type { StageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import { VALIDATION_AGENT } from '../../src/resource-plugins/items/github-rollout/validation.ts';

/** The plugin storage collection holding one record per pull request resource. */
export const AUTO_DEPLOY_COLLECTION = 'auto-deploy';
/** Whether Auto deploy is armed on a pull request, from its stored record. */
export const autoDeployArmed = (storage: Pick<PluginStorage, 'get'>, pullResourceId: string) => (storage.get(AUTO_DEPLOY_COLLECTION, pullResourceId)?.value as { state?: unknown } | undefined)?.state === 'armed';
export const autoDeployInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('set'), value: z.enum(['arm', 'stop']), sourceResourceId: z.string().min(1), requestId: z.string().uuid() }).strict(),
]);
const ATTENTION = 'auto-deploy';
/** Steps one pass takes at most for a record, so a pass that keeps acting still ends. */
const STEPS_PER_PASS = 8;

interface Validations { run(nodeId: string, input: JsonObject): Promise<unknown> }
type Resources = Pick<ResourceCoordinator, 'cached' | 'execute' | 'writing' | 'refreshPresentation'>;
type Node = WorkspaceState['nodes'][number];
export interface AutoDeployOptions {
  storage: PluginStorage; store: Pick<SqliteStore, 'listJobs' | 'readSettings' | 'agentObservation' | 'agentBackground'>; control: WorkspaceControl; resources: Resources; validations: Validations;
  sessions?: SessionCoordinator; starter?: HostedAgents; changed: () => Promise<void>; now?: () => number; allowed?: () => boolean;
  stageRules?: () => readonly StageRule[]; tagging?: () => boolean; readinessEveryMs?: number;
}

const pullUrl = (data: Record<string, unknown>) => `https://github.com/${String(data.owner)}/${String(data.repo)}/pull/${Number(data.number)}`;
const errorText = (error: unknown) => clip(String((error as Error)?.message ?? error), 300);

/** Auto deploy of pull requests: a person arms it, this service performs each step. It reads the pull request and the rollouts its
 * merge discovered, lets the pure state machine decide, and sends each write through the journaled provider actions exactly once.
 * The record is saved before every write, so a restart resumes and never sends a write again whose outcome it cannot confirm. */
export class AutoDeploys {
  private options: AutoDeployOptions; private now: () => number; private allowed: () => boolean;
  private reconciling?: Promise<void>; private again = false; private timer?: ReturnType<typeof setInterval>; private closed = false;
  private readAt = new Map<string, { at: number; value: PullMergeReadiness }>();
  constructor(options: AutoDeployOptions) { this.options = options; this.now = options.now ?? Date.now; this.allowed = options.allowed ?? (() => true); }

  async run(nodeId: string, input: unknown): Promise<unknown> {
    const args = autoDeployInput.parse(input), state = await this.options.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId);
    const resource = state.resources.find(record => record.id === node?.resourceId);
    if (!node || !resource || isOffMap(node, state.nodes)) throw new Error('Open a pull request on the map to deploy it automatically.');
    if (resource.pluginId === 'github.rollout' && args.operation === 'status') return this.rolloutStatus(state, node);
    if (resource.pluginId !== 'github.pull-request') throw new Error('Auto deploy starts from a pull request.');
    const record = this.read(resource.id);
    if (args.operation === 'status') return this.view(record);
    if (args.operation === 'options') return this.choices(node, resource, record);
    if (args.sourceResourceId !== resource.id) throw new Error('This auto deploy belongs to another item. Reopen the menu.');
    if (args.value === 'arm') {
      if (record?.state === 'armed') return this.view(record);
      const armed = armRecord({ id: args.requestId, pullResourceId: resource.id, pullNodeId: node.id, now: this.now() });
      this.save(armed); this.readAt.delete(resource.id);
      await this.attention(armed); await this.options.changed(); this.observe();
      return this.view(armed);
    }
    if (record?.state !== 'armed') return this.view(record);
    const stopped: AutoDeployRecord = { ...record, state: 'stopped', step: 'stopped', updatedAt: this.now() };
    delete stopped.detail;
    this.save(stopped); await this.attention(stopped); await this.options.changed();
    return this.view(stopped);
  }

  private view(record: AutoDeployRecord | undefined) {
    if (!record) return { state: 'off' };
    return { state: record.state, step: record.step, ...(record.detail ? { detail: record.detail } : {}), line: statusLine(record), armedAt: record.armedAt, updatedAt: record.updatedAt,
      ...(record.halt ? { halt: record.halt } : {}) };
  }
  private async rolloutStatus(state: WorkspaceState, node: Node) {
    for (const pull of this.options.storage.list(AUTO_DEPLOY_COLLECTION).map(entry => entry.value as unknown as AutoDeployRecord)) {
      const pullNode = this.pullNode(state, pull);
      if (pullNode && this.rollouts(state, pull).some(rollout => rollout.id === node.id || rollout.resourceId === node.resourceId)) return { ...this.view(pull), pullNodeId: pullNode.id, pullTitle: pullNode.title };
    }
    return { state: 'off' };
  }
  private async choices(node: Node, resource: WorkspaceState['resources'][number], record: AutoDeployRecord | undefined) {
    const context = { sourceResourceId: resource.id };
    if (record?.state === 'armed') return { current: '', prompt: statusLine(record), context, options: [{ id: 'stop', label: 'Stop auto deploy', description: 'Nothing further is tagged, merged or approved. A write already sent is not undone.' }] };
    const pull = ((await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { merged?: boolean; state?: string; base?: { ref?: string } } } | undefined)?.pull;
    const base = pull?.base?.ref ?? 'its base branch', number = Number(resource.data.number);
    const refusal = pull?.merged ? 'Already merged.' : pull?.state === 'closed' ? 'The pull request is closed.' : undefined;
    const steps = `${this.tagging() ? 'Tags it [ship], merges' : 'Merges'} it into ${base} once ready (an agent fixes failing CI, twice at most), validates every rollout phase and approves the next one only after a pass. Any doubt halts.`;
    return { current: '', prompt: record ? statusLine(record) : `Deploy #${number} automatically?`, context,
      options: [{ id: 'arm', label: 'Start auto deploy', ...(refusal ? { description: refusal, disabled: true } : { description: clip(steps, 300), confirm: { prompt: clip(`Auto deploy #${number} “${node.title}”?`, 500), note: clip(steps, 300), action: 'Start auto deploy' } }) }] };
  }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.closed = false; clearInterval(this.timer); this.timer = setInterval(() => this.observe(), 15_000); this.timer.unref?.(); this.observe(); }
  async close() { this.closed = true; clearInterval(this.timer); await this.reconciling?.catch(() => {}); }
  /** One pass over every armed auto deploy; a pass asked for while one runs runs once more after it. */
  reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = (async () => { do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.closed); })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async reconcileOnce() {
    for (const entry of this.options.storage.list(AUTO_DEPLOY_COLLECTION)) {
      const record = entry.value as unknown as AutoDeployRecord;
      if (record.state !== 'armed') continue;
      try { await this.advance(record.pullResourceId); }
      catch (error) { await this.finish(this.read(record.pullResourceId), { kind: 'halt', code: 'error', reason: clip(`Auto deploy stopped on an error: ${errorText(error)}`, 300) }).catch(() => {}); }
    }
  }

  /** Takes steps for one pull request until it has to wait. */
  private async advance(pullResourceId: string) {
    for (let step = 0; step < STEPS_PER_PASS && !this.closed; step++) {
      let record = this.read(pullResourceId);
      if (record?.state !== 'armed') return;
      const state = await this.options.control.read(), node = this.pullNode(state, record);
      if (!node) { await this.finish(record, { kind: 'halt', code: 'closed', reason: 'The pull request is no longer on the map.' }); return; }
      const resolved = this.resolveWrites(record);
      if (resolved.decision) { await this.finish(resolved.record, resolved.decision); return; }
      record = resolved.record;
      record = await this.requestMissing(state, record);
      if (record.state !== 'armed') return;
      const facts = await this.facts(state, node, record);
      record = observe(record, facts);
      const decision = decide(record, facts);
      if (decision.kind === 'wait' || decision.kind === 'halt' || decision.kind === 'stop' || decision.kind === 'done') { await this.finish(record, decision); return; }
      if (!await this.act(state, node, record, decision)) return;
    }
  }

  /** Writes left `sending` by an interrupted pass: the journal says whether they went out. Confirmed ones count as sent; declined ones halt;
   * one never journaled was never sent and is forgotten; anything else stays `sending`, which halts as outcome-unknown. */
  private resolveWrites(record: AutoDeployRecord): { record: AutoDeployRecord; decision?: AutoDeployDecision } {
    if (!record.writes.some(write => write.state === 'sending' && write.kind !== 'fix')) return { record };
    const jobs = new Map(this.options.store.listJobs().map(job => [job.requestKey, job]));
    let declined: string | undefined;
    const writes = record.writes.flatMap(write => {
      if (write.state !== 'sending' || write.kind === 'fix') return [write];
      const job = jobs.get(write.requestId);
      if (!job) return [];
      if (job.state === 'succeeded') return [{ ...write, state: 'sent' as const }];
      if (job.state === 'failed') declined ??= job.error ?? 'GitHub declined the request.';
      return [write];
    });
    const next = { ...record, writes };
    return declined ? { record: next, decision: { kind: 'halt', code: 'declined', reason: clip(declined, 300) } } : { record: next };
  }

  /** A validation recorded but not confirmed (the pass stopped in between) is asked for again with the same journaled request. */
  private async requestMissing(state: WorkspaceState, record: AutoDeployRecord) {
    for (const check of record.checks.filter(entry => !entry.validationId)) {
      const rollout = state.nodes.find(node => node.id === check.rolloutNodeId);
      try {
        const result = await this.options.validations.run(check.rolloutNodeId, { operation: 'trigger', sourceResourceId: rollout?.resourceId ?? '', value: check.agent ?? VALIDATION_AGENT, requestId: check.requestId, phase: { focus: check.label, jobs: check.jobs ?? [] } }) as { validationId?: unknown };
        if (typeof result?.validationId !== 'string') throw new Error('The validation was not recorded.');
        record = { ...record, checks: record.checks.map(entry => entry.key === check.key ? { ...entry, validationId: result.validationId as string } : entry) };
        this.save(record);
      } catch (error) {
        await this.finish(record, { kind: 'halt', code: 'agent-unavailable', reason: clip(`The validation of ${check.label} could not be requested: ${errorText(error)}`, 300) });
        return this.read(record.pullResourceId)!;
      }
    }
    return record;
  }

  private async facts(state: WorkspaceState, node: Node, record: AutoDeployRecord): Promise<AutoDeployFacts> {
    const now = this.now(), facts: AutoDeployFacts = { now, tagging: this.tagging(), rollouts: [] };
    if (record.mergedAt === undefined) {
      const readiness = await this.readiness(node, record).catch(() => undefined);
      if (readiness) {
        const detail = (await this.options.resources.cached(node.id).catch(() => null))?.detail as { failingChecks?: unknown } | undefined;
        const failing = Array.isArray(detail?.failingChecks) ? detail.failingChecks.filter((name): name is string => typeof name === 'string').slice(0, 20) : [];
        facts.pull = { ...readiness, tag: titleTag(readiness.title).tag, failing } satisfies PullFacts;
      }
      return facts;
    }
    for (const rollout of this.rollouts(state, record)) facts.rollouts.push(await this.rolloutFacts(rollout));
    return facts;
  }
  private async readiness(node: Node, record: AutoDeployRecord) {
    const saved = this.readAt.get(record.pullResourceId), every = this.options.readinessEveryMs ?? 60_000;
    if (saved && this.now() - saved.at < every) return saved.value;
    const value = await this.options.resources.execute(node.id, 'pr.mergeReadiness', {}, AbortSignal.timeout(120_000)) as unknown as PullMergeReadiness;
    this.readAt.set(record.pullResourceId, { at: this.now(), value });
    return value;
  }
  private async rolloutFacts(node: Node): Promise<RolloutFacts> {
    const snapshot = await this.options.resources.cached(node.id).catch(() => null), observation = snapshot?.detail as unknown as RolloutObservation | undefined;
    if (!observation || !('jobs' in observation) || !observation.run) return { nodeId: node.id, title: node.title, jobs: [], gates: [], validations: [] };
    const run = observation.run, approvable = new Set(approvableGates(observation).map(gate => gate.environment.id));
    const listed = await this.options.validations.run(node.id, { operation: 'list' }).catch(() => undefined) as { validations?: { label: string; state: string; verdict?: string; resolvedBy?: string }[] } | undefined;
    const rule = stageRule(observation, this.options.stageRules?.() ?? []);
    return { nodeId: node.id, title: node.title, run: { id: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion, headSha: run.head_sha }, jobs: observation.jobs,
      gates: observation.gates.map(gate => ({ id: gate.environment.id, name: gate.environment.name, approvable: approvable.has(gate.environment.id) })), ...(rule ? { rule } : {}),
      validations: (listed?.validations ?? []).map(view => ({ label: view.label, state: view.state as RolloutFacts['validations'][number]['state'], ...(view.verdict ? { verdict: view.verdict as RolloutFacts['validations'][number]['verdict'] } : {}), ...(view.resolvedBy ? { resolvedBy: view.resolvedBy } : {}) })) };
  }

  /** Performs one decided step and says whether the pass may take another. */
  private async act(state: WorkspaceState, node: Node, record: AutoDeployRecord, decision: Exclude<AutoDeployDecision, { kind: 'wait' | 'halt' | 'stop' | 'done' }>): Promise<boolean> {
    if (decision.kind === 'tag') return this.write(record, decision, 'tag', node.id, 'pr.showShip', { value: 'ship', expectedTitle: decision.title, sourceResourceId: record.pullResourceId });
    if (decision.kind === 'merge') return this.write(record, decision, 'merge', node.id, 'pr.merge', { value: decision.method, pullRequestId: decision.pullRequestId, expectedHeadOid: decision.head, sourceResourceId: record.pullResourceId });
    if (decision.kind === 'approve') {
      const options = await this.options.resources.execute(decision.rolloutNodeId, 'rollout.approval.options', {}, AbortSignal.timeout(120_000)).catch(() => undefined) as { context?: Record<string, unknown> } | undefined;
      const context = options?.context;
      if (!context || String(context.runId) !== String(decision.runId) || String(context.attempt) !== String(decision.attempt) || String(context.environmentIds) !== decision.environmentIds.join(',')) {
        await this.finish(record, { kind: 'wait', step: 'approving', detail: decision.names }); return false;
      }
      return this.write(record, decision, decision.key, decision.rolloutNodeId, 'rollout.approve', { value: 'approve', runId: String(context.runId), attempt: String(context.attempt), environmentIds: String(context.environmentIds), sourceResourceId: String(context.sourceResourceId) });
    }
    if (decision.kind === 'validate') return this.validate(state, record, decision);
    return this.fix(state, node, record, decision);
  }

  /** Saves the write as `sending`, sends it once through the journaled provider action and reads the journal for its outcome. */
  private async write(record: AutoDeployRecord, decision: AutoDeployDecision, key: string, nodeId: string, actionId: string, input: JsonObject): Promise<boolean> {
    const requestId = stableUuid(`auto-deploy:${record.id}:${key}`), kind = decision.kind as 'tag' | 'merge' | 'approve';
    const sending = settle({ ...record, writes: [...record.writes, { key, kind, requestId, at: this.now(), state: 'sending' }] }, decision, this.now());
    this.save(sending); await this.options.changed();
    let failure: unknown;
    try { await this.options.resources.execute(nodeId, actionId, { ...input, requestId }, AbortSignal.timeout(200_000)); } catch (error) { failure = error; }
    await this.options.resources.writing();
    this.readAt.delete(record.pullResourceId);
    const job = this.options.store.listJobs().find(entry => entry.requestKey === requestId), latest = this.read(record.pullResourceId) ?? sending;
    if (job?.state === 'succeeded') { this.save({ ...latest, writes: latest.writes.map(write => write.key === key ? { ...write, state: 'sent' } : write) }); return latest.state === 'armed'; }
    if (!job || job.state === 'failed') {
      const forgotten = { ...latest, writes: latest.writes.filter(write => write.key !== key) };
      await this.finish(forgotten, { kind: 'halt', code: 'declined', reason: clip(job?.error ?? errorText(failure), 300) }); return false;
    }
    await this.finish(latest, decide(latest, { now: this.now(), tagging: false, rollouts: [] })); return false;
  }

  /** Asks for the validation of one phase from the rollout's own validation agent: its idle hidden agent again, else one started
   * hidden. The request is recorded before it is sent. */
  private async validate(state: WorkspaceState, record: AutoDeployRecord, decision: Extract<AutoDeployDecision, { kind: 'validate' }>) {
    const rollout = state.nodes.find(node => node.id === decision.rolloutNodeId)!;
    const check = { key: decision.key, rolloutNodeId: rollout.id, label: decision.label, requestId: stableUuid(`auto-deploy:${record.id}:validate:${decision.key}`), agent: VALIDATION_AGENT, requestedAt: this.now(), jobs: decision.jobs };
    this.save(settle({ ...record, checks: [...record.checks, check] }, decision, this.now())); await this.options.changed();
    return (await this.requestMissing(state, this.read(record.pullResourceId)!)).state === 'armed';
  }

  /** Asks an agent to fix the failing checks on the branch: the agent of the previous fix or another ready agent connected to the pull
   * request, else a new Claude session beside it. Waits while the previous fixer still works. */
  private async fix(state: WorkspaceState, node: Node, record: AutoDeployRecord, decision: Extract<AutoDeployDecision, { kind: 'fix' }>) {
    const previous = record.fixes.at(-1)?.agentNodeId, agents = await this.agentsOf(state, node.id);
    const agent = agents.find(entry => entry.ready && entry.nodeId === previous) ?? agents.find(entry => entry.ready);
    if (!agent && agents.some(entry => entry.nodeId === previous && entry.status === 'working')) { await this.finish(record, { kind: 'wait', step: 'fixing-ci', detail: `${record.fixes.length}/${FIX_ATTEMPTS}` }); return false; }
    const starter = this.options.starter;
    if (!agent) {
      const refusal = !starter ? 'No connected agent is ready to fix CI, and starting one is not available here.' : await starter.ready().then(() => undefined, error => errorText(error));
      if (refusal) { await this.finish(record, { kind: 'halt', code: 'agent-unavailable', reason: clip(`No agent can fix the failing checks: ${refusal}`, 300) }); return false; }
    }
    const resource = state.resources.find(entry => entry.id === record.pullResourceId)!, detail = (await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { head?: { ref?: unknown } } } | undefined;
    const branch = typeof detail?.pull?.head?.ref === 'string' ? detail.pull.head.ref : undefined, url = pullUrl(resource.data);
    const prompt = [`Fix the failing checks of pull request ${node.title} (${url})${branch ? ` on its branch ${branch}` : ''}, head commit ${decision.head.slice(0, 12)}.`,
      decision.failing.length ? `Failing: ${decision.failing.join(', ')}.` : 'Read the failing checks of the head commit on GitHub.',
      'Find out why they fail, fix the cause and push the fix to the same branch. Do not skip, disable or weaken checks.',
      'Do not merge, approve, retitle or close the pull request: auto deploy does that once the new commit\'s checks pass.',
      'Say in one line what you changed once it is pushed.'].join('\n');
    const seed = `auto-deploy:${record.id}:fix:${decision.attempt}`, agentNodeId = agent?.nodeId ?? stableUuid(`${seed}:node`);
    const sending = settle({ ...record, fixes: [...record.fixes, { head: decision.head, at: this.now(), agentNodeId }], writes: [...record.writes, { key: `fix:${decision.attempt}`, kind: 'fix', requestId: stableUuid(seed), at: this.now(), state: 'sending' }] }, decision, this.now());
    this.save(sending); await this.options.changed();
    try {
      if (agent) await promptAgent(this.options.sessions!, agent.sessionId, `${FROM_TABLE} Fix the failing checks the pasted request describes:`, prompt);
      else {
        const folder = state.nodes.find(candidate => candidate.id === node.projectId && !candidate.resourceId)?.workingDirectory;
        const request: ResourceCreate = { requestId: stableUuid(`${seed}:session`), nodeId: agentNodeId, resourceId: stableUuid(`${seed}:resource`), pluginId: 'agent.session', title: clip(`Fix CI · ${node.title}`, 120),
          ...(node.projectId ? { projectId: node.projectId } : {}), placedBy: node.id, connections: [{ id: stableUuid(`${seed}:link`), otherId: node.id, kind: 'context', sourceIsNew: false }],
          data: { provider: 'claude', cwd: folder || starter!.fallbackDirectory() } };
        await starter!.launch(request, { prompt, data: { autoDeploy: { pullNodeId: node.id, attempt: decision.attempt } } });
      }
    } catch {
      await this.finish(this.read(record.pullResourceId) ?? sending, { kind: 'halt', code: 'outcome-unknown', reason: 'The fix request to the agent could not be confirmed. Check the agent; nothing more was sent.' });
      return false;
    }
    const latest = this.read(record.pullResourceId) ?? sending;
    this.save({ ...latest, writes: latest.writes.map(write => write.key === `fix:${decision.attempt}` ? { ...write, state: 'sent' } : write) });
    return false;
  }

  private async agentsOf(state: WorkspaceState, nodeId: string) {
    return Promise.all(connectedAgents(state, nodeId).map(async agent => {
      const status = await agentReadiness(this.options.sessions, state, agent, sessionId => this.options.store.agentObservation(sessionId), this.now, sessionId => this.options.store.agentBackground(sessionId));
      return { ...agent, status, ready: status === 'idle' };
    }));
  }
  /** Saves the record after a decision that ends the step, and keeps the pull request's Needs me in line with it. */
  private async finish(record: AutoDeployRecord | undefined, decision: AutoDeployDecision) {
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
  private async attention(record: AutoDeployRecord) {
    const want = record.state === 'halted' ? { reason: 'error' as const, note: 'Auto deploy halted', eventId: `${record.id}:halted` }
      : record.state === 'done' ? { reason: 'finished' as const, note: 'Auto deploy done', eventId: `${record.id}:done` } : undefined;
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

  private pullNode(state: WorkspaceState, record: Pick<AutoDeployRecord, 'pullNodeId' | 'pullResourceId'>) {
    const onMap = (node: Node | undefined) => node && !isOffMap(node, state.nodes) ? node : undefined;
    return onMap(state.nodes.find(node => node.id === record.pullNodeId && node.resourceId === record.pullResourceId)) ?? state.nodes.find(node => node.resourceId === record.pullResourceId && !isOffMap(node, state.nodes));
  }
  /** Rollouts the pull request's merge discovered (PR-05), on the map. */
  private rollouts(state: WorkspaceState, record: Pick<AutoDeployRecord, 'pullResourceId'>) {
    const pulls = new Set(state.nodes.filter(node => node.resourceId === record.pullResourceId).map(node => node.id));
    return state.nodes.filter(node => {
      const resource = state.resources.find(entry => entry.id === node.resourceId), runId = Number(resource?.data.runId);
      if (resource?.pluginId !== 'github.rollout' || !Number.isSafeInteger(runId) || isOffMap(node, state.nodes)) return false;
      const id = discoveredLinkId(record.pullResourceId, rolloutDiscoveryKey(runId));
      return state.links.some(link => link.id === id && (pulls.has(link.sourceId) && link.targetId === node.id || pulls.has(link.targetId) && link.sourceId === node.id));
    });
  }
  private tagging() {
    if (this.options.tagging) return this.options.tagging();
    const own = (this.options.store.readSettings().value as { plugins?: Record<string, Record<string, unknown>> }).plugins?.['github.pull-request'];
    return own?.showShip === true;
  }
  private read(pullResourceId: string) { return this.options.storage.get(AUTO_DEPLOY_COLLECTION, pullResourceId)?.value as unknown as AutoDeployRecord | undefined; }
  private save(record: AutoDeployRecord) { this.options.storage.put(AUTO_DEPLOY_COLLECTION, record.pullResourceId, record as unknown as JsonValue); }
}
