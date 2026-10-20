import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionContinuation, sessionIdentity } from './session-continuation.ts';
import type { SavedAgentSession } from './session-continuation.ts';
import { AGENT_TOOL_CONTEXT_VERSION } from './tool-context.ts';

const session: SavedAgentSession = {
  resourceId: 'agent-1', projectId: 'billing', provider: 'claude', connectionId: 'account-1',
  nativeSessionId: 'conversation-1', workspaceId: 'billing-dev-01', model: 'opus',
  state: 'paused', transport: 'detached', canResume: true, workspaceAvailable: true,
};

test('resume preserves native identity, original model, workspace and existing node', () => {
  const request = buildSessionContinuation('billing', session);
  assert.equal(request.operation, 'resume');
  assert.equal(request.resourceId, 'agent-1');
  assert.equal(request.nativeSessionId, 'conversation-1');
  assert.equal(request.workspaceId, 'billing-dev-01');
  assert.equal(request.model, 'opus');
  assert.ok(!('initialPrompt' in request));
  assert.ok(!('task' in request));
});

test('an active attached session reconnects its UI without starting another process', () => {
  for (const state of ['working', 'waiting', 'idle'] as const) {
    const request = buildSessionContinuation('billing', { ...session, state, transport: 'attached', canResume: false });
    assert.equal(request.operation, 'attach');
    assert.ok(!('toolContextUpdate' in request));
  }
  assert.equal(buildSessionContinuation('billing', { ...session, state: 'waiting' }).operation, 'resume');
});

test('old resumed sessions queue the guide without rewriting history; delivered versions are not repeated', () => {
  for (const toolContextVersion of [undefined, 'older-guide']) {
    const saved = { ...session, agentNodeId: 'map-agent-1', toolContextVersion };
    const request = buildSessionContinuation('billing', saved);
    assert.equal(request.toolContextUpdate?.delivery, 'next-turn');
    assert.equal(request.toolContextUpdate?.version, AGENT_TOOL_CONTEXT_VERSION);
    assert.match(request.toolContextUpdate!.prompt, /"agentNodeId":"map-agent-1"/);
    assert.match(request.toolContextUpdate!.prompt, /"workspaceId":"billing-dev-01"/);
    assert.equal(saved.toolContextVersion, toolContextVersion); // Only confirmed delivery updates persisted metadata.
    assert.ok(!('initialPrompt' in request));
  }
  const current = buildSessionContinuation('billing', { ...session, toolContextVersion: AGENT_TOOL_CONTEXT_VERSION });
  assert.ok(!('toolContextUpdate' in current));
});

test('unavailable sessions fail explicitly instead of falling back to a new conversation', () => {
  assert.throws(() => buildSessionContinuation('docs', session), /another project/);
  assert.throws(() => buildSessionContinuation('billing', { ...session, workspaceAvailable: false }), /workspace unavailable/);
  assert.throws(() => buildSessionContinuation('billing', { ...session, canResume: false }), /cannot resume/);
  assert.throws(() => buildSessionContinuation('billing', { ...session, nativeSessionId: '' }), /identity/);
});

test('identical native ids in different connections or workspaces are distinct sessions', () => {
  assert.equal(sessionIdentity(session), sessionIdentity({ ...session }));
  assert.notEqual(sessionIdentity(session), sessionIdentity({ ...session, connectionId: 'account-2' }));
  assert.notEqual(sessionIdentity(session), sessionIdentity({ ...session, workspaceId: 'other-box' }));
  assert.notEqual(sessionIdentity(session), sessionIdentity({ ...session, provider: 'codex' }));
});
