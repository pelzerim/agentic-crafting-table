import type { ResourceViewServices } from '../../types.ts';
import type { WorkflowReviewCoordinator } from '../../../../packages/workspace-service/workflow-reviews.ts';
export type WorkflowReviewStatus = Awaited<ReturnType<WorkflowReviewCoordinator['status']>>[number];

/** View-only adapter. Provider calls and durable decisions stay in the service. */
export function mountWorkflowAction(container: HTMLElement, services: ResourceViewServices) {
  const document = container.ownerDocument, group = document.createElement('section'), button = document.createElement('button'), hint = document.createElement('small');
  group.className = 'pr-review-action pr-workflow-action'; group.setAttribute('aria-label', 'GitHub workflow review');
  const heading = document.createElement('strong'), details = document.createElement('details'), summary = document.createElement('summary'), explanation = document.createElement('p');
  heading.textContent = 'GitHub'; details.className = 'pr-workflow-help'; summary.textContent = 'Setup required'; details.append(summary, explanation); details.hidden = true;
  button.textContent = 'Post /review'; button.setAttribute('aria-label', 'Post /review on GitHub'); button.disabled = true; hint.textContent = 'Checking workflow support…'; group.append(heading, button, hint, details); container.append(group);
  let active = false, disposed = false, pending = false, epoch = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let supported = false, reason = '', requestId: string | undefined, target: string | undefined, latest: WorkflowReviewStatus | undefined;
  const run = (operation: string, extra = {}) => services.runAction('pr.review.workflow', { operation, ...extra });
  function render() {
    if (disposed) return;
    button.textContent = target ? 'Open workflow review' : 'Post /review';
    button.setAttribute('aria-label', target ? 'Open workflow review' : 'Post /review on GitHub');
    button.disabled = pending || (!target && (!supported || (!!requestId && !!latest && !['failed', 'cancelled'].includes(latest.state))));
    details.hidden = Boolean(target || supported || !reason); explanation.textContent = reason;
    hint.textContent = latest?.error ?? (target ? latest?.status.replaceAll('-', ' ') ?? 'Review started' : supported ? 'Posts a GitHub comment · watches the report' : 'Workflow unavailable');
  }
  async function poll() {
    if (!active || disposed) return;
    const current = epoch;
    try {
      const results = await run('status') as unknown as WorkflowReviewStatus[];
      if (disposed || !active || current !== epoch) return;
      latest = (requestId ? results.find(r => r.requestId === requestId) : results.findLast(r => !['succeeded', 'failed', 'cancelled'].includes(r.state)));
      target = latest?.nodeId;
      if (requestId && latest && ['failed', 'cancelled'].includes(latest.state) && !target) requestId = undefined;
      render();
    } catch (error) { if (!disposed && active && current === epoch) hint.textContent = (error as Error).message; }
    finally { if (!disposed && active && current === epoch) timer = setTimeout(() => { void poll(); }, 1500); }
  }
  button.onclick = async () => {
    if (target) { services.openResource(target); return; }
    if (!supported || pending) return;
    requestId ??= crypto.randomUUID(); pending = true; render();
    try { await run('start', { requestId }); }
    catch (error) { reason = (error as Error).message; }
    finally { pending = false; render(); clearTimeout(timer); if (active) void poll(); }
  };
  return {
    setActive(value: boolean) {
      if (active === value) return; active = value; epoch++; clearTimeout(timer);
      if (!active) return;
      const current = epoch;
      void run('options').then(value => { if (disposed || !active || current !== epoch) return; const capability = value as unknown as { supported: boolean; reason?: string }; supported = capability.supported; reason = capability.reason ?? ''; render(); }).catch(error => { if (!disposed && active && current === epoch) { reason = (error as Error).message; render(); } });
      void poll();
    },
    dispose() { disposed = true; epoch++; clearTimeout(timer); group.remove(); },
  };
}
