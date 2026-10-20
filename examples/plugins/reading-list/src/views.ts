/** Window entry views (browser). Builds DOM only; data comes from the service through runAction. */
import type { MountedResourceView, ResourcePluginViews, ResourceSnapshot } from '@agent-crafting-table/plugin-sdk/index.ts';
import { emptyState, formatWhen, mountViewHeader, skeleton, staleNotice } from '@agent-crafting-table/plugin-sdk/views.ts';
import type { ViewHeaderData } from '@agent-crafting-table/plugin-sdk/views.ts';
import { READ_STATE } from './definition.ts';

interface Detail { url: string; site: string; note: string; tags: string[]; readAt: string | null; checks: 'on' | 'off'; check: { state: string; checkedAt: string; pageTitle?: string; reason?: string; status?: number } | null }

/** The status chip has one job: say what state the link is in. */
function header(detail: Detail | undefined, url: string, site: string): ViewHeaderData {
  const state = detail?.check?.state;
  const status = !detail ? undefined
    : state === 'broken' ? { label: 'Broken', tone: 'red' as const }
    : detail.readAt ? { label: 'Read', tone: 'green' as const }
    : { label: 'Unread', tone: 'neutral' as const };
  return { status, meta: [site, detail?.tags.length ? detail.tags.join(', ') : null, detail?.readAt && `Read ${formatWhen(detail.readAt, 'relative')}`], link: { url, provider: site } };
}

function checkLine(detail: Detail): string {
  if (detail.checks === 'off') return 'Link checks are off in Settings.';
  const check = detail.check;
  if (!check) return 'Not checked yet.';
  if (check.state === 'ok') return `Checked ${formatWhen(check.checkedAt, 'relative')}.`;
  if (check.state === 'broken') return `The page is gone (HTTP ${check.status}). Update the URL or remove the link.`;
  return `Couldn’t check: ${check.reason ?? 'unknown reason'}.`;
}

export const readingLinkViews: ResourcePluginViews = {
  mountDetail(container, resource, services): MountedResourceView {
    const document = container.ownerDocument, url = String(resource.data.url), site = new URL(url).hostname;
    const root = document.createElement('section'), banner = document.createElement('p'), body = document.createElement('div');
    root.className = 'reading-link'; banner.className = 'view-stale-banner'; banner.setAttribute('role', 'status'); banner.hidden = true;
    body.className = 'reading-link-body'; body.setAttribute('aria-live', 'polite');
    root.append(banner, body); container.append(root);

    // The host draws the title, ↗, freshness and ↻ in the frame bar; the plugin supplies data and one primary action.
    const bar = mountViewHeader(document, services, root, { onRefresh: () => { if (active) void load(true); } });
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'btn'; toggle.dataset.variant = 'primary'; toggle.dataset.size = 'sm'; toggle.hidden = true;
    bar.actions.append(toggle);
    bar.update(header(undefined, url, site));
    body.append(skeleton(document));

    let active = false, disposed = false, generation = 0, detail: Detail | undefined;
    const live = (ticket: number) => active && !disposed && ticket === generation;

    function show(snapshot: ResourceSnapshot) {
      detail = snapshot.detail as unknown as Detail;
      bar.update(header(detail, url, site));
      bar.freshness({ observedAt: snapshot.observedAt, stale: snapshot.stale, error: snapshot.error, provider: site });
      banner.textContent = snapshot.stale ? staleNotice({ observedAt: snapshot.observedAt, error: snapshot.error, provider: site }) : '';
      banner.hidden = !snapshot.stale;
      toggle.hidden = false; toggle.textContent = detail.readAt ? 'Mark unread' : 'Mark read';
      const note = document.createElement('p'), check = document.createElement('p');
      check.className = 'reading-link-check'; check.textContent = checkLine(detail);
      check.dataset.state = detail.check?.state ?? 'none';
      body.replaceChildren(check);
      // The frame bar already shows the item title; repeat only the page's own title when it differs.
      const pageTitle = detail.check?.pageTitle;
      if (pageTitle && pageTitle !== resource.title) {
        const title = document.createElement('h2'); title.className = 'reading-link-title'; title.textContent = pageTitle; body.prepend(title);
      }
      if (detail.note) { note.className = 'reading-link-note'; note.textContent = detail.note; body.append(note); }
      else body.append(emptyState(document, 'No note yet', { detail: 'Edit the item to add why you saved it.' }));
    }

    async function load(refresh = false) {
      const ticket = ++generation; bar.busy(true);
      try {
        // Paint the saved copy first, then read; a late answer for an old ticket is dropped.
        if (!detail && !refresh) {
          const saved = await services.runAction('resource.read', { cachedOnly: true }) as unknown as ResourceSnapshot | null;
          if (live(ticket) && saved?.detail) show(saved);
        }
        const snapshot = await services.runAction('resource.read', { refresh }) as unknown as ResourceSnapshot;
        if (live(ticket)) show(snapshot);
      } catch (error) {
        if (!live(ticket)) return;
        banner.textContent = detail ? staleNotice({ error: (error as Error).message, provider: site }) : (error as Error).message; banner.hidden = false;
        if (!detail) body.replaceChildren();
      } finally { if (!disposed && ticket === generation) bar.busy(false); }
    }

    toggle.onclick = async () => {
      if (!detail || toggle.getAttribute('aria-busy') === 'true') return;
      toggle.setAttribute('aria-busy', 'true');
      try { await services.runAction(READ_STATE, { operation: 'set', value: detail.readAt ? 'unread' : 'read' }); await load(); }
      catch (error) { banner.textContent = (error as Error).message; banner.hidden = false; }
      finally { toggle.removeAttribute('aria-busy'); }
    };

    return {
      update() {},
      // The host activates the view when it is shown and deactivates it when it is hidden or closing.
      setActive(value) { if (active === value) return; active = value; generation++; if (active) void load(); else bar.busy(false); },
      dispose() { disposed = true; generation++; bar.dispose(); root.remove(); },
    };
  },
};
