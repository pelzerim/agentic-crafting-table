import { mountProviderRead } from '../../read-view.ts';
import type { ResourcePluginViews } from '../../types.ts';
import { formatWhen } from '../../format-when.ts';
import { emptyState } from '../../view-header.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { blockMarkdown, blockTree, inlineMarkdown, savedBlocks } from './blocks.ts';
import { unreadLabel } from './comments.ts';
import type { BlockNode } from './blocks.ts';

const ID = /^[a-f0-9]{32}$/;
/** The `notion.page.comments` read: unread count, or whether comments could not be read at all. */
function commentState(value: unknown) {
  const state = value && typeof value === 'object' ? value as { available?: unknown; reason?: unknown; unread?: unknown } : {};
  return { unread: typeof state.unread === 'number' && state.unread > 0 ? Math.floor(state.unread) : 0, unavailable: state.available === false && typeof state.reason === 'string' };
}
export const notionPageViews: ResourcePluginViews = {
  identity: resource => JSON.stringify([resource.connectionId, resource.data]),
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    return mountProviderRead(container, services, {
      className: 'notion-detail', provider: 'Notion', documentTitle: true,
      local: () => services.runAction('notion.page.comments'),
      header(snapshot, local) {
        const detail = snapshot?.detail, id = typeof detail?.id === 'string' && ID.test(detail.id) ? detail.id : ID.test(String(resource.data.pageId)) ? String(resource.data.pageId) : undefined;
        const comments = commentState(local), archived = detail?.archived === true;
        return {
          status: archived ? { label: 'Archived', tone: 'neutral' } : comments.unread ? { label: unreadLabel(comments.unread), tone: 'blue' } : undefined,
          meta: ['Page', typeof detail?.editedAt === 'string' && `edited ${formatWhen(detail.editedAt)}`, archived && comments.unread ? unreadLabel(comments.unread) : comments.unavailable && 'Comments unavailable'],
          link: id ? { url: `https://www.notion.so/${id}`, provider: 'Notion' } : undefined,
        };
      },
      render(body, snapshot) {
        body.replaceChildren();
        if (snapshot.detail?.incomplete) { const warning = document.createElement('p'); warning.textContent = 'Some blocks require Notion and are marked below.'; body.append(warning); }
        const blocks = savedBlocks(snapshot.detail?.blocks);
        const append = (parent: HTMLElement, nodes: BlockNode[]) => {
          let ordinal = 0;
          for (const { block, children } of nodes) {
            ordinal = block.type === 'numbered_list_item' ? ordinal + 1 : 0;
            let element: HTMLElement, childParent: HTMLElement;
            if (block.type === 'toggle') {
              const details = document.createElement('details'), summary = document.createElement('summary'), inline = document.createElement('div');
              renderMarkdown(inline, inlineMarkdown(block)); summary.append(...(inline.firstElementChild?.childNodes ?? inline.childNodes));
              details.append(summary); element = details; childParent = details;
            } else {
              element = document.createElement('div'); renderMarkdown(element, blockMarkdown(block, ordinal)); childParent = element;
            }
            element.classList.add('notion-block'); element.dataset.blockType = block.type; if (block.unsupported) element.dataset.unsupported = '';
            if (children.length) { const nested = document.createElement('div'); nested.className = 'notion-children'; append(nested, children); childParent.append(nested); }
            parent.append(element);
          }
        };
        const content = document.createElement('div'); content.className = 'notion-document markdown-content';
        append(content, blockTree(blocks));
        body.append(blocks.length ? content : emptyState(document, 'This page is empty.', { detail: 'Add content in Notion; it appears here on the next read.' }));
      },
    });
  },
};
