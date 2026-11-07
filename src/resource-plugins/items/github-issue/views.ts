import { GITHUB_ISSUE_PULLS_OPERATION } from './definition.ts';
import type { IssueComment } from './connector.ts';
import { mountProviderRead } from '../../read-view.ts';
import type { ResourcePluginViews } from '../../types.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { formatWhen } from '../../format-when.ts';
import { emptyState, timeElement } from '../../view-header.ts';
import type { ChipTone } from '../../view-header.ts';

const URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;
export const githubIssueViews: ResourcePluginViews = {
  identity: resource => JSON.stringify([resource.connectionId, resource.data]),
  /** Linked pull requests → Add to the map: the service attaches them; the map flies to the first one. */
  async runContextAction(actionId, _resource, services) {
    if (actionId !== 'pulls.add') throw new Error('This action is not available for GitHub issues.');
    const result = await services.runAction(GITHUB_ISSUE_PULLS_OPERATION, { operation: 'add', requestId: crypto.randomUUID() }) as { nodeId?: unknown };
    return typeof result?.nodeId === 'string' ? { nodeId: result.nodeId } : {};
  },
  mountDetail(container, resource, services) {
    const document = container.ownerDocument, { owner, repo, number } = resource.data;
    const saved = `https://github.com/${owner}/${repo}/issues/${number}`;
    return mountProviderRead(container, services, {
      className: 'github-issue-detail', provider: 'GitHub', choices: { load: 'issue.state.options', apply: 'issue.state.set' }, documentTitle: true,
      header(snapshot) {
        const detail = snapshot?.detail, url = typeof detail?.url === 'string' && URL_PATTERN.test(detail.url) ? detail.url : URL_PATTERN.test(saved) ? saved : undefined;
        return {
          status: snapshot ? { label: snapshot.label, tone: (snapshot.indicators?.[0]?.tone ?? 'neutral') as ChipTone } : undefined,
          meta: [`#${number}`, typeof detail?.author === 'string' && `opened by ${detail.author}`, typeof detail?.updatedAt === 'string' && `updated ${formatWhen(detail.updatedAt)}`],
          link: url ? { url, provider: 'GitHub' } : undefined,
        };
      },
      render(body, snapshot) {
        const detail = snapshot.detail ?? {}, text = typeof detail.body === 'string' ? detail.body.trim() : '';
        const parts: HTMLElement[] = [];
        if (Array.isArray(detail.labels) && detail.labels.length) {
          const labels = document.createElement('ul'); labels.className = 'github-issue-labels'; labels.setAttribute('aria-label', 'Labels');
          for (const name of detail.labels) { const label = document.createElement('li'); label.textContent = String(name); labels.append(label); }
          parts.push(labels);
        }
        if (text) {
          const description = document.createElement('div'); description.className = 'github-issue-description markdown-content';
          renderMarkdown(description, text); parts.push(description);
        } else parts.push(emptyState(document, 'This issue has no description.', { detail: 'Add one on GitHub; it appears here on the next read.' }));
        const comments = Array.isArray(detail.comments) ? detail.comments as IssueComment[] : [], total = typeof detail.commentsTotal === 'number' ? detail.commentsTotal : comments.length;
        if (comments.length) {
          const section = document.createElement('section'), heading = document.createElement('h3');
          section.className = 'github-issue-comments'; heading.textContent = total > comments.length ? `Latest ${comments.length} of ${total} comments` : `${total} ${total === 1 ? 'comment' : 'comments'}`;
          section.append(heading);
          for (const comment of comments) {
            const article = document.createElement('article'), header = document.createElement('header'), author = document.createElement('strong'), text = document.createElement('div');
            article.className = 'github-issue-comment'; article.dataset.commentId = String(comment.id); article.setAttribute('aria-label', `Comment from ${comment.author}`);
            author.textContent = comment.author; header.append(author, timeElement(document, comment.date));
            text.className = 'markdown-content'; renderMarkdown(text, comment.body);
            article.append(header, text); section.append(article);
          }
          parts.push(section);
        }
        body.replaceChildren(...parts);
      },
    });
  },
};
