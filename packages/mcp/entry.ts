import { dirname, isAbsolute, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkspaceConnection } from '../workspace-service/connection.ts';
import { createServiceMcpServer } from './service-server.ts';
import { loadBuilds } from '../workspace-service/plugin-loader.ts';
import type { PluginBuild } from '../workspace-service/plugin-loader.ts';
import { useInstalledPackages } from '../../src/resource-plugins/builtins.ts';

async function main() {
  const directory = process.env.ACT_DATA_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error('ACT_DATA_DIR must name the app workspace directory');
  const connection = new WorkspaceConnection(directory, process.execPath, join(dirname(process.argv[1]), 'workspace-service.cjs'), Boolean(process.versions.electron), { subscribe: false });
  await connection.connect();
  // The tools, guide and agent policies of installed packages come from the same verified builds the service runs.
  const { plugins } = await connection.call<{ plugins: PluginBuild[] }>('plugins.loaded');
  useInstalledPackages((await loadBuilds(plugins, { service: false })).loaded);
  const server = createServiceMcpServer(connection, { projectId: process.env.ACT_PROJECT_ID, agentNodeId: process.env.ACT_NODE_ID, workspaceId: process.env.ACT_WORKSPACE_ID });
  const close = () => { connection.close(); void server.close(); };
  process.stdin.once('end', close); process.once('SIGTERM', close); process.once('SIGINT', close);
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
