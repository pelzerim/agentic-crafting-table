import { LINEAR_PULLS_OPERATION } from './definition.ts';
import { mountProviderRead } from '../../read-view.ts';
import type { ResourcePluginViews } from '../../types.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { formatWhen } from '../../format-when.ts';
import { emptyState } from '../../view-header.ts';
import type { ChipTone } from '../../view-header.ts';

const KEY = /^[A-Z][A-Z0-9]*-[1-9]\d*$/i, URL_PATTERN = /^https:\/\/linear\.app\/[A-Za-z0-9_-]+\/issue\//;
export const linearTicketViews: ResourcePluginViews = {
  identity: resource => JSON.stringify([resource.connectionId, resource.data]),
  /** Linked pull requests → Add to the map: the service attaches them; the map flies to the first one. */
  async runContextAction(actionId, _resource, services) {
    if (actionId !== 'pulls.add') throw new Error('This action is not available for Linear tickets.');
    const result = await services.runAction(LINEAR_PULLS_OPERATION, { operation: 'add', requestId: crypto.randomUUID() }) as { nodeId?: unknown };
    return typeof result?.nodeId === 'string' ? { nodeId: result.nodeId } : {};
  },
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const saved = typeof resource.data.workspaceKey === 'string' && KEY.test(String(resource.data.issueId)) ? `https://linear.app/${resource.data.workspaceKey}/issue/${resource.data.issueId}` : undefined;
    return mountProviderRead(container, services, {
      className: 'linear-detail', provider: 'Linear', choices: { load: 'linear.status.options', apply: 'linear.status.set' }, documentTitle: true,
      header(snapshot) {
        const detail = snapshot?.detail, url = typeof detail?.url === 'string' && URL_PATTERN.test(detail.url) ? detail.url : saved;
        const identifier = typeof detail?.identifier === 'string' ? detail.identifier : KEY.test(String(resource.data.issueId)) ? String(resource.data.issueId) : undefined;
        return {
          status: snapshot ? { label: snapshot.label, tone: (snapshot.indicators?.[0]?.tone ?? 'neutral') as ChipTone } : undefined,
          meta: [identifier, typeof detail?.updatedAt === 'string' && `updated ${formatWhen(detail.updatedAt)}`],
          link: url ? { url, provider: 'Linear' } : undefined,
        };
      },
      render(body, snapshot) {
        const text = typeof snapshot.detail?.description === 'string' ? snapshot.detail.description.trim() : '';
        if (!text) { body.replaceChildren(emptyState(document, 'This issue has no description.', { detail: 'Add one in Linear; it appears here on the next read.' })); return; }
        const description = document.createElement('div'); description.className = 'linear-description markdown-content';
        renderMarkdown(description, String(snapshot.detail?.description));
        body.replaceChildren(description);
      },
    });
  },
};
