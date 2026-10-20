import { expect, _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { SessionSnapshot } from '../../packages/session-runtime/protocol.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { agentProviders } from '../../packages/workspace-service/agent-providers.ts';
import type { AgentProvider } from '../../packages/workspace-service/agent-providers.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize } from './visual-fixture.ts';

type Providers = NonNullable<Parameters<typeof startWorkspaceService>[3]>;
const text = (result: any) => (result.content as { text: string }[])[0].text;

/** Stands the scripted native agent in for Claude in a service that runs in this process: the probe answers with it,
 * so starting an agent never reaches an installed CLI. Returns what puts the real provider back. */
export async function scriptedClaude(directory: string) {
  const executable = join(directory, 'claude'), providers = agentProviders as Record<string, AgentProvider>, real = providers.claude;
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  providers.claude = { ...real, probe: async () => ({ executable, version: '2.1.281 (scripted test fixture)', remoteControl: true, autoMode: true }) };
  return () => { providers.claude = real; };
}

/** A real service, supervisor and hidden desktop on fixture providers, with scripted agents in real
 * PTYs that report through the production MCP bridge. Nothing reaches a provider or a model. */
/** Stage rules for the staged Web / Release workflow of the rollout specs. */
export const STAGED_DEPLOY_RULES = [{ id: 'web-release', workflow: '^web\\s*/\\s*release$', stages: [
  { key: 'preview', environment: 'preview' }, { key: 'live', environment: 'live' }, { key: 'settle', environment: 'live', delayMinutes: 10 }] }];

export async function rolloutHarness(providers: Providers, agents: readonly string[], setup: (agent: (id: string, title: string, x: number) => WorkspaceCommand) => WorkspaceCommand[], project: { summary?: string; /** Saved as the rollout package's stage rules setting. */ stageRules?: readonly object[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-rollout-harness-')), agentScript = join(directory, 'agent-fixture'), restoreClaude = await scriptedClaude(directory);
  await writeFile(agentScript, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/scripted-agent.mjs')).href)};\n`, { mode: 0o700 });
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, providers);
  if (project.stageRules) {
    const settings = service.store.readSettings();
    service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, plugins: { ...settings.value.plugins, 'github.rollout': { stageRules: JSON.stringify(project.stageRules) } } } });
  }
  const agent = (id: string, title: string, x: number): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title, projectId: 'project', position: { x, y: 520 }, data: { provider: 'claude', sessionId: `${id}-session` } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Web', summary: project.summary ?? '', position: { x: 0, y: 0 }, workingDirectory: directory }, ...setup(agent), ...agents.map(id => ({ type: 'node.update' as const, id, activity: 'idle' as const })) ] });
  const supervisor = await connectSupervisor(runtime.directory);
  for (const id of agents) await supervisor.call('sessions.launch', { sessionId: `${id}-session`, requestId: `${id}-session`, nodeId: id, workspaceId: 'fixture', cwd: directory, executable: agentScript, args: [], cols: 200, rows: 40 });
  const tick = async () => { const db = new DatabaseSync(service.store.file); db.exec('UPDATE resource_cache SET checked_at=0'); db.close(); await service.resources.poll(); };
  await tick();
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const mcp = new Map<string, Client>();
  const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await resize(app, page, 1440, 900);
  return {
    service, app, page, tick, directory,
    /** A session the service started itself: what its terminal printed, and a line typed into it. */
    session: (sessionId: string) => ({
      async output() { return (await supervisor.call<SessionSnapshot>('sessions.read', { sessionId })).chunks.map(chunk => chunk.data).join(''); },
      async type(line: string) { await supervisor.call('sessions.input', { sessionId, data: `${line}\r` }); },
    }),
    /** Everything the agent's terminal printed, including prompts pasted into it. */
    async output(id: string) { return (await supervisor.call<SessionSnapshot>('sessions.read', { sessionId: `${id}-session` })).chunks.map(chunk => chunk.data).join(''); },
    async report(id: string, rolloutNodeId: string, body: object) {
      if (!mcp.has(id)) { const client = new Client({ name: `${id}-fixture`, version: '1' }); mcp.set(id, client);
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ...process.env, ACT_DATA_DIR: directory, ACT_NODE_ID: id } as Record<string, string>, stderr: 'pipe' })); }
      const result = await mcp.get(id)!.callTool({ name: 'workspace_report_validation', arguments: { rolloutNodeId, ...body } });
      expect(result.isError, text(result)).not.toBe(true); return JSON.parse(text(result));
    },
    async idle(id: string) { const state = await service.control.read();
      await service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.update', id, activity: 'idle' }] }); },
    async close() {
      for (const client of mcp.values()) await client.close().catch(() => {});
      await exitWithoutShutdown(app); await service.close(); restoreClaude();
      await supervisor.call('admin.shutdown').catch(() => {}); supervisor.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
