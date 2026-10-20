import { startSupervisor } from './supervisor.ts';

async function main() {
  if (!process.env.ACT_DATA_DIR) throw new Error('ACT_DATA_DIR is required');
  const supervisor = await startSupervisor(process.env.ACT_DATA_DIR);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void supervisor.close().then(() => process.exit(0)); });
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
