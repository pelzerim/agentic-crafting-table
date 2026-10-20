import { openResourceChoices } from '../../choices.ts';
import { REVIEW_LOOP_OPERATION } from '../code-review/review-loop.ts';
import type { ResourceRecord, ResourceViewServices } from '../../types.ts';

interface LoopView { state?: string; line?: string; round?: number; rounds?: { round: number; reviewNodeId?: string }[] }
const READ_EVERY_MS = 10_000;

/** The pull request view's Review loop: the Actions entry that arms or stops it, and the status line under the frame bar
 * with Open round N and Stop while it runs. The line follows the service's record and keeps its last word until Stop. */
export function mountReviewLoop(document: Document, services: ResourceViewServices, resource: ResourceRecord, report: (message: string) => void) {
  const button = (text: string, className: string, label = text) => { const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = text; node.setAttribute('aria-label', label); return node; };
  const entry = button('Review loop', 'pr-review-loop'); entry.setAttribute('aria-haspopup', 'menu'); entry.setAttribute('aria-expanded', 'false');
  entry.title = 'Review, send critical, high and security findings to one agent, and review again until clean, halting on any doubt';
  const text = document.createElement('span'); text.className = 'pr-review-loop-text';
  const open = button('Open round 1', 'pr-review-loop-open'), stop = button('Stop', 'pr-review-loop-stop', 'Stop review loop');
  stop.title = 'No further reviews or fix requests are sent. Work already sent is not undone.';
  const status = document.createElement('div'); status.className = 'pr-review-loop-status'; status.setAttribute('role', 'status'); status.hidden = true; status.append(text, open, stop);
  let active = false, disposed = false, timer: ReturnType<typeof setTimeout> | undefined, closeMenu: (() => void) | undefined, current: string | undefined;

  entry.onclick = () => {
    if (!active || disposed) return;
    if (entry.getAttribute('aria-expanded') === 'true') { closeMenu?.(); return; }
    closeMenu = openResourceChoices(entry, services, { load: 'options', apply: 'set', runtime: REVIEW_LOOP_OPERATION }, () => active && !disposed ? read() : Promise.resolve(),
      report, { menu: 'Review loop', loading: 'Checking the review loop…', pending: 'Updating the review loop…', reportLoad: true });
  };
  open.onclick = () => { if (current) services.openResource(current); };
  stop.onclick = async () => {
    stop.disabled = true;
    try { await services.runAction(REVIEW_LOOP_OPERATION, { operation: 'set', value: 'stop', sourceResourceId: resource.id, requestId: crypto.randomUUID() }); await read(); }
    catch (failure) { report((failure as Error).message); }
    finally { stop.disabled = false; }
  };

  async function read() {
    const value = await services.runAction(REVIEW_LOOP_OPERATION, { operation: 'status' }).catch(() => undefined) as LoopView | undefined;
    if (disposed) return;
    const state = value?.state ?? 'off', armed = state === 'armed', round = value?.rounds?.find(entry => entry.round === value.round);
    status.hidden = !value?.line || state === 'stopped'; status.dataset.state = state;
    text.textContent = value?.line ?? '';
    current = round?.reviewNodeId;
    open.hidden = !armed || !current; open.textContent = `Open round ${round?.round ?? 1}`; open.setAttribute('aria-label', open.textContent);
    stop.hidden = !armed;
    entry.textContent = armed ? 'Review loop · on' : 'Review loop'; entry.setAttribute('aria-label', entry.textContent);
    schedule(armed);
  }
  const schedule = (armed: boolean) => { clearTimeout(timer); if (armed && active && !disposed) timer = setTimeout(() => { void read(); }, READ_EVERY_MS); };

  return {
    entry, status, read,
    setActive(value: boolean) { active = value; if (!value) clearTimeout(timer); },
    dispose() { disposed = true; clearTimeout(timer); closeMenu?.(); },
  };
}
