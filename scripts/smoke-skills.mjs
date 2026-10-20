// Explicit live capability gate. Never called by CI; all processes/data are disposable.
// Native one-time approvals are limited to reading/acknowledging this test project context.
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { once } from 'node:events';
import electron from 'electron';
import { WorkspaceConnection } from '../packages/workspace-service/connection.ts';
import { connectWorkspace } from '../packages/workspace-service/client.ts';
import { connectSupervisor } from '../packages/session-runtime/client.ts';
import { openCodexMetadata } from '../packages/session-runtime/codex-client.ts';
import { probeCodex } from '../packages/session-runtime/codex.ts';
if (process.env.ACT_LIVE_SKILLS !== '1') throw new Error('Set ACT_LIVE_SKILLS=1 to enable bounded native model calls in disposable projects.');
if (process.env.ACT_SKILL_PROVIDER && !['claude', 'codex'].includes(process.env.ACT_SKILL_PROVIDER)) throw new Error('ACT_SKILL_PROVIDER must be claude or codex');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'act-native-skills-'))), cwd = join(directory, 'project'); await mkdir(cwd);
const token = 'ACT_SKILL_OK_' + randomUUID().slice(0,8), name = 'act-disposable-skill';
for (const parent of ['.claude', '.agents']) { const folder = join(cwd, parent, 'skills', name); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Disposable native skill capability test.\n---\nThis is a bounded local integration check. Reply exactly ${token}. Do not edit files, start agents or contact external services. The crafting table guide still applies.\n`); }
const workspace = new WorkspaceConnection(directory, electron, resolve('dist/workspace-service.cjs'), true), projectId = randomUUID();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let runtime; const created = [];
try {
 await workspace.connect();
 const settings = await workspace.call('settings.read'); await workspace.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, claude: { remoteControl: false, arguments: [] } } });
 await workspace.call('apply', { commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'skill-probe' }, commands: [{ type: 'project.create', id: projectId, title: 'Disposable native skill check', summary: 'Test native skill invocation without changes to project files.', workingDirectory: cwd, position: { x: 0, y: 0 } }] });
 for (const provider of (process.env.ACT_SKILL_PROVIDER ? [process.env.ACT_SKILL_PROVIDER] : ['claude', 'codex'])) {
  const catalog = await workspace.call('skills.list', { projectId, provider }), skill = catalog.skills.find(row => row.name === name);
  if (!skill || skill.unavailable) throw new Error(`${provider} did not discover the disposable skill: ${JSON.stringify(skill)}`);
  const graph = (await workspace.call('read')).state, requestId = randomUUID();
  const record = { provider, requestId, nativeId: provider === 'claude' ? requestId : undefined }; created.push(record);
  await workspace.call('runtime.run', { action: 'skill.run', nodeId: projectId, arguments: { requestId, nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: graph.revision, provider, model: provider === 'claude' ? 'haiku' : 'gpt-6-astra', skillId: skill.id, position: { x: 320, y: 150 }, arguments: '' } });
  runtime ??= await connectSupervisor(join(directory, 'runtime'));
  let sequence = 0, transcript = '', hookSkipped = false, trusted = false, lastApproval = '', success = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
   const output = await runtime.call('sessions.read', { sessionId: requestId, after: sequence }); sequence = output.lastSequence;
   const fresh = output.chunks.map(chunk => chunk.data).join(''); transcript += fresh; record.nativeId = output.session.native?.nativeSessionId ?? record.nativeId;
   if (fresh.includes('\x1b[6n')) await runtime.call('sessions.input', { sessionId: requestId, data: '\x1b[1;1R' });
   if (fresh.includes('\x1b[c')) await runtime.call('sessions.input', { sessionId: requestId, data: '\x1b[?1;2c' });
   const tail = stripVTControlCharacters(transcript).slice(-6000);
   if (provider === 'claude' && tail.replace(/\s+/g, '').includes('Yes,Itrustthisfolder') && !trusted) { trusted = true; await runtime.call('sessions.input', { sessionId: requestId, data: '\x1b[B' }); await sleep(120); await runtime.call('sessions.input', { sessionId: requestId, data: '\r' }); }
   if (provider === 'codex' && tail.includes('Hooks') && tail.replace(/\s+/g, '').includes('Continuewithouttrusting') && !hookSkipped) { hookSkipped = true; await sleep(350); for (const data of ['\x1b[B','\x1b[B','\r']) { await runtime.call('sessions.input', { sessionId: requestId, data }); await sleep(100); } }
   if (provider === 'codex' && output.session.native?.status === 'input' && tail.includes('Allow the crafting_table MCP server') && /action:\s*[\"]?agent\.context(?:\.ack)?/.test(tail) && tail.includes('1. Allow') && lastApproval !== output.session.native.observedAt) { lastApproval = output.session.native.observedAt; await runtime.call('sessions.input', { sessionId: requestId, data: '\r' }); }
   const compact = tail.replace(/\s+/g, '');
   if (provider === 'claude' && compact.includes('Doyouwanttoproceed?') && compact.includes('crafting_table') && /action:.*agent\.context(?:\.ack)?/.test(compact) && Date.now() - Number(lastApproval || 0) > 5000) { lastApproval = String(Date.now()); await runtime.call('sessions.input', { sessionId: requestId, data: '\r' }); }
   if (tail.includes(token)) {
    if (provider === 'claude') { const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk'); const messages = await getSessionMessages(record.nativeId, { dir: cwd }); success = messages.some(message => message.type === 'assistant' && JSON.stringify(message.message).includes(token)); }
    else { const metadata = await openCodexMetadata((await probeCodex()).executable); try { const result = await metadata.rpc.request('thread/read', { threadId: record.nativeId, includeTurns: true }); success = result.thread.turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && item.text.includes(token))); } finally { metadata.rpc.close(); } }
    if (success) break;
   }
   if (['failed','exited','lost'].includes(output.session.state)) break;
   await sleep(200);
  }
  console.log(JSON.stringify({ provider, discovered: true, nativeId: record.nativeId, skillBodyUsed: success }));
  await runtime.call('sessions.stop', { sessionId: requestId });
  if (!success) { console.log(stripVTControlCharacters(transcript).slice(-6000)); throw new Error('Native skill did not return its body-only marker'); }
 }
} finally {
 if (runtime) { for (const record of created) await runtime.call('sessions.stop', { sessionId: record.requestId }).catch(() => {}); runtime.close(); }
 workspace.close();
 for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) { const client = await connect().catch(() => undefined); if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(7000) }); await client.call('admin.shutdown'); await ended; client.close(); } }
 for (const record of created) {
  if (!record.nativeId) continue;
  if (record.provider === 'claude') { const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk'); await deleteSession(record.nativeId, { dir: cwd }).catch(error => console.log('Claude cleanup:', error.message)); }
  else { const metadata = await openCodexMetadata((await probeCodex()).executable); try { await metadata.rpc.request('thread/delete', { threadId: record.nativeId }); } finally { metadata.rpc.close(); } }
 }
 await rm(directory, { recursive: true, force: true });
}
