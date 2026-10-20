import { mountProviderRead } from '../../read-view.ts';
import type { ResourcePluginViews } from '../../types.ts';
import { emptyState } from '../../view-header.ts';
import { formatWhen } from '../../format-when.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { slackMarkdown } from '../../../../packages/provider-runtime/slack-markdown.ts';

const URL_PATTERN = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\//;
export const slackMessageViews: ResourcePluginViews = {
  identity: resource => JSON.stringify([resource.connectionId, resource.data]),
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const link = (url: unknown) => typeof url === 'string' && URL_PATTERN.test(url) ? url : undefined;
    const saved = typeof resource.data.workspaceHost === 'string' && typeof resource.data.channelId === 'string' && typeof resource.data.messageTs === 'string'
      ? link(`https://${resource.data.workspaceHost}/archives/${resource.data.channelId}/p${resource.data.messageTs.replace('.', '')}`) : undefined;
    return mountProviderRead(container, services, { className: 'slack-detail', provider: 'Slack', header(snapshot) {
      const detail = snapshot?.detail, count = Array.isArray(detail?.messages) ? detail.messages.length : undefined, url = link(detail?.url) ?? saved;
      return {
        meta: [typeof detail?.channel === 'string' && !resource.title.startsWith(`#${detail.channel}`) && `#${detail.channel}`, count !== undefined && (detail?.scope === 'message' && count <= 1 ? 'Message' : `Thread · ${count}`)],
        link: url ? { url, provider: 'Slack' } : undefined,
      };
    }, render(body, snapshot) {
      body.replaceChildren();
      const messages = Array.isArray(snapshot.detail?.messages) ? snapshot.detail.messages : [];
      const url = link(snapshot.detail?.url) ?? saved;
      if (!messages.length) body.append(emptyState(document, 'No messages in this thread.', { detail: 'The thread may have been deleted or moved.', ...(url ? { action: { label: 'Open in Slack', url } } : {}) }));
      const names = Object.fromEntries(messages.flatMap(message => message && typeof message === 'object' && !Array.isArray(message) && typeof message.userId === 'string' && typeof message.author === 'string' ? [[message.userId, message.author]] : []));
      for (const message of messages) {
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.text !== 'string' || typeof message.ts !== 'string') continue;
        const article = document.createElement('article'), title = document.createElement('header'), author = document.createElement('strong'), timestamp = document.createElement('time'), text = document.createElement('div');
        article.className = 'slack-thread-message'; article.dataset.messageTs = message.ts; article.dataset.selected = String(message.selected === true); article.setAttribute('aria-label', `${message.selected ? 'Selected message' : 'Message'} from ${message.author}`);
        author.textContent = String(message.author); author.title = String(message.userId);
        const sent = Number(message.ts.slice(0, 10)) * 1000; timestamp.dateTime = new Date(sent).toISOString(); timestamp.textContent = formatWhen(sent, 'relative'); timestamp.title = formatWhen(sent, 'full');
        title.append(author, timestamp); if (message.selected) { const selected = document.createElement('span'); selected.textContent = 'Selected'; selected.className = 'slack-selected-label'; title.append(selected); }
        text.className = 'slack-message-text markdown-content'; renderMarkdown(text, slackMarkdown(message.text, names)); article.append(title, text);
        if (message.edited) { const edited = document.createElement('small'); edited.textContent = 'Edited'; article.append(edited); }
        if (message.incomplete) { const notice = document.createElement('p'); notice.textContent = 'Open Slack to view attachments or rich content.'; article.append(notice); }
        body.append(article);
      }
      // Reveal an offscreen selected reply inside the retained detail scroller.
      const selected = body.querySelector<HTMLElement>('[data-selected="true"]'), scroller = container.closest<HTMLElement>('.resource-detail');
      if (selected && scroller) { const bounds = selected.getBoundingClientRect(), viewport = scroller.getBoundingClientRect(); if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) scroller.scrollTop += bounds.top - viewport.top - 12; }
    } });
  },
};
