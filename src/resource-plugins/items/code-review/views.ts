import type { MountedResourceView, ResourcePluginViews, ResourceRecord, ResourceViewServices } from '../../types.ts';
import { mountReviewDesk } from './desk.ts';

/** A finished review opens as the findings triage desk; the native run stays one tab away. */
export const codeReviewViews: ResourcePluginViews = {
  identity: resource => resource.data.phase ? `preparing:${resource.data.reviewJobId}:${resource.data.phase}` : String(resource.data.sessionId),
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
    return resource.data.phase ? mountPreparing(container, resource, services, element) : mountReviewDesk(container, resource, services);
  },
};

/** A review item exists from the moment it is requested; it shows its preparation
 * phase until the session starts, or the error and Retry when preparation failed. */
function mountPreparing(container: HTMLElement, resource: ResourceRecord, services: ResourceViewServices, element: <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => HTMLElementTagNameMap[K]): MountedResourceView {
  const failed = resource.data.phase === 'failed', provider = resource.data.provider === 'codex' ? 'Codex' : 'Claude';
  const root = element('section', '', 'code-review-detail code-review-preparing'), heading = element('strong', failed ? 'The review could not start' : `Preparing ${provider} review`);
  const phase = element('p', ({ queued: 'Waiting to start…', fetching: 'Fetching and comparing the PR…', starting: `Starting ${provider}…` } as Record<string, string>)[String(resource.data.phase)] ?? '', 'code-review-phase');
  const elapsed = element('small', '', 'code-review-elapsed'), since = Date.parse(String(resource.data.preparingSince));
  phase.setAttribute('role', 'status'); root.append(heading);
  const tick = () => { const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000)); elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`; };
  let timer: ReturnType<typeof setInterval> | undefined;
  if (failed) {
    const error = element('p', String(resource.data.error ?? 'Review preparation failed.'), 'code-review-error'), retry = element('button', 'Retry review'), note = element('p', '', 'code-review-note');
    error.setAttribute('role', 'alert'); retry.type = 'button'; note.hidden = true;
    retry.onclick = async () => {
      retry.disabled = true; note.hidden = true;
      try { await services.runAction('review.retry', { requestId: crypto.randomUUID() }); }
      catch (reason) { note.hidden = false; note.textContent = (reason as Error).message; retry.disabled = false; }
    };
    root.append(error, retry, note);
  } else {
    root.append(phase);
    if (Number.isFinite(since)) { root.append(elapsed); tick(); timer = setInterval(tick, 1000); }
  }
  container.append(root);
  return { update() {}, dispose() { clearInterval(timer); root.remove(); } };
}
