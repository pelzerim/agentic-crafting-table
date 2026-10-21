import { startWorkspaceService } from './server.ts';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

async function main() {
  const directory = process.env.ACT_DATA_DIR;
  if (!directory) throw new Error('ACT_DATA_DIR is required');
  const runtimeEntry = join(dirname(process.argv[1]), 'session-supervisor.cjs');
  // The service runs from dist/ inside the app; the app's package.json sits beside dist/.
  try { process.env.ACT_APP_VERSION ??= String(JSON.parse(readFileSync(join(dirname(process.argv[1]), '..', 'package.json'), 'utf8')).version); } catch {}
  const service = await startWorkspaceService(directory, undefined, existsSync(runtimeEntry) ? {
    directory: join(directory, 'runtime'), executable: process.execPath, entrypoint: runtimeEntry, electronRuntime: Boolean(process.versions.electron),
  } : undefined);
  const stop = () => { void service.close().then(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
