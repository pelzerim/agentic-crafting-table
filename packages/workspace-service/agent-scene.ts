/** What a Claude item's sheep is told (AGENT-07e): the pose, counts and flags the map draws, derived from the
 * item's own status and its session's background row. Pure, so the hook path and the settle pass agree. */
import { BACKGROUND_STALE_MS, busyHelpers, runsBesidePrompt, taskProgress, waitingOnHelpers } from './agent-background.ts';
import type { BackgroundState } from './agent-background.ts';
import type { GraphNode } from '../../src/graph/graph.ts';

/** A shell command shows once it has been in flight this long, so quick ones never do. */
export const COMMAND_AFTER_MS = 1_500;
/** Once shown, the command pose stays at least this long. */
export const COMMAND_HOLD_MS = 3_000;
/** One-shot moments are written at most this often. */
export const MOMENT_GAP_MS = 4_000;
export type Pose = NonNullable<GraphNode['pose']>;
export type Moment = NonNullable<GraphNode['moment']>;
export type Scene = { pose: Pose | undefined; helpers: number; waiting: boolean; beside: number; tasks: GraphNode['tasks']; bell: boolean; pen: boolean };
type Status = { activity: string; attention: string; attentionNote?: string };

export function commandShowing(shell: BackgroundState['shell'], now: number) {
  if (!shell) return false;
  const until = shell.running ? Infinity : shell.until ?? shell.since, shown = shell.since + COMMAND_AFTER_MS;
  return until >= shown && now >= shown && now < Math.max(until, shown + COMMAND_HOLD_MS);
}

export function agentScene(node: Status, background: BackgroundState | undefined, now: number, { ended = false } = {}): Scene {
  const working = node.activity === 'working', live = background && now - background.observedAt < BACKGROUND_STALE_MS ? background : undefined;
  const pose: Pose | undefined = node.attention === 'input' ? node.attentionNote === 'Agent needs permission' ? 'gate' : 'asking' : node.attention === 'error' ? 'fallen'
    : working ? live?.compacting ? 'shearing' : commandShowing(live?.shell, now) ? 'command' : undefined : ended ? 'ended' : undefined;
  return { pose, helpers: working ? busyHelpers(live, now) : 0, waiting: working && waitingOnHelpers(live, now), beside: ended ? 0 : live?.tasks.filter(runsBesidePrompt).length ?? 0,
    tasks: ended ? undefined : taskProgress(live), bell: !ended && live?.model !== undefined && live.model.now !== live.model.first, pen: !ended && Boolean(live?.worktree) };
}

type Patch = { helpers?: number; waiting?: boolean; pose?: Pose | 'none'; beside?: number; tasks?: { done: number; total: number }; bell?: boolean; pen?: boolean; moment?: Moment };
/** The `node.update` fields that bring the node to the scene, or nothing. A helper that left or arrived takes a moment
 * with it; `happened` (a failed or denied tool) is a moment of its own on a working item, at most one per gap. */
export function sceneChanges(node: Pick<GraphNode, 'helpers' | 'waiting' | 'pose' | 'beside' | 'tasks' | 'bell' | 'pen' | 'moment'>, scene: Scene, now: number, happened?: 'stumble' | 'bump'): Patch | undefined {
  const patch: Patch = {}, had = node.helpers ?? 0;
  if (scene.helpers !== had) patch.helpers = scene.helpers;
  if (scene.waiting !== Boolean(node.waiting)) patch.waiting = scene.waiting;
  if (scene.pose !== node.pose) patch.pose = scene.pose ?? 'none';
  if (scene.beside !== (node.beside ?? 0)) patch.beside = scene.beside;
  if ((scene.tasks?.done ?? 0) !== (node.tasks?.done ?? 0) || (scene.tasks?.total ?? 0) !== (node.tasks?.total ?? 0)) patch.tasks = scene.tasks ?? { done: 0, total: 0 };
  if (scene.bell !== Boolean(node.bell)) patch.bell = scene.bell;
  if (scene.pen !== Boolean(node.pen)) patch.pen = scene.pen;
  const walk = scene.helpers < had ? 'leave' : scene.helpers > had ? 'enter' : undefined, free = !node.moment || now - node.moment.at >= MOMENT_GAP_MS;
  if (walk && (free || node.moment?.kind === 'stumble' || node.moment?.kind === 'bump')) patch.moment = { kind: walk, at: now };
  else if (!walk && happened && free) patch.moment = { kind: happened, at: now };
  return Object.keys(patch).length ? patch : undefined;
}
