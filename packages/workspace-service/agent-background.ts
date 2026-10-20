/** Background work a Claude process still runs after its main turn: background
 * subagents, shells, Monitor watchers and similar tasks. Claude Code reports the
 * in-flight set as `background_tasks` on Stop/SubagentStop hooks; a background
 * Agent launch (PostToolUse `status: "async_launched"`) and SubagentStop are the
 * incremental signals older versions without that snapshot still provide.
 *
 * A teammate is reported as running for the life of its session, idle or not, so
 * its task alone says nothing. What its agent last did decides: a TeammateIdle
 * hook marks it idle, a tool hook shows it in flight or just finished. Signals are
 * keyed by teammate name and matched to a task of that name when the snapshot
 * gives one; otherwise they are counted against the number of teammate tasks.
 *
 * A foreground subagent is in no snapshot. While the main turn is active its own
 * tool hooks are the only sign of it: `helpers` keeps the last one per agent id
 * until its SubagentStop or the end of the turn. */
export type BackgroundTask = { id: string; kind: string; name?: string };
export type BackgroundSnapshotEntry = { id: string; type: string; status?: string; name?: string };
export type TeammateSignal = { key: string; at: number; state: 'tool' | 'quiet' | 'idle' };
export type HelperSignal = { id: string; at: number; state: 'tool' | 'quiet' };
/** `team.at` is when the teammates last had a reason to be working: first seen, or messaged by the main thread. */
export type BackgroundState = { tasks: BackgroundTask[]; ended: string[]; snapshotAt: number; turnEnded: boolean; observedAt: number; team?: { at: number; signals: TeammateSignal[] }; waking?: boolean; helpers?: HelperSignal[];
  /** The main thread's shell commands as one stretch: when the first started, how many are in flight, when the last ended. */
  shell?: { since: number; running: number; until?: number }; compacting?: boolean;
  /** The session's current task list by id, the model it started on and runs on now, and whether its working directory is a Claude worktree. */
  list?: { created: string[]; done: string[] }; model?: { first: string; now: string }; worktree?: boolean };
export type BackgroundChange = { observedAt: number; snapshot?: BackgroundSnapshotEntry[]; launched?: BackgroundTask; ended?: string; turnEnded?: boolean; teammate?: Pick<TeammateSignal, 'key' | 'state'>; poked?: boolean; recipient?: string; helper?: Pick<HelperSignal, 'id' | 'state'>; shell?: 'start' | 'end';
  compact?: 'start' | 'end'; task?: { id: string; state: 'created' | 'completed' }; model?: { to: string; from?: string }; worktree?: boolean };

/** Without any hook from its process for this long, outstanding work no longer keeps an item working. */
export const BACKGROUND_STALE_MS = 2 * 60 * 60 * 1000;
/** A teammate between two tool calls is generating; longer than any such pause without a hook means it sits idle. */
export const TEAMMATE_QUIET_MS = 5 * 60 * 1000;
const ENDED_LIMIT = 200, SIGNAL_LIMIT = 50;
const inFlight = (status?: string) => status === undefined || status === 'running' || status === 'pending';
const isTeammate = (task: BackgroundTask) => task.kind === 'teammate';
/** Named agents run as `a<name>-<16 hex>`; the name is what TeammateIdle reports. */
export const teammateKey = (agentId: string) => /^a(.+)-[0-9a-f]{16}$/.exec(agentId)?.[1] ?? agentId;

export function applyBackground(state: BackgroundState | undefined, change: BackgroundChange): BackgroundState {
  const current = state ?? { tasks: [], ended: [], snapshotAt: 0, turnEnded: false, observedAt: 0 };
  const ended = change.ended && !current.ended.includes(change.ended) ? [...current.ended, change.ended].slice(-ENDED_LIMIT) : current.ended;
  let tasks = current.tasks, snapshotAt = current.snapshotAt;
  if (change.snapshot && change.observedAt >= snapshotAt) {
    tasks = change.snapshot.filter(entry => inFlight(entry.status)).map(entry => ({ id: entry.id, kind: entry.type, ...(entry.name ? { name: entry.name } : {}) }));
    snapshotAt = change.observedAt;
  }
  if (change.launched && change.observedAt >= snapshotAt) tasks = [...tasks, change.launched];
  const seen = new Set<string>();
  tasks = tasks.filter(task => !ended.includes(task.id) && !seen.has(task.id) && seen.add(task.id));
  let at = current.team?.at ?? (current.tasks.some(isTeammate) ? current.snapshotAt : 0), signals = current.team?.signals ?? [];
  if (change.poked || tasks.some(task => isTeammate(task) && !current.tasks.some(known => known.id === task.id))) at = Math.max(at, change.observedAt);
  if (change.poked) {
    const woken = (signal: TeammateSignal) => signal.state !== 'tool' && signal.at <= change.observedAt && (!change.recipient || signal.key === change.recipient);
    signals = signals.map(signal => woken(signal) ? { ...signal, at: change.observedAt, state: 'quiet' as const } : signal);
    if (change.recipient && !signals.some(signal => signal.key === change.recipient)) signals = [...signals, { key: change.recipient, at: change.observedAt, state: 'quiet' as const }].slice(-SIGNAL_LIMIT);
  }
  if (change.ended) { const key = teammateKey(change.ended); signals = signals.filter(signal => signal.key !== key || signal.state === 'idle' || signal.at > change.observedAt); }
  if (change.teammate && !signals.some(signal => signal.key === change.teammate!.key && signal.at > change.observedAt))
    signals = [...signals.filter(signal => signal.key !== change.teammate!.key), { ...change.teammate, at: change.observedAt }].slice(-SIGNAL_LIMIT);
  const turnEnded = change.turnEnded ?? current.turnEnded;
  let helpers = turnEnded ? [] : (current.helpers ?? []).filter(helper => helper.id !== change.ended && !tasks.some(task => task.id === helper.id));
  // With teammates listed, an unknown agent's tool hooks are a teammate's and are counted there.
  if (change.helper && !turnEnded && !ended.includes(change.helper.id) && !tasks.some(task => isTeammate(task) || task.id === change.helper!.id) && !helpers.some(helper => helper.id === change.helper!.id && helper.at > change.observedAt))
    helpers = [...helpers.filter(helper => helper.id !== change.helper!.id), { ...change.helper, at: change.observedAt }].slice(-SIGNAL_LIMIT);
  const forgotten = snapshotAt !== current.snapshotAt && !tasks.some(isTeammate);
  const waking = change.turnEnded === undefined && (current.waking || (current.turnEnded && current.tasks.some(task => task.id === change.ended)));
  let shell = current.shell;
  if (change.shell === 'start') shell = shell?.running ? { since: shell.since, running: shell.running + 1 } : { since: change.observedAt, running: 1 };
  else if (shell?.running && (change.shell === 'end' || change.turnEnded)) {
    const running = change.turnEnded ? 0 : shell.running - 1;
    shell = running ? { since: shell.since, running } : { since: shell.since, running: 0, until: change.observedAt };
  }
  const compacting = change.compact === 'start' || (current.compacting && change.compact !== 'end' && !change.turnEnded);
  let list = current.list;
  if (change.task) {
    const { id, state: phase } = change.task, finished = list !== undefined && list.created.length > 0 && list.created.every(known => list!.done.includes(known));
    const base = phase === 'created' && finished && !list!.created.includes(id) ? { created: [], done: [] } : list ?? { created: [], done: [] }, add = (ids: string[]) => ids.includes(id) ? ids : [...ids, id].slice(-ENDED_LIMIT);
    list = { created: add(base.created), done: phase === 'completed' ? add(base.done) : base.done };
  }
  const model = change.model ? { first: current.model?.first ?? change.model.from ?? change.model.to, now: change.model.to } : current.model;
  const worktree = change.worktree ?? current.worktree;
  return { tasks, ended, snapshotAt, turnEnded, observedAt: Math.max(current.observedAt, change.observedAt),
    ...(!forgotten && (signals.length || tasks.some(isTeammate)) ? { team: { at, signals } } : {}), ...(waking ? { waking } : {}), ...(helpers.length ? { helpers } : {}), ...(shell ? { shell } : {}), ...(compacting ? { compacting: true } : {}), ...(list ? { list } : {}), ...(model ? { model } : {}), ...(worktree ? { worktree: true } : {}) };
}

/** A shell or a watcher runs beside the prompt: it may never end, ends without a hook, and wakes the
 * main thread only if something happens. The agent it belongs to is at its prompt meanwhile. */
export const runsBesidePrompt = (task: BackgroundTask) => task.kind === 'shell' || task.kind === 'monitor';

/** The tasks that still keep an ended turn working at `now`: every task but those beside the prompt and a teammate that is idle or has gone quiet. */
export function outstanding(state: BackgroundState, now: number): BackgroundTask[] {
  const held = state.tasks.filter(task => !runsBesidePrompt(task)), teammates = held.filter(isTeammate);
  if (!teammates.length) return held;
  const signals = state.team?.signals ?? [], fresh = now - (state.team?.at ?? state.snapshotAt) < TEAMMATE_QUIET_MS;
  const live = (signal?: TeammateSignal) => signal !== undefined && now - signal.at < (signal.state === 'tool' ? BACKGROUND_STALE_MS : signal.state === 'quiet' ? TEAMMATE_QUIET_MS : 0);
  const own = (task: BackgroundTask) => signals.find(signal => signal.key === task.name);
  const unmatched = teammates.filter(task => !own(task)), spare = signals.filter(signal => !teammates.some(task => task.name === signal.key));
  // Once every unnamed teammate has reported, their own marks say how many are busy.
  const reported = spare.length >= unmatched.length;
  const busy = reported ? spare.filter(live).length : Math.max(fresh ? unmatched.length - spare.filter(signal => signal.state === 'idle').length : 0, spare.filter(live).length);
  const waiting = new Set([...teammates.filter(task => live(own(task))), ...unmatched.slice(0, busy)]);
  return held.filter(task => !isTeammate(task) || waiting.has(task));
}

/** How many subagents and teammates of a session are busy at `now`: its outstanding background subagents and
 * teammates, and during an active main turn every foreground agent with a tool in flight or one that ended
 * inside the teammate quiet window. Nothing counts once the process has been silent for the stale limit. */
export function busyHelpers(state: BackgroundState | undefined, now: number): number {
  if (!state || now - state.observedAt >= BACKGROUND_STALE_MS) return 0;
  const background = outstanding(state, now).filter(task => task.kind === 'subagent' || isTeammate(task)).length;
  const foreground = state.turnEnded ? 0 : (state.helpers ?? []).filter(helper => now - helper.at < (helper.state === 'tool' ? BACKGROUND_STALE_MS : TEAMMATE_QUIET_MS)).length;
  return background + foreground;
}

/** Progress of the session's current task list, if it has one. */
export const taskProgress = (state: BackgroundState | undefined) => state?.list?.created.length ? { done: state.list.done.length, total: state.list.created.length } : undefined;

/** Whether the session itself only waits: its main turn has ended, it is not waking to read a result, and a helper is busy. */
export const waitingOnHelpers = (state: BackgroundState | undefined, now: number) => Boolean(state?.turnEnded && !state.waking && busyHelpers(state, now) > 0);

const labels: [kind: string, one: string, many: string][] = [
  ['subagent', 'subagent', 'subagents'], ['teammate', 'teammate', 'teammates'], ['monitor', 'watcher', 'watchers'],
  ['shell', 'background shell', 'background shells'], ['workflow', 'workflow', 'workflows'],
];

export function backgroundSummary(tasks: BackgroundTask[]) {
  if (!tasks.length) return undefined;
  const count = (match: (kind: string) => boolean) => tasks.filter(task => match(task.kind)).length;
  const parts = labels.map(([kind, one, many]) => [count(candidate => candidate === kind), one, many] as const);
  parts.push([count(kind => !labels.some(([known]) => known === kind)), 'background task', 'background tasks']);
  return `Waiting on ${parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(' · ')}`;
}
