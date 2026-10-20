import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBackground, backgroundSummary, busyHelpers, outstanding, taskProgress, teammateKey, waitingOnHelpers, BACKGROUND_STALE_MS, TEAMMATE_QUIET_MS } from './agent-background.ts';
import type { BackgroundState } from './agent-background.ts';

test('background work counts launches and snapshots, and drops tasks that ended', () => {
  let state = applyBackground(undefined, { observedAt: 1, launched: { id: 'a', kind: 'subagent' } });
  state = applyBackground(state, { observedAt: 2, launched: { id: 'b', kind: 'subagent' } });
  assert.deepEqual(state.tasks.map(task => task.id), ['a', 'b']);
  state = applyBackground(state, { observedAt: 3, ended: 'a' });
  assert.deepEqual(state.tasks.map(task => task.id), ['b']);
  state = applyBackground(state, { observedAt: 4, snapshot: [
    { id: 'b', type: 'subagent', status: 'running' }, { id: 'shell-1', type: 'shell', status: 'running' },
    { id: 'm', type: 'monitor' }, { id: 'done', type: 'shell', status: 'completed' },
  ] });
  assert.deepEqual(state.tasks, [{ id: 'b', kind: 'subagent' }, { id: 'shell-1', kind: 'shell' }, { id: 'm', kind: 'monitor' }]);
  state = applyBackground(state, { observedAt: 5, snapshot: [] });
  assert.deepEqual(state.tasks, []);
});

test('duplicate and out-of-order background signals do not revive finished work', () => {
  let state = applyBackground(undefined, { observedAt: 10, ended: 'a' });
  state = applyBackground(state, { observedAt: 9, launched: { id: 'a', kind: 'subagent' } });
  assert.deepEqual(state.tasks, [], 'a stop that overtook its launch wins');
  state = applyBackground(state, { observedAt: 11, launched: { id: 'b', kind: 'subagent' } });
  state = applyBackground(state, { observedAt: 12, launched: { id: 'b', kind: 'subagent' } });
  assert.equal(state.tasks.length, 1, 'a repeated launch counts once');
  state = applyBackground(state, { observedAt: 20, snapshot: [{ id: 'c', type: 'shell', status: 'running' }] });
  state = applyBackground(state, { observedAt: 15, snapshot: [{ id: 'b', type: 'subagent', status: 'running' }] });
  assert.deepEqual(state.tasks, [{ id: 'c', kind: 'shell' }], 'an older snapshot is ignored');
  state = applyBackground(state, { observedAt: 18, launched: { id: 'late', kind: 'subagent' } });
  assert.deepEqual(state.tasks, [{ id: 'c', kind: 'shell' }], 'a newer snapshot without the task means it already finished');
  state = applyBackground(state, { observedAt: 21, snapshot: [{ id: 'a', type: 'subagent', status: 'running' }] });
  assert.deepEqual(state.tasks, [], 'a task that ended stays ended');
});

test('the main turn flag follows the latest main-thread observation', () => {
  let state = applyBackground(undefined, { observedAt: 1, turnEnded: true });
  assert.equal(state.turnEnded, true);
  state = applyBackground(state, { observedAt: 2, ended: 'x' });
  assert.equal(state.turnEnded, true, 'background-only signals keep the flag');
  state = applyBackground(state, { observedAt: 3, turnEnded: false });
  assert.equal(state.turnEnded, false); assert.equal(state.observedAt, 3);
});

test('waiting summaries name each kind of outstanding work', () => {
  assert.equal(backgroundSummary([]), undefined);
  assert.equal(backgroundSummary([{ id: 'a', kind: 'subagent' }]), 'Waiting on 1 subagent');
  assert.equal(backgroundSummary([{ id: 'a', kind: 'subagent' }, { id: 'b', kind: 'subagent' }]), 'Waiting on 2 subagents');
  assert.equal(backgroundSummary([{ id: 'm', kind: 'monitor' }, { id: 'a', kind: 'subagent' }]), 'Waiting on 1 subagent · 1 watcher');
  assert.equal(backgroundSummary([{ id: 's', kind: 'shell' }, { id: 't', kind: 'MCP task' }, { id: 'u', kind: 'cloud session' }]), 'Waiting on 1 background shell · 2 background tasks');
});

const Q = TEAMMATE_QUIET_MS, teammate = (id: string, name?: string) => ({ id, type: 'teammate', status: 'running', ...(name ? { name } : {}) });
const ids = (state: BackgroundState, now: number) => outstanding(state, now).map(task => task.id);
const signal = (state: BackgroundState, observedAt: number, key: string, phase: 'tool' | 'quiet' | 'idle') => applyBackground(state, { observedAt, teammate: { key, state: phase } });

test('a teammate that went idle no longer counts; a busy one and every other kind still do', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [teammate('t1'), teammate('t2'), { id: 'a1', type: 'subagent', status: 'running' }] });
  assert.deepEqual(ids(state, 1_500), ['t1', 't2', 'a1']);
  state = signal(state, 2_000, 'scout', 'idle');
  assert.equal(backgroundSummary(outstanding(state, 2_500)), 'Waiting on 1 subagent · 1 teammate', 'one idle, one busy counts one');
  state = signal(state, 3_000, 'builder', 'idle');
  assert.deepEqual(ids(state, 3_500), ['a1'], 'idle teammates leave the subagent outstanding');
  state = applyBackground(state, { observedAt: 4_000, ended: 'a1' });
  assert.deepEqual(ids(state, 4_500), []); assert.equal(state.tasks.length, 2, 'the teammates are still known');
  state = signal(state, 5_000, 'scout', 'tool');
  assert.deepEqual(ids(state, 5_500), ['t1'], 'a tool from an idle teammate makes it busy again');
  state = signal(state, 4_900, 'scout', 'idle');
  assert.deepEqual(ids(state, 5_500), ['t1'], 'an older idle mark does not override newer work');
});

test('an idle mark is matched to its task by name, otherwise counted against the teammates', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [teammate('t1', 'scout'), teammate('t2', 'builder')] });
  assert.deepEqual(state.tasks[0], { id: 't1', kind: 'teammate', name: 'scout' });
  state = signal(state, 2_000, 'builder', 'idle');
  assert.deepEqual(ids(state, 2_500), ['t1'], 'the named task is the idle one');
  state = signal(state, 3_000, 'someone-else', 'idle');
  assert.deepEqual(ids(state, 3_500), [], 'a mark that names no task still takes one teammate off the count');
  state = signal(state, 4_000, 'a-third', 'idle');
  assert.deepEqual(ids(state, 4_500), [], 'more marks than teammates is not negative');
  assert.equal(teammateKey('ascout-0123456789abcdef'), 'scout');
  assert.equal(teammateKey('a0123456789abcdef0'), 'a0123456789abcdef0', 'an unnamed agent keeps its id');
});

test('without any idle mark a teammate counts only while its activity is recent or a tool is in flight', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [teammate('t1')] });
  assert.deepEqual(ids(state, 1_000 + Q - 1), ['t1'], 'a teammate first seen just now gets the quiet window');
  assert.deepEqual(ids(state, 1_000 + Q), []);
  state = signal(state, 2_000, 'scout', 'tool');
  assert.deepEqual(ids(state, 2_000 + 10 * Q), ['t1'], 'a long tool call is not quiet');
  assert.deepEqual(ids(state, 2_000 + BACKGROUND_STALE_MS), [], 'a tool whose end was lost stops counting');
  state = signal(state, 3_000, 'scout', 'quiet');
  assert.deepEqual(ids(state, 3_000 + Q - 1), ['t1']); assert.deepEqual(ids(state, 3_000 + Q), []);
  state = applyBackground(state, { observedAt: 3_000 + 2 * Q, turnEnded: true, snapshot: [teammate('t1')] });
  assert.deepEqual(ids(state, 3_001 + 2 * Q), [], 'a later snapshot of the same teammate is not activity');
  state = applyBackground(state, { observedAt: 3_000 + 3 * Q, turnEnded: true, snapshot: [teammate('t1'), teammate('t9')] });
  assert.deepEqual(ids(state, 3_001 + 3 * Q), ['t1', 't9'], 'a new teammate starts the window again');
});

test('a main turn that messages a teammate makes idle teammates count again', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [teammate('t1', 'scout')] });
  state = signal(state, 2_000, 'scout', 'idle');
  state = applyBackground(state, { observedAt: 3_000, turnEnded: false });
  assert.deepEqual(ids(state, 3_500), [], 'a turn that leaves the team alone wakes nobody');
  state = applyBackground(state, { observedAt: 4_000, turnEnded: false, poked: true });
  assert.deepEqual(ids(state, 4_000 + Q - 1), ['t1']); assert.deepEqual(ids(state, 4_000 + Q), []);
});

test('teammates listed without names count by their own marks once each has reported, and a message wakes only its recipient', () => {
  const names = ['scout-1', 'scout-2', 'scout-2-v2', 'search-batching', 'scout-3', 'scout-4'];
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, snapshot: names.map((_, index) => teammate(`t${index}`)) });
  for (const name of names) state = signal(state, 2_000, name, name === 'scout-4' ? 'tool' : 'idle');
  state = applyBackground(state, { observedAt: 3_000, turnEnded: false, poked: true, recipient: 'scout-4' });
  assert.equal(busyHelpers(state, 3_500), 1, 'five idle teammates and one at work is one busy teammate');
  state = applyBackground(state, { observedAt: 4_000, turnEnded: false, poked: true, recipient: 'scout-1' });
  assert.equal(busyHelpers(state, 4_500), 2, 'the teammate just messaged may be at work again');
  assert.equal(busyHelpers(state, 4_000 + Q), 1, 'and goes quiet without a hook');
  state = applyBackground(state, { observedAt: 5_000, turnEnded: false, poked: true });
  assert.equal(busyHelpers(state, 5_500), 6, 'a message without a known recipient may wake any of them');
});

test('an agent that stops takes its activity with it but keeps an idle mark', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [teammate('t1')] });
  state = signal(state, 2_000, 'a0123456789abcdef0', 'tool');
  state = applyBackground(state, { observedAt: 3_000, ended: 'a0123456789abcdef0' });
  assert.deepEqual(ids(state, 1_000 + Q), [], 'a finished subagent is not a busy teammate');
  state = signal(state, 4_000, 'scout', 'idle');
  state = applyBackground(state, { observedAt: 5_000, ended: 'ascout-0123456789abcdef' });
  assert.deepEqual(ids(state, 5_500), []);
  state = applyBackground(state, { observedAt: 6_000, turnEnded: true, snapshot: [] });
  assert.equal(state.team, undefined, 'a snapshot without teammates forgets the team');
});

test('a stored row from before teammate tracking parses and stops counting once quiet', () => {
  const row: BackgroundState = JSON.parse('{"tasks":[{"id":"t1a2b3c4d","kind":"teammate"},{"id":"s1","kind":"workflow"}],"ended":["a0123456789abcdef0"],"snapshotAt":1000,"turnEnded":true,"observedAt":1000}');
  assert.deepEqual(ids(row, 1_000 + Q - 1), ['t1a2b3c4d', 's1']); assert.deepEqual(ids(row, 1_000 + Q), ['s1']);
  const next = applyBackground(row, { observedAt: 1_000 + 2 * Q, turnEnded: true, snapshot: [teammate('t1a2b3c4d')] });
  assert.deepEqual(ids(next, 1_001 + 2 * Q), [], 'the next snapshot keeps when the teammate was first seen');
  assert.deepEqual(ids(signal(row, 2_000, 'scout', 'idle'), 2_500), ['s1']);
});

test('a tracked task ending after the turn marks the main thread as about to wake', () => {
  let state = applyBackground(undefined, { observedAt: 1, turnEnded: true, snapshot: [{ id: 'a', type: 'subagent' }] });
  assert.equal(state.waking, undefined);
  state = applyBackground(state, { observedAt: 2, ended: 'unknown' }); assert.equal(state.waking, undefined);
  state = applyBackground(state, { observedAt: 3, ended: 'a' }); assert.equal(state.waking, true);
  state = signal(state, 4, 'scout', 'idle'); assert.equal(state.waking, true);
  state = applyBackground(state, { observedAt: 5, turnEnded: true }); assert.equal(state.waking, undefined);
});

test('busy helpers count background subagents and busy teammates, never an idle or quiet teammate', () => {
  assert.equal(busyHelpers(undefined, 1), 0);
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [
    { id: 'a', type: 'subagent', status: 'running' }, { id: 'sh', type: 'shell', status: 'running' }, { id: 'm', type: 'monitor' },
    { id: 't1', type: 'teammate', status: 'running', name: 'scout' }, { id: 't2', type: 'teammate', status: 'running', name: 'builder' },
  ] });
  assert.equal(busyHelpers(state, 1_001), 3, 'shells and watchers are not helpers; freshly listed teammates are busy');
  state = applyBackground(state, { observedAt: 2_000, teammate: { key: 'scout', state: 'idle' } });
  assert.equal(busyHelpers(state, 2_001), 2);
  state = applyBackground(state, { observedAt: 3_000, teammate: { key: 'builder', state: 'quiet' } });
  assert.equal(busyHelpers(state, 3_000 + TEAMMATE_QUIET_MS - 1), 2);
  assert.equal(busyHelpers(state, 3_000 + TEAMMATE_QUIET_MS), 1, 'a teammate past the quiet window no longer counts');
  state = applyBackground(state, { observedAt: 4_000, ended: 'a' });
  assert.equal(busyHelpers(state, 4_001), 1);
  assert.equal(busyHelpers(state, state.observedAt + BACKGROUND_STALE_MS), 0, 'nothing counts once the process has been silent for the stale limit');
});

test('a foreground subagent counts from its first tool hook to its stop, while the main turn is active', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false });
  assert.equal(busyHelpers(state, 1_000), 0);
  state = applyBackground(state, { observedAt: 2_000, helper: { id: 'fg-1', state: 'tool' } });
  state = applyBackground(state, { observedAt: 2_100, helper: { id: 'fg-2', state: 'tool' } });
  assert.equal(busyHelpers(state, 2_200), 2);
  state = applyBackground(state, { observedAt: 2_300, helper: { id: 'fg-1', state: 'tool' } });
  assert.equal(busyHelpers(state, 2_400), 2, 'the same agent counts once');
  // A tool in flight keeps it busy however long it runs; between tools it counts for the quiet window.
  assert.equal(busyHelpers(state, 2_300 + 3 * TEAMMATE_QUIET_MS), 2);
  state = applyBackground(state, { observedAt: 5_000, helper: { id: 'fg-2', state: 'quiet' } });
  assert.equal(busyHelpers(state, 5_000 + TEAMMATE_QUIET_MS - 1), 2);
  assert.equal(busyHelpers(state, 5_000 + TEAMMATE_QUIET_MS), 1);
  state = applyBackground(state, { observedAt: 6_000, ended: 'fg-1' });
  assert.equal(busyHelpers(state, 6_001), 1);
  state = applyBackground(state, { observedAt: 6_500, helper: { id: 'fg-1', state: 'quiet' } });
  assert.equal(busyHelpers(state, 6_501), 1, 'a hook that arrives after the stop does not revive it');
  state = applyBackground(state, { observedAt: 7_000, turnEnded: true, snapshot: [] });
  assert.equal(busyHelpers(state, 7_001), 0, 'foreground agents do not outlive their turn');
  assert.equal(state.helpers, undefined);
  state = applyBackground(state, { observedAt: 7_500, helper: { id: 'late', state: 'tool' } });
  assert.equal(busyHelpers(state, 7_501), 0, 'nor does a late hook count once the turn has ended');
});

test('an agent is counted once: a known background task or a teammate is not also a foreground helper', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, launched: { id: 'bg', kind: 'subagent' } });
  state = applyBackground(state, { observedAt: 1_100, helper: { id: 'bg', state: 'tool' } });
  assert.equal(busyHelpers(state, 1_200), 1);
  state = applyBackground(state, { observedAt: 1_300, helper: { id: 'fg', state: 'tool' } });
  assert.equal(busyHelpers(state, 1_400), 2);
  // With teammates listed, an unknown agent's tool hooks are a teammate's and are counted there.
  let team = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, snapshot: [{ id: 't1', type: 'teammate', status: 'running', name: 'scout' }] });
  team = applyBackground(team, { observedAt: 1_100, helper: { id: 'ascout-0123456789abcdef', state: 'tool' } });
  assert.equal(team.helpers, undefined);
  assert.equal(busyHelpers(team, 1_200), 1);
});

test('rows stored before helpers were tracked read as no foreground helpers', () => {
  const stored: BackgroundState = { tasks: [{ id: 'a', kind: 'subagent' }], ended: [], snapshotAt: 10, turnEnded: true, observedAt: 10 };
  assert.equal(busyHelpers(stored, 11), 1);
});

test('shells and watchers run beside the prompt and do not keep an ended turn working', () => {
  const state = applyBackground(undefined, { observedAt: 1, turnEnded: true, snapshot: [{ id: 's', type: 'shell', status: 'running' }, { id: 'm', type: 'monitor', status: 'running' }, { id: 'a', type: 'subagent', status: 'running' }, { id: 'w', type: 'workflow', status: 'running' }] });
  assert.deepEqual(outstanding(state, 2).map(task => task.kind), ['subagent', 'workflow']);
  assert.deepEqual(outstanding(applyBackground(undefined, { observedAt: 1, turnEnded: true, snapshot: [{ id: 's', type: 'shell' }, { id: 'm', type: 'monitor' }] }), 2), []);
});

test('a session waits on its helpers once its own turn has ended, unless it is waking or none is busy', () => {
  assert.equal(waitingOnHelpers(undefined, 1), false);
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, launched: { id: 'bg', kind: 'subagent' } });
  state = applyBackground(state, { observedAt: 1_100, helper: { id: 'fg', state: 'tool' } });
  assert.equal(waitingOnHelpers(state, 1_200), false, 'the main turn is active: it works alongside them');
  state = applyBackground(state, { observedAt: 2_000, turnEnded: true, snapshot: [{ id: 'bg', type: 'subagent', status: 'running' }, { id: 'bg-2', type: 'subagent', status: 'running' }, { id: 'sh', type: 'shell', status: 'running' }] });
  assert.equal(waitingOnHelpers(state, 2_001), true);
  // One helper finished: the lead wakes to read the result while the other still runs.
  state = applyBackground(state, { observedAt: 3_000, ended: 'bg' });
  assert.deepEqual([state.waking, busyHelpers(state, 3_001), waitingOnHelpers(state, 3_001)], [true, 1, false]);
  state = applyBackground(state, { observedAt: 4_000, turnEnded: true, snapshot: [{ id: 'bg-2', type: 'subagent', status: 'running' }, { id: 'sh', type: 'shell', status: 'running' }] });
  assert.equal(waitingOnHelpers(state, 4_001), true, 'its own Stop puts it back to waiting');
  state = applyBackground(state, { observedAt: 5_000, turnEnded: true, snapshot: [{ id: 'sh', type: 'shell', status: 'running' }] });
  assert.equal(waitingOnHelpers(state, 5_001), false, 'a shell is not a helper');
  const team = applyBackground(applyBackground(undefined, { observedAt: 1_000, turnEnded: true, snapshot: [{ id: 't', type: 'teammate', status: 'running', name: 'scout' }] }), { observedAt: 2_000, teammate: { key: 'scout', state: 'idle' } });
  assert.equal(waitingOnHelpers(team, 2_001), false, 'nor is an idle teammate');
  assert.equal(waitingOnHelpers(state, state.observedAt + BACKGROUND_STALE_MS), false);
});

test('a main-thread shell command is tracked from its start to its end, and the end of the turn ends it', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, shell: 'start' });
  assert.deepEqual(state.shell, { since: 1_000, running: 1 });
  state = applyBackground(state, { observedAt: 1_500, turnEnded: false, shell: 'start' });
  assert.deepEqual(state.shell, { since: 1_000, running: 2 }, 'parallel commands are one stretch');
  state = applyBackground(state, { observedAt: 2_000, turnEnded: false, shell: 'end' });
  assert.deepEqual(state.shell, { since: 1_000, running: 1 });
  state = applyBackground(state, { observedAt: 3_000, turnEnded: false, shell: 'end' });
  assert.deepEqual(state.shell, { since: 1_000, running: 0, until: 3_000 });
  state = applyBackground(state, { observedAt: 4_000, turnEnded: false, shell: 'start' });
  assert.deepEqual(state.shell, { since: 4_000, running: 1 });
  state = applyBackground(state, { observedAt: 5_000, turnEnded: true });
  assert.deepEqual(state.shell, { since: 4_000, running: 0, until: 5_000 }, 'a Stop without the tool result ends it');
  state = applyBackground(state, { observedAt: 6_000, shell: 'end' });
  assert.deepEqual(state.shell, { since: 4_000, running: 0, until: 5_000 });
});

test('compacting runs from its start to its end, or to the end of the turn', () => {
  let state = applyBackground(undefined, { observedAt: 1_000, turnEnded: false, compact: 'start' });
  assert.equal(state.compacting, true);
  state = applyBackground(state, { observedAt: 1_500, turnEnded: false });
  assert.equal(state.compacting, true, 'a tool hook leaves it');
  state = applyBackground(state, { observedAt: 2_000, compact: 'end' });
  assert.equal(state.compacting, undefined);
  state = applyBackground(applyBackground(state, { observedAt: 3_000, compact: 'start' }), { observedAt: 4_000, turnEnded: true });
  assert.equal(state.compacting, undefined);
});

test('the task list counts its own tasks once and starts over after it was finished', () => {
  let state = applyBackground(undefined, { observedAt: 1, task: { id: '1', state: 'created' } });
  for (const id of ['2', '3', '2']) state = applyBackground(state, { observedAt: 2, task: { id, state: 'created' } });
  assert.deepEqual(taskProgress(state), { done: 0, total: 3 });
  state = applyBackground(state, { observedAt: 3, task: { id: '1', state: 'completed' } }); state = applyBackground(state, { observedAt: 3, task: { id: '1', state: 'completed' } });
  assert.deepEqual(taskProgress(state), { done: 1, total: 3 });
  state = applyBackground(state, { observedAt: 4, task: { id: '9', state: 'completed' } });
  assert.deepEqual(taskProgress(state), { done: 2, total: 4 }, 'a task finished before its creation was seen still counts');
  for (const id of ['2', '3']) state = applyBackground(state, { observedAt: 5, task: { id, state: 'completed' } });
  assert.deepEqual(taskProgress(state), { done: 4, total: 4 });
  state = applyBackground(state, { observedAt: 6, turnEnded: true, snapshot: [] });
  assert.deepEqual(taskProgress(state), { done: 4, total: 4 }, 'a finished list stays until the next one starts');
  state = applyBackground(state, { observedAt: 7, task: { id: '10', state: 'created' } });
  assert.deepEqual(taskProgress(state), { done: 0, total: 1 }, 'the first task after a finished list starts a new one');
  assert.equal(taskProgress(undefined), undefined); assert.equal(taskProgress(applyBackground(undefined, { observedAt: 1, turnEnded: false })), undefined);
});

test('the first model seen is the session\'s own, and the working directory is the last one reported', () => {
  let state = applyBackground(undefined, { observedAt: 1, model: { to: 'opus' } });
  assert.deepEqual(state.model, { first: 'opus', now: 'opus' });
  state = applyBackground(state, { observedAt: 2, model: { to: 'haiku', from: 'opus' } });
  assert.deepEqual(state.model, { first: 'opus', now: 'haiku' });
  state = applyBackground(state, { observedAt: 3, model: { to: 'opus', from: 'haiku' } });
  assert.deepEqual(state.model, { first: 'opus', now: 'opus' });
  assert.deepEqual(applyBackground(undefined, { observedAt: 1, model: { to: 'haiku', from: 'opus' } }).model, { first: 'opus', now: 'haiku' }, 'a switch seen before any start names where it came from');
  state = applyBackground(state, { observedAt: 4, turnEnded: false, worktree: true });
  assert.equal(state.worktree, true);
  state = applyBackground(state, { observedAt: 5, turnEnded: false });
  assert.equal(state.worktree, true, 'a hook that says nothing leaves it');
  state = applyBackground(state, { observedAt: 6, turnEnded: false, worktree: false });
  assert.equal(state.worktree, undefined);
});
