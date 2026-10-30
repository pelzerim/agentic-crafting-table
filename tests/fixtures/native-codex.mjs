// Deterministic native protocol fixture, not a Codex model or live-provider test.
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const args = process.argv.slice(2), file = join(process.env.CODEX_FIXTURE_HOME ?? process.cwd(), 'native-codex.json');
const value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if (args.includes('--help')) { console.log('--remote --model --config resume --listen --stdio'); process.exit(0); }

if (args.includes('app-server')) {
  const pause = async method => {
    if (process.env.CODEX_FIXTURE_PAUSE_METHOD !== method) return;
    writeFileSync(join(process.cwd(), 'native-paused'), method);
    while (!existsSync(join(process.cwd(), 'native-release'))) await new Promise(resolve => setTimeout(resolve, 20));
  };
  if (process.env.CODEX_FIXTURE_PAUSE_METHOD === 'startup') { writeFileSync(join(process.cwd(), 'native-server.pid'), String(process.pid)); await pause('startup'); }
  let thread, subscriber;
  try { thread = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const clients = new Set(), save = () => writeFileSync(file, JSON.stringify(thread));
  const notify = (method, params) => { for (const client of clients) client.send(JSON.stringify({ method, params })); };
  const status = (type, activeFlags = []) => { thread.status = { type, activeFlags }; notify('thread/status/changed', { threadId: thread.id, status: thread.status }); };
  const sync = async socket => {
    const config = thread.config['mcp_servers.crafting_table'], client = new Client({ name: 'native-codex-fixture', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env }, stderr: 'pipe' }));
      const call = async (name, argumentsValue) => { const response = await client.callTool({ name, arguments: argumentsValue }); if (response.isError) throw new Error(JSON.stringify(response)); return JSON.parse(response.content[0].text); };
      const nodeId = config.env.ACT_NODE_ID;
      const context = await call('workspace_run', { action: 'agent.context', nodeId, arguments: {} });
      if (!context.guide.prompt.includes('Keep the map in sync')) throw new Error('Guide missing');
      await call('workspace_run', { action: 'agent.context.ack', nodeId, arguments: { deliveryId: context.deliveryId } });
      const graph = await call('workspace_read', {});
      if (!graph.nodes.some(node => node.id === 'codex-result')) await call('workspace_apply', { expectedRevision: graph.revision, command: { type: 'item.add', id: 'codex-result', resourceId: 'codex-result-resource', pluginId: 'workspace.todo', title: 'Codex result', position: { x: 800, y: 200 }, projectId: graph.nodes.find(node => node.id === nodeId).projectId, data: { completed: false } } });
      socket.send(JSON.stringify({ method: 'fixture/output', params: { text: 'MCP_SYNC_DONE' } }));
    } finally { await client.close(); }
  };
  const handle = async (input, socket) => {
    if (!input.method) return; let result = {}; const params = input.params ?? {};
    await pause(input.method);
    switch (input.method) {
      case 'initialize': break;
      case 'model/list': result = { data: ['gpt-6-astra', 'fixture-choice'].map(model => ({ id: model, model, displayName: model, hidden: false, isDefault: model === 'gpt-6-astra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] })), nextCursor: null }; break;
      case 'skills/list': result = { data: params.cwds.map(cwd => ({ cwd, skills: [{ name: 'fixture-skill', description: 'Inspect the fixture project', path: join(cwd, '.agents/skills/fixture-skill/SKILL.md'), scope: 'repo', enabled: true }, { name: 'disabled-skill', description: 'Disabled fixture', path: '/disabled/SKILL.md', scope: 'user', enabled: false }], errors: [] })) }; break;
      case 'thread/list': result = { data: thread && (!params.searchTerm || `${thread.name} ${thread.preview}`.toLowerCase().includes(params.searchTerm.toLowerCase())) ? [thread] : [], nextCursor: null }; break;
      case 'thread/read': if (thread?.id !== params.threadId) throw new Error('Native conversation is missing'); result = { thread }; break;
      case 'thread/start': thread = { id: randomUUID(), cwd: params.cwd, status: { type: 'idle' }, config: params.config, model: params.model, updatedAt: Date.now() / 1000, name: 'Saved Codex', preview: 'Saved Codex' }; break;
      case 'thread/resume':
        if (!thread || thread.id !== params.threadId) throw new Error('Native conversation is missing');
        if (params.config) thread.config = params.config;
        subscriber = socket; if (!process.env.CODEX_FIXTURE_QUIET_RESUME) notify('thread/started', { thread }); break;
      case 'thread/inject_items': thread.context = params.items; thread.injections = (thread.injections ?? 0) + 1; save(); break;
      case 'thread/unsubscribe': if (subscriber === socket) subscriber = undefined; break;
      case 'fixture/input':
        if (params.data === 'work') { status('active'); const tool = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); writeFileSync(join(process.cwd(), 'native-tool.pid'), String(tool.pid)); }
        if (params.data === 'wait') { status('active', ['waitingOnApproval']); subscriber?.send(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} })); }
        if (params.data === 'done') status('idle');
        if (params.data === 'sync') await sync(socket);
        if (params.data === 'disconnect') for (const client of clients) client.terminate?.();
        break;
    }
    if (input.method === 'thread/start' || input.method === 'thread/resume') result = { thread };
    if (input.id !== undefined) socket.send(JSON.stringify({ id: input.id, result }));
  };
  const receive = (bytes, socket) => { const input = JSON.parse(String(bytes)); void handle(input, socket).catch(error => socket.send(JSON.stringify({ id: input.id, error: { code: -32600, message: error.message }, method: input.id === undefined ? 'fixture/output' : undefined, params: { text: 'FIXTURE_ERROR:' + error.message } }))); };
  if (args.includes('--stdio')) {
    const socket = { send: data => process.stdout.write(data + '\n') }; clients.add(socket);
    createInterface({ input: process.stdin }).on('line', line => receive(line, socket));
  } else {
    const http = createServer(), sockets = new WebSocketServer({ server: http });
    sockets.on('connection', socket => { clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('message', bytes => receive(bytes, socket)); });
    http.listen(value('--listen').slice('unix://'.length));
    writeFileSync(join(process.cwd(), 'native-server.pid'), String(process.pid));
  }
  // Deliberately leave tool cleanup to the owning session supervisor.
  process.on('SIGTERM', () => process.exit(0));
} else {
  const socket = new WebSocket('ws+unix://' + value('--remote').slice('unix://'.length) + ':/', { perMessageDeflate: false });
  socket.on('open', () => { socket.send(JSON.stringify({ id: 1, method: 'initialize', params: {} })); socket.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: value('resume') } })); });
  socket.on('message', bytes => {
    const frame = JSON.parse(String(bytes));
    if (frame.id === 2 && frame.result) { process.stdout.write('NATIVE_READY:' + frame.result.thread.id + '\r\n'); if (args.includes('--')) process.stdout.write('INITIAL_PROMPT:' + value('--') + '\r\n'); }
    if (frame.method === 'item/commandExecution/requestApproval') process.stdout.write('NATIVE_APPROVAL_WAITING\r\n');
    if (frame.method === 'fixture/output') process.stdout.write(frame.params.text + '\r\n');
  });
  socket.on('close', () => process.exit(0));
  // Real Codex asks for bracketed paste; only the paste journey needs it here.
  if (process.env.CODEX_FIXTURE_INPUT_LOG) process.stdout.write('\x1b[?2004h');
  process.stdin.setRawMode?.(true); process.stdin.resume(); let line = '';
  process.stdin.on('data', data => { if (process.env.CODEX_FIXTURE_INPUT_LOG) appendFileSync(process.env.CODEX_FIXTURE_INPUT_LOG, data); for (const char of String(data)) { if (char === '\r' || char === '\n') { if (line === 'exit') process.exit(0); socket.send(JSON.stringify({ method: 'fixture/input', params: { data: line } })); process.stdout.write('NATIVE_INPUT:' + line + '\r\n'); line = ''; } else line += char; } });
  process.on('SIGTERM', () => process.exit(0));
}
