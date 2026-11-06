import type { RelatedResourceItem, ResourcePluginViews } from '../../types.ts';
import { mountViewHeader } from '../../view-header.ts';
import { parseClaudeArtifactUrl } from './url.ts';

/** The claude.ai page itself, through the host's embedded `claude` site. A host that embeds no pages, or an item
 * without a saved link, gets a small panel whose Open in browser uses the system browser. */
export const claudeArtifactViews: ResourcePluginViews = {
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
      const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
    };
    const artifact = parseClaudeArtifactUrl(resource.data.url);
    const root = element('section', '', 'claude-artifact-view');
    container.append(root);
    const header = mountViewHeader(document, services, root);
    const pageLink = artifact ? { link: { url: artifact.url, provider: 'Claude' } } : {};

    const open = element('button', 'Open in browser'); open.type = 'button';
    if (artifact) open.onclick = () => { if (services.openUrl) services.openUrl(artifact.url); else document.defaultView?.open(artifact.url, '_blank', 'noopener'); };
    else open.disabled = true;
    const related = element('div', '', 'claude-artifact-related'); related.setAttribute('aria-label', 'Connected items');
    const title = element('h3', resource.title, 'claude-artifact-title');
    let embed = artifact && services.mountWebPage ? { url: artifact.url, mount: services.mountWebPage } : undefined;
    const slot = element('div', '', 'claude-artifact-page');
    const showPanel = () => {
      slot.remove();
      header.update({ status: { label: 'Private', tone: 'neutral' }, meta: ['Claude artifact'], ...pageLink });
      const body = element('div', '', 'claude-artifact-body');
      open.className = 'btn'; open.dataset.variant = 'primary'; open.dataset.size = 'sm';
      const link = element('a', artifact?.url ?? 'No claude.ai link saved', 'claude-artifact-link');
      if (artifact) { link.href = artifact.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      const actions = element('div', '', 'claude-artifact-actions'); actions.append(open);
      const facts = element('dl', '', 'claude-artifact-facts');
      const fact = (label: string, value: string, length: number) => { const row = element('div'), dd = element('dd'), code = element('code', value.slice(0, length)); code.title = value; dd.append(code); row.append(element('dt', label), dd); facts.append(row); };
      if (typeof resource.data.headSha === 'string' && resource.data.headSha) fact('Revision', resource.data.headSha, 12);
      if (typeof resource.data.sessionId === 'string' && resource.data.sessionId) fact('Session', resource.data.sessionId, 8);
      facts.hidden = !facts.childElementCount;
      body.append(title, link, actions, element('p', 'Opens on claude.ai, where you are signed in to Claude.', 'claude-artifact-note'), facts, related);
      root.append(body);
    };
    if (embed) { header.update(pageLink); header.actions.append(open); root.append(slot); } else showPanel();

    // The host keeps a closed view mounted but hidden; only the open one holds a live page.
    let page: { dispose(): void } | undefined;
    const showPage = (shown: boolean) => {
      if (!embed || shown === Boolean(page)) return;
      if (!shown) { page!.dispose(); page = undefined; return; }
      page = embed.mount(slot, { site: 'claude', url: embed.url });
      // A host that does not embed this site gets the panel instead.
      if (!page) { embed = undefined; showPanel(); }
    };
    const renderRelated = (items: RelatedResourceItem[]) => {
      related.replaceChildren();
      const sources = items.filter(item => item.resource?.pluginId === 'github.pull-request' || item.resource?.pluginId === 'agent.session');
      if (!sources.length) return;
      related.append(element('strong', 'From'));
      for (const item of sources) {
        const button = element('button', `${item.resource?.pluginId === 'agent.session' ? 'Agent' : 'Pull request'} · ${item.title}`, 'claude-artifact-source');
        button.type = 'button'; button.onclick = () => services.openResource(item.nodeId); related.append(button);
      }
    };
    let offRelated: (() => void) | undefined;
    return {
      update(snapshot) { if (snapshot.title) title.textContent = snapshot.title; },
      setActive(active) { offRelated?.(); offRelated = active ? services.observeRelated?.(renderRelated) : undefined; showPage(active); },
      dispose() { offRelated?.(); showPage(false); header.dispose(); root.remove(); },
    };
  },
};
