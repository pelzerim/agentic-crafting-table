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
import { derivedId } from './review-findings.ts';
import type { ResourceCoordinator } from './resources.ts';
import { agentReadiness, autoValidatingPulls, connectedAgents } from './rollout-validation.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import { clip } from '../../src/pull-requests/review-findings.ts';
import { titleTag } from '../../src/resource-plugins/items/github-pull-request/show-ship.ts';
import type { JsonObject, JsonValue } from '../../src/resource-plugins/types.ts';
import { armRecord, autoDeployEvents, decide, declined, FIX_ATTEMPTS, observe, PHASE_LABEL, REBASE_ATTEMPTS, phaseTrack, recordKey, seedCatchUp, settle, statusLine, takeoverRefusal, trackNext } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import type { AutoDeployDecision, AutoDeployFacts, AutoDeployRecord, CatchUp, FindingSendFacts, LinkedReviewFacts, PullFacts, RolloutFacts } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import type { FindingStatus, ReviewFindings } from '../../src/pull-requests/review-findings.ts';
import { rolloutFactsOf } from '../../src/resource-plugins/items/github-rollout/rollout-facts.ts';
import type { ListedEvent, ListedValidation } from '../../src/resource-plugins/items/github-rollout/rollout-facts.ts';
import { stageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import type { StageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import { VALIDATION_AGENT } from '../../src/resource-plugins/items/github-rollout/validation.ts';

/** The plugin storage collection holding one record per pull request resource. */
export const AUTO_DEPLOY_COLLECTION = 'auto-deploy';
const ROLLOUT_ATTENTION = 'provider:github.rollout';
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
/** The review findings operation (`review.findings`) on a review item. */
interface Findings { run(nodeId: string, input: JsonObject): Promise<unknown> }
interface ListedFindings { state: 'running' | 'complete' | 'failed'; reviewSessionId: string; format?: 'findings' | 'text'; review?: ReviewFindings; statuses: Record<string, FindingStatus>; ignored: string[] }
type Resources = Pick<ResourceCoordinator, 'cached' | 'execute' | 'writing' | 'refreshPresentation'>;
type Node = WorkspaceState['nodes'][number];
export interface AutoDeployOptions {
  storage: PluginStorage; store: Pick<SqliteStore, 'listJobs' | 'readSettings' | 'agentObservation' | 'agentBackground' | 'reviewSend' | 'rolloutValidations'>; control: WorkspaceControl; resources: Resources; validations: Validations;
  /** Sends blocking review findings to the fixer; absent, a review with blocking findings halts. */
  findings?: Findings;
  sessions?: SessionCoordinator; starter?: HostedAgents; changed: () => Promise<void>; now?: () => number; allowed?: () => boolean;
  stageRules?: () => readonly StageRule[]; tagging?: () => boolean; readinessEveryMs?: number;
}

const pullUrl = (data: Record<string, unknown>) => `https://github.com/${String(data.owner)}/${String(data.repo)}/pull/${Number(data.number)}`;
const errorText = (error: unknown) => clip(String((error as Error)?.message ?? error), 300);
const HALT_REASON = 300;
/** Why a validation could not be requested, within a halt reason's length: the error is kept whole and the phase label is
 * shortened instead, since a phase gated on many jobs names them all. */
export function validationRequestFailure(label: string, error: string) {
  const tail = ` could not be requested: ${clip(error, 200)}`, room = HALT_REASON - 'The validation of '.length - tail.length;
  return `The validation of ${clip(label, Math.max(room, 20))}${tail}`;
}

/** Auto deploy of pull requests: a person arms it, this service performs each step. It reads the pull request and the rollouts its
 * merge discovered, lets the pure state machine decide, and sends each write through the journaled provider actions exactly once.
 * The record is saved before every write, so a restart resumes and never sends a write again whose outcome it cannot confirm. */
export class AutoDeploys {
  private options: AutoDeployOptions; private now: () => number; private allowed: () => boolean;
  private reconciling?: Promise<void>; private again = false; private timer?: ReturnType<typeof setInterval>; private closed = false;
  private readAt = new Map<string, { at: number; value: PullMergeReadiness }>();
  private unfilter?: () => void;
  constructor(options: AutoDeployOptions) { this.options = options; this.now = options.now ?? Date.now; this.allowed = options.allowed ?? (() => true); this.unfilter = options.control.filter((state, commands) => this.quiet(state, commands)); }

  /** While armed, what it takes care of alerts nobody: a followed rollout finishing or waiting at a gate, and an agent validating one of them
   * finishing a turn. The event is spent without an alert, so it is not raised again once auto deploy ends. Concerns, failures, a halt and
   * “Auto deploy done” still alert. */
  quiet(state: WorkspaceState, commands: readonly WorkspaceCommand[]): readonly WorkspaceCommand[] {
    const muffled = (command: WorkspaceCommand) => command.type === 'attention.set' && (command.source === ROLLOUT_ATTENTION ? command.reason === 'finished' || command.reason === 'input' : command.source === 'completion' && command.reason === 'finished');
    if (!commands.some(muffled)) return commands;
    const armed = this.options.storage.list(AUTO_DEPLOY_COLLECTION).map(entry => entry.value as unknown as AutoDeployRecord).filter(record => record.state === 'armed');
    if (!armed.length) return commands;
    const rollouts = new Set<string>(), agents = new Set<string>();
    for (const record of armed) for (const rollout of this.followed(state, record)) {
      if (!rollout.resourceId) continue;
      rollouts.add(rollout.resourceId);
      for (const validation of this.options.store.rolloutValidations({ rolloutResourceId: rollout.resourceId }))
        if (validation.requestedAt >= record.armedAt || record.checks.some(check => check.validationId === `V${validation.ordinal}`)) agents.add(validation.agentNodeId);
    }
    const resourceOf = (id: string) => state.nodes.find(node => node.id === id)?.resourceId;
    const agentResources = new Set([...agents].map(resourceOf).filter(Boolean));
    return commands.map(command => {
      if (command.type !== 'attention.set' || !muffled(command)) return command;
      const resourceId = resourceOf(command.id);
      const ours = command.source === ROLLOUT_ATTENTION ? Boolean(resourceId && rollouts.has(resourceId)) : agents.has(command.id) || Boolean(resourceId && agentResources.has(resourceId));
      return ours ? { type: 'attention.set', id: command.id, source: command.source, reason: null, ...(command.eventId ? { eventId: command.eventId } : {}) } : command;
    });
  }

  async run(nodeId: string, input: unknown): Promise<unknown> {
    const args = autoDeployInput.parse(input), state = await this.options.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId);
    const resource = state.resources.find(record => record.id === node?.resourceId);
    if (!node || !resource || isOffMap(node, state.nodes)) throw new Error('Open a pull request or a rollout on the map to deploy it automatically.');
    if (resource.pluginId === 'github.rollout') return this.runRollout(state, node, resource, args);
    if (resource.pluginId !== 'github.pull-request') throw new Error('Auto deploy starts from a pull request or a rollout.');
    const record = this.read(resource.id);
    if (args.operation === 'status') return { ...this.view(record), ...(record ? { events: await this.events(state, record) } : {}) };
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
      return { ...this.view(record), track, ...(record?.state === 'done' ? { events: await this.events(state, record) } : {}) };
    }
    const pull = record.pullResourceId ? this.pullNode(state, record) : undefined, number = Number(state.resources.find(entry => entry.id === record.pullResourceId)?.data.number);
    const track = phaseTrack(record, await this.rolloutFacts(node));
    return { ...this.view(record), ...(pull ? { pullNodeId: pull.id, pullTitle: pull.title, ...(Number.isSafeInteger(number) ? { pullNumber: number } : {}) } : {}), track, next: trackNext(track), events: await this.events(state, record) };
  }
  /** What auto deploy did, with links to what each action touched (an agent, a review, a commit) and, for an action on a rollout,
   * the run it belongs to (“On run #1842”). */
  private async events(state: WorkspaceState, record: AutoDeployRecord) {
    const pull = state.resources.find(entry => entry.id === record.pullResourceId)?.data, repository = pull ? `https://github.com/${String(pull.owner)}/${String(pull.repo)}` : undefined;
    const item = (nodeId: string | undefined) => { const node = state.nodes.find(entry => entry.id === nodeId); return node?.resourceId && !isOffMap(node, state.nodes) ? { label: node.title, resourceId: node.resourceId } : undefined; };
    const runs = new Map<string, { label: string; resourceId?: string }>();
    const run = async (nodeId: string) => {
      if (!runs.has(nodeId)) {
        const node = state.nodes.find(entry => entry.id === nodeId), observation = (await this.options.resources.cached(nodeId).catch(() => null))?.detail as { run?: { run_number?: unknown } } | undefined;
        const number = Number(observation?.run?.run_number);
        runs.set(nodeId, { label: Number.isSafeInteger(number) && number > 0 ? `On run #${number}` : `On ${node?.title ?? 'the rollout'}`, ...(node?.resourceId ? { resourceId: node.resourceId } : {}) });
      }
      return runs.get(nodeId)!;
    };
    let rollout = this.followed(state, record)[0]?.id ?? record.checks[0]?.rolloutNodeId;
    const events = [];
    for (const event of autoDeployEvents(record)) {
      const links = [item(event.agentNodeId), item(event.reviewNodeId), event.commit && repository ? { label: event.commit.slice(0, 7), url: `${repository}/commit/${event.commit}` } : undefined].filter(Boolean);
      if (event.rolloutNodeId) rollout = event.rolloutNodeId;
      const group = event.part === 'rollout' && rollout ? await run(rollout) : undefined;
      events.push({ ...event, ...(links.length ? { links } : {}), ...(group ? { group } : {}) });
    }
    return events;
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
    const pull = ((await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { merged?: boolean; draft?: boolean; state?: string; base?: { ref?: string } } } | undefined)?.pull;
    const base = pull?.base?.ref ?? 'its base branch', number = Number(resource.data.number), prompt = record ? statusLine(record) : `Deploy #${number} automatically?`;
    if (pull?.merged) {
      const running = await this.runningRollouts(state, resource.id);
      if (!running.length) return { current: '', prompt, context, options: [{ id: 'arm', label: 'Start auto deploy', description: 'Already merged.', disabled: true }] };
      const runs = running.map(entry => entry.facts.run?.number ? `run #${entry.facts.run.number}` : entry.node.title);
      const confirm = { prompt: running.length === 1 ? `Auto deploy ${runs[0]} from here?` : `Auto deploy the ${running.length} rollouts of #${number} from here?`, action: 'Start auto deploy', pick: this.catchUpChoices(running.map(entry => entry.facts)) };
      return { current: '', prompt, context: { ...context, from: 'here' }, options: [{ id: 'arm', label: running.length === 1 ? 'Auto deploy its rollout' : `Auto deploy its ${running.length} rollouts`, description: clip(runs.join(', '), 300), confirm }] };
    }
    const refusal = pull?.state === 'closed' ? 'The pull request is closed.' : undefined;
    const first = [pull?.draft ? 'marks it ready for review' : '', this.tagging() ? 'tags it [ship]' : '', 'rebases it'].filter(Boolean).join(', ');
    const steps = `${first.charAt(0).toUpperCase()}${first.slice(1)} onto ${base} when needed, has an agent fix blocking Claude review findings and failing CI, merges it into ${base} once ready, validates every rollout phase and approves the next one only after a pass. Any doubt halts.`;
    return { current: '', prompt, context,
      options: [{ id: 'arm', label: 'Start auto deploy', ...(refusal ? { description: refusal, disabled: true } : { description: clip(steps, 300), confirm: { prompt: clip(`Auto deploy #${number} “${node.title}”?`, 500), note: clip(steps, 300), action: 'Start auto deploy' } }) }] };
  }

  /** The two ways to treat what already deployed, each with its plan: one line per phase that ran or waits at its gate, and a foot line. */
  private catchUpChoices(rollouts: readonly RolloutFacts[]) {
    const now = this.now(), several = rollouts.length > 1;
    const option = (catchUp: CatchUp) => {
      const plan: { name: string; text: string; tone?: 'do' | 'risk' }[] = [], before: string[] = [], waits: string[] = [], gates: string[] = [];
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
          } else if (phase.state === 'done' && phase.check?.state === 'running' && phase.check.id) {
            plan.push({ name, text: `${phase.check.id} validating · counts once it passes`, tone: 'do' }); needs.push(phase.name);
            waits.push(`${phase.check.id} (${name})`);
          } else if (phase.state === 'done') {
            if (phase.check?.state === 'accepted') plan.push({ name, text: `deployed${at} · counts as accepted, not validated`, tone: 'risk' });
            else { plan.push({ name, text: `deployed${at} · validate now`, tone: 'do' }); needs.push(phase.name); before.push(name); }
          } else if (phase.state === 'running') plan.push({ name, text: 'deploying · validate once deployed', tone: 'do' });
          else if (phase.gate && phase.gate.state !== 'approved' && rollout.gates.length && !gated) {
            gated = true; gates.push(name);
            const text = phase.gate.state === 'other' ? 'waits for another approver, then validate once deployed'
              : needs.length ? `approve after ${needs.join(', ')} ${needs.length === 1 ? 'passes' : 'pass'}, then validate once deployed` : 'approve now, then validate once deployed';
            plan.push({ name, text, tone: 'do' });
          }
        }
      }
      const gate = gates.join(', ');
      const fresh = before.length ? `${before.length === 1 ? 'one validation' : `${before.length} validations`} (${before.join(', ')})` : '';
      const ahead = [waits.length ? `waits for ${waits.join(', ')}` : '', fresh].filter(Boolean).join(' and ');
      const first = ahead ? `${ahead.charAt(0).toUpperCase()}${ahead.slice(1)} ${gate ? `before ${gate}` : fresh ? 'now' : 'first'}.` : gate ? `Approves ${gate} at once.` : '';
      return { plan: plan.slice(0, 20), foot: clip(`${first ? `${first} ` : ''}Validates ${gate || 'each phase'} after it deploys. Any doubt halts.`, 300) };
    };
    return { field: 'catchUp', label: 'Phases that already ran', options: [
      { id: 'validate', label: 'Validate what shipped first', note: 'Phases with no passing validation are validated before the next gate.', ...option('validate') },
      { id: 'accept', label: 'Start from the next phase', note: 'What already deployed counts as accepted; only phases that finish from now on are validated.', ...option('accept') }] };
  }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.unfilter ??= this.options.control.filter((state, commands) => this.quiet(state, commands)); this.closed = false; clearInterval(this.timer); this.timer = setInterval(() => this.observe(), 15_000); this.timer.unref?.(); this.observe(); }
  async close() { this.unfilter?.(); this.unfilter = undefined; this.closed = true; clearInterval(this.timer); await this.reconciling?.catch(() => {}); }
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
    const pending = (write: AutoDeployRecord['writes'][number]) => write.state === 'sending' && write.kind !== 'fix' && write.kind !== 'rebase';
    if (!record.writes.some(pending)) return { record };
    const jobs = new Map(this.options.store.listJobs().map(job => [job.requestKey, job]));
    let refusal: AutoDeployDecision | undefined;
    const writes = record.writes.flatMap(write => {
      if (!pending(write)) return [write];
      if (write.kind === 'findings') return this.options.store.reviewSend(write.requestId) ? [{ ...write, state: 'sent' as const }] : [];
      const job = jobs.get(write.requestId);
      if (!job) return [];
      if (job.state === 'succeeded') return [{ ...write, state: 'sent' as const }];
      if (job.state === 'failed') refusal ??= declined(write.kind, job.error ?? 'GitHub declined the request.');
      return [write];
    });
    const next = { ...record, writes };
    return refusal ? { record: next, decision: refusal } : { record: next };
  }

  /** A validation recorded but not confirmed (the pass stopped in between) is asked for again with the same journaled request. */
  private async requestMissing(state: WorkspaceState, record: AutoDeployRecord) {
    for (const check of record.checks.filter(entry => !entry.validationId && !entry.accepted)) {
      const rollout = state.nodes.find(node => node.id === check.rolloutNodeId);
      try {
        const result = await this.options.validations.run(check.rolloutNodeId, { operation: 'trigger', sourceResourceId: rollout?.resourceId ?? '', value: check.agent ?? VALIDATION_AGENT, requestId: check.requestId, phase: { focus: clip(check.label, PHASE_LABEL), jobs: check.jobs ?? [] } }) as { validationId?: unknown };
        if (typeof result?.validationId !== 'string') throw new Error('The validation was not recorded.');
        record = { ...record, checks: record.checks.map(entry => entry.key === check.key ? { ...entry, validationId: result.validationId as string } : entry) };
        this.save(record);
      } catch (error) {
        console.error(`Auto deploy could not request the validation of ${check.label}: ${String((error as Error)?.message ?? error)}`);
        await this.finish(record, { kind: 'halt', code: 'agent-unavailable', reason: validationRequestFailure(check.label, errorText(error)) });
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
        Object.assign(facts, await this.reviewFacts(state, node, record));
      }
      return facts;
    }
    for (const rollout of this.followed(state, record)) facts.rollouts.push(await this.rolloutFacts(rollout));
    return facts;
  }
  /** The newest review linked to the pull request that is running or finished with findings, and the last findings send as its
   * journal and the review's statuses have it. */
  private async reviewFacts(state: WorkspaceState, node: Node, record: AutoDeployRecord): Promise<{ review?: LinkedReviewFacts; send?: FindingSendFacts }> {
    const findings = this.options.findings, found: { review?: LinkedReviewFacts; send?: FindingSendFacts } = {};
    if (!findings) return found;
    const list = (nodeId: string) => findings.run(nodeId, { operation: 'list' }).then(value => value as ListedFindings, () => undefined);
    const linked = state.nodes.filter(entry => !isOffMap(entry, state.nodes) && state.resources.some(resource => resource.id === entry.resourceId && resource.pluginId === 'code.review' && resource.data.sourcePrId === node.id));
    for (const entry of linked.reverse()) {
      const listed = await list(entry.id), provider = state.resources.find(resource => resource.id === entry.resourceId)?.data.provider === 'codex' ? 'Codex' : 'Claude';
      if (!listed || listed.state === 'failed' || listed.state === 'complete' && listed.format !== 'findings') continue;
      found.review = { nodeId: entry.id, title: `${provider} review`, state: listed.state === 'running' ? 'running' : 'findings', findings: (listed.review?.findings ?? []).map(finding => ({ id: finding.id, kind: finding.kind, ...(finding.severity ? { severity: finding.severity } : {}),
        title: finding.title, ...(finding.locations[0] ? { path: finding.locations[0].path } : {}), status: listed.statuses[finding.id] ?? 'open', ignored: listed.ignored.includes(finding.id) })) };
      break;
    }
    const last = record.findingSends?.at(-1);
    if (last && !last.pushed) {
      const send = this.options.store.reviewSend(last.sendId), listed = await list(last.reviewNodeId), statuses = listed?.statuses ?? {};
      const titles = Object.fromEntries((listed?.review?.findings ?? []).filter(finding => last.findingIds.includes(finding.id)).map(finding => [finding.id, finding.title]));
      found.send = { state: send?.state ?? 'missing', ...(send?.error ? { error: send.error } : {}), reported: last.findingIds.filter(id => statuses[id] === 'fixed'), titles };
    }
    return found;
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
    if (decision.kind === 'ready') return this.write(record, decision, 'ready', node.id, 'pr.state', { value: 'ready', expectedState: 'draft', pullRequestId: decision.pullRequestId, sourceResourceId: record.pullResourceId! });
    if (decision.kind === 'tag') return this.write(record, decision, 'tag', node.id, 'pr.showShip', { value: 'ship', expectedTitle: decision.title, sourceResourceId: record.pullResourceId! });
    if (decision.kind === 'update') {
      const rebases = [...record.rebases ?? [], { head: decision.head, base: decision.baseHead, at: this.now(), mode: 'update' as const }];
      return this.write({ ...record, rebases }, decision, `update:${decision.baseHead}`, node.id, 'pr.updateBranch', { pullRequestId: decision.pullRequestId, expectedHeadOid: decision.head, sourceResourceId: record.pullResourceId! });
    }
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
    if (decision.kind === 'send-findings') return this.sendFindings(state, node, record, decision);
    return this.ask(state, node, record, decision);
  }

  /** Saves the write as `sending`, sends it once through the journaled provider action and reads the journal for its outcome. */
  private async write(record: AutoDeployRecord, decision: AutoDeployDecision, key: string, nodeId: string, actionId: string, input: JsonObject, label?: string): Promise<boolean> {
    const requestId = stableUuid(`auto-deploy:${record.id}:${key}`), kind = decision.kind as 'ready' | 'tag' | 'update' | 'merge' | 'approve';
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
      await this.finish(forgotten, declined(kind, job?.error ?? errorText(failure))); return false;
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

  /** Asks an agent to fix the failing checks on the branch, or to rebase it onto its base and resolve the conflicts: the agent of the
   * previous request or another ready agent connected to the pull request, else a new Claude session beside it. Waits while the
   * previous agent still works. */
  private async ask(state: WorkspaceState, node: Node, record: AutoDeployRecord, decision: Extract<AutoDeployDecision, { kind: 'fix' | 'rebase' }>) {
    const rebase = decision.kind === 'rebase', previous = this.previousAgent(record), agents = await this.agentsOf(state, node.id);
    const agent = agents.find(entry => entry.ready && entry.nodeId === previous) ?? agents.find(entry => entry.ready);
    const waiting: AutoDeployDecision = rebase ? { kind: 'wait', step: 'rebasing', detail: `${decision.base} (${decision.attempt}/${REBASE_ATTEMPTS})` } : { kind: 'wait', step: 'fixing-ci', detail: `${record.fixes.length}/${FIX_ATTEMPTS}` };
    if (!agent && agents.some(entry => entry.nodeId === previous && entry.status === 'working')) { await this.finish(record, waiting); return false; }
    const starter = this.options.starter;
    if (!agent) {
      const refusal = !starter ? `No connected agent is ready to ${rebase ? 'rebase the branch' : 'fix CI'}, and starting one is not available here.` : await starter.ready().then(() => undefined, error => errorText(error));
      if (refusal) { await this.finish(record, { kind: 'halt', code: 'agent-unavailable', reason: clip(`No agent can ${rebase ? 'rebase the branch' : 'fix the failing checks'}: ${refusal}`, 300) }); return false; }
    }
    const resource = state.resources.find(entry => entry.id === record.pullResourceId)!, branch = await this.branch(node), url = pullUrl(resource.data);
    const prompt = rebase ? [`Rebase the branch ${branch ?? 'of the pull request'} of pull request ${node.title} (${url}) onto the current head of ${decision.base}: it has merge conflicts with ${decision.base}. Its head commit is ${decision.head.slice(0, 12)}.`,
      `Fetch ${decision.base}, rebase the branch onto it and resolve every conflict, keeping what both sides meant. Run the checks you can run locally.`,
      'Push the rebased branch with --force-with-lease to the same branch.',
      'Do not merge, approve, retitle or close the pull request: auto deploy does that once the branch is on its base and its checks pass.',
      'Say in one line what you resolved once it is pushed.'].join('\n')
      : [`Fix the failing checks of pull request ${node.title} (${url})${branch ? ` on its branch ${branch}` : ''}, head commit ${decision.head.slice(0, 12)}.`,
        decision.failing.length ? `Failing: ${decision.failing.join(', ')}.` : 'Read the failing checks of the head commit on GitHub.',
        'Find out why they fail, fix the cause and push the fix to the same branch. Do not skip, disable or weaken checks.',
        'Do not merge, approve, retitle or close the pull request: auto deploy does that once the new commit\'s checks pass.',
        'Say in one line what you changed once it is pushed.'].join('\n');
    const seed = `auto-deploy:${record.id}:${decision.kind}:${decision.attempt}`, agentNodeId = agent?.nodeId ?? stableUuid(`${seed}:node`), title = clip(`${rebase ? 'Rebase' : 'Fix CI'} · ${node.title}`, 120);
    const agentTitle = agent?.title ?? title, key = `${decision.kind}:${decision.attempt}`, write = { key, kind: decision.kind, requestId: stableUuid(seed), at: this.now(), state: 'sending' as const };
    const entry = rebase ? { rebases: [...record.rebases ?? [], { head: decision.head, base: decision.base, at: this.now(), agentNodeId, agentTitle, mode: 'agent' as const }] }
      : { fixes: [...record.fixes, { head: decision.head, at: this.now(), agentNodeId, agentTitle }] };
    const sending = settle({ ...record, ...entry, writes: [...record.writes, write] }, decision, this.now());
    if (rebase) sending.detail = `${sending.detail} · ${agentTitle}`;
    this.save(sending); await this.options.changed();
    try {
      if (agent) await promptAgent(this.options.sessions!, agent.sessionId, `${FROM_TABLE} ${rebase ? 'Rebase the branch' : 'Fix the failing checks'} the pasted request describes:`, prompt);
      else {
        const folder = state.nodes.find(candidate => candidate.id === node.projectId && !candidate.resourceId)?.workingDirectory;
        const request: ResourceCreate = { requestId: stableUuid(`${seed}:session`), nodeId: agentNodeId, resourceId: stableUuid(`${seed}:resource`), pluginId: 'agent.session', title,
          ...(node.projectId ? { projectId: node.projectId } : {}), placedBy: node.id, connections: [{ id: stableUuid(`${seed}:link`), otherId: node.id, kind: 'context', sourceIsNew: false }],
          data: { provider: 'claude', cwd: folder || starter!.fallbackDirectory() } };
        await starter!.launch(request, { prompt, data: { autoDeploy: { pullNodeId: node.id, attempt: decision.attempt, ...(rebase ? { rebase: true } : {}) } } });
      }
    } catch {
      await this.finish(this.read(recordKey(record)) ?? sending, { kind: 'halt', code: 'outcome-unknown', reason: `The ${rebase ? 'rebase' : 'fix'} request to the agent could not be confirmed. Check the agent; nothing more was sent.` });
      return false;
    }
    const latest = this.read(recordKey(record)) ?? sending;
    this.save({ ...latest, writes: latest.writes.map(entry => entry.key === key ? { ...entry, state: 'sent' } : entry) });
    return false;
  }

  /** Sends the blocking findings of a review to the fixer through the findings send path, under a send id derived from the record and
   * the review, so a send interrupted by a restart goes out again under the same id and is never delivered twice. The fixer is a
   * ready agent connected to the pull request (the previous one first), else a new Claude agent beside the review. */
  private async sendFindings(state: WorkspaceState, node: Node, record: AutoDeployRecord, decision: Extract<AutoDeployDecision, { kind: 'send-findings' }>) {
    const findings = this.options.findings;
    if (!findings) { await this.finish(record, { kind: 'halt', code: 'agent-unavailable', reason: 'The review has blocking findings, and they cannot be sent to an agent from this workspace.' }); return false; }
    const seed = `auto-deploy:${record.id}:findings:${decision.reviewNodeId}`, spawnId = stableUuid(`${seed}:agent`), existing = record.findingSends?.find(entry => entry.reviewNodeId === decision.reviewNodeId);
    let agentNodeId = existing?.agentNodeId, agentTitle = existing?.agentTitle;
    if (!existing) {
      const previous = this.previousAgent(record), agents = await this.agentsOf(state, node.id), agent = agents.find(entry => entry.ready && entry.nodeId === previous) ?? agents.find(entry => entry.ready);
      agentNodeId = agent?.nodeId ?? derivedId(spawnId, 'node'); agentTitle = agent?.title;
    }
    const spawn = agentNodeId === derivedId(spawnId, 'node'), sendId = existing?.sendId ?? stableUuid(seed), key = `findings:${decision.reviewNodeId}`;
    const listed = await findings.run(decision.reviewNodeId, { operation: 'list' }) as ListedFindings;
    const send = { reviewNodeId: decision.reviewNodeId, reviewTitle: decision.reviewTitle, sendId, findingIds: decision.findingIds, head: decision.head, at: this.now(), ...(agentNodeId ? { agentNodeId } : {}), ...(agentTitle ? { agentTitle } : {}),
      counts: decision.counts, ...(record.reviewLeft ? { left: record.reviewLeft } : {}) };
    const sending = settle({ ...record, findingSends: existing ? record.findingSends : [...record.findingSends ?? [], send],
      writes: [...record.writes.filter(write => write.key !== key), { key, kind: 'findings', requestId: sendId, at: existing?.at ?? this.now(), state: 'sending' }] }, decision, this.now());
    if (agentTitle) sending.detail = `${agentTitle} is fixing ${decision.findingIds.length} finding${decision.findingIds.length === 1 ? '' : 's'}`;
    this.save(sending); await this.options.changed();
    const resource = state.resources.find(entry => entry.id === record.pullResourceId)!, branch = await this.branch(node);
    const note = clip(`Auto deploy merges pull request ${node.title} (${pullUrl(resource.data)}) once its checks pass. Push the fixes to its branch${branch ? ` ${branch}` : ''}, then report them fixed. Do not merge, approve or close the pull request.`, 2000);
    try {
      if (!spawn) {
        const offered = await findings.run(decision.reviewNodeId, { operation: 'options' }) as { agents?: { nodeId: string }[] };
        if (!offered.agents?.some(entry => entry.nodeId === agentNodeId)) await this.connect(state, record, decision.reviewNodeId, agentNodeId!);
      }
      await findings.run(decision.reviewNodeId, spawn ? { operation: 'spawn', requestId: spawnId, sendId, reviewSessionId: listed.reviewSessionId, findingIds: decision.findingIds, provider: 'claude', note }
        : { operation: 'send', requestId: sendId, reviewSessionId: listed.reviewSessionId, findingIds: decision.findingIds, agentNodeId: agentNodeId!, note });
    } catch (error) {
      if (!this.options.store.reviewSend(sendId)) { await this.finish(this.read(recordKey(record)) ?? sending, { kind: 'halt', code: 'findings-failed', reason: clip(`The findings could not be sent to ${agentTitle ?? 'a new agent'}: ${errorText(error)}`, 300) }); return false; }
    }
    const latest = this.read(recordKey(record)) ?? sending, title = spawn ? (await this.options.control.read()).nodes.find(entry => entry.id === agentNodeId)?.title : undefined;
    this.save({ ...latest, writes: latest.writes.map(write => write.key === key ? { ...write, state: 'sent' } : write),
      ...(title ? { findingSends: latest.findingSends?.map(entry => entry.sendId === sendId ? { ...entry, agentTitle: title } : entry), ...(latest.step === 'fixing-findings' ? { detail: `${title} is fixing ${decision.findingIds.length} finding${decision.findingIds.length === 1 ? '' : 's'}` } : {}) } : {}) });
    return false;
  }
  /** Links a fixer the findings path would not offer for this review to it. */
  private async connect(state: WorkspaceState, record: AutoDeployRecord, reviewNodeId: string, agentNodeId: string) {
    if (state.links.some(link => [link.sourceId, link.targetId].includes(reviewNodeId) && [link.sourceId, link.targetId].includes(agentNodeId))) return;
    await this.options.control.dispatch({ commandId: stableUuid(`auto-deploy:${record.id}:link:${reviewNodeId}`), expectedRevision: state.revision, actor: { kind: 'system', id: ATTENTION },
      commands: [{ type: 'link.save', link: { id: stableUuid(`auto-deploy:${record.id}:link:${reviewNodeId}:id`), sourceId: reviewNodeId, targetId: agentNodeId, kind: 'context', label: 'Findings' } }] });
  }
  /** The agent auto deploy asked last: for a rebase, review findings or a CI fix. */
  private previousAgent(record: AutoDeployRecord) {
    return [...record.rebases ?? [], ...record.findingSends ?? [], ...record.fixes].filter(entry => entry.agentNodeId).sort((a, b) => a.at - b.at).at(-1)?.agentNodeId;
  }
  private async branch(node: Node) {
    const detail = (await this.options.resources.cached(node.id).catch(() => null))?.detail as { pull?: { head?: { ref?: unknown } } } | undefined;
    return typeof detail?.pull?.head?.ref === 'string' ? detail.pull.head.ref : undefined;
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
