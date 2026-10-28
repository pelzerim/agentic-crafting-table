import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import type { WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { PluginStorage } from '../plugin-sdk/host.ts';
import type { PullMergeReadiness } from '../provider-runtime/github.ts';
import type { RolloutObservation } from '../provider-runtime/github-rollout.ts';
import { rolloutDiscoveryKey } from '../provider-runtime/github-status.ts';
import { FROM_TABLE, promptAgent } from './agent-prompt.ts';
import type { HostedAgents } from './agents.ts';
import { discoveredLinkId, stableUuid } from './resources.ts';
import type { ResourceCoordinator } from './resources.ts';
import { agentReadiness, autoValidatingPulls, connectedAgents } from './rollout-validation.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import { clip } from '../../src/pull-requests/review-findings.ts';
import { titleTag } from '../../src/resource-plugins/items/github-pull-request/show-ship.ts';
import type { JsonObject, JsonValue } from '../../src/resource-plugins/types.ts';
import { armRecord, autoDeployEvents, decide, FIX_ATTEMPTS, observe, phaseTrack, recordKey, seedCatchUp, settle, statusLine, takeoverRefusal, trackNext } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import type { AutoDeployDecision, AutoDeployFacts, AutoDeployRecord, CatchUp, PullFacts, RolloutFacts } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import { rolloutFactsOf } from '../../src/resource-plugins/items/github-rollout/rollout-facts.ts';
import type { ListedEvent, ListedValidation } from '../../src/resource-plugins/items/github-rollout/rollout-facts.ts';
import { stageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import type { StageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import { VALIDATION_AGENT } from '../../src/resource-plugins/items/github-rollout/validation.ts';

/** The plugin storage collection holding one record per pull request resource. */
export const AUTO_DEPLOY_COLLECTION = 'auto-deploy';
/** Whether Auto deploy is armed on a pull request, from its stored record. */
export const autoDeployArmed = (storage: Pick<PluginStorage, 'get'>, pullResourceId: string) => (storage.get(AUTO_DEPLOY_COLLECTION, pullResourceId)?.value as { state?: unknown } | undefined)?.state === 'armed';
/** `from: 'here'` takes over rollouts already running (from a rollout, or a merged pull request's), with `catchUp` for what already deployed. */
export const autoDeployInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('set'), value: z.enum(['arm', 'stop']), sourceResourceId: z.string().min(1), requestId: z.string().uuid(), from: z.literal('here').optional(), catchUp: z.enum(['validate', 'accept']).optional() }).strict(),
]);
const ATTENTION = 'auto-deploy';
const STOP = { id: 'stop', label: 'Stop auto deploy', description: 'Nothing further is tagged, merged or approved. A write already sent is not undone.' };
const TAKEOVER_STEPS = 'Validates every phase of this rollout and approves the next one only after a pass. Any doubt halts.';
const clock = (at: number) => { const date = new Date(at); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
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
    if (!node || !resource || isOffMap(node, state.nodes)) throw new Error('Open a pull request or a rollout on the map to deploy it automatically.');
    if (resource.pluginId === 'github.rollout') return this.runRollout(state, node, resource, args);
    if (resource.pluginId !== 'github.pull-request') throw new Error('Auto deploy starts from a pull request or a rollout.');
    const record = this.read(resource.id);
    if (args.operation === 'status') return this.view(record);
    if (args.operation === 'options') return this.choices(state, node, resource, record);
    if (args.sourceResourceId !== resource.id) throw new Error('This auto deploy belongs to another item. Reopen the menu.');
    if (args.value === 'stop') return this.view(await this.stop(record));
    if (record?.state === 'armed') return this.view(record);
    if (args.from === 'here') {
      const running = await this.runningRollouts(state, resource.id);
      if (!running.length) throw new Error('No running rollout of this pull request is on the map.');
      return this.view(await this.arm(armRecord({ id: args.requestId, pullResourceId: resource.id, pullNodeId: node.id, now: this.now(), takeover: { catchUp: args.catchUp ?? 'validate', rolloutNodeIds: running.map(entry => entry.node.id) } }), running.map(entry => entry.facts)));
    }
    return this.view(await this.arm(armRecord({ id: args.requestId, pullResourceId: resource.id, pullNodeId: node.id, now: this.now() }), []));
  }

  /** Auto deploy from a rollout: its status with the phase track, the confirm, and arming or stopping the record that follows it. */
  private async runRollout(state: WorkspaceState, node: Node, resource: WorkspaceState['resources'][number], args: z.infer<typeof autoDeployInput>) {
    const record = this.following(state, node);
    if (args.operation === 'status') return this.rolloutStatus(state, node, record);
    if (args.operation === 'options') return this.rolloutChoices(state, node, resource, record);
    if (args.sourceResourceId !== resource.id) throw new Error('This auto deploy belongs to another item. Reopen the menu.');
    if (args.value === 'stop') return this.rolloutStatus(state, node, await this.stop(record));
    if (record?.state === 'armed') return this.rolloutStatus(state, node, record);
    const facts = await this.rolloutFacts(node), refusal = takeoverRefusal(facts);
    if (refusal) throw new Error(refusal);
    const takeover = { catchUp: args.catchUp ?? 'validate', rolloutNodeIds: [node.id] }, pull = this.discoverer(state, node);
    const fresh = pull ? armRecord({ id: args.requestId, pullResourceId: pull.resourceId!, pullNodeId: pull.id, now: this.now(), takeover })
      : armRecord({ id: args.requestId, rolloutResourceId: resource.id, rolloutNodeId: node.id, now: this.now(), takeover });
    const owned = this.read(recordKey(fresh));
    if (owned?.state === 'armed') throw new Error(`Auto deploy is already armed on #${Number(state.resources.find(entry => entry.id === owned.pullResourceId)?.data.number)}. Stop it there first.`);
    return this.rolloutStatus(state, node, await this.arm(fresh, [facts]));
  }

  private async arm(record: AutoDeployRecord, rollouts: readonly RolloutFacts[]) {
    const armed = seedCatchUp(record, rollouts, this.now());
    this.save(armed); this.readAt.delete(recordKey(armed));
    await this.attention(armed); await this.options.changed(); this.observe();
    return armed;
  }
  private async stop(record: AutoDeployRecord | undefined) {
    if (record?.state !== 'armed') return record;
    const stopped: AutoDeployRecord = { ...record, state: 'stopped', step: 'stopped', updatedAt: this.now() };
    delete stopped.detail;
    this.save(stopped); await this.attention(stopped); await this.options.changed();
    return stopped;
  }

  private view(record: AutoDeployRecord | undefined) {
    if (!record) return { state: 'off' };
    return { state: record.state, step: record.step, ...(record.detail ? { detail: record.detail } : {}), line: statusLine(record), armedAt: record.armedAt, updatedAt: record.updatedAt,
      ...(record.halt ? { halt: record.halt } : {}) };
  }
  /** The record following a rollout, its pull request when one owns it, the phase track and what auto deploy did. Without an armed
   * or halted record the track is the rollout's own: its validations, its gates on GitHub and whether Auto validate covers it. */
  private async rolloutStatus(state: WorkspaceState, node: Node, record: AutoDeployRecord | undefined) {
    if (record?.state !== 'armed' && record?.state !== 'halted') {
      const track = phaseTrack(undefined, { ...await this.rolloutFacts(node), autoValidate: autoValidatingPulls(state, node.id).length > 0 });
      return { ...this.view(record), track };
    }
    const pull = record.pullResourceId ? this.pullNode(state, record) : undefined, number = Number(state.resources.find(entry => entry.id === record.pullResourceId)?.data.number);
    const track = phaseTrack(record, await this.rolloutFacts(node));
    return { ...this.view(record), ...(pull ? { pullNodeId: pull.id, pullTitle: pull.title, ...(Number.isSafeInteger(number) ? { pullNumber: number } : {}) } : {}), track, next: trackNext(track), events: autoDeployEvents(record) };
  }
  private async rolloutChoices(state: WorkspaceState, node: Node, resource: WorkspaceState['resources'][number], record: AutoDeployRecord | undefined) {
    const context = { sourceResourceId: resource.id, from: 'here' };
    if (record?.state === 'armed') {
      const number = Number(state.resources.find(entry => entry.id === record.pullResourceId)?.data.number);
      return { current: '', prompt: `Under auto deploy${record.pullResourceId && Number.isSafeInteger(number) ? ` from #${number}` : ''} · ${statusLine(record).replace(/^Auto deploy · /, '')}`, context, options: [STOP] };
    }
    const facts = await this.rolloutFacts(node), refusal = takeoverRefusal(facts), prompt = `Auto deploy ${facts.run?.number ? `run #${facts.run.number}` : 'this rollout'} from here?`;
    if (refusal) return { current: '', prompt, context, options: [{ id: 'arm', label: 'Start auto deploy', description: refusal, disabled: true }] };
    return { current: '', prompt, context, options: [{ id: 'arm', label: 'Start auto deploy', description: TAKEOVER_STEPS, confirm: { prompt, action: 'Start auto deploy', pick: this.catchUpChoices([facts]) } }] };
  }
  private async choices(state: WorkspaceState, node: Node, resource: WorkspaceState['resources'][number], record: AutoDeployRecord | undefined) {
    const context = { sourceResourceId: resource.id };
    if (record?.state === 'armed') return { current: '', prompt: statusLine(record), context, options: [STOP] };
    const pull = ((await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { merged?: boolean; state?: string; base?: { ref?: string } } } | undefined)?.pull;
    const base = pull?.base?.ref ?? 'its base branch', number = Number(resource.data.number), prompt = record ? statusLine(record) : `Deploy #${number} automatically?`;
    if (pull?.merged) {
      const running = await this.runningRollouts(state, resource.id);
      if (!running.length) return { current: '', prompt, context, options: [{ id: 'arm', label: 'Start auto deploy', description: 'Already merged.', disabled: true }] };
      const runs = running.map(entry => entry.facts.run?.number ? `run #${entry.facts.run.number}` : entry.node.title);
      const confirm = { prompt: running.length === 1 ? `Auto deploy ${runs[0]} from here?` : `Auto deploy the ${running.length} rollouts of #${number} from here?`, action: 'Start auto deploy', pick: this.catchUpChoices(running.map(entry => entry.facts)) };
      return { current: '', prompt, context: { ...context, from: 'here' }, options: [{ id: 'arm', label: running.length === 1 ? 'Auto deploy its rollout' : `Auto deploy its ${running.length} rollouts`, description: clip(runs.join(', '), 300), confirm }] };
    }
    const refusal = pull?.state === 'closed' ? 'The pull request is closed.' : undefined;
    const steps = `${this.tagging() ? 'Tags it [ship], merges' : 'Merges'} it into ${base} once ready (an agent fixes failing CI, twice at most), validates every rollout phase and approves the next one only after a pass. Any doubt halts.`;
    return { current: '', prompt, context,
      options: [{ id: 'arm', label: 'Start auto deploy', ...(refusal ? { description: refusal, disabled: true } : { description: clip(steps, 300), confirm: { prompt: clip(`Auto deploy #${number} “${node.title}”?`, 500), note: clip(steps, 300), action: 'Start auto deploy' } }) }] };
  }

  /** The two ways to treat what already deployed, each with its plan: one line per phase that ran or waits at its gate, and a foot line. */
  private catchUpChoices(rollouts: readonly RolloutFacts[]) {
    const now = this.now(), several = rollouts.length > 1;
    const option = (catchUp: CatchUp) => {
      const plan: { name: string; text: string; tone?: 'do' | 'risk' }[] = [], before: string[] = [], gates: string[] = [];
      for (const rollout of rollouts) {
        const record = seedCatchUp(armRecord({ id: 'plan', rolloutResourceId: rollout.nodeId, rolloutNodeId: rollout.nodeId, now, takeover: { catchUp, rolloutNodeIds: [rollout.nodeId] } }), [rollout], now);
        const track = phaseTrack(record, rollout), needs: string[] = [];
        let gated = false;
        for (const phase of track.phases) {
          const name = several ? `${rollout.title} · ${phase.name}` : phase.name, at = phase.at === undefined ? '' : ` ${clock(phase.at)}`;
          if (phase.noCheck) continue;
          if (phase.check?.state === 'passed') {
            const finished = rollout.validations.find(entry => entry.label === phase.check!.id)?.finishedAt;
            plan.push({ name, text: `${phase.check.id} passed${finished === undefined ? '' : ` at ${clock(finished)}`} · counts` });
          } else if (phase.state === 'done') {
            if (phase.check?.state === 'accepted') plan.push({ name, text: `deployed${at} · counts as accepted, not validated`, tone: 'risk' });
            else { plan.push({ name, text: `deployed${at} · validate now`, tone: 'do' }); needs.push(phase.name); }
          } else if (phase.state === 'running') plan.push({ name, text: 'deploying · validate once deployed', tone: 'do' });
          else if (phase.gate && phase.gate.state !== 'approved' && rollout.gates.length && !gated) {
            gated = true; gates.push(name);
            const text = phase.gate.state === 'other' ? 'waits for another approver, then validate once deployed'
              : needs.length ? `approve after ${needs.join(', ')} ${needs.length === 1 ? 'passes' : 'pass'}, then validate once deployed` : 'approve now, then validate once deployed';
            plan.push({ name, text, tone: 'do' });
          }
        }
        before.push(...needs.map(name => several ? `${rollout.title} · ${name}` : name));
      }
      const gate = gates.join(', ');
      const first = before.length ? `${before.length === 1 ? 'One validation' : `${before.length} validations`} (${before.join(', ')}) ${gate ? `before ${gate}` : 'now'}.` : gate ? `Approves ${gate} at once.` : '';
      return { plan: plan.slice(0, 20), foot: clip(`${first ? `${first} ` : ''}Validates ${gate || 'each phase'} after it deploys. Any doubt halts.`, 300) };
    };
    return { field: 'catchUp', label: 'Phases that already ran', options: [
      { id: 'validate', label: 'Validate what shipped first', note: 'Phases with no passing validation are validated before the next gate.', ...option('validate') },
      { id: 'accept', label: 'Start from the next phase', note: 'What already deployed counts as accepted; only phases that finish from now on are validated.', ...option('accept') }] };
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
      try { await this.advance(recordKey(record)); }
      catch (error) { await this.finish(this.read(recordKey(record)), { kind: 'halt', code: 'error', reason: clip(`Auto deploy stopped on an error: ${errorText(error)}`, 300) }).catch(() => {}); }
    }
  }

  /** Takes steps for one record until it has to wait. */
  private async advance(key: string) {
    for (let step = 0; step < STEPS_PER_PASS && !this.closed; step++) {
      let record = this.read(key);
      if (record?.state !== 'armed') return;
      const state = await this.options.control.read(), node = this.ownerNode(state, record);
      if (!node) { await this.finish(record, { kind: 'halt', code: 'closed', reason: record.pullResourceId ? 'The pull request is no longer on the map.' : 'The rollout is no longer on the map.' }); return; }
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
    for (const check of record.checks.filter(entry => !entry.validationId && !entry.accepted)) {
      const rollout = state.nodes.find(node => node.id === check.rolloutNodeId);
      try {
        const result = await this.options.validations.run(check.rolloutNodeId, { operation: 'trigger', sourceResourceId: rollout?.resourceId ?? '', value: check.agent ?? VALIDATION_AGENT, requestId: check.requestId, phase: { focus: check.label, jobs: check.jobs ?? [] } }) as { validationId?: unknown };
        if (typeof result?.validationId !== 'string') throw new Error('The validation was not recorded.');
        record = { ...record, checks: record.checks.map(entry => entry.key === check.key ? { ...entry, validationId: result.validationId as string } : entry) };
        this.save(record);
      } catch (error) {
        await this.finish(record, { kind: 'halt', code: 'agent-unavailable', reason: clip(`The validation of ${check.label} could not be requested: ${errorText(error)}`, 300) });
        return this.read(recordKey(record))!;
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
    for (const rollout of this.followed(state, record)) facts.rollouts.push(await this.rolloutFacts(rollout));
    return facts;
  }
  private async readiness(node: Node, record: AutoDeployRecord) {
    const saved = this.readAt.get(recordKey(record)), every = this.options.readinessEveryMs ?? 60_000;
    if (saved && this.now() - saved.at < every) return saved.value;
    const value = await this.options.resources.execute(node.id, 'pr.mergeReadiness', {}, AbortSignal.timeout(120_000)) as unknown as PullMergeReadiness;
    this.readAt.set(recordKey(record), { at: this.now(), value });
    return value;
  }
  private async rolloutFacts(node: Node): Promise<RolloutFacts> {
    const snapshot = await this.options.resources.cached(node.id).catch(() => null), observation = snapshot?.detail as unknown as RolloutObservation | undefined;
    if (!observation || !('jobs' in observation) || !observation.run) return rolloutFactsOf(node, undefined, undefined);
    const listed = await this.options.validations.run(node.id, { operation: 'list' }).catch(() => undefined) as { validations?: ListedValidation[]; events?: ListedEvent[] } | undefined;
    return rolloutFactsOf(node, observation, listed, stageRule(observation, this.options.stageRules?.() ?? []));
  }

  /** Performs one decided step and says whether the pass may take another. */
  private async act(state: WorkspaceState, node: Node, record: AutoDeployRecord, decision: Exclude<AutoDeployDecision, { kind: 'wait' | 'halt' | 'stop' | 'done' }>): Promise<boolean> {
    if (decision.kind === 'tag') return this.write(record, decision, 'tag', node.id, 'pr.showShip', { value: 'ship', expectedTitle: decision.title, sourceResourceId: record.pullResourceId! });
    if (decision.kind === 'merge') return this.write(record, decision, 'merge', node.id, 'pr.merge', { value: decision.method, pullRequestId: decision.pullRequestId, expectedHeadOid: decision.head, sourceResourceId: record.pullResourceId! });
    if (decision.kind === 'approve') {
      const options = await this.options.resources.execute(decision.rolloutNodeId, 'rollout.approval.options', {}, AbortSignal.timeout(120_000)).catch(() => undefined) as { context?: Record<string, unknown> } | undefined;
      const context = options?.context;
      if (!context || String(context.runId) !== String(decision.runId) || String(context.attempt) !== String(decision.attempt) || String(context.environmentIds) !== decision.environmentIds.join(',')) {
        await this.finish(record, { kind: 'wait', step: 'approving', detail: decision.names }); return false;
      }
      return this.write(record, decision, decision.key, decision.rolloutNodeId, 'rollout.approve', { value: 'approve', runId: String(context.runId), attempt: String(context.attempt), environmentIds: String(context.environmentIds), sourceResourceId: String(context.sourceResourceId) }, decision.names);
    }
    if (decision.kind === 'validate') return this.validate(state, record, decision);
    return this.fix(state, node, record, decision);
  }

  /** Saves the write as `sending`, sends it once through the journaled provider action and reads the journal for its outcome. */
  private async write(record: AutoDeployRecord, decision: AutoDeployDecision, key: string, nodeId: string, actionId: string, input: JsonObject, label?: string): Promise<boolean> {
    const requestId = stableUuid(`auto-deploy:${record.id}:${key}`), kind = decision.kind as 'tag' | 'merge' | 'approve';
    const sending = settle({ ...record, writes: [...record.writes, { key, kind, requestId, at: this.now(), state: 'sending', ...(label ? { label } : {}) }] }, decision, this.now());
    this.save(sending); await this.options.changed();
    let failure: unknown;
    try { await this.options.resources.execute(nodeId, actionId, { ...input, requestId }, AbortSignal.timeout(200_000)); } catch (error) { failure = error; }
    await this.options.resources.writing();
    this.readAt.delete(recordKey(record));
    const job = this.options.store.listJobs().find(entry => entry.requestKey === requestId), latest = this.read(recordKey(record)) ?? sending;
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
    return (await this.requestMissing(state, this.read(recordKey(record))!)).state === 'armed';
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
      await this.finish(this.read(recordKey(record)) ?? sending, { kind: 'halt', code: 'outcome-unknown', reason: 'The fix request to the agent could not be confirmed. Check the agent; nothing more was sent.' });
      return false;
    }
    const latest = this.read(recordKey(record)) ?? sending;
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
    const latest = this.read(recordKey(record));
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
      const state = await this.options.control.read(), node = this.ownerNode(state, record);
      if (!node) return;
      const current = node.attentionSources?.[ATTENTION] ?? null;
      if (want ? current === want.reason && node.attentionEvents?.[ATTENTION] === want.eventId : current === null) return;
      const command: WorkspaceCommand = want ? { type: 'attention.set', id: node.id, source: ATTENTION, reason: want.reason, note: want.note, eventId: want.eventId } : { type: 'attention.set', id: node.id, source: ATTENTION, reason: null };
      try { await this.options.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: ATTENTION }, commands: [command] }); return; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }

  private pullNode(state: WorkspaceState, record: Pick<AutoDeployRecord, 'pullNodeId' | 'pullResourceId'>) {
    if (!record.pullResourceId) return undefined;
    const onMap = (node: Node | undefined) => node && !isOffMap(node, state.nodes) ? node : undefined;
    return onMap(state.nodes.find(node => node.id === record.pullNodeId && node.resourceId === record.pullResourceId)) ?? state.nodes.find(node => node.resourceId === record.pullResourceId && !isOffMap(node, state.nodes));
  }
  private rolloutNode(state: WorkspaceState, record: Pick<AutoDeployRecord, 'rolloutNodeId' | 'rolloutResourceId'>) {
    if (!record.rolloutResourceId) return undefined;
    const onMap = (node: Node | undefined) => node && !isOffMap(node, state.nodes) ? node : undefined;
    return onMap(state.nodes.find(node => node.id === record.rolloutNodeId && node.resourceId === record.rolloutResourceId)) ?? state.nodes.find(node => node.resourceId === record.rolloutResourceId && !isOffMap(node, state.nodes));
  }
  /** The item a record belongs to, where its Needs me shows: the pull request, or the rollout for a rollout's own record. */
  private ownerNode(state: WorkspaceState, record: AutoDeployRecord) { return record.pullResourceId ? this.pullNode(state, record) : this.rolloutNode(state, record); }
  /** The rollouts a record follows: its own rollout; the rollouts a takeover named; else every rollout the pull request's merge discovered. */
  private followed(state: WorkspaceState, record: AutoDeployRecord) {
    if (!record.pullResourceId) { const own = this.rolloutNode(state, record); return own ? [own] : []; }
    const discovered = this.rollouts(state, record), named = record.takeover?.rolloutNodeIds;
    return named ? discovered.filter(node => named.includes(node.id)) : discovered;
  }
  /** The newest record that follows this rollout, armed ones first. */
  private following(state: WorkspaceState, node: Node) {
    const records = this.options.storage.list(AUTO_DEPLOY_COLLECTION).map(entry => entry.value as unknown as AutoDeployRecord)
      .filter(record => record.pullResourceId ? this.pullNode(state, record) && this.followed(state, record).some(rollout => rollout.id === node.id || rollout.resourceId === node.resourceId) : record.rolloutResourceId === node.resourceId);
    return records.sort((a, b) => Number(b.state === 'armed') - Number(a.state === 'armed') || b.armedAt - a.armedAt)[0];
  }
  /** The pull request on the map whose merge discovered this rollout (PR-05), if any. */
  private discoverer(state: WorkspaceState, node: Node) {
    const runId = Number(state.resources.find(entry => entry.id === node.resourceId)?.data.runId);
    if (!Number.isSafeInteger(runId)) return undefined;
    for (const link of state.links) {
      const otherId = link.sourceId === node.id ? link.targetId : link.targetId === node.id ? link.sourceId : undefined, other = state.nodes.find(entry => entry.id === otherId);
      const resource = state.resources.find(entry => entry.id === other?.resourceId);
      if (other && resource?.pluginId === 'github.pull-request' && !isOffMap(other, state.nodes) && link.id === discoveredLinkId(resource.id, rolloutDiscoveryKey(runId))) return other;
    }
    return undefined;
  }
  /** The rollouts a pull request's merge discovered that are still running, with what was read of them. */
  private async runningRollouts(state: WorkspaceState, pullResourceId: string) {
    const found: { node: Node; facts: RolloutFacts }[] = [];
    for (const node of this.rollouts(state, { pullResourceId })) {
      const facts = await this.rolloutFacts(node);
      if (!takeoverRefusal(facts)) found.push({ node, facts });
    }
    return found;
  }
  /** Rollouts the pull request's merge discovered (PR-05), on the map. */
  private rollouts(state: WorkspaceState, record: Pick<AutoDeployRecord, 'pullResourceId'>) {
    if (!record.pullResourceId) return [];
    const pullResourceId = record.pullResourceId, pulls = new Set(state.nodes.filter(node => node.resourceId === pullResourceId).map(node => node.id));
    return state.nodes.filter(node => {
      const resource = state.resources.find(entry => entry.id === node.resourceId), runId = Number(resource?.data.runId);
      if (resource?.pluginId !== 'github.rollout' || !Number.isSafeInteger(runId) || isOffMap(node, state.nodes)) return false;
      const id = discoveredLinkId(pullResourceId, rolloutDiscoveryKey(runId));
      return state.links.some(link => link.id === id && (pulls.has(link.sourceId) && link.targetId === node.id || pulls.has(link.targetId) && link.sourceId === node.id));
    });
  }
  private tagging() {
    if (this.options.tagging) return this.options.tagging();
    const own = (this.options.store.readSettings().value as { plugins?: Record<string, Record<string, unknown>> }).plugins?.['github.pull-request'];
    return own?.showShip === true;
  }
  private read(key: string) { return this.options.storage.get(AUTO_DEPLOY_COLLECTION, key)?.value as unknown as AutoDeployRecord | undefined; }
  private save(record: AutoDeployRecord) { this.options.storage.put(AUTO_DEPLOY_COLLECTION, recordKey(record), record as unknown as JsonValue); }
}
