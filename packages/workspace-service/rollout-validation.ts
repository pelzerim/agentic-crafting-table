import { FROM_TABLE, promptAgent } from './agent-prompt.ts';
import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import type { WorkspaceControl, WorkspaceState, WorkspaceCommand } from '../core/control.ts';
import type { AgentObservation, SqliteStore } from './sqlite-store.ts';
import { discoveredLinkId, stableUuid } from './resources.ts';
import type { ResourceCoordinator } from './resources.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { HostedAgents } from './agents.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import { outstanding } from './agent-background.ts';
import type { BackgroundState } from './agent-background.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import type { RolloutObservation, RolloutRun, RolloutShipped } from '../provider-runtime/github-rollout.ts';
import { rolloutDiscoveryKey } from '../provider-runtime/github-status.ts';
import { autoValidates } from '../../src/resource-plugins/items/github-pull-request/header.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import { clip } from '../../src/pull-requests/review-findings.ts';
import { acceptReport, annotateValidations, ATTACH_VALIDATION, NEW_VALIDATION_AGENT, observedEvents, REUSE_MS, reportShape, VALIDATION_AGENT, VALIDATION_AGENT_LABEL, validationAttention, verdictLabels } from '../../src/resource-plugins/items/github-rollout/validation.ts';
import type { AppApproval, CheckStatus, SnapshotJob, Validation, ValidationReport, ValidationScope, Verdict } from '../../src/resource-plugins/items/github-rollout/validation.ts';
import { currentPhase } from '../../src/resource-plugins/items/github-rollout/phases.ts';
import { componentOf, dueStage, environmentStates, reachedStage, stageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import type { Component, DueStage, EnvironmentStatus, StagePlan, StageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import { VALIDATION_LINK } from './validation-link-migration.ts';

const label = z.string().regex(/^V[1-9][0-9]{0,5}$/);
export const rolloutValidationInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('trigger'), sourceResourceId: z.string().min(1), value: z.string().min(1), sessionId: z.string().min(1).optional(), requestId: z.string().uuid(), rerun: label.optional(),
    /** Scope the validation to the phase that ran since the last validation of the attempt (one click, Approve and validate). */
    phased: z.literal(true).optional(),
    phase: z.object({ focus: z.string().min(1).max(200), jobs: z.array(z.number().int().nonnegative()).max(200) }).strict().optional() }).strict(),
  z.object({ operation: z.literal('ask'), validationId: label, requestId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('show'), validationId: label }).strict(),
  z.object({ operation: z.literal('hide'), validationId: label }).strict(),
  z.object({ operation: z.literal('report'), agentNodeId: z.string().min(1).max(200), ...reportShape }).strict(),
]);
/** Operations only a person starts; agents list, read options and report through their own tool. */
export const humanRolloutValidationOperations = ['trigger', 'ask', 'show', 'hide'];
/** An agent that stays idle this long without a final report has not reported. */
/** The attention.set a validation's outcome needs on its rollout node, or nothing. An event the node already
 * records is settled, also once its alert was acknowledged and the source is gone: raising it again would be refused
 * as a replay and asked for again on the next pass, without end. */
export function validationAttentionCommand(node: { id: string; attentionSources?: Record<string, string>; attentionEvents?: Record<string, string> }, source: string,
  wanted: { reason: 'validation' | 'error' | null; note?: string; eventId?: string }): WorkspaceCommand | undefined {
  const reason = node.attentionSources?.[source] ?? null;
  const settled = wanted.reason === null ? reason === null : node.attentionEvents?.[source] === wanted.eventId;
  if (settled) return undefined;
  return { type: 'attention.set', id: node.id, source, reason: wanted.reason, ...(wanted.reason ? { note: wanted.note, eventId: wanted.eventId } : {}) };
}
export const NO_REPORT_AFTER_MS = 2 * 60_000;
/** A validation that hears nothing from its agent this long has not reported, whatever the agent seems to do: agents report progress at least every 2 minutes. */
export const NO_REPORT_DEADLINE_MS = 15 * 60_000;
/** A hidden validation agent idle this long after its validations settled is archived, which stops its session; as long as a final chat validation is reused, so a follow-up can still come. */
export const HIDDEN_AGENT_IDLE_MS = REUSE_MS;
const UNCONFIRMED = 'Delivery could not be confirmed. Check the agent before sending again.';
const NO_RUN = 'This rollout has no run to validate yet. Refresh it and try again.';
const NO_SESSIONS = 'Starting an agent is not available here: native Claude sessions are not configured.';
const NOT_STARTED = 'The new agent could not start.';
/** How long a failed Claude probe answers for the next ones. */
const UNREADY_MS = 30_000;

export type AgentStatus = 'idle' | 'working' | 'stopped';
export interface ValidationAgent { nodeId: string; title: string; sessionId: string; direct: boolean; ready: boolean; status: AgentStatus; prompt: boolean; path: { nodes: string[]; links: string[] } }
/** Whether an agent that cannot take a prompt is held at a question or dialog in its terminal. */
export const heldAtPrompt = (state: WorkspaceState, nodeId: string, status: AgentStatus) => status === 'working' && state.nodes.find(node => node.id === nodeId)?.attention === 'input';
const availability = (agent: Pick<ValidationAgent, 'status' | 'prompt'>) => agent.status === 'idle' ? 'Ready' : agent.status === 'stopped' ? 'Stopped' : agent.prompt ? 'Waiting for you to answer a prompt in its terminal' : 'Working';
const unavailable = (agent: Pick<ValidationAgent, 'status' | 'prompt'>) => agent.status === 'stopped' ? 'The agent is stopped. Resume it, then try again.'
  : agent.prompt ? 'Answer the prompt in the agent\'s terminal first.' : 'Wait until the agent is ready for a new prompt.';

type ConnectedAgent = Omit<ValidationAgent, 'ready' | 'status' | 'prompt'>;
/** Agents reachable from an item through links in either direction, with the
 * shortest connecting path. Undermap/archived items neither appear nor connect.
 * `through` limits which reached items the search continues from. */
export function connectedAgents(state: WorkspaceState, rolloutNodeId: string, through?: (nodeId: string) => boolean): ConnectedAgent[] {
  const rollout = state.nodes.find(node => node.id === rolloutNodeId);
  if (!rollout) return [];
  const onMap = new Set(state.nodes.filter(node => !isOffMap(node, state.nodes)).map(node => node.id));
  const starts = state.nodes.filter(node => onMap.has(node.id) && (node.id === rolloutNodeId || rollout.resourceId && node.resourceId === rollout.resourceId)).map(node => node.id);
  const previous = new Map<string, { node: string; link: string } | null>(starts.map(id => [id, null])), queue = [...starts];
  for (let i = 0; i < queue.length; i++) {
    if (i >= starts.length && through && !through(queue[i])) continue;
    for (const link of state.links) {
      const next = link.sourceId === queue[i] ? link.targetId : link.targetId === queue[i] ? link.sourceId : undefined;
      if (!next || previous.has(next) || !onMap.has(next)) continue;
      previous.set(next, { node: queue[i], link: link.id }); queue.push(next);
    }
  }
  const resources = new Map(state.resources.map(resource => [resource.id, resource])), seen = new Set<string>(), agents: ConnectedAgent[] = [];
  for (const id of queue) {
    const node = state.nodes.find(candidate => candidate.id === id)!, resource = resources.get(node.resourceId ?? '');
    if (resource?.pluginId !== 'agent.session' || typeof resource.data.sessionId !== 'string' || seen.has(resource.id)) continue;
    seen.add(resource.id);
    const nodes: string[] = [], links: string[] = [];
    for (let step: string | undefined = id; step; ) { nodes.unshift(step); const back = previous.get(step); if (!back) break; links.unshift(back.link); step = back.node; }
    agents.push({ nodeId: id, title: node.title, sessionId: resource.data.sessionId, direct: links.length === 1, path: { nodes, links } });
  }
  return agents;
}

/** Request id of the one automatic validation of a run attempt; a validation that carries it was not asked for by a person. */
export const automaticRequestId = (rolloutResourceId: string, scope: Pick<ValidationScope, 'runId' | 'attempt' | 'headSha'>) => stableUuid(`rollout-validation:automatic:${rolloutResourceId}:${scope.runId}:${scope.attempt}:${scope.headSha}`);
/** Request id of the automatic validation of one stage of a staged run attempt: asking twice, or again after a restart, finds it. */
export const stageRequestId = (rolloutResourceId: string, scope: Pick<ValidationScope, 'runId' | 'attempt' | 'headSha'>, stage: string) => stableUuid(`rollout-validation:stage:${rolloutResourceId}:${scope.runId}:${scope.attempt}:${scope.headSha}:${stage}`);
/** Request id of the automatic validation of one phase of a gated run attempt, named by the jobs it covers. */
export const phaseRequestId = (rolloutResourceId: string, scope: Pick<ValidationScope, 'runId' | 'attempt' | 'headSha'>, jobs: readonly number[]) => stableUuid(`rollout-validation:phase:${rolloutResourceId}:${scope.runId}:${scope.attempt}:${scope.headSha}:${jobs.join(',')}`);
/** Request id of a validation an agent reported without a request. */
export const unrequestedRequestId = (rolloutResourceId: string, ordinal: number) => stableUuid(`rollout-validation:unrequested:${rolloutResourceId}:${ordinal}`);
/** Request id of a validation an agent started by reporting without an id. */
export const chatRequestId = (rolloutResourceId: string, ordinal: number) => stableUuid(`rollout-validation:chat:${rolloutResourceId}:${ordinal}`);
type Discovery = { node: WorkspaceState['nodes'][number]; pull: WorkspaceState['resources'][number] };
/** Pull requests on the map that discovered this rollout after their merge. */
export function discoveringPulls(state: WorkspaceState, rolloutNodeId: string): Discovery[] {
  const resource = state.resources.find(record => record.id === state.nodes.find(node => node.id === rolloutNodeId)?.resourceId), runId = Number(resource?.data.runId);
  if (!resource || !Number.isSafeInteger(runId)) return [];
  const aliases = new Set(state.nodes.filter(node => node.resourceId === resource.id).map(node => node.id));
  return state.links.flatMap(link => {
    const node = state.nodes.find(candidate => candidate.id === (aliases.has(link.targetId) ? link.sourceId : aliases.has(link.sourceId) ? link.targetId : undefined));
    const pull = state.resources.find(record => record.id === node?.resourceId);
    return node && pull?.pluginId === 'github.pull-request' && !isOffMap(node, state.nodes) && link.id === discoveredLinkId(pull.id, rolloutDiscoveryKey(runId)) ? [{ node, pull }] : [];
  });
}
/** Those of them that keep Auto validate on (off is `autoValidate: false`). */
export const autoValidatingPulls = (state: WorkspaceState, rolloutNodeId: string): string[] => discoveringPulls(state, rolloutNodeId).filter(({ pull }) => autoValidates(pull)).map(({ node }) => node.id);

const pullUrl = ({ owner, repo, number }: Record<string, unknown>) => typeof owner === 'string' && typeof repo === 'string' && Number.isSafeInteger(number) ? `https://github.com/${owner}/${repo}/pull/${number}` : undefined;
/** What the table already knows about a validation, sent with the request so the agent does not derive it again. */
export interface ValidationContext {
  run: { id: number; attempt: number; commit: string; workflow: string; url?: string };
  stage?: { name: string; environment: string; finishedAt: string };
  pullRequests: { number: number; title: string; url?: string }[];
  environments: { name: string; status: EnvironmentStatus; finishedAt?: string; jobs: { id: number; name: string; status: string; conclusion: string | null }[] }[];
  previous?: { validationId: string; verdict?: Verdict; stage?: string; summary: string; checks: { id: string; title: string; status: CheckStatus; observation?: string }[]; followup?: ValidationReport['followup'] };
  component?: Component;
  merged?: { since: { run: number; commit: string; url: string }; pullRequests: { number: number; title: string; url?: string }[]; commits: number; truncated?: true };
}
const iso = (at: number) => new Date(at).toISOString();
/** The context payload: the run and its jobs per environment, the pull requests behind it, the stage this request is for,
 * the newest final report on the rollout, the component its changed files touch and every pull request merged since the
 * workflow's previous successful run, which the run deploys too. */
export function validationContext(input: { observation: RolloutObservation & { run: RolloutRun }; pulls: readonly { number: number; title: string; url?: string }[]; previous?: Validation; component?: Component; stage?: DueStage; shipped?: RolloutShipped }): ValidationContext {
  const { observation, previous, stage } = input, run = observation.run, report = previous?.report;
  return {
    run: { id: run.id, attempt: run.run_attempt, commit: run.head_sha, workflow: observation.workflow || run.name || '', ...(observation.url ? { url: observation.url } : {}) },
    ...(stage ? { stage: { name: stage.key, environment: stage.environment, finishedAt: iso(stage.finishedAt) } } : {}),
    pullRequests: input.pulls.map(pull => ({ number: pull.number, title: clip(pull.title, 200), ...(pull.url ? { url: pull.url } : {}) })),
    environments: environmentStates(observation.jobs).map(entry => ({ name: entry.name, status: entry.status, ...(entry.finishedAt === undefined ? {} : { finishedAt: iso(entry.finishedAt) }),
      jobs: entry.jobs.slice(0, 20).map(job => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion })) })),
    ...(previous ? { previous: { validationId: `V${previous.ordinal}`, ...(previous.verdict ? { verdict: previous.verdict } : {}), ...(previous.scope.stage ? { stage: previous.scope.stage } : {}), summary: report?.summary ?? '',
      checks: (report?.checks ?? []).slice(0, 12).map(check => ({ id: check.id, title: check.title, status: check.status, ...(check.observation ? { observation: clip(check.observation, 240) } : {}) })),
      ...(report?.followup ? { followup: report.followup } : {}) } } : {}),
    ...(input.component ? { component: input.component } : {}),
    ...(input.shipped?.since ? { merged: { since: { run: input.shipped.since.runId, commit: input.shipped.since.commit, url: input.shipped.since.url }, commits: input.shipped.commits, ...(input.shipped.truncated ? { truncated: true as const } : {}),
      pullRequests: input.shipped.pulls.map(pull => ({ number: pull.number, title: clip(pull.title, 200), ...(pull.url ? { url: pull.url } : {}) })) } } : {}),
  };
}

/** “is still running”, “passed 4 min ago”. */
const reuseState = (view: Validation, now: number) => view.state === 'final' && view.verdict
  ? `${verdictLabels[view.verdict].toLowerCase()} ${Math.max(0, Math.floor((now - (view.finishedAt ?? view.updatedAt)) / 60_000))} min ago` : 'is still running';
const sources = 'for example the cluster CLI, a metrics datasource or a log store';
/** What an agent is asked to do for one validation. `pulls` names the pull requests behind the rollout; `delegate` asks an agent with other work to hand
 * the validation to a lead subagent in the background; `payload` is the table's context; `stage` the stage of a staged run beside all its stages. */
export function validationPrompt(request: { nodeId: string; title: string; id: string; run: Pick<RolloutRun, 'id' | 'run_attempt' | 'head_sha'>; context?: { sourceUrl?: string; content: string }; pulls?: readonly Discovery[]; delegate?: boolean;
  payload?: ValidationContext; stage?: { due: StagePlan; plans: readonly StagePlan[] }; phase?: { focus: string; jobs: string[] } }) {
  const { nodeId, id, run, context, pulls = [], payload, stage, phase } = request;
  return [
    `Check whether this rollout works as intended: ${request.title}${context?.sourceUrl ? ` (${context.sourceUrl})` : ''}. It is Agentic Crafting Table item ${nodeId}.`,
    ...(pulls.length ? [`Pull request${pulls.length > 1 ? 's' : ''} behind this rollout: ${pulls.map(({ node, pull }) => { const url = pullUrl(pull.data); return `${node.title}${url ? ` (${url})` : ''}`; }).join('; ')}.`] : []),
    `This is validation ${id} for run ${run.id}, attempt ${run.run_attempt}, commit ${run.head_sha.slice(0, 12)}, focus: ${phase?.focus ?? stage?.due.focus ?? 'whole run'}.`,
    ...(phase ? [`The table asks for one validation per approval phase of this rollout, each with its own id. This one covers ${phase.focus}${phase.jobs.length ? `: judge what these jobs deployed: ${phase.jobs.join('; ')}` : ''}. Earlier phases were validated separately and stay final on the table; do not repeat them, and say what changed since the newest final report in the context below.`] : []),
    ...(stage ? [`The table asks for one validation per stage of this rollout, each with its own id: ${stage.plans.map(plan => plan.focus).join('; ')}. Earlier validations stay final and on the table; the newest final report is in the context below. Judge this stage, and say what changed since that report.`] : []),
    context ? `Rollout state:\n${context.content.slice(0, 4000)}` : 'Read its current state with workspace_run resource.read on that item.',
    ...(payload ? [`Context from the table (JSON):\n${JSON.stringify(payload, null, 1)}`] : []),
    request.delegate ? `Do not do this in your own turn. Hand this whole validation to one lead subagent running in the background, give it this request word for word and whatever context it needs, then carry on with your other work and stay free for new prompts. The lead may fan out: it starts one subagent per data source (${sources}), gives each the checks that source answers, and merges what they find. Only the lead sends the reports, with workspace_report_validation; while it waits for its subagents it sends progress reports that mark the checks they finished and leave the rest pending or running. If it cannot reach that tool, pass its reports on as they arrive. Say in one line that the validation is running, and give the summary when the lead finishes.`
      : `You lead this validation. You may fan out: start one subagent per data source (${sources}), give each the checks that source answers, and merge what they find. Only you send the reports, with workspace_report_validation; while you wait for your subagents, send progress reports that mark the checks they finished and leave the rest pending or running.`,
    'Check the deployed change against what it was meant to do, using the connected tickets, PRs and notes. Do not approve, rerun, cancel or change deployments.',
    'Let the rollout land before you judge it, and keep the table up to date while you do. You may keep watching for as long as the rollout takes, but not by sitting idle: never sleep longer than 30 seconds in one command, look again after each wait, and send a "progress" report whenever a check changes and at least every 2 minutes, saying what you have confirmed and what you are still waiting for. Do not wait for things that need hours to tell, such as long-term metrics: report those as skipped checks with a reason and the earliest time they could be checked. Send a first report with an interim verdict within 2 minutes from what is checkable now; list checks that need a settled window as pending with the earliest time; then update. The final verdict is inconclusive only when nothing that matters could be checked.',
    [`Report on the table with workspace_report_validation (rolloutNodeId "${nodeId}", validationId "${id}"):`,
      '· first, a "progress" report (sequence 1) whose summary opens with your interim verdict, listing the checks you plan, with status "pending";',
      '· then a "progress" report after each check, with its observation, before/after metrics and evidence links (https only);',
      '· finally a "final" report with a verdict: passed, concerns (works, but a person should look before the next gate), failed, or inconclusive (you could not check what matters).',
      'Write so a person can scan it: summary: one sentence with the verdict and why, then at most two more (under 600 characters); each check observation: one or two sentences, then any details as "- " bullet lines; figures that compare before and after go in metrics with a label, not in the prose. Plain Markdown (bullets, **bold**, `code`, https links) is shown as such.',
      'Each report replaces the previous one and needs a higher sequence. You may narrow scope.jobs to the job ids you checked. Say what you could not check as a skipped check with a reason. Then reply with the summary in one paragraph.',
      'If something changes after your final report, send a "followup" report for the same validationId with a higher sequence, a verdict and the checks; it may change the verdict.'].join('\n'),
  ].join('\n\n');
}

export const AGENT_QUIET_MS = 20_000;
/** Observations that mean Claude is showing a permission dialog. */
export const isPermissionPrompt = (event: string | undefined) => event === 'Notification:permission_prompt' || event === 'PermissionRequest';
const output = new Map<string, { sequence: number; since: number }>();
/** A permission dialog counts as answered only when the person pressed a deciding
 * key in the terminal after the prompt was observed and the terminal printed
 * something after that key. A dialog is silent and a resize repaints it, so
 * neither silence nor output is evidence on its own. */
const permissionAnswered = (last: AgentObservation | undefined, current: SessionSnapshot) => {
  const { decisiveInputAt, decisiveInputSequence } = current.session;
  return isPermissionPrompt(last?.event) && decisiveInputAt !== undefined && decisiveInputSequence !== undefined
    && decisiveInputAt > last!.observedAt && current.lastSequence > decisiveInputSequence;
};
/** Whether an agent can take a new prompt now: idle, working (or waiting for
 * input), or stopped. Only a running, writable, idle process is ready. Claude's
 * idle prompt counts as ready; a question does not, and a permission prompt only
 * once the person answered it in the terminal. A turn that ended without a Stop
 * hook (an interrupt) and an answered permission prompt both leave the item's
 * state behind, so a terminal that has printed nothing for a while counts as
 * sitting at its prompt. Delivery presses Enter, which would accept an open
 * dialog: never report idle while one may be showing. */
/** The main turn has ended, something is still listed in the background, and none of it is waited on, so the agent sits at its prompt. */
const parked = (state: BackgroundState | undefined, now: number) => Boolean(state?.turnEnded && !state.waking && state.tasks.length && !outstanding(state, now).length);
export async function agentReadiness(sessions: SessionCoordinator | undefined, state: WorkspaceState, agent: { nodeId: string; sessionId: string },
  lastEvent: (sessionId: string) => AgentObservation | undefined = () => undefined, now = Date.now, background: (sessionId: string) => BackgroundState | undefined = () => undefined): Promise<AgentStatus> {
  const target = state.nodes.find(candidate => candidate.id === agent.nodeId);
  const current = sessions && await sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId: agent.sessionId, after: Number.MAX_SAFE_INTEGER }).catch(() => undefined);
  if (!target || !current || current.session.state !== 'running' || current.session.stopRequestedAt || current.session.readOnly) return 'stopped';
  if (current.session.native) return target.activity === 'idle' && target.attention !== 'input' && current.session.native.status === 'idle' ? 'idle' : 'working';
  const seen = output.get(agent.sessionId);
  if (!seen || seen.sequence !== current.lastSequence) output.set(agent.sessionId, { sequence: current.lastSequence, since: now() });
  if (target.attention === 'input') {
    const last = lastEvent(agent.sessionId);
    if (last?.event === 'Notification:idle_prompt') return 'idle';
    if (!permissionAnswered(last, current)) return 'working';
  } else if (target.activity === 'idle' || parked(background(agent.sessionId), now())) return 'idle';
  return now() - output.get(agent.sessionId)!.since >= AGENT_QUIET_MS ? 'idle' : 'working';
}

type Resources = Pick<ResourceCoordinator, 'context' | 'cached' | 'content' | 'refreshPresentation'>;
type Stage = { due: DueStage; plans: readonly StagePlan[] };
type Trigger = Extract<z.infer<typeof rolloutValidationInput>, { operation: 'trigger' }>;
/** The scope an approval phase asks for: its focus and the jobs it covers; without one, a stage's focus or the whole run. */
const stageScope = (stage?: Stage) => stage ? { focus: stage.due.focus, environments: [stage.due.environment], stage: stage.due.key, label: stage.due.label } : {};
const phaseScope = (args: Trigger, fallback = 'whole run') => ({ focus: args.phase?.focus ?? fallback, ...(args.phase?.jobs.length ? { jobs: args.phase.jobs } : {}) });
const phasePrompt = (args: Trigger, jobs: readonly { id: number; name: string }[]) => args.phase ? { phase: { focus: args.phase.focus, jobs: args.phase.jobs.map(id => jobs.find(job => job.id === id)?.name ?? `job ${id}`) } } : {};

/** Validations of rollouts: agents are asked through a journaled prompt, report back
 * through workspace_report_validation, and the service derives staleness, the
 * current verdict, Needs me, No report and the rollout's event history from them. */
export class RolloutValidations {
  private store: SqliteStore; private control: WorkspaceControl; private resources: Resources; private sessions: SessionCoordinator | undefined; private changed: () => Promise<void>;
  private now: () => number; private allowed: () => boolean; private noReportAfter: number; private noReportDeadline: number;
  private reconciling?: Promise<void>; private again = false; private timer?: ReturnType<typeof setInterval>; private closed = false;
  /** Since when each hidden agent with settled validations has been seen idle at its prompt, by this service's passes. */
  private idleHidden = new Map<string, number>();
  private starter?: HostedAgents; private starting = new Map<string, Promise<unknown>>(); private unready?: { at: number; reason: string }; private stageRules: () => readonly StageRule[]; private deploying: (pullResourceId: string) => boolean;
  constructor(store: SqliteStore, control: WorkspaceControl, resources: Resources, sessions: SessionCoordinator | undefined, changed: () => Promise<void>, options: { now?: () => number; allowed?: () => boolean; noReportAfterMs?: number; noReportDeadlineMs?: number; starter?: HostedAgents; /** The configured stage rules, read on every pass; none by default. */ stageRules?: () => readonly StageRule[]; /** Whether Auto deploy is armed on a pull request; it then asks for that rollout's validations itself. */ deploying?: (pullResourceId: string) => boolean } = {}) {
    this.store = store; this.control = control; this.resources = resources; this.sessions = sessions; this.changed = changed; this.starter = options.starter; this.stageRules = options.stageRules ?? (() => []); this.deploying = options.deploying ?? (() => false);
    this.now = options.now ?? Date.now; this.allowed = options.allowed ?? (() => true); this.noReportAfter = options.noReportAfterMs ?? NO_REPORT_AFTER_MS; this.noReportDeadline = options.noReportDeadlineMs ?? NO_REPORT_DEADLINE_MS;
  }

  async run(nodeId: string, input: unknown): Promise<unknown> {
    let args = rolloutValidationInput.parse(input);
    const { state, node, resource } = await this.rollout(nodeId);
    if (args.operation === 'list') { this.observe(); return this.describe(state, resource.id, await this.observation(node.id)); }
    if (args.operation === 'report') return this.report(node.id, resource.id, args);
    if (args.operation === 'show' || args.operation === 'hide') return this.visibility(state, node.id, resource.id, args.operation, args.validationId);
    const agents = await this.agents(state, nodeId);
    if (args.operation === 'ask') return this.ask(node, resource.id, args, agents);
    const reuse = await this.reusable(resource.id, node.id);
    if (args.operation === 'options') {
      const blocked = await this.cannotStart(node.id), again = reuse ? 'Re-run · ' : '';
      return { current: '', prompt: reuse ? `${reuse.label}, started from chat, covers ${reuse.scope.focus ?? 'this run'} and ${reuseState(reuse, this.now())}. Show it, or re-run the validation:` : 'Ask an agent to check this rollout works as intended:',
        context: { sourceResourceId: resource.id, ...(reuse ? { rerun: reuse.label } : {}) },
        options: [...(reuse ? [{ id: ATTACH_VALIDATION, label: `Show ${reuse.label}`, description: `Its report instead of a second validation; ${reuseState(reuse, this.now())}` }] : []),
          ...agents.map(agent => ({ id: agent.nodeId, label: agent.title, description: `${again}${availability(agent)} · ${agent.direct ? 'connected' : 'connected through another item; a direct connection will be added'}`,
            ...(agent.ready ? {} : { disabled: true }), highlight: agent.path })),
          { id: NEW_VALIDATION_AGENT, label: 'Start a new agent', description: blocked ?? `${again}A new Claude session beside this rollout, connected to it and its pull requests`, ...(blocked ? { disabled: true } : {}) }] };
    }
    if (args.sourceResourceId !== resource.id) throw new Error('This validation belongs to another rollout. Reopen the menu.');
    if (args.value === ATTACH_VALIDATION && !reuse) throw new Error('That validation is no longer under way or recent. Reopen the menu.');
    // A repeated request answers as the first did: its phase was fixed when it was sent.
    const replay = args.phased ? this.store.jobByRequest(`rollout-validation:${args.requestId}`) : undefined;
    if (replay?.state === 'succeeded') return replay.result;
    if (replay) args = { ...args, ...(replay.input.arguments as Trigger) };
    else if (args.phased && !args.phase) {
      const observation = await this.observation(node.id), run = observation?.run, attempt = run ? this.attemptValidations(resource.id, run) : [];
      const phase = run && currentPhase(run, observation!.jobs, observation!.gates, attempt.flatMap(entry => entry.scope.jobs ?? []));
      const latest = attempt.filter(entry => entry.scope.jobs?.length).at(-1);
      if (!phase && latest) return { sent: false, attached: true, validationId: `V${latest.ordinal}`, pending: `V${latest.ordinal} covers everything that ran so far; the next phase is validated once it ran.` };
      if (phase) args = { ...args, phase: { focus: phase.focus, jobs: phase.jobs } };
    }
    if (reuse && !args.phased && (args.value === ATTACH_VALIDATION || !args.rerun)) {
      return { sent: false, attached: true, validationId: reuse.label,
        pending: `${reuse.label}, started from chat, ${reuseState(reuse, this.now())}; its report is on the rollout. Re-run from Validate to ask again.` };
    }
    const own = args.value === VALIDATION_AGENT ? agents.find(agent => agent.ready && agent.direct && this.validationAgentOf(state, agent.nodeId) === node.id) : undefined;
    if (own) { const result = await this.request(state, node, resource.id, own, { ...args, value: own.nodeId }, undefined, true); await this.settle(); return result; }
    if (args.value === NEW_VALIDATION_AGENT || args.value === VALIDATION_AGENT) { const result = await this.spawn(state, node, resource.id, args); await this.settle(); return result; }
    const agent = agents.find(candidate => candidate.nodeId === args.value);
    if (!agent || (args.sessionId && args.sessionId !== agent.sessionId)) throw new Error('Choose an agent connected to this rollout.');
    if (!agent.ready) throw new Error(unavailable(agent));
    const result = await this.request(state, node, resource.id, agent, { ...args, value: agent.nodeId });
    await this.settle(); return result;
  }

  private agents(state: WorkspaceState, nodeId: string): Promise<ValidationAgent[]> {
    return Promise.all(connectedAgents(state, nodeId).map(async agent => {
      const status = await agentReadiness(this.sessions, state, agent, sessionId => this.store.agentObservation(sessionId), this.now, sessionId => this.store.agentBackground(sessionId));
      return { ...agent, status, ready: status === 'idle', prompt: heldAtPrompt(state, agent.nodeId, status) };
    }));
  }

  /** Why Start a new agent cannot apply to this rollout now; undefined when it can. */
  private async cannotStart(nodeId: string): Promise<string | undefined> {
    if (!this.starter) return NO_SESSIONS;
    if (!(await this.observation(nodeId))?.run) return NO_RUN;
    if (this.unready && this.now() - this.unready.at < UNREADY_MS) return this.unready.reason;
    try { await this.starter.ready(); this.unready = undefined; return undefined; }
    catch (error) { this.unready = { at: this.now(), reason: clip((error as Error).message, 300) }; return this.unready.reason; }
  }
  /** One launch per request: a repeat while it runs joins it, a later one reads its journal. */
  private spawn(state: WorkspaceState, node: WorkspaceState['nodes'][number], resourceId: string, args: Trigger, stage?: Stage): Promise<unknown> {
    const running = this.starting.get(args.requestId); if (running) return running;
    const work = this.startAgent(state, node, resourceId, args, stage).finally(() => this.starting.delete(args.requestId));
    this.starting.set(args.requestId, work); return work;
  }
  /** Starts a Claude session for this validation beside the rollout, connected to it and to the pull requests that
   * discovered it. The request is the session's opening prompt. A launch that fails ends the validation
   * inconclusive; one whose outcome is unknown leaves it requested for the No report rule. */
  private async startAgent(state: WorkspaceState, node: WorkspaceState['nodes'][number], resourceId: string, args: Trigger, stage?: Stage) {
    const nodeId = node.id, observation = await this.observation(nodeId), run = observation?.run;
    const job = this.store.enqueueJob(`rollout-validation:${args.requestId}`, { action: 'rollout.validation', nodeId, arguments: args });
    if (job.state === 'succeeded') return job.result;
    if (job.state !== 'queued') throw new Error(['failed', 'cancelled'].includes(job.state) && job.error || UNCONFIRMED);
    const refusal = !this.starter ? NO_SESSIONS : !run ? NO_RUN : undefined;
    if (refusal || !run || !this.starter) { this.store.transitionJob(job.id, 'queued', 'cancelled', { error: refusal }); throw new Error(refusal); }
    this.store.transitionJob(job.id, 'queued', 'running');
    let validation: Validation | undefined;
    try {
      await this.starter.ready();
      const seed = `rollout-validation:${args.requestId}`, agentNodeId = stableUuid(`${seed}:node`), title = `Validate · ${clip(node.title, 80)}`;
      const pulls = discoveringPulls(state, nodeId), folder = (projectId?: string) => state.nodes.find(candidate => candidate.id === projectId && !candidate.resourceId)?.workingDirectory;
      const cwd = folder(node.projectId) || pulls.map(({ node: pull }) => folder(pull.projectId)).find(Boolean) || this.starter.fallbackDirectory();
      validation = this.store.createRolloutValidation({ id: randomUUID(), rolloutResourceId: resourceId, agentNodeId, agent: { title, provider: 'claude' },
        requestId: args.requestId, scope: { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha, ...stageScope(stage), ...phaseScope(args, stage?.due.focus) }, requestedAt: this.now() });
      const id = `V${validation.ordinal}`, context = await this.resources.context(nodeId, AbortSignal.timeout(10_000)).catch(() => undefined);
      const connect = (otherId: string, extra?: { label: string; reveal: 'hover' }) => ({ id: stableUuid(`${seed}:link:${otherId}`), otherId, kind: 'context' as const, sourceIsNew: false, ...extra });
      const request: ResourceCreate = { requestId: stableUuid(`${seed}:session`), nodeId: agentNodeId, resourceId: stableUuid(`${seed}:resource`), pluginId: 'agent.session', title,
        ...(node.projectId ? { projectId: node.projectId } : {}), placedBy: nodeId, hidden: { label: VALIDATION_AGENT_LABEL }, connections: [connect(nodeId, VALIDATION_LINK), ...pulls.map(({ node: pull }) => connect(pull.id))], data: { provider: 'claude', cwd } };
      const payload = await this.payload(state, nodeId, resourceId, { ...observation!, run }, stage?.due, validation.id);
      await this.starter.launch(request, { prompt: validationPrompt({ nodeId, title: node.title, id, run, context, pulls, payload, ...(stage ? { stage } : {}), ...phasePrompt(args, observation!.jobs) }), data: { validation: { rolloutNodeId: nodeId, validationId: id, requestId: args.requestId } } });
      const result = { sent: true, linked: true, validationId: id, agentNodeId };
      this.store.transitionJob(job.id, 'running', 'succeeded', { result });
      return result;
    } catch (error) {
      const reason = clip((error as Error).message, 300), uncertain = Boolean(validation) && (error as { code?: string }).code === 'LAUNCH_UNCERTAIN';
      if (uncertain) { this.store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'Check the agent before sending again.' }); throw error; }
      const message = validation ? `${NOT_STARTED} ${reason}` : reason;
      if (validation) this.store.updateRolloutValidation(validation.id, validation.sequence, { state: 'final', verdict: 'inconclusive', finishedAt: this.now(), idleSince: null,
        report: { summary: message, verdict: 'inconclusive', checks: [{ id: 'start', title: 'Start a new agent', status: 'skipped', observation: reason }], recommendations: [] } }, this.now());
      this.store.transitionJob(job.id, 'running', 'failed', { error: message });
      await this.settle().catch(() => {});
      throw new Error(message, { cause: error });
    }
  }

  /** Journals the request, links the agent when it is not directly connected, records the validation and prompts the agent once. */
  private async request(state: WorkspaceState, node: WorkspaceState['nodes'][number], resourceId: string, agent: ValidationAgent, args: Trigger, stage?: Stage, lead = false) {
    const nodeId = node.id, observation = await this.observation(nodeId), run = observation?.run;
    const job = this.store.enqueueJob(`rollout-validation:${args.requestId}`, { action: 'rollout.validation', nodeId, arguments: args });
    if (job.state === 'succeeded') return job.result;
    if (job.state !== 'queued') throw new Error(UNCONFIRMED);
    if (!run) { this.store.transitionJob(job.id, 'queued', 'cancelled'); throw new Error(NO_RUN); }
    this.store.transitionJob(job.id, 'queued', 'running');
    let linked = false;
    try {
      if (!agent.direct) {
        const current = await this.control.read();
        await this.control.dispatch({ commandId: `${args.requestId}:link`, expectedRevision: current.revision, actor: { kind: 'user', id: 'rollout-validation' },
          commands: [{ type: 'link.save', link: { id: randomUUID(), sourceId: nodeId, targetId: agent.nodeId, kind: 'context', ...VALIDATION_LINK } }] });
        linked = true;
      }
      const provider = state.resources.find(record => record.id === state.nodes.find(candidate => candidate.id === agent.nodeId)?.resourceId)?.data.provider;
      const validation = this.store.createRolloutValidation({ id: randomUUID(), rolloutResourceId: resourceId, agentNodeId: agent.nodeId, agent: { title: agent.title, ...(typeof provider === 'string' ? { provider } : {}) },
        requestId: args.requestId, scope: { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha, ...stageScope(stage), ...phaseScope(args, stage?.due.focus) }, requestedAt: this.now() });
      const id = `V${validation.ordinal}`, context = await this.resources.context(nodeId, AbortSignal.timeout(10_000)).catch(() => undefined);
      const payload = await this.payload(state, nodeId, resourceId, { ...observation!, run }, stage?.due, validation.id);
      await promptAgent(this.sessions!, agent.sessionId, `${FROM_TABLE} Check the rollout as the pasted request describes:`,
        validationPrompt({ nodeId, title: node.title, id, run, context, pulls: discoveringPulls(state, nodeId), delegate: !lead, payload, ...(stage ? { stage } : {}), ...phasePrompt(args, observation!.jobs) }));
      const result = { sent: true, linked, validationId: id };
      this.store.transitionJob(job.id, 'running', 'succeeded', { result });
      return result;
    } catch (error) { this.store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'Check the agent before sending again.' }); throw error; }
  }

  /** The validation started from chat that answers a request for the stage the run has reached: about the current attempt and that stage,
   * not resolved, and still under way or final less than 15 minutes ago. */
  private async reusable(resourceId: string, nodeId: string) {
    const observation = await this.observation(nodeId), run = observation?.run;
    if (!observation || !run) return undefined;
    const stage = this.reached({ ...observation, run })?.key, now = this.now();
    return annotateValidations(this.store.rolloutValidations({ rolloutResourceId: resourceId }), run).filter(view => !view.stale && !view.resolvedBy && view.requestId === chatRequestId(resourceId, view.ordinal)
      && view.scope.stage === stage && (view.state === 'requested' || view.state === 'running' || view.state === 'final' && now - (view.finishedAt ?? view.updatedAt) < REUSE_MS)).at(-1);
  }

  /** Auto validate, asked of the rollout's validation agent as one click would: its idle hidden agent again, else a new hidden one.
   * A staged run gets one validation per stage that is due, while no validation of the attempt is still open; a stage is covered by
   * its own request or by one a person made after it fell due. Any other run gets the one validation of its attempt nobody asked
   * for, while it runs or when first seen. Only while Claude cannot start a session here does a ready connected agent take the
   * request instead: the agent of the attempt's last validation, then one connected through a pull request that discovered the
   * rollout, then any. */
  private async validateAutomatically(state: WorkspaceState, node: WorkspaceState['nodes'][number], resourceId: string, observation: RolloutObservation & { run: RolloutRun }, firstSeen: boolean) {
    // A pull request whose Auto deploy is armed asks for this rollout's validations itself; asking here too would validate each stage twice.
    const deployed = (id: string) => { const resourceId = state.nodes.find(candidate => candidate.id === id)?.resourceId; return Boolean(resourceId && this.deploying(resourceId)); };
    const run = observation.run, pulls = autoValidatingPulls(state, node.id).filter(id => !deployed(id)), scope = { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha };
    if (!pulls.length || !this.sessions) return false;
    const rule = stageRule(observation, this.stageRules()), due = rule && dueStage(rule, observation.jobs, this.now());
    const attempt = this.attemptValidations(resourceId, run);
    if (!rule && this.gated(resourceId, observation)) return this.validatePhase(state, node, resourceId, observation, attempt, pulls);
    if (rule ? !due : run.status === 'completed' && !firstSeen) return false;
    const requestId = due ? stageRequestId(resourceId, scope, due.key) : automaticRequestId(resourceId, scope);
    if (due ? attempt.some(entry => entry.requestId === requestId || !entry.scope.stage && entry.requestedAt >= due.dueAt || entry.scope.stage === due.key && entry.requestId === chatRequestId(resourceId, entry.ordinal))
      || annotateValidations(attempt, run).some(view => !view.resolvedBy && (view.state === 'requested' || view.state === 'running')) : attempt.length) return false;
    return this.automatic(state, node, resourceId, { operation: 'trigger', sourceResourceId: resourceId, value: VALIDATION_AGENT, requestId }, pulls, due ? attempt : [], due && rule ? { due, plans: rule.stages } : undefined);
  }
  /** Sends an automatic request to the rollout's validation agent, or while Claude cannot start one to a ready connected agent: the
   * agent of the attempt's last validation in `earlier`, then one connected through a pull request in `pulls`, then any. */
  private async automatic(state: WorkspaceState, node: WorkspaceState['nodes'][number], resourceId: string, args: Trigger, pulls: readonly string[], earlier: readonly Validation[], stage?: Stage) {
    const ready = (await this.agents(state, node.id)).filter(candidate => candidate.ready);
    const own = ready.find(candidate => candidate.direct && this.validationAgentOf(state, candidate.nodeId) === node.id);
    if (own) return this.request(state, node, resourceId, own, { ...args, value: own.nodeId }, stage, true).then(() => true, () => false);
    if (!(await this.cannotStart(node.id))) return this.spawn(state, node, resourceId, args, stage).then(() => true, () => false);
    // Through the pull request: reached from it without passing the rollout, so an earlier direct link does not hide it.
    const aliases = new Set(state.nodes.filter(candidate => candidate.resourceId === resourceId).map(candidate => candidate.id));
    const preferred = new Set(pulls.flatMap(pull => connectedAgents(state, pull, id => !aliases.has(id)).map(candidate => candidate.nodeId)));
    const previous = earlier.at(-1)?.agentNodeId;
    const agent = ready.find(candidate => candidate.nodeId === previous) ?? ready.find(candidate => preferred.has(candidate.nodeId)) ?? ready[0];
    if (!agent) return false;
    return this.request(state, node, resourceId, agent, { ...args, value: agent.nodeId }, stage).then(() => true, () => false);
  }

  private attemptValidations(resourceId: string, run: RolloutRun) {
    return this.store.rolloutValidations({ rolloutResourceId: resourceId }).filter(entry => entry.scope.runId === run.id && entry.scope.attempt === run.run_attempt && entry.scope.headSha === run.head_sha);
  }
  /** A run attempt that waits, or waited, at a deployment gate is validated per phase instead of once. */
  private gated(resourceId: string, observation: RolloutObservation & { run: RolloutRun }) {
    return observation.gates.length > 0 || this.store.rolloutEvents(resourceId).some(event => event.kind === 'gate-waiting' && event.runId === observation.run.id && event.attempt === observation.run.run_attempt);
  }
  /** Auto validate of a gated run: each phase once its gate waits, and what ran after the last gate once the run ended, each
   * from the jobs no validation of the attempt covers; nothing while a validation of the attempt is open or a phase still runs. */
  private async validatePhase(state: WorkspaceState, node: WorkspaceState['nodes'][number], resourceId: string, observation: RolloutObservation & { run: RolloutRun }, attempt: Validation[], pulls: readonly string[]) {
    const run = observation.run, scope = { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha };
    const phase = currentPhase(run, observation.jobs, observation.gates, attempt.flatMap(entry => entry.scope.jobs ?? []));
    if (!phase || phase.boundary === 'running') return false;
    if (annotateValidations(attempt, run).some(view => !view.resolvedBy && (view.state === 'requested' || view.state === 'running'))) return false;
    const requestId = phaseRequestId(resourceId, scope, phase.jobs);
    if (attempt.some(entry => entry.requestId === requestId)) return false;
    return this.automatic(state, node, resourceId, { operation: 'trigger', sourceResourceId: resourceId, value: VALIDATION_AGENT, requestId, phase: { focus: phase.focus, jobs: phase.jobs } }, pulls, attempt);
  }

  /** The context a request carries, from what the table holds: the cached run, the pull requests that discovered the rollout and their
   * changed files (their read-only files action, cached), the newest final report on the rollout other than `except`, and the pull
   * requests merged since the workflow's previous successful run (the rollout's read-only action, cached). A read that fails or takes
   * over 10 seconds leaves its part out. */
  private async payload(state: WorkspaceState, nodeId: string, resourceId: string, observation: RolloutObservation & { run: RolloutRun }, stage?: DueStage, except?: string) {
    const pulls = discoveringPulls(state, nodeId), files: string[] = [];
    for (const { node } of pulls.slice(0, 3)) {
      const pull = ((await this.resources.cached(node.id).catch(() => null))?.detail as { pull?: { head?: { sha?: unknown }; base?: { sha?: unknown } } } | undefined)?.pull;
      if (typeof pull?.head?.sha !== 'string' || typeof pull.base?.sha !== 'string') continue;
      const read = this.resources.content(node.id, 'files', { head: pull.head.sha, base: pull.base.sha }).then(result => (result.content as { files?: { filename?: unknown }[] }).files ?? [], () => []);
      const listed = await Promise.race([read, new Promise<[]>(resolve => setTimeout(resolve, 10_000, []).unref?.())]);
      files.push(...listed.map(file => file.filename).filter((name): name is string => typeof name === 'string' && !files.includes(name)));
    }
    const previous = this.store.rolloutValidations({ rolloutResourceId: resourceId }).filter(entry => entry.state === 'final' && entry.id !== except)
      .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt) || b.ordinal - a.ordinal)[0];
    const component = componentOf(files), run = observation.run;
    const shippedRead = Promise.resolve().then(() => this.resources.content(nodeId, 'rollout.shipped', { runId: run.id, workflowId: run.workflow_id, runNumber: run.run_number, head: run.head_sha, ...(run.head_branch ? { branch: run.head_branch } : {}) }))
      .then(result => result.content as unknown as RolloutShipped, () => undefined);
    const shipped = await Promise.race([shippedRead, new Promise<undefined>(resolve => setTimeout(resolve, 10_000, undefined).unref?.())]);
    return validationContext({ ...(shipped ? { shipped } : {}), observation, pulls: pulls.map(({ node, pull }) => { const url = pullUrl(pull.data); return { number: Number(pull.data.number), title: node.title, ...(url ? { url } : {}) }; }),
      ...(previous ? { previous } : {}), ...(component ? { component } : {}), ...(stage ? { stage } : {}) });
  }

  observe() { if (!this.closed && this.allowed()) void this.reconcile().catch(() => {}); }
  start() { this.closed = false; clearInterval(this.timer); this.timer = setInterval(() => this.observe(), 15_000); this.timer.unref?.(); this.observe(); }
  async close() { this.closed = true; clearInterval(this.timer); await this.reconciling?.catch(() => {}); }
  /** Records rollout transitions, marks validations without a report, and keeps each
   * validating agent's Needs me source and the map card in line with the verdicts. */
  reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return this.reconciling; }
    this.reconciling = (async () => { do { this.again = false; await this.reconcileOnce(); } while (this.again && !this.closed); })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  private async reconcileOnce() {
    const state = await this.control.read(), now = this.now(), commands: WorkspaceCommand[] = [], repaint: string[] = [];
    let stored = false;
    for (const resource of state.resources.filter(record => record.pluginId === 'github.rollout')) {
      const node = state.nodes.find(candidate => candidate.resourceId === resource.id && !isOffMap(candidate, state.nodes));
      if (!node) continue;
      const observation = await this.observation(node.id), known = this.store.rolloutEvents(resource.id), events = observation ? observedEvents(observation, known, now, this.approvals(state, resource.id)) : [];
      if (events.length) { this.store.addRolloutEvents(resource.id, events); repaint.push(node.id); stored = true; }
      // An attempt is validated automatically when it first shows, a staged one at each stage; until then each pass looks for a ready agent again.
      const run = observation?.run;
      if (run && await this.validateAutomatically(state, node, resource.id, { ...observation, run }, !known.some(event => event.runId === run.id && event.attempt === run.run_attempt))) { stored = true; this.again = true; }
      const validations = this.store.rolloutValidations({ rolloutResourceId: resource.id });
      if (!validations.length) continue;
      const resolved = new Set(annotateValidations(validations, observation?.run).filter(view => view.resolvedBy).map(view => view.id));
      for (const validation of validations.filter(entry => entry.state === 'requested' || entry.state === 'running')) {
        const idle = this.idleSince(state, validation, now);
        if (resolved.has(validation.id) || now - validation.updatedAt >= this.noReportDeadline || idle !== undefined && now - idle >= this.noReportAfter) {
          this.store.updateRolloutValidation(validation.id, validation.sequence, { state: 'no-report', idleSince: null }, now); stored = true;
        } else if (idle !== validation.idleSince) this.store.updateRolloutValidation(validation.id, validation.sequence, { idleSince: idle ?? null }, now);
      }
      const views = annotateValidations(this.store.rolloutValidations({ rolloutResourceId: resource.id }), observation?.run);
      for (const [agentNodeId, wanted] of validationAttention(views)) {
        const command = validationAttentionCommand(node, `validation:${agentNodeId}`, wanted);
        if (command) commands.push(command);
      }
      repaint.push(node.id);
    }
    commands.push(...this.retireHidden(state, now));
    if (commands.length) {
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'rollout-validation' }, commands }); stored = true; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; this.again = true; }
    }
    if (stored) await this.changed();
    for (const nodeId of new Set(repaint)) await this.resources.refreshPresentation(nodeId).catch(() => {});
  }

  /** Archives each hidden agent whose validations all settled and that sat idle at its prompt, with nothing in the background, for
   * HIDDEN_AGENT_IDLE_MS since its last report and since this service first saw it so; archiving stops its session. The validations and
   * their reports stay on the rollout. An agent on the map is never retired. Reads the store once and the pass's workspace state. */
  private retireHidden(state: WorkspaceState, now: number): WorkspaceCommand[] {
    const agents = new Map<string, { open: boolean; latest: number }>();
    for (const validation of this.store.rolloutValidations({})) {
      const entry = agents.get(validation.agentNodeId) ?? { open: false, latest: 0 };
      agents.set(validation.agentNodeId, { open: entry.open || validation.state === 'requested' || validation.state === 'running', latest: Math.max(entry.latest, validation.finishedAt ?? 0, validation.updatedAt) });
    }
    const commands: WorkspaceCommand[] = [];
    for (const id of this.idleHidden.keys()) if (!agents.has(id)) this.idleHidden.delete(id);
    for (const [id, { open, latest }] of agents) {
      const agent = state.nodes.find(node => node.id === id);
      if (!agent?.hiddenAt || isOffMap(agent, state.nodes) || open || !this.atPrompt(state, agent)) { this.idleHidden.delete(id); continue; }
      const since = this.idleHidden.get(id) ?? now; this.idleHidden.set(id, since);
      if (now - Math.max(since, latest) < HIDDEN_AGENT_IDLE_MS) continue;
      commands.push({ type: 'node.archive', id }); this.idleHidden.delete(id);
    }
    return commands;
  }
  /** Not working, waiting on no helper or background shell, and not held at a question: Claude's idle prompt only. */
  private atPrompt(state: WorkspaceState, agent: WorkspaceState['nodes'][number]) {
    if (agent.activity === 'working' || agent.beside || agent.helpers) return false;
    if (agent.attention !== 'input') return true;
    const sessionId = state.resources.find(record => record.id === agent.resourceId)?.data.sessionId;
    return typeof sessionId === 'string' && this.store.agentObservation(sessionId)?.event === 'Notification:idle_prompt';
  }

  /** Since when the validation's agent has been idle without reporting, or undefined while it works. Claude at its idle prompt
   * is idle since it got there, even across a restart; a question or permission prompt waits on the person. */
  private idleSince(state: WorkspaceState, validation: Validation & { idleSince?: number }, now: number) {
    const agent = state.nodes.find(candidate => candidate.id === validation.agentNodeId);
    if (!agent || isOffMap(agent, state.nodes)) return validation.idleSince ?? now;
    if (agent.activity === 'working') return undefined;
    if (agent.attention !== 'input') return validation.idleSince ?? now;
    const sessionId = state.resources.find(record => record.id === agent.resourceId)?.data.sessionId, last = typeof sessionId === 'string' ? this.store.agentObservation(sessionId) : undefined;
    if (last?.event !== 'Notification:idle_prompt') return undefined;
    return validation.idleSince ?? Math.min(now, Math.max(last.observedAt, validation.updatedAt));
  }

  /** Stores a report. A report for an id nobody requested records that validation for the reporting agent (labelled unrequested)
   * instead of refusing it; one without an id goes to the agent's open validation or starts one from chat; a "followup" amends a
   * final validation and may change its verdict, which then counts from now. */
  private async report(nodeId: string, resourceId: string, args: Extract<z.infer<typeof rolloutValidationInput>, { operation: 'report' }>) {
    const observation = await this.observation(nodeId), run = observation?.run, notes: string[] = [];
    const all = this.store.rolloutValidations({ rolloutResourceId: resourceId });
    let validation = args.validationId ? all.find(entry => `V${entry.ordinal}` === args.validationId) : this.reportedBy(all, args.agentNodeId, args.phase, run);
    if (!validation && args.validationId) {
      validation = await this.unrequested(resourceId, args.validationId, args.agentNodeId, run);
      notes.push(`${args.validationId} was not requested on this rollout; it was recorded as an unrequested validation of run ${validation.scope.runId}, attempt ${validation.scope.attempt}`);
    } else if (!validation) {
      validation = await this.fromChat(resourceId, args.agentNodeId, observation);
      notes.push(`no validationId was given, so this was started from chat as V${validation.ordinal} (${validation.scope.focus}); send the next reports with validationId "V${validation.ordinal}"`);
    } else if (!args.validationId) notes.push(`no validationId was given; the report went to V${validation.ordinal}, send the next reports with validationId "V${validation.ordinal}"`);
    const id = `V${validation.ordinal}`;
    if (validation.agentNodeId !== args.agentNodeId) throw new Error('This validation was requested from another agent.');
    const amending = validation.state === 'final';
    if (amending && args.phase !== 'followup') throw new Error(`${id} is already final. Send phase "followup" with a higher sequence to amend it, or ask the user to request a new validation.`);
    if (args.sequence <= validation.sequence) return { ...this.receipt(validation, run), ignored: true, warnings: [`sequence ${args.sequence} is not newer than ${validation.sequence}; the report was ignored`] };
    const input: Partial<typeof args> = { ...args, validationId: id }; delete input.agentNodeId; delete input.operation;
    const accepted = acceptReport(input, this.attemptJobs(resourceId, validation, observation)?.map(job => job.id));
    if (!amending && accepted.phase === 'followup') notes.push(`${id} was not final yet; the follow-up was taken as its final report`);
    const now = this.now(), final = accepted.phase !== 'progress';
    const report = { at: now, ...accepted.report, ...(amending ? { followup: { at: now, ...(validation.verdict ? { previous: validation.verdict } : {}), count: (validation.report?.followup?.count ?? 0) + 1 } } : {}) };
    const { runId, attempt, headSha, focus, jobs, environments, stage, label } = validation.scope;
    const saved = this.store.updateRolloutValidation(validation.id, validation.sequence, { state: final ? 'final' : 'running', ...(final ? { verdict: accepted.report.verdict, finishedAt: now } : {}),
      sequence: accepted.sequence, reports: validation.reports + 1, report, scope: { runId, attempt, headSha, ...(focus ? { focus } : {}), ...(stage ? { stage } : {}), ...(label ? { label } : {}),
        ...(args.scope ? accepted.scope : { ...(jobs ? { jobs } : {}), ...(environments ? { environments } : {}) }) },
      startedAt: validation.startedAt ?? now, idleSince: null }, now);
    if (!saved) throw new Error('Another report for this validation arrived at the same time. Send the report again with a higher sequence.');
    await this.resources.refreshPresentation(nodeId).catch(() => {});
    await this.settle();
    return { ...this.receipt(saved, run), accepted: { checks: accepted.report.checks.length, evidence: accepted.report.checks.reduce((sum, check) => sum + (check.evidence?.length ?? 0), 0) }, warnings: [...notes, ...accepted.warnings] };
  }
  /** The validation a report without an id is about: the agent's newest one still open on the current attempt, or for a follow-up its newest final one. */
  private reportedBy(validations: readonly Validation[], agentNodeId: string, phase: string, run: RolloutRun | null | undefined) {
    const mine = annotateValidations(validations, run).filter(view => view.agentNodeId === agentNodeId && !view.stale);
    const open = mine.filter(view => !view.resolvedBy && view.state !== 'final').sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const id = open?.id ?? (phase === 'followup' ? mine.filter(view => view.state === 'final').sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0]?.id : undefined);
    return validations.find(entry => entry.id === id);
  }
  /** Records a validation an agent reports without a request, under the id it used, about the rollout's current run attempt. */
  private async unrequested(resourceId: string, validationId: string, agentNodeId: string, run: RolloutRun | null | undefined) {
    const { agent, provider } = await this.reporter(agentNodeId, `${validationId} was not requested on this rollout, and only an agent on the map can report a validation.`);
    if (!run) throw new Error(NO_RUN);
    const ordinal = Number(validationId.slice(1));
    return this.store.createRolloutValidation({ id: randomUUID(), ordinal, rolloutResourceId: resourceId, agentNodeId, agent: { title: agent.title, ...(typeof provider === 'string' ? { provider } : {}) },
      requestId: unrequestedRequestId(resourceId, ordinal), scope: { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha, focus: 'whole run' }, requestedAt: this.now() });
  }
  /** Starts the validation an agent reports without an id: the next id, about the current run attempt and the stage it has reached. */
  private async fromChat(resourceId: string, agentNodeId: string, observation: RolloutObservation | undefined) {
    const { agent, provider } = await this.reporter(agentNodeId, 'Only an agent on the map can report a validation.'), run = observation?.run;
    if (!observation || !run) throw new Error(NO_RUN);
    const stage = this.reached({ ...observation, run }), ordinal = Math.max(0, ...this.store.rolloutValidations({ rolloutResourceId: resourceId }).map(entry => entry.ordinal)) + 1;
    return this.store.createRolloutValidation({ id: randomUUID(), ordinal, rolloutResourceId: resourceId, agentNodeId, agent: { title: agent.title, ...(typeof provider === 'string' ? { provider } : {}) },
      requestId: chatRequestId(resourceId, ordinal), scope: { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha, focus: stage?.focus ?? 'whole run', ...(stage ? { environments: [stage.environment], stage: stage.key, label: stage.label } : {}) },
      requestedAt: this.now() });
  }
  private async reporter(agentNodeId: string, refusal: string) {
    const state = await this.control.read(), agent = state.nodes.find(node => node.id === agentNodeId), resource = state.resources.find(record => record.id === agent?.resourceId);
    if (!agent || resource?.pluginId !== 'agent.session' || isOffMap(agent, state.nodes)) throw new Error(refusal);
    return { agent, provider: resource.data.provider };
  }
  /** The stage of a staged run it has reached now, however long ago; undefined for a run without stages. */
  private reached(observation: RolloutObservation & { run: RolloutRun }) {
    const rule = stageRule(observation, this.stageRules());
    return rule ? reachedStage(rule, observation.jobs, this.now()) : undefined;
  }

  private async ask(node: WorkspaceState['nodes'][number], resourceId: string, args: { validationId: string; requestId: string }, agents: ValidationAgent[]) {
    const validation = this.store.rolloutValidations({ rolloutResourceId: resourceId }).find(entry => `V${entry.ordinal}` === args.validationId);
    if (!validation) throw new Error(`${args.validationId} was not requested on this rollout.`);
    const job = this.store.enqueueJob(`rollout-validation-ask:${args.requestId}`, { action: 'rollout.validation', nodeId: node.id, arguments: args });
    if (job.state === 'succeeded') return job.result;
    if (job.state !== 'queued') throw new Error(UNCONFIRMED);
    const agent = agents.find(candidate => candidate.nodeId === validation.agentNodeId), resolvedBy = annotateValidations(this.store.rolloutValidations({ rolloutResourceId: resourceId }), (await this.observation(node.id))?.run).find(view => view.id === validation.id)?.resolvedBy;
    const refusal = resolvedBy && validation.state !== 'final' ? `${args.validationId} was resolved by ${resolvedBy}; request a new validation instead.` : validation.state !== 'no-report' ? (validation.state === 'final' ? `${args.validationId} already reported.` : `${args.validationId} is still waiting for the agent's report.`)
      : !agent ? 'The agent is no longer connected to this rollout.' : !agent.ready ? unavailable(agent) : undefined;
    if (refusal || !agent) { this.store.transitionJob(job.id, 'queued', 'cancelled'); throw new Error(refusal); }
    this.store.transitionJob(job.id, 'queued', 'running');
    try {
      await promptAgent(this.sessions!, agent.sessionId, `${FROM_TABLE} Please report the validation the pasted note describes:`, [`You were asked to validate ${node.title} (validation ${args.validationId}) and have not reported a result on the table yet.`,
        `Report it now with workspace_report_validation (rolloutNodeId "${node.id}", validationId "${args.validationId}", a sequence higher than ${validation.sequence}): a "final" report with a verdict and the checks you ran.`,
        'If you could not check what matters, report "inconclusive" and say why as a skipped check. Do not approve, rerun, cancel or change deployments.'].join('\n'));
      this.store.updateRolloutValidation(validation.id, validation.sequence, { state: validation.reports ? 'running' : 'requested', idleSince: null }, this.now());
      const result = { sent: true, validationId: args.validationId };
      this.store.transitionJob(job.id, 'running', 'succeeded', { result });
      await this.settle(); return result;
    } catch (error) { this.store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'Check the agent before sending again.' }); throw error; }
  }

  /** The rollout a hidden agent was started to validate, if it is one. */
  private validationAgentOf(state: WorkspaceState, agentNodeId: string) {
    const agent = state.nodes.find(node => node.id === agentNodeId), data = state.resources.find(record => record.id === agent?.resourceId)?.data;
    const started = data?.validation as { rolloutNodeId?: unknown } | undefined;
    return agent?.hiddenAt && typeof started?.rolloutNodeId === 'string' ? started.rolloutNodeId : undefined;
  }
  /** Show validation agent puts the validation's agent on the map beside the rollout, from the archive too; Hide takes an agent
   * started hidden off it again. Neither touches its session. */
  private async visibility(state: WorkspaceState, nodeId: string, resourceId: string, operation: 'show' | 'hide', validationId: string) {
    const validation = this.store.rolloutValidations({ rolloutResourceId: resourceId }).find(entry => `V${entry.ordinal}` === validationId);
    if (!validation) throw new Error(`${validationId} was not requested on this rollout.`);
    const agent = state.nodes.find(candidate => candidate.id === validation.agentNodeId);
    if (!agent) throw new Error('The agent of this validation is no longer on your table.');
    if (operation === 'hide' && !agent.hideLabel) throw new Error('Only an agent started for a validation can be hidden here.');
    const wanted = operation === 'show' ? Boolean(agent.hiddenAt) : !agent.hiddenAt;
    if (wanted) await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'rollout-validation' },
      commands: [operation === 'show' ? { type: 'node.show', id: agent.id, near: [nodeId] } : { type: 'node.hide', id: agent.id }] });
    await this.changed();
    return operation === 'show' ? { agentNodeId: agent.id, shown: true } : { agentNodeId: agent.id, hidden: true };
  }

  private describe(state: WorkspaceState, resourceId: string, observation: RolloutObservation | undefined) {
    const views = annotateValidations(this.store.rolloutValidations({ rolloutResourceId: resourceId }), observation?.run);
    const agents = new Map(state.nodes.map(node => [node.id, node]));
    const visibility = (agentNodeId: string) => { const agent = agents.get(agentNodeId); return agent?.hiddenAt ? { agentHidden: true as const } : agent?.hideLabel && !isOffMap(agent, state.nodes) ? { agentHideable: true as const } : {}; };
    const automatic = (view: Validation) => view.requestId === automaticRequestId(resourceId, view.scope) || Boolean(view.scope.stage) && view.requestId === stageRequestId(resourceId, view.scope, view.scope.stage!)
      || Boolean(view.scope.jobs?.length) && view.requestId === phaseRequestId(resourceId, view.scope, view.scope.jobs!);
    return { validations: views.map(view => { const copy: Partial<typeof view & { idleSince: number; rolloutResourceId: string }> = { ...view, ...(automatic(view) ? { automatic: true } : {}),
      ...(view.requestId === unrequestedRequestId(resourceId, view.ordinal) ? { unrequested: true } : {}), ...(view.requestId === chatRequestId(resourceId, view.ordinal) ? { chat: true } : {}), ...visibility(view.agentNodeId) }; delete copy.idleSince; delete copy.rolloutResourceId; return copy; }),
      events: this.store.rolloutEvents(resourceId) };
  }
  private receipt(validation: Validation, run: RolloutObservation['run'] | undefined) {
    return { validationId: `V${validation.ordinal}`, state: validation.state, sequence: validation.sequence, stale: annotateValidations([validation], run)[0].stale };
  }
  /** Jobs of the validated attempt: the live observation, or that attempt's saved snapshot. */
  private attemptJobs(resourceId: string, validation: Validation, observation: RolloutObservation | undefined): SnapshotJob[] | undefined {
    const run = observation?.run;
    if (run && run.id === validation.scope.runId && run.run_attempt === validation.scope.attempt) return observation!.jobs;
    return this.store.rolloutEvents(resourceId).filter(event => event.kind === 'jobs-snapshot' && event.runId === validation.scope.runId && event.attempt === validation.scope.attempt).at(-1)?.body.jobs as SnapshotJob[] | undefined;
  }
  private approvals(state: WorkspaceState, resourceId: string): AppApproval[] {
    const aliases = new Set(state.nodes.filter(node => node.resourceId === resourceId).map(node => node.id));
    return this.store.rolloutApprovalJobs().filter(job => aliases.has(job.input.nodeId)).map(job => {
      const input = job.input.arguments.input as Record<string, unknown>;
      return { runId: Number(input.runId), attempt: Number(input.attempt), environmentIds: String(input.environmentIds).split(',').map(Number), at: Date.parse(job.updatedAt) };
    });
  }
  private async observation(nodeId: string) {
    const snapshot = await this.resources.cached(nodeId).catch(() => null);
    const detail = snapshot?.detail as unknown as RolloutObservation | undefined;
    return detail && 'jobs' in detail ? detail : undefined;
  }
  private async rollout(nodeId: string) {
    const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId), resource = state.resources.find(record => record.id === node?.resourceId);
    if (!node || resource?.pluginId !== 'github.rollout' || isOffMap(node, state.nodes)) throw new Error('Open a rollout on the map to validate it.');
    return { state, node, resource };
  }
  private async settle() { await this.reconcile(); await this.changed(); }
}
