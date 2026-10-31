import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookFields, localArtifactTitle } from './agent-hook-event.ts';

const native = '00000000-0000-4000-8000-000000000001';

test('hooks forward main-thread events and ignore other conversations and subagent turns', () => {
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, native), { event: 'PreToolUse', toolName: 'Bash' });
  assert.equal(hookFields({ session_id: 'other', hook_event_name: 'Stop' }, native), undefined);
  for (const name of ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'SessionStart'])
    assert.equal(hookFields({ session_id: native, hook_event_name: name, agent_id: 'sub', tool_name: 'Read', notification_type: 'permission_prompt' }, native), undefined, name);
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'Notification', notification_type: 'idle_prompt' }, native), { event: 'Notification', notificationType: 'idle_prompt' });
});

test('hooks forward background launches, subagent stops and in-flight snapshots', () => {
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_response: { status: 'async_launched', agentId: 'a1' } }, native),
    { event: 'PostToolUse', toolName: 'Agent', launched: { id: 'a1', kind: 'subagent' } });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_response: { status: 'completed', agentId: 'a1' } }, native),
    { event: 'PostToolUse', toolName: 'Agent' }, 'a foreground subagent has already finished');
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', background_tasks: [] }, native),
    { event: 'SubagentStop', agentId: 'a1', backgroundTasks: [] });
  const stop = hookFields({ session_id: native, hook_event_name: 'Stop', background_tasks: [
    { id: 't1', type: 'shell', status: 'running', command: 'tail -f log', description: 'tail logs' }, { id: 't2', type: 'monitor', status: 'running', server: 's', tool: 't' }, { type: 'shell' }, 'junk',
  ] }, native);
  assert.deepEqual(stop, { event: 'Stop', backgroundTasks: [{ id: 't1', type: 'shell', status: 'running' }, { id: 't2', type: 'monitor', status: 'running' }] }, 'commands and descriptions stay out of the table');
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'Stop' }, native), { event: 'Stop' }, 'older Claude sends no snapshot');
});

test('a message from the main thread names its teammate recipient and nothing else of its input', () => {
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'scout-4', message: 'private text' } }, native),
    { event: 'PreToolUse', toolName: 'SendMessage', recipient: 'scout-4' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: 'not a name', message: 'x' } }, native), { event: 'PostToolUse', toolName: 'SendMessage' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { to: 'scout' } }, native), { event: 'PreToolUse', toolName: 'Bash' });
});

test('a subagent finishing a tool is forwarded as its own minimal event, never as the main thread\'s', () => {
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', agent_id: 'sub', tool_name: 'Read', background_tasks: [{ id: 't', type: 'shell' }] }, native), { event: 'SubagentToolUse', agentId: 'sub' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', agent_id: 'sub', tool_name: 'Agent', tool_response: { status: 'async_launched', agentId: 'nested' } }, native),
    { event: 'SubagentToolUse', agentId: 'sub' }, 'a nested launch is not the main thread\'s background work');
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', agent_id: 'sub', tool_name: 'Artifact', cwd: '/work/repo', tool_input: { file_path: 'p.html' }, tool_response: { url: 'https://claude.ai/artifact/aB3_x-9Zq' } }, native),
    { event: 'SubagentToolUse', agentId: 'sub' }, 'a subagent publish attaches no artifact');
  assert.equal(hookFields({ session_id: 'other', hook_event_name: 'PostToolUse', agent_id: 'sub' }, native), undefined);
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Read' }, native), { event: 'PostToolUse', toolName: 'Read' });
});

test('a teammate going idle and a subagent starting a tool are forwarded with ids only', () => {
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'TeammateIdle', teammate_name: 'scout', team_name: 'default', agent_id: 'ascout-0123456789abcdef', background_tasks: [{ id: 't', type: 'shell' }] }, native),
    { event: 'TeammateIdle', teammate: 'scout', agentId: 'ascout-0123456789abcdef' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'TeammateIdle', teammate_name: 'scout' }, native), { event: 'TeammateIdle', teammate: 'scout' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'TeammateIdle' }, native), { event: 'TeammateIdle' }, 'an idle mark without a name still counts');
  assert.equal(hookFields({ session_id: 'other', hook_event_name: 'TeammateIdle', teammate_name: 'scout' }, native), undefined);
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PreToolUse', agent_id: 'sub', tool_name: 'Bash', tool_input: { command: 'make' } }, native), { event: 'SubagentToolStart', agentId: 'sub' });
});

test('a teammate in the in-flight snapshot keeps a description only when it is a bare name', () => {
  const tasks = (background_tasks: unknown[]) => hookFields({ session_id: native, hook_event_name: 'Stop', background_tasks }, native)?.backgroundTasks;
  assert.deepEqual(tasks([{ id: 't1', type: 'teammate', status: 'running', description: 'scout' }]), [{ id: 't1', type: 'teammate', status: 'running', name: 'scout' }]);
  assert.deepEqual(tasks([{ id: 't1', type: 'teammate', status: 'running', description: 'Find the flaky test' }]), [{ id: 't1', type: 'teammate', status: 'running' }], 'prose stays out of the table');
  assert.deepEqual(tasks([{ id: 's1', type: 'shell', status: 'running', description: 'build' }]), [{ id: 's1', type: 'shell', status: 'running' }]);
});

const ID = '00000000-0000-4000-8000-000000000042', URL = `https://claude.ai/code/artifact/${ID}`;
const published = (tool_response: unknown, tool_input: Record<string, unknown> = { file_path: 'overview.html' }) =>
  hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Artifact', cwd: '/work/repo', tool_input, tool_response }, native);

test('an Artifact publish yields its validated claude.ai URL from several plausible response shapes', () => {
  for (const response of [
    { url: URL }, { artifact: { url: `${URL}?share=1`, id: ID } }, URL,
    [{ type: 'text', text: `Published your page.\nURL: ${URL}\nThis session now watches it.` }],
    { content: [{ type: 'text', text: `Published private artifact: ${URL}.` }] },
    { result: `Created ${URL} (private)` },
  ]) assert.deepEqual(published(response)?.artifact, { url: URL, filePath: '/work/repo/overview.html' }, JSON.stringify(response));
  assert.deepEqual(published({ url: 'https://claude.ai/artifact/aB3_x-9Zq' }, { file_path: '/abs/page.html', title: '  PR #42 architecture  ' })?.artifact,
    { url: 'https://claude.ai/artifact/aB3_x-9Zq', title: 'PR #42 architecture', filePath: '/abs/page.html' });
  assert.equal(published({ url: URL }, { file_path: 'x.html', description: 'Flow of the billing change' })?.artifact?.title, 'Flow of the billing change');
});

test('only publishes with an unambiguous artifact URL become artifacts', () => {
  for (const action of ['read', 'list', 'delete', 'open', 'pin', 'quickstart']) assert.equal(published({ url: URL }, { action, url: URL })?.artifact, undefined, action);
  assert.equal(published({ url: `${URL}/assets/a.png` }, { url: URL, asset: true, file_path: 'a.png' })?.artifact, undefined, 'asset uploads are not new artifacts');
  for (const response of [
    { url: `https://claude.ai.example.com/code/artifact/${ID}` }, { url: `http://claude.ai/code/artifact/${ID}` }, 'Published.', null,
    { url: `${URL}/assets/logo.png` }, { first: URL, second: 'https://claude.ai/artifact/other' },
  ]) assert.equal(published(response)?.artifact, undefined, JSON.stringify(response));
  assert.equal(published({ url: URL }, { action: 'publish', file_path: 'p.html' })?.artifact?.url, URL);
  assert.equal(published('Updated in place.', { url: URL, file_path: 'p.html' })?.artifact?.url, URL, 'a republish names its artifact in tool_input.url');
  assert.equal(published({ first: URL, second: 'https://claude.ai/artifact/other' }, { url: URL })?.artifact?.url, URL);
  assert.equal(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: URL } }, native)?.artifact, undefined, 'never read from other tools or terminal output');
  assert.equal(hookFields({ session_id: native, hook_event_name: 'PreToolUse', tool_name: 'Artifact', tool_input: { url: URL } }, native)?.artifact, undefined);
});

test('a local page title is read only from a small HTML file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'act-artifact-title-'));
  try {
    writeFileSync(join(directory, 'page.html'), '<!doctype html><head><title>Billing &amp; plans flow</title></head><body>x</body>');
    writeFileSync(join(directory, 'notes.txt'), '<title>Not HTML</title>');
    writeFileSync(join(directory, 'huge.html'), '<title>Too big</title>' + 'x'.repeat(3 * 1024 * 1024));
    assert.equal(localArtifactTitle(join(directory, 'page.html')), 'Billing & plans flow');
    assert.equal(localArtifactTitle(join(directory, 'notes.txt')), undefined);
    assert.equal(localArtifactTitle(join(directory, 'huge.html')), undefined);
    assert.equal(localArtifactTitle(join(directory, 'missing.html')), undefined);
    assert.equal(localArtifactTitle('relative.html'), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the new signals forward ids, counts and flags, never their content', () => {
  const native = 'native-1', base = { session_id: native, cwd: '/repo' };
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, native), { event: 'SubagentStart', agentId: 'a1' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: 'keep the plan' }, native), { event: 'PreCompact' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'a long summary' }, native), { event: 'PostCompact' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'make secrets' }, tool_use_id: 't1', error: 'exit 2: token=abc', is_interrupt: false }, native), { event: 'PostToolUseFailure', toolName: 'Bash' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: true }, native), { event: 'PostToolUseFailure', toolName: 'Bash', interrupt: true });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, reason: 'destructive' }, native), { event: 'PermissionDenied', toolName: 'Bash' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'TaskCreated', task_id: '7', task_subject: 'Ship the secret plan', task_description: 'details' }, native), { event: 'TaskCreated', taskId: '7' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'TaskCompleted', task_id: '7', task_subject: 'Ship the secret plan' }, native), { event: 'TaskCompleted', taskId: '7' });
  assert.deepEqual(hookFields({ ...base, hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5', requested_model: 'haiku', source: 'user', context_tokens: 1200 }, native), { event: 'PostModelSwitch', model: 'claude-haiku-5', previousModel: 'claude-opus-5-5' });
  // A subagent's or teammate's own failures, denials and tasks are not the item's.
  for (const hook_event_name of ['PostToolUseFailure', 'PermissionDenied', 'TaskCreated', 'TaskCompleted', 'PreCompact', 'PostModelSwitch']) assert.equal(hookFields({ ...base, hook_event_name, agent_id: 'a1', task_id: '1', tool_name: 'Bash' }, native), undefined, hook_event_name);
  assert.equal(hookFields({ ...base, session_id: 'other', hook_event_name: 'TaskCreated', task_id: '7' }, native), undefined);
  assert.equal(hookFields({ ...base, hook_event_name: 'TaskCreated' }, native)?.taskId, undefined);
});

test('the session start names its model, and a main-thread hook says whether it runs in a Claude worktree', () => {
  const native = 'native-1';
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5', cwd: '/repo' }, native), { event: 'SessionStart', model: 'claude-opus-5-5' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'UserPromptSubmit', prompt: 'hello', cwd: '/repo/.claude/worktrees/fix-login' }, native), { event: 'UserPromptSubmit', worktree: true });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: '/repo/.claude/worktrees/fix-login/src' }, native), { event: 'PostToolUse', toolName: 'Read', worktree: true });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: '/repo/.claude/worktrees' }, native), { event: 'PostToolUse', toolName: 'Read' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'Stop' }, native), { event: 'Stop' }, 'no directory, no claim');
  assert.equal(hookFields({ session_id: native, hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/repo/.claude/worktrees/x', agent_id: 'a1' }, native)?.worktree, undefined, 'a subagent in a worktree does not pen the item');
});

test('Stop forwards the last assistant message, bounded; other events never carry text', () => {
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'Stop', last_assistant_message: 'Done.\n\nPushed to main.' }, native), { event: 'Stop', lastMessage: 'Done.\n\nPushed to main.' });
  assert.equal(hookFields({ session_id: native, hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(5000) }, native)!.lastMessage!.length, 2000);
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'Stop', last_assistant_message: 42 }, native), { event: 'Stop' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'PostToolUse', tool_name: 'Bash', last_assistant_message: 'text' }, native), { event: 'PostToolUse', toolName: 'Bash' });
  assert.deepEqual(hookFields({ session_id: native, hook_event_name: 'SubagentStop', agent_id: 'sub', last_assistant_message: 'text' }, native), { event: 'SubagentStop', agentId: 'sub' });
});

test('a main session starting under another id is a switch of conversation, by the source Claude names', () => {
  const other = randomUUID(), start = (source: string, fields = {}) => hookFields({ session_id: other, hook_event_name: 'SessionStart', source, ...fields }, native);
  assert.deepEqual(start('clear'), { event: 'SessionStart', switched: { kind: 'new', nativeSessionId: other } });
  assert.deepEqual(start('fork')?.switched, { kind: 'fork', nativeSessionId: other });
  assert.deepEqual(start('resume')?.switched, { kind: 'resume', nativeSessionId: other });
  assert.equal(start('compact'), undefined);
  assert.equal(start('clear', { agent_id: 'sub' }), undefined);
  assert.equal(hookFields({ session_id: native, hook_event_name: 'SessionStart', source: 'resume' }, native)?.switched, undefined);
  assert.equal(hookFields({ session_id: native, hook_event_name: 'SessionEnd', reason: 'clear' }, native)?.endReason, 'clear');
});
