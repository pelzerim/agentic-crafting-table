import * as z from 'zod/v4';
import { awaitingAnswer } from '../../src/graph/attention.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FROM_TABLE, prompting as sending, promptAgent } from './agent-prompt.ts';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { VideoSkill } from '../core/settings.ts';
import type { ProjectSkill, ProjectSkillCatalog, SkillRun } from '../core/skills.ts';
import type { JobRecord, SqliteStore } from './sqlite-store.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { findById } from '../../src/graph/lookup.ts';
import { webLinkUrl } from '../../src/resource-plugins/define.ts';
import { providerLabels } from '../../src/agents/display-names.ts';

export const PR_VIDEO_LINE = 'When the video is ready, add the MP4 to the map as a Video item linked to this pull request.';
export const SESSION_VIDEO_REQUEST = 'Explain what you built in this session. When the video is ready, add the MP4 to the map as a Video item linked to this session.';
/** The skill id a built-in launch carries; it names no installed skill. */
export const BUILT_IN_VIDEO = 'built-in:video';

/** The built-in video skill: the repository folder in development, else the packaged app's resources, outside app.asar. */
export function videoSkillFolder(entry: string) {
  const root = dirname(dirname(entry)), source = join(root, 'apps', 'desktop', 'video-skill');
  return existsSync(source) ? source : join(dirname(root), 'video-skill');
}
const mapLine = (link: string) => `When the MP4 is ready, add it to the map with the workspace tools: item.add with pluginId "workspace.video", resourceId "video:<absolute MP4 path>", data {"source": "<absolute MP4 path>"}, a short title, and links: [${link}]. Never open, post or commit the video.`;
/** The built-in task for a pull request: a video summarizing it, added to the map linked to the pull request. */
export function pullRequestVideoTask(folder: string, url: string, prNodeId: string) {
  return [
    `Make a short narrated video that summarizes the pull request ${url}.`,
    `Read "${folder}/SKILL.md" and follow it; its scripts and kit are in that folder. Keep the path quoted, since it may contain spaces.`,
    'Cover what the pull request changes for the person using it, the working result, how it works in one diagram, and the risk.',
    mapLine(`{"otherId": "${prNodeId}", "kind": "reference"}`),
  ].join('\n');
}
/** The built-in task for an agent session: a video explaining its own work, added to the map linked to the session. */
export function sessionVideoTask(folder: string) {
  return [
    'Make a short narrated video that explains this session.',
    `Read "${folder}/SKILL.md" and follow it; its scripts and kit are in that folder. Keep the path quoted, since it may contain spaces.`,
    'Cover the overall goal, what you built, the latest changes, and the key decisions and why you made them.',
    mapLine('{"agent": true, "kind": "reference"}'),
  ].join('\n');
}
const READY = 'Wait until the agent is ready for a new prompt.', HELD = 'The agent has not picked up the last video request yet. Check its terminal before asking again.';
const schema = z.object({ requestId: z.string().uuid() }).strict();
const UNSETTLED: ReadonlySet<JobRecord['state']> = new Set(['queued', 'running', 'waiting', 'outcome-unknown']);
/** What a session prompt remembers to tell whether the agent took a turn after it. */
interface Prompted { requestId: string; sessionId: string; promptAt: string; completion?: string }
// Pull request launches in flight: a click that arrives meanwhile answers with the same launch.
const launching = new Map<string, Promise<{ nodeId: string }>>();

export interface VideoExplainHost {
  store: SqliteStore; sessions?: SessionCoordinator; skill(): VideoSkill; enabled(provider: string): boolean;
  /** The built-in video skill's folder, used while no skill is chosen. */
  builtIn: string;
  skills(input: { provider: string; projectId?: string; cwd?: string }): Promise<ProjectSkillCatalog>;
  skillPrompt(provider: string, skill: ProjectSkill, argumentsText: string): string;
  defaultModel(provider: string): Promise<string>;
  /** `builtIn` names a host-built task: the run's arguments are its whole opening prompt. */
  runSkill?(projectId: string, run: SkillRun, builtIn?: string): Promise<unknown>;
}

/** A UUID derived from the request, so a retried launch sends the same input. */
const derivedId = (requestId: string, part: string) => {
  const hex = createHash('sha256').update(`${requestId}:${part}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const label = (provider: string) => providerLabels[provider] ?? provider;
/** The latest Explain in video request for this item, from the job journal. */
const latestJob = (store: SqliteStore, nodeId: string) => store.listJobs().findLast(job => job.input.action === 'video.explain' && job.input.nodeId === nodeId);

/** The launch for a pull request, in a new session beside the PR and connected from it: a chosen skill gets the PR URL and
 * where the video goes, the built-in one its whole task. */
export function pullRequestVideoRun(pr: { id: string; position: { x: number; y: number } }, task: string, launch: { provider: VideoSkill['provider']; model: string; skillId: string; cwd?: string }, requestId: string): SkillRun {
  return { requestId, nodeId: derivedId(requestId, 'node'), resourceId: derivedId(requestId, 'resource'), ...launch,
    arguments: task, position: { x: pr.position.x + 300, y: pr.position.y + 140 },
    connection: { id: derivedId(requestId, 'connection'), otherId: pr.id, kind: 'context', sourceIsNew: false } };
}

/** Explain in video (VIDEO-EXPLAIN): a pull request launches the built-in or chosen skill in a new session; an agent
 * session is prompted to run it on what it built. A request for the same item that may still be running is reused, never sent twice. */
export async function explainInVideo(control: WorkspaceControl, host: VideoExplainHost, nodeId: string, input: unknown) {
  const { requestId } = schema.parse(input), skill = host.skill(), state = await control.read();
  const node = findById(state.nodes, nodeId), resource = findById(state.resources, node?.resourceId);
  if (node && resource?.pluginId === 'github.pull-request') {
    const running = launching.get(node.id);
    if (running) return running;
    const launch = pullRequest(control, host, state, node, resource.data, skill, requestId).finally(() => launching.delete(node.id));
    launching.set(node.id, launch);
    return launch;
  }
  if (!node || !resource || resource.pluginId !== 'agent.session' || isArchived(node, state.nodes)) throw new Error('Explain in video works on pull requests and agent sessions.');
  if (host.store.jobByRequest(`video-explain:${requestId}`)?.state === 'succeeded') return { sent: true };
  const sessionId = resource.data.sessionId, provider = String(resource.data.provider ?? 'claude'), sessions = host.sessions;
  if (typeof sessionId !== 'string' || !sessions) throw new Error('Resume the agent first.');
  if (node.activity !== 'idle' || awaitingAnswer(node) || sending.has(sessionId)) throw new Error(READY);
  sending.add(sessionId);
  try {
    const ready = async (current: WorkspaceState) => {
      const fresh = findById(current.nodes, nodeId);
      if (!fresh || isArchived(fresh, current.nodes) || findById(current.resources, fresh.resourceId)?.data.sessionId !== sessionId) throw new Error('The agent changed. Ask again.');
      if (fresh.activity !== 'idle' || awaitingAnswer(fresh)) throw new Error(READY);
      const live = await sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId, after: Number.MAX_SAFE_INTEGER });
      if (findById(current.nodes, live.session.nodeId)?.resourceId !== resource.id) throw new Error('The process belongs to a different agent.');
      if (live.session.native && live.session.native.status !== 'idle') throw new Error(READY);
      if (live.session.state !== 'running' || live.session.stopRequestedAt || live.session.readOnly) throw new Error('Resume the agent first.');
      return { session: live.session, node: fresh };
    };
    const { session } = await ready(state);
    // A prompt holds the session until the agent ends a turn after it, so a retry after a lost reply never types it twice.
    const held = latestJob(host.store, nodeId), prompted = held?.input.arguments as Prompted | undefined;
    const holding = held && (UNSETTLED.has(held.state) || held.state === 'succeeded') && prompted?.sessionId === sessionId
      && !(node.turnEndedAt && prompted.promptAt && node.turnEndedAt > prompted.promptAt) && node.attentionEvents?.completion === prompted?.completion ? held : undefined;
    if (holding && holding.state !== 'queued') throw new Error(HELD);
    let prompt = sessionVideoTask(host.builtIn);
    if (skill.skillId) {
      const catalog = await host.skills({ provider, cwd: session.cwd });
      const selected = catalog.skills.find(candidate => candidate.name === skill.name && !candidate.unavailable);
      if (!selected) throw new Error(`${label(provider)} has no ${skill.name} skill in this session's folder.`);
      prompt = host.skillPrompt(provider, selected, SESSION_VIDEO_REQUEST);
    }
    const fresh = (await ready(await control.read())).node;
    const job = host.store.enqueueJob(holding?.requestKey ?? `video-explain:${requestId}`, holding?.input ?? { action: 'video.explain', nodeId,
      arguments: { requestId, sessionId, promptAt: new Date().toISOString(), ...(fresh.attentionEvents?.completion ? { completion: fresh.attentionEvents.completion } : {}) } satisfies Prompted as never });
    if (job.state === 'succeeded') return { sent: true };
    if (job.state !== 'queued') throw new Error(HELD);
    host.store.transitionJob(job.id, 'queued', 'running');
    try {
      await promptAgent(sessions, sessionId, prompt, FROM_TABLE);
      host.store.transitionJob(job.id, 'running', 'succeeded', { result: { sent: true } });
      return { sent: true };
    } catch (error) { host.store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'Check the agent before asking again.' }); throw error; }
  } finally { sending.delete(sessionId); }
}

const turnedOff = (provider: string) => new Error(`${label(provider)} is turned off. Turn it on in Settings → Agents → ${label(provider)} → Enabled.`);

/** Whether a video session's process still runs. */
async function alive(host: VideoExplainHost, state: WorkspaceState, nodeId: string) {
  const session = findById(state.nodes, nodeId), sessionId = findById(state.resources, session?.resourceId)?.data.sessionId;
  if (!session || isArchived(session, state.nodes) || typeof sessionId !== 'string' || !host.sessions) return false;
  const live = await host.sessions.runtime.call<SessionSnapshot>('sessions.read', { sessionId, after: Number.MAX_SAFE_INTEGER }).catch(() => undefined);
  return live?.session.state === 'running' && !live.session.stopRequestedAt;
}
/** An earlier video session is still at work while its process runs and it works, asks, or has not ended its first turn. */
async function busy(host: VideoExplainHost, state: WorkspaceState, nodeId: string) {
  const session = findById(state.nodes, nodeId);
  if (!session || (session.activity !== 'working' && session.attention !== 'input' && (session.turnEndedAt || session.attentionEvents?.completion))) return false;
  return alive(host, state, nodeId);
}

async function pullRequest(control: WorkspaceControl, host: VideoExplainHost, state: WorkspaceState, node: WorkspaceState['nodes'][number], data: Record<string, unknown>, skill: VideoSkill, requestId: string) {
  if (!host.runSkill) throw new Error('Agent runtime is unavailable');
  if (!host.enabled(skill.provider)) throw turnedOff(skill.provider);
  const template = control.registry.get('github.pull-request')?.webLink?.template, url = template && webLinkUrl(template, data as never);
  if (!url || isArchived(node, state.nodes)) throw new Error('This pull request is no longer on the map.');
  if (!node.projectId) throw new Error('Move this pull request into a project first.');
  const held = latestJob(host.store, node.id), launched = (held?.result as { nodeId?: unknown } | undefined)?.nodeId;
  if (held?.state === 'succeeded' && typeof launched === 'string') {
    if ((held.input.arguments as { requestId?: unknown }).requestId === requestId) return { nodeId: launched };
    if (await busy(host, state, launched)) return { nodeId: launched, reused: true };
  }
  let job: JobRecord;
  // A launch that may already run is replayed as it was: the same request and plan, so the supervisor starts it once.
  if (held && UNSETTLED.has(held.state)) job = held;
  else {
    let skillId = BUILT_IN_VIDEO, task = pullRequestVideoTask(host.builtIn, url, node.id), cwd: string | undefined;
    if (skill.skillId) {
      const catalog = await host.skills({ provider: skill.provider, projectId: node.projectId });
      const selected = catalog.skills.find(candidate => candidate.name === skill.name && !candidate.unavailable);
      if (!selected) throw new Error(`${label(skill.provider)} has no ${skill.name} skill in this project's folder.`);
      skillId = selected.id; task = `${url}\n${PR_VIDEO_LINE}`; cwd = catalog.cwd;
    }
    const run = pullRequestVideoRun(node, task, { provider: skill.provider, model: await host.defaultModel(skill.provider), skillId, ...(cwd ? { cwd } : {}) }, requestId);
    if (!host.enabled(skill.provider)) throw turnedOff(skill.provider);
    job = host.store.enqueueJob(`video-explain:${requestId}`, { action: 'video.explain', nodeId: node.id, arguments: { requestId, projectId: node.projectId, run } });
  }
  const { projectId, run } = job.input.arguments as { projectId: string; run: SkillRun };
  // A concurrent click on the same request may have settled the job first.
  const settle = (next: 'succeeded' | 'failed' | 'outcome-unknown', patch: { result?: unknown; error?: string }) => { const current = host.store.getJob(job.id)!; if (UNSETTLED.has(current.state)) host.store.transitionJob(job.id, current.state, next, patch); };
  if (job.state === 'queued' || job.state === 'waiting') job = host.store.transitionJob(job.id, job.state, 'running');
  // A replay starts the saved run's provider, which may have been turned off since.
  if (!host.enabled(run.provider)) {
    if (await alive(host, await control.read(), run.nodeId)) { settle('succeeded', { result: { nodeId: run.nodeId } }); return { nodeId: run.nodeId, reused: true }; }
    settle('failed', { error: turnedOff(run.provider).message }); throw turnedOff(run.provider);
  }
  try { await host.runSkill(projectId, run, run.skillId === BUILT_IN_VIDEO ? 'Explain in video' : undefined); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settle((error as { code?: string }).code === 'LAUNCH_UNCERTAIN' ? 'outcome-unknown' : 'failed', { error: message }); throw error;
  }
  settle('succeeded', { result: { nodeId: run.nodeId } });
  return { nodeId: run.nodeId };
}
