import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentLaunch, createProjectAgent, summarizeProject } from './project-context.ts';
import type { ProjectContext } from './project-context.ts';
import { AGENT_TOOL_CONTEXT_VERSION } from './tool-context.ts';

const billing: ProjectContext = {
  id: 'billing', name: 'Billing redesign', goal: 'Make plan changes predictable.',
  currentState: 'Plan picker implemented; coverage is in progress.',
  decisions: ['Downgrade timing is not decided yet.'],
  repository: 'acme/app', branch: 'feat/billing-redesign',
  resources: [{ title: 'PR #48', reference: 'https://github.com/acme/app/pull/48' }],
};

test('a new agent receives project context together with its task', async () => {
  const request = buildAgentLaunch(billing, 'codex', 'Add downgrade tests.', undefined, [], { agentNodeId: 'agent-1', workspaceId: 'billing-dev-01' });
  let calls = 0;
  const result = await createProjectAgent({ async create(sent) {
    calls++;
    assert.equal(sent.initialPrompt, request.initialPrompt);
    assert.equal(sent.toolContext.version, AGENT_TOOL_CONTEXT_VERSION);
    assert.equal(sent.systemPrompt, sent.toolContext.prompt);
    assert.ok(!sent.initialPrompt.includes(sent.toolContext.prompt));
    assert.match(sent.systemPrompt, /immediately register its URL/);
    assert.match(sent.systemPrompt, /relationships.cardinality/);
    assert.match(sent.toolContext.prompt, /"projectId":"billing"/);
    assert.match(sent.toolContext.prompt, /"agentNodeId":"agent-1"/);
    assert.match(sent.toolContext.prompt, /"workspaceId":"billing-dev-01"/);
    for (const command of ['workspace_read', 'workspace_plugins', 'workspace_apply', 'item.add', 'node.attach', 'node.move', 'node.update', 'link.save']) {
      assert.ok(sent.toolContext.prompt.includes(command), command);
    }
    assert.match(sent.initialPrompt, /Downgrade timing is not decided/);
    assert.match(sent.initialPrompt, /feat\/billing-redesign/);
    assert.match(sent.initialPrompt, /Your task\nAdd downgrade tests\.$/);
    return { sessionId: 'session-1' };
  } }, request);
  assert.equal(calls, 1);
  assert.equal(result.launch.initialPrompt, request.initialPrompt);
});

test('an edited preview is the exact summary sent, without changing the project', () => {
  const edited = 'Billing redesign. Downgrades now apply next cycle.';
  const request = buildAgentLaunch(billing, 'claude', 'Implement the confirmation.', edited);
  assert.equal(request.projectSummary, edited);
  assert.ok(request.initialPrompt.includes(edited));
  assert.ok(!request.initialPrompt.includes('not decided'));
  assert.equal(request.systemPrompt, request.toolContext.prompt); // Editing the brief cannot drop tool instructions.
  assert.ok(!request.systemPrompt.includes(edited));
  assert.equal(billing.decisions?.[0], 'Downgrade timing is not decided yet.');
});

test('each launch captures current context and keeps earlier prompts unchanged', () => {
  const oldLaunch = buildAgentLaunch(billing, 'codex', 'Review.');
  const newLaunch = buildAgentLaunch({ ...billing, currentState: 'Ready to merge.' }, 'codex', 'Review.');
  assert.match(newLaunch.initialPrompt, /Ready to merge/);
  assert.ok(!oldLaunch.initialPrompt.includes('Ready to merge'));
  const unrelated = buildAgentLaunch({ id: 'docs', name: 'Docs', goal: 'Update onboarding.' }, 'codex', 'Write examples.');
  assert.ok(!unrelated.initialPrompt.includes('billing-redesign'));
  assert.ok(!unrelated.initialPrompt.includes('PR #48'));
});

test('large project fields produce a bounded brief; empty tasks keep context without an initial prompt', () => {
  const long = 'word '.repeat(500);
  const summary = summarizeProject({ ...billing, name: long, goal: long,
    currentState: long, decisions: [long, long], repository: long, branch: long,
    resources: Array.from({ length: 100 }, () => ({ title: long })),
  });
  assert.ok(summary.split(/\s+/).length <= 160);
  const idle = buildAgentLaunch(billing, 'claude', '  ');
  assert.equal(idle.initialPrompt, ''); assert.equal(idle.task, '');
  assert.ok(idle.projectSummary.includes('Billing')); assert.ok(idle.systemPrompt.includes('Keep the map in sync'));
});
