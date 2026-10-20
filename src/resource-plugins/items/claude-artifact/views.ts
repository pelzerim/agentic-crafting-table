import type { RelatedResourceItem, ResourcePluginViews } from '../../types.ts';
import { mountViewHeader } from '../../view-header.ts';
import { parseClaudeArtifactUrl } from './url.ts';

/** A small local panel. The artifact itself needs the user's claude.ai sign-in, so it
 * always opens in the browser; nothing is embedded or fetched. */
export const claudeArtifactViews: ResourcePluginViews = {
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
      const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
    };
    const artifact = parseClaudeArtifactUrl(resource.data.url);
    const root = element('section', '', 'claude-artifact-view'), body = element('div', '', 'claude-artifact-body');
    root.append(body); container.append(root);
    const header = mountViewHeader(document, services, root);
    header.update({ status: { label: 'Private', tone: 'neutral' }, meta: ['Claude artifact'], ...(artifact ? { link: { url: artifact.url, provider: 'Claude' } } : {}) });

    const title = element('h3', resource.title, 'claude-artifact-title');
    const open = element('button', 'Open in browser', 'btn'); open.type = 'button'; open.dataset.variant = 'primary'; open.dataset.size = 'sm';
    const link = element('a', artifact?.url ?? 'No claude.ai link saved', 'claude-artifact-link');
    if (artifact) {
      link.href = artifact.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      // The host routes the link's own clicks to the browser; the button uses the same opener.
      open.onclick = () => { if (services.openUrl) services.openUrl(artifact.url); else document.defaultView?.open(artifact.url, '_blank', 'noopener'); };
    } else open.disabled = true;
    const note = element('p', 'Opens on claude.ai, where you are signed in to Claude.', 'claude-artifact-note');
    const facts = element('dl', '', 'claude-artifact-facts');
    const fact = (label: string, value: Node | string) => { const row = element('div'); const dd = element('dd'); dd.append(value); row.append(element('dt', label), dd); facts.append(row); };
    const revision = typeof resource.data.headSha === 'string' && resource.data.headSha ? resource.data.headSha : '';
    if (revision) { const code = element('code', revision.slice(0, 12)); code.title = revision; fact('Revision', code); }
    if (typeof resource.data.sessionId === 'string' && resource.data.sessionId) { const code = element('code', resource.data.sessionId.slice(0, 8)); code.title = resource.data.sessionId; fact('Session', code); }
    const related = element('div', '', 'claude-artifact-related'); related.setAttribute('aria-label', 'Connected items');
    body.append(title, link, element('div', '', 'claude-artifact-actions'), note, facts, related);
    body.querySelector('.claude-artifact-actions')!.append(open);
    facts.hidden = !facts.childElementCount;

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
      setActive(active) { offRelated?.(); offRelated = active ? services.observeRelated?.(renderRelated) : undefined; },
      dispose() { offRelated?.(); header.dispose(); root.remove(); },
    };
  },
};
