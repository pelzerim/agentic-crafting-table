import type { RecoveryState } from '../../../packages/workspace-service/lifecycle.ts';

/** What the recovery notice says, if anything. Closing the app records pending
 * entries that restore nothing yet; those are not worth announcing. */
export function recoveryNotice(state: RecoveryState | undefined, error: string) {
  const failed = state?.entries.filter(entry => entry.state === 'failed') ?? [];
  const restored = state?.entries.filter(entry => entry.state === 'restored').length ?? 0;
  const pending = state?.entries.some(entry => entry.state === 'pending');
  const meaningful = Boolean(error || state?.error || failed.length || restored || (state?.phase === 'recovering' && pending));
  const title = error || state?.error ? 'Recovery needs attention' : state?.phase === 'recovering' ? 'Resuming your workspace…' : failed.length ? 'Some sessions need attention' : `${restored} session${restored === 1 ? '' : 's'} restored`;
  return { failed, identity: meaningful ? JSON.stringify({ error, state }) : undefined, title };
}
