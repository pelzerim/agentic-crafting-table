import type { MountedResourceView, ResourceSnapshot, ResourceViewServices } from './types.ts';
import { openResourceChoices } from './choices.ts';
import { mountViewHeader, skeleton, staleNotice } from './view-header.ts';
import type { ViewHeaderData } from './view-header.ts';

export interface ProviderReadOptions {
  className: string;
  /** Provider name used in "Open in …" and freshness copy. */
  provider: string;
  /** Header data; called without a snapshot for the first paint from local data. `local` is
   * the latest value of `local()`, once it has loaded. */
  header(snapshot?: ResourceSnapshot, local?: unknown): ViewHeaderData;
  /** Local, provider-free state shown in the header (e.g. unread counts), reloaded after
   * each read and after the person opens the provider page from the header. */
  local?(): Promise<unknown>;
  render(body: HTMLElement, snapshot: ResourceSnapshot, reload: () => Promise<void>): void;
  /** Makes the status chip a menu of provider workflow states. */
  choices?: { load: string; apply: string };
  /** Long-form documents repeat their title in the body when the view is wide. */
  documentTitle?: boolean;
}

/** Shared provider reading surface with optional explicit workflow controls;
 * retained on the map, fetched only on entry
 * or explicit refresh. A late response cannot update an inactive/disposed view. */
export function mountProviderRead(container: HTMLElement, services: ResourceViewServices, options: ProviderReadOptions): MountedResourceView {
  const document = container.ownerDocument, root = document.createElement('section'), body = document.createElement('div'), banner = document.createElement('p');
  const title = document.createElement('h1');
  root.className = `${options.className} provider-read`; body.className = 'provider-read-content'; banner.className = 'view-stale-banner'; title.className = 'provider-read-title';
  banner.setAttribute('role', 'status'); banner.hidden = true; title.hidden = true; body.setAttribute('aria-live', 'polite');
  const status = options.choices ? document.createElement('button') : undefined;
  let closeChoices: (() => void) | undefined;
  if (status && options.choices) {
    const choices = options.choices;
    status.type = 'button'; status.setAttribute('aria-label', 'Change status'); status.setAttribute('aria-haspopup', 'menu'); status.setAttribute('aria-expanded', 'false'); status.hidden = true;
    status.onclick = () => {
      if (!active || disposed) return;
      if (status.getAttribute('aria-expanded') === 'true') { closeChoices?.(); return; }
      closeChoices = openResourceChoices(status, services, choices, () => active && !disposed ? load() : Promise.resolve(), message => { if (active && !disposed) { banner.textContent = message; banner.hidden = !message; } });
    };
  }
  root.append(banner, title, body); container.append(root);
  let active = false, disposed = false, generation = 0, shown = false, latest: ResourceSnapshot | undefined, local: unknown;
  async function reloadLocal() {
    if (!options.local) return;
    let value: unknown;
    try { value = await options.local(); } catch { return; }
    if (disposed || !active) return;
    local = value;
    if (latest) header.update(options.header(latest, local));
  }
  // Opening the provider page from the header is the person reading it there.
  const opener = services.openUrl && { openUrl(url: string) { services.openUrl!(url); void services.runAction('resource.opened', {}).then(reloadLocal, () => {}); } };
  const header = mountViewHeader(document, { ...services, ...opener }, root, { chip: status, onRefresh: () => { if (active) void load(true); } });
  header.update(options.header());
  body.append(skeleton(document));
  function show(snapshot: ResourceSnapshot) {
    latest = snapshot;
    const data = options.header(snapshot, local);
    header.update(data);
    if (status) { status.textContent = data.status?.label ?? snapshot.label; status.dataset.tone = data.status?.tone ?? 'neutral'; status.setAttribute('aria-label', `Change status: ${status.textContent}`); status.hidden = false; }
    header.freshness({ observedAt: snapshot.observedAt, stale: snapshot.stale, error: snapshot.error, provider: options.provider });
    if (options.documentTitle && snapshot.title) { title.textContent = snapshot.title; title.hidden = false; }
    render(snapshot);
    banner.textContent = snapshot.stale ? staleNotice({ observedAt: snapshot.observedAt, error: snapshot.error, provider: options.provider }) : '';
    banner.hidden = !snapshot.stale;
    shown = true;
    void reloadLocal();
  }
  const render = (snapshot: ResourceSnapshot) => options.render(body, snapshot, () => active && !disposed ? load() : Promise.resolve());
  async function load(reload = false) {
    const current = ++generation; header.busy(true);
    try {
      if (!shown && !reload) {
        const saved = await services.runAction('resource.read', { cachedOnly: true }) as unknown as ResourceSnapshot | null;
        if (disposed || !active || current !== generation) return;
        if (saved?.detail) show(saved);
      }
      const snapshot = await services.runAction('resource.read', { refresh: reload }) as unknown as ResourceSnapshot;
      if (disposed || !active || current !== generation) return;
      show(snapshot);
    } catch (failure) {
      if (disposed || !active || current !== generation) return;
      if (!shown) { body.replaceChildren(); if (status) status.hidden = true; }
      banner.textContent = shown ? staleNotice({ error: (failure as Error).message, provider: options.provider }) : (failure as Error).message; banner.hidden = false;
    } finally { if (!disposed && current === generation) header.busy(false); }
  }
  return { update() {}, setActive(value) { if (active === value) return; active = value; generation++; closeChoices?.(); if (active) void load(); else header.busy(false); }, dispose() { disposed = true; generation++; closeChoices?.(); header.dispose(); root.remove(); } };
}
