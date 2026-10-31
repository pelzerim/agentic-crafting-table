import type { ElectronApplication } from '@playwright/test';

/** Simulate an unexpected desktop exit; orderly close is covered in lifecycle.spec.ts. */
export async function exitWithoutShutdown(app: ElectronApplication) {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = app.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); });
  await closed;
  // Electron can stall in exit on a Wayland session; this stands for a crash, so a kill serves the same purpose.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
