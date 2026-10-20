import type { ResourcePluginViews, ResourceViewServices } from '../../types.ts';

const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
  signal.addEventListener('abort', abort, { once: true });
});

/** Explain architecture, shared by the map menu and the PR view: launch once, then
 * follow the same request until its Claude session is on the map. */
export async function runArchitectureAction(services: Pick<ResourceViewServices, 'runAction'>, signal: AbortSignal): Promise<{ nodeId: string }> {
  signal.throwIfAborted();
  const options = await services.runAction('pr.architecture', { operation: 'options' }) as { canLaunch?: boolean; reason?: string };
  signal.throwIfAborted();
  if (!options.canLaunch) throw new Error(options.reason || 'Explain architecture is not available for this pull request.');
  const requestId = crypto.randomUUID();
  let startError: unknown;
  try { await services.runAction('pr.architecture', { operation: 'launch', requestId }); }
  catch (error) { startError = error; } // A lost reply may still have started the durable launch. Never resend it.
  // Capturing a large PR can take minutes; the service bounds it at three.
  const deadline = performance.now() + 240_000, uncertainDeadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const runs = await services.runAction('pr.architecture', { operation: 'status', requestId }) as { requestId: string; state: string; error?: string; nodeId?: string }[];
    signal.throwIfAborted();
    const run = runs.find(run => run.requestId === requestId);
    if (run?.state === 'launched' && run.nodeId) return { nodeId: run.nodeId };
    if (run?.state === 'failed') throw new Error(run.error || 'Explain architecture did not start.');
    if (!run && startError && performance.now() >= uncertainDeadline) throw startError;
    await pause(signal);
  }
  throw new Error('Explain architecture is still preparing. Open the pull request later before starting it again.');
}

/** Map shortcuts share the durable review coordinators with the full PR view.
 * Only explicit activation starts work; navigation cannot change this binding. */
export const runReviewContextAction: NonNullable<ResourcePluginViews['runContextAction']> = async (actionId, resource, services, signal) => {
  signal.throwIfAborted();
  if (actionId === 'architecture.explain') return runArchitectureAction(services, signal);
  if (!['review.claude', 'review.codex', 'review.workflow'].includes(actionId)) throw new Error('Unknown review action');
  const workflow = actionId === 'review.workflow', requestId = crypto.randomUUID();
  const action = workflow ? 'pr.review.workflow' : `pr.${actionId}`;
  if (workflow) {
    const capability = await services.runAction(action, { operation: 'options' }) as { supported: boolean; reason?: string };
    signal.throwIfAborted();
    if (!capability.supported) throw new Error(capability.reason || 'This repository does not support /review.');
  }
  signal.throwIfAborted();
  let startError: unknown;
  try { await services.runAction(action, { requestId, sourceResourceId: resource.id, ...(workflow ? { operation: 'start' } : {}) }); }
  catch (error) { startError = error; } // A lost reply may still have started a durable job. Never resend it.
  const deadline = performance.now() + 240_000, uncertainDeadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const runs = await services.runAction(workflow ? action : 'pr.review.status', { requestId, ...(workflow ? { operation: 'status' } : {}) }) as { requestId: string; state: string; error?: string; nodeId?: string }[];
    signal.throwIfAborted();
    const run = runs.find(run => run.requestId === requestId);
    if (run?.nodeId) return { nodeId: run.nodeId };
    if (run && ['failed', 'cancelled'].includes(run.state)) throw new Error(run.error || 'Review preparation did not complete.');
    if (!run && startError && performance.now() >= uncertainDeadline) throw startError;
    await pause(signal);
  }
  throw new Error('Review preparation is still pending. Open the PR to check its status before starting another review.');
};
