import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionPath } from './shell-path.ts';
import { openCodexMetadata } from './codex-client.ts';
import { isBelow } from '../../src/graph/archive.ts';
import type { CodexModel } from './codex-client.ts';

export interface CodexCapability { executable: string; version: string }
let capability: Promise<CodexCapability> | undefined;
export function probeCodex(): Promise<CodexCapability> {
  if (!capability) capability = (async () => {
    const env = { ...process.env, PATH: await sessionPath() };
    const paths = [...env.PATH.split(':').filter(Boolean).map(path => join(path, 'codex')), join(homedir(), '.local/bin/codex')];
    const executable = paths.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
    if (!executable) throw new Error('Codex CLI is not installed. Install and sign in to Codex, then retry.');
    const exec = promisify(execFile);
    const [version, help, server] = await Promise.all([
      exec(executable, ['--version'], { timeout: 5000, env }), exec(executable, ['--help'], { timeout: 5000, env }), exec(executable, ['app-server', '--help'], { timeout: 5000, env }),
    ]);
    if (['--remote', '--model', '--config', 'resume'].some(flag => !help.stdout.includes(flag)) || !server.stdout.includes('--listen') || !server.stdout.includes('--stdio')) throw new Error('This Codex version lacks native terminal/session integration. Update Codex and retry.');
    return { executable: realpathSync(executable), version: version.stdout.trim().slice(0, 100) };
  })().catch(error => { capability = undefined; throw error; });
  return capability;
}

/** Catalog metadata, not a model call or a guarantee of account access at launch. */
export async function codexModels() {
  const installed = await probeCodex(), metadata = await openCodexMetadata(installed.executable, { env: { ...process.env, PATH: await sessionPath() } });
  try {
    const models: CodexModel[] = []; let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await metadata.models(cursor); models.push(...result.data.filter(model => !model.hidden));
      if (!result.nextCursor) return { ...installed, models };
      if (cursor === result.nextCursor) throw new Error('Codex returned a repeated model page');
      cursor = result.nextCursor;
    }
    throw new Error('Codex model catalog exceeded its page limit');
  } finally { metadata.rpc.close(); }
}

export async function discoverCodexSessions(state: import('../core/control.ts').WorkspaceState, query = '', cursor?: string) {
  const installed = await probeCodex(), metadata = await openCodexMetadata(installed.executable, { env: { ...process.env, PATH: await sessionPath() } });
  try {
    const page = await metadata.sessions({ query, cursor });
    const sessions: import('../../src/resource-plugins/types.ts').SavedSessionOption[] = page.data.map(thread => {
      const node = state.nodes.find(node => state.resources.some(resource => resource.id === node.resourceId && resource.data.provider === 'codex' && resource.data.nativeSessionId === thread.id));
      return { id: thread.id, title: (node?.title || thread.name || thread.preview || 'Codex session').replace(/\s+/g, ' ').slice(0, 240), cwd: thread.cwd, modifiedAt: thread.updatedAt * 1000,
        ...(thread.gitInfo?.branch ? { branch: thread.gitInfo.branch } : {}), ...(node ? { nodeId: node.id, projectTitle: state.nodes.find(project => project.id === node.projectId)?.title } : {}),
        ...(node?.archivedAt ? { unavailable: 'Restore this archived item before resuming it.' } : node && isBelow(node, state.nodes) ? { unavailable: 'Bring this item back from Undermap before resuming it.' } : {}) };
    });
    return { sessions, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  } finally { metadata.rpc.close(); }
}
export async function resolveCodexSession(id: string) {
  const installed = await probeCodex(), metadata = await openCodexMetadata(installed.executable, { env: { ...process.env, PATH: await sessionPath() } });
  try { const thread = await metadata.session(id); return { nativeSessionId: thread.id, cwd: thread.cwd }; }
  finally { metadata.rpc.close(); }
}
