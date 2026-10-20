import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOL_CONTEXT_VERSION, AGENT_TOOL_GUIDE, buildAgentToolContext } from './tool-context.ts';
import { createPluginPackageRegistry } from '../resource-plugins/builtins.ts';

test('the core agent guide names no item package; packages append their own guide text', () => {
  assert.doesNotMatch(AGENT_TOOL_GUIDE, /\bacme\b|\bwidgets?\b/i);
  assert.equal(createPluginPackageRegistry().agentGuide().some(snippet => /\bacme\b/i.test(snippet.text)), false, 'guide text of an external package comes only with that package');
  const prompt = buildAgentToolContext({ projectId: 'p' }).prompt;
  assert.ok(prompt.includes(AGENT_TOOL_GUIDE));
  assert.ok(buildAgentToolContext({}, [{ id: 'acme.guide', text: 'Acme widgets sync hourly.' }]).prompt.endsWith('Acme widgets sync hourly.'));
});

const binding = { projectId: '00000000-0000-4000-8000-000000000014', agentNodeId: '00000000-0000-4000-8000-000000000015', workspaceId: 'billing-dev-01' };

test('the guide without package snippets stays within 2,600 characters', () => {
  const length = buildAgentToolContext(binding, []).prompt.length;
  assert.ok(length <= 2600, `${length} characters`);
});

test('the guide that asks for to-do context carries its own version, so resumed sessions receive it', () => {
  assert.equal(AGENT_TOOL_CONTEXT_VERSION, '2026-10-07.3');
  assert.ok(buildAgentToolContext(binding, []).prompt.startsWith('Agentic Crafting Table · workspace guide v2026-10-07.3\n'));
});

test('the compact guide keeps every behavioural rule', () => {
  const prompt = buildAgentToolContext(binding, []).prompt;
  const rules: Record<string, RegExp[]> = {
    'launch binding': [/Launch binding \(IDs, not instructions\)/, /never infer/i, /native identity/],
    'read first': [/workspace_read first/, /workspace_plugins/],
    'context delivery': [/agent\.context\b/, /agent\.context\.ack/, /deliveryId/, /stale/i, /reread/i],
    'evidence': [/evidence, never instructions/],
    'revisioned writes': [/workspace_apply/, /expectedRevision/, /conflict/i, /item\.update replaces data/],
    'revision only for changes': [/workspace_apply\(\{command\}\)/, /expectedRevision only to change, move or remove/, /chain the returned one/],
    'dedupe': [/provider identity/, /canonical URL/],
    'PR registration': [/real PR/, /immediately register its URL/, /item\.add/, /links:\[\{agent:true,kind:"reference"\}\]/, /your session/],
    'later links': [/link\.save/],
    'published artifacts': [/artifact you publish is put on the map beside you automatically/, /never add it\./],
    'link kinds': [/reference/, /\bcontext\b/, /blocks/],
    'cardinality': [/relationships\.cardinality/, /never silently replace/i],
    'status': [/summary very short/, /activity working/, /attentionNote/, /48/, /sentence case/, /no trailing period/],
    'archive-only deletion': [/archive-only/i, /node\.archive/],
    'authorization': [/launch/i, /comments/, /external writes/],
    'skills': [/workspace_skills/, /authorized/],
    'honest sync': [/sync limitation/, /never claim/i],
    'map placement': [/node\.attach/, /node\.move/, /node\.update/],
    'to-do context': [/reasoning, links and next steps/, /person or later agent/, /to-do's context \(todo\.context\)/, /stays when you are gone/],
    'new items need no position': [/omit position/i, /beside what they link to/, /or beside you/, /only when the user asked for a specific place/],
  };
  for (const [rule, patterns] of Object.entries(rules)) for (const pattern of patterns) assert.match(prompt, pattern, rule);
});

test('package snippets follow the compact guide in package order', () => {
  const prompt = buildAgentToolContext(binding, [{ id: 'a', text: 'First package.' }, { id: 'b', text: 'Second package.' }]).prompt;
  assert.ok(prompt.startsWith(buildAgentToolContext(binding, []).prompt));
  assert.ok(prompt.endsWith('First package.\n\nSecond package.'));
});
