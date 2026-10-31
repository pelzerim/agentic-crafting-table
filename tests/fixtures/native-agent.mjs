// Deterministic native-CLI contract fixture. It never calls a model or GitHub.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--version')) { console.log('2.1.281 (scripted test fixture)'); process.exit(0); }
if (args.includes('--help')) { console.log('--append-system-prompt --session-id --resume --mcp-config --plugin-dir --system-prompt-snapshot --remote-control\n  --permission-mode <mode> (choices: "auto", "default", "plan")'); process.exit(0); }
if (args.includes('--input-format')) {
  // SDK metadata handshake only. Any model prompt would fail this fixture.
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const frame = JSON.parse(line);
    assert.equal(frame.type, 'control_request'); assert.equal(frame.request.subtype, 'initialize');
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [
      { name: 'fixture-skill', description: 'Inspect the fixture project', argumentHint: '<focus>' },
      { name: 'exit', description: 'Not a skill', builtin: true },
    ], models: [], agents: [] } } }));
  }
  process.exit(0);
}
assert.equal(args.filter(arg => arg === '--permission-mode').length, 1);
await writeFile(join(process.cwd(), 'fixture-flags.json'), JSON.stringify({ remoteControl: args.includes('--remote-control'), permissionMode: value('--permission-mode'), ...(args.includes('--effort') ? { effort: value('--effort') } : {}) }));
const orientation = args.includes('--') && args.at(-1).startsWith('Read the table context offer');
const resumed = args.includes('--resume'), idle = !resumed && (!args.includes('--') || orientation), nativeId = value(resumed ? '--resume' : '--session-id');
const config = JSON.parse(await readFile(value('--mcp-config'), 'utf8')).mcpServers.crafting_table;
const guide = value('--append-system-prompt');
assert.ok(guide.includes(config.env.ACT_NODE_ID)); assert.ok(guide.includes(config.env.ACT_PROJECT_ID));
assert.ok(guide.includes('Keep the map in sync')); assert.ok(!guide.includes('BILLING_BRIEF'));
const skill = args.includes('--') && args.at(-1).startsWith('/fixture-skill');
// Explain architecture: the host-built prompt names a request file instead of carrying the diff.
const architecture = !resumed && args.includes('--') && args.at(-1).startsWith('Read the architecture request at');
// A rollout validation the table started: the request is the opening prompt, with the report call it asks for.
const validation = !resumed && args.includes('--') && args.at(-1).startsWith('Check whether this rollout works as intended') ? args.at(-1).match(/workspace_report_validation \(rolloutNodeId "([^"]+)", validationId "(V\d+)"\)/) : null;
const scripted = skill || architecture || Boolean(validation);
if (!resumed && !idle && !scripted) { assert.ok(args.at(-1).includes('BILLING_BRIEF')); assert.ok(args.at(-1).includes('REGISTER_FIXTURE_PR')); }
const historyPath = join(process.cwd(), 'fixture-conversation.json');
// One folder can hold several conversations once a session opens another beside it.
const history = await readFile(historyPath, 'utf8').then(JSON.parse, () => ({}));
const conversations = [...history.conversations ?? [], ...(history.nativeId ? [history.nativeId] : [])];
if (resumed) assert.ok(conversations.includes(nativeId));
else await writeFile(historyPath, JSON.stringify({ nativeId, conversations }));
const hooks = JSON.parse(await readFile(join(value('--plugin-dir'), 'hooks/hooks.json'), 'utf8')).hooks;
async function hook(event, payload = {}) {
  const command = hooks[event][0].hooks[0];
  return await new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Hook failed: ${code}`)));
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume(); child.stdin.end(JSON.stringify({ session_id: nativeId, hook_event_name: event, ...payload }));
  });
}
const openingHook = await hook('SessionStart');
const client = new Client({ name: 'scripted-native-agent', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env }, stderr: 'pipe' }));
async function call(name, input = {}) {
  await hook('PreToolUse');
  const response = await client.callTool({ name, arguments: input });
  await hook('PostToolUse');
  const data = JSON.parse(response.content[0].text);
  if (response.isError) throw Object.assign(new Error(data.error.message), data.error);
  return data;
}
const nodeId = config.env.ACT_NODE_ID;
async function acknowledgeContext(offered) {
  // Concurrent recovery changes peer state in the hierarchy. A stale receipt
  // must be reread, not acknowledged blindly or treated as a process failure.
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = offered ?? await call('workspace_run', { action: 'agent.context', nodeId });
    assert.ok(current.projectSummary.includes('BILLING_BRIEF'));
    try {
      await call('workspace_run', { action: 'agent.context.ack', nodeId, arguments: { deliveryId: current.deliveryId } });
      return current;
    } catch (error) {
      if (error.code !== 'INVALID_REQUEST' || !error.message.includes('Context delivery is stale')) throw error;
      offered = undefined;
    }
  }
  throw new Error('Fixture context kept changing before acknowledgement');
}
const context = await acknowledgeContext();
if (orientation) {
  assert.ok(!resumed); assert.ok(args.at(-1).includes('wait for my choice'));
  assert.ok(openingHook.includes('hierarchy')); assert.ok(context.hierarchy);
  await writeFile(join(process.cwd(), 'fixture-opening-context.json'), JSON.stringify({ prompt: args.at(-1), hook: JSON.parse(openingHook), context }));
  console.log('What next (scripted fixture): inspect the connected project items.');
}
async function registerPR() {
  // One call, no read and no revision: registering a PR only adds to the map.
  const registered = await call('workspace_apply', { commandId: 'register-pr', command: { type: 'item.add', id: 'fixture-pr', resourceId: 'fixture-pr-resource', pluginId: 'github.pull-request', title: 'Fixture PR from agent', projectId: config.env.ACT_PROJECT_ID, position: { x: 900, y: 180 }, data: { owner: 'fixture', repo: 'local-only', number: 48 },
    links: [{ agent: true, kind: 'reference' }] } });
  assert.equal(registered.itemLinks[0].links.length, 1); assert.ok(registered.revision > 0);
}
if (!resumed && !idle && !scripted) await registerPR();
// A synthetic Claude Code Artifact tool call: the hook payloads a real publish sends. Nothing is uploaded.
const ARTIFACT_URL = 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000016';
async function publishArtifact(input, response) {
  await hook('PreToolUse', { tool_name: 'Artifact', tool_input: input });
  await hook('PostToolUse', { tool_name: 'Artifact', cwd: process.cwd(), tool_input: input, tool_response: response });
}
if (architecture) {
  const request = await readFile(JSON.parse(args.at(-1).slice('Read the architecture request at '.length).split(' and follow it.')[0]), 'utf8');
  assert.ok(request.includes('private Claude artifact')); assert.ok(request.includes('PR source material'));
  await writeFile(join(process.cwd(), 'architecture.html'), '<!doctype html><head><title>Billing plan architecture</title></head><body>Scripted fixture page</body>');
  await publishArtifact({ file_path: 'architecture.html' }, [{ type: 'text', text: `Published a private page.\nURL: ${ARTIFACT_URL}` }]);
  console.log(`ARCHITECTURE_PUBLISHED:${ARTIFACT_URL}`);
}
const report = (body) => call('workspace_report_validation', { rolloutNodeId: validation[1], validationId: validation[2], ...body });
if (validation) {
  console.log(`VALIDATION_REQUEST:${args.at(-1)}`);
  await report({ sequence: 1, phase: 'progress', summary: 'Planning the checks', checks: [{ id: 'C1', title: 'Rollout landed', status: 'pending' }] });
}
if (skill) console.log('SKILL_PROMPT:' + args.at(-1));
if (resumed && args.includes('--')) { assert.ok(args.at(-1).includes('reopened')); await writeFile(join(process.cwd(), 'fixture-continued.txt'), nativeId); }
await hook('Stop');
console.log(`NATIVE_${resumed ? 'RESUMED' : idle ? 'IDLE' : 'READY'}:${nativeId}`);
if (idle) assert.ok(['opus', 'fable'].includes(value('--model')));
process.on('SIGTERM', async () => { process.stdout.write('\x1b[?1049l\x1b[2J\x1b[HCLI_TEARDOWN'); await client.close(); process.exit(0); });
const lines = createInterface({ input: process.stdin });
async function submit() {
  const output = await hook('UserPromptSubmit');
  if (!output) return;
  const text = JSON.parse(output).hookSpecificOutput.additionalContext;
  if (!text.includes('Agentic Crafting Table · workspace guide')) return;
  const reference = JSON.parse(text.split('\n').at(-1));
  assert.ok(text.includes(config.env.ACT_NODE_ID)); assert.ok(text.includes('Keep the map in sync'));
  await writeFile(join(process.cwd(), 'fixture-injected-context.json'), JSON.stringify({ text, reference }));
  await acknowledgeContext(reference);
  console.log('WORKBENCH_CONTEXT_ACKNOWLEDGED');
}
for await (const line of lines) {
  if (line === 'exit') break;
  if (line === 'work') { await submit(); console.log('WORK_STARTED'); continue; }
  if (line === 'background') {
    await hook('PreToolUse', { tool_name: 'Agent' }); await hook('PostToolUse', { tool_name: 'Agent', tool_response: { status: 'async_launched', agentId: 'fixture-subagent' } });
    await hook('Stop', { background_tasks: [{ id: 'fixture-subagent', type: 'subagent', status: 'running' }] }); console.log('BACKGROUND_WAITING'); continue;
  }
  if (line === 'background-done') {
    await hook('SubagentStop', { agent_id: 'fixture-subagent', agent_type: 'general-purpose', background_tasks: [] });
    await hook('PreToolUse', { tool_name: 'Read' }); await hook('Stop', { background_tasks: [] }); console.log('BACKGROUND_DONE'); continue;
  }
  // A slash command's dialog: shown after the turn ended, with no main-thread hook once it is answered.
  // The hooks Claude Code sends, in order, when `/clear` moves its process to a new conversation.
  if (line === 'clear-command') { await hook('SessionEnd', { reason: 'clear' }); await hook('SessionStart', { session_id: randomUUID(), source: 'clear' }); console.log('CONVERSATION_CLEARED'); continue; }
  if (line === 'permission-after-stop') { await hook('Notification', { notification_type: 'permission_prompt' }); console.log('PERMISSION_DIALOG'); continue; }
  if (line === 'subagent-tool') { await hook('PostToolUse', { agent_id: 'fixture-fork', tool_name: 'Read' }); console.log('SUBAGENT_TOOL'); continue; }
  if (line === 'wait-for-input') { await hook('PermissionRequest'); console.log('WAITING_FOR_INPUT'); continue; }
  if (line === 'screen') { process.stdout.write('\x1b[?1049h\x1b[2J\x1b[HRETAIN_THIS_NATIVE_SCREEN'); continue; }
  if (line === 'REGISTER_FIXTURE_PR') { await registerPR(); continue; }
  if (line === 'validation-final') { await report({ sequence: 2, phase: 'final', verdict: 'passed', summary: 'Rollout healthy', checks: [{ id: 'C1', title: 'Rollout landed', status: 'passed' }] }); await hook('Stop'); console.log('VALIDATION_REPORTED'); continue; }
  if (line === 'publish-artifact') { await publishArtifact({ action: 'publish', url: ARTIFACT_URL, file_path: 'architecture.html', title: 'Billing plan architecture v2' }, { url: ARTIFACT_URL }); console.log('ARTIFACT_REPUBLISHED'); continue; }
  await submit();
  console.log(`RECEIVED:${line}`);
  await writeFile(join(process.cwd(), 'fixture-input.txt'), line);
  await hook('Stop');
}
lines.close(); process.stdin.pause();
await hook('SessionEnd'); await client.close();
