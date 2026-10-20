import { notionId } from './notion-transport.ts';
import type { NotionTransport } from './notion-transport.ts';
import { escapeMarkdown } from './notion-markdown.ts';
export interface NotionBlock { id: string; type: string; text: string; depth: number; unsupported: boolean; markdown?: string; checked?: boolean; language?: string }
/** `viewers` are the identities that act as the signed-in person: the integration's bot and,
 * for an OAuth integration owned by a user, that user. An internal integration has no human owner. */
export interface NotionPageContent { id: string; title: string; url: string; archived: boolean; editedAt: string; blocks: NotionBlock[]; incomplete: boolean; viewers: string[] }
/** One open comment; `parentId` is the page for page-level discussions or the block it is anchored to. */
export interface NotionComment { id: string; discussionId: string; parentId: string; createdAt: string; authorId: string }
const uuid = (value: string) => { try { notionId(value); return true; } catch { return false; } };
const invalid = () => new Error('Notion returned incomplete or inconsistent page content. Refresh to retry.');
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); return value as Record<string, any>; }
function text(value: unknown): string {
  if (!Array.isArray(value)) throw invalid();
  return value.map(value => { const item = object(value); if (typeof item.plain_text !== 'string') throw invalid(); return item.plain_text; }).join('');
}
const wrap = (value: string, marker: string) => { const [, before, core, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value)!; return core ? `${before}${marker}${core}${marker}${after}` : value; };
/** Rich text as inline Markdown for the shared renderer; provider text never becomes markup. */
export function notionInlineMarkdown(value: unknown): string {
  if (!Array.isArray(value)) throw invalid();
  return value.map(raw => {
    const item = object(raw), annotations = item.annotations && typeof item.annotations === 'object' ? item.annotations as Record<string, unknown> : {};
    if (typeof item.plain_text !== 'string') throw invalid();
    let content: string;
    if (annotations.code === true) { const fence = item.plain_text.includes('`') ? '``' : '`'; content = fence.length > 1 ? `${fence} ${item.plain_text} ${fence}` : `${fence}${item.plain_text}${fence}`; }
    else content = escapeMarkdown(item.plain_text);
    if (annotations.strikethrough === true) content = wrap(content, '~~');
    if (annotations.italic === true) content = wrap(content, '*');
    if (annotations.bold === true) content = wrap(content, '**');
    const href = typeof item.href === 'string' ? item.href : typeof item.text?.link?.url === 'string' ? item.text.link.url : undefined;
    return href && /^https?:\/\//.test(href) && content.trim() ? `[${content}](${href.replace(/[()\s]/g, encodeURIComponent)})` : content;
  }).join('');
}
export class NotionClient {
  private transport: NotionTransport; private botId: string;
  constructor(transport: NotionTransport, botId: string) { this.transport = transport; this.botId = notionId(botId); }
  /** With `reuse`, a page whose revision and archive state are unchanged keeps that content and
   * costs two requests instead of a full read. */
  async page(id: string, signal: AbortSignal, reuse?: NotionPageContent): Promise<NotionPageContent> {
    const pageId = notionId(id); let requests = 0, characters = 0, formatted = 0;
    const read = async (path: string) => { signal.throwIfAborted(); if (++requests > 64) throw new Error('This Notion page exceeds the 64-request reading limit. No partial page was saved.'); const result = object(await this.transport.get(path, signal)); signal.throwIfAborted(); return result; };
    const me = await read('/v1/users/me'); if (me.object !== 'user' || me.type !== 'bot' || notionId(me.id) !== this.botId) throw new Error('The Notion credential belongs to a different account. Reconnect the original profile.');
    const owner = me.bot?.owner?.type === 'user' ? me.bot.owner.user?.id : undefined, viewers = [this.botId, ...(typeof owner === 'string' && uuid(owner) ? [notionId(owner)] : [])];
    const first = await read(`/v1/pages/${pageId}`);
    const check = (page: Record<string, any>) => { if (page.object !== 'page' || notionId(page.id) !== pageId || typeof page.last_edited_time !== 'string' || typeof page.archived !== 'boolean') throw invalid(); };
    check(first);
    const archived = first.archived || first.in_trash === true;
    if (reuse && reuse.id === pageId && reuse.editedAt === first.last_edited_time && reuse.archived === archived) return { ...reuse, viewers };
    const properties = Object.values(object(first.properties)).map(object), title = properties.find(property => property.type === 'title');
    if (!title || typeof title.id !== 'string') throw invalid();
    const list = async (path: string) => {
      const values: Record<string, any>[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const result = await read(`${path}?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
        if (result.object !== 'list' || !Array.isArray(result.results) || typeof result.has_more !== 'boolean' || result.results.length > 100) throw invalid();
        values.push(...result.results.map(object)); if (values.length > 2000) throw new Error('This Notion page exceeds the 2,000-item reading limit.');
        if (!result.has_more) break;
        if (typeof result.next_cursor !== 'string' || !result.results.length || cursors.has(result.next_cursor)) throw invalid();
        notionId(result.next_cursor); cursors.add(result.next_cursor); cursor = result.next_cursor;
      } while (true);
      return values;
    };
    const titleItems = await list(`/v1/pages/${pageId}/properties/${encodeURIComponent(decodeURIComponent(title.id))}`);
    const fullTitle = titleItems.map(item => { if (item.object !== 'property_item' || item.type !== 'title') throw invalid(); return text([item.title]); }).join('').trim() || 'Untitled';
    if (fullTitle.length > 500) throw new Error('This Notion title exceeds the item title limit.');
    const blocks: NotionBlock[] = [], seen = new Set<string>();
    async function children(parent: string, depth: number): Promise<void> {
      if (depth > 16) throw new Error('This Notion page exceeds the nested-content depth limit.');
      for (const raw of await list(`/v1/blocks/${parent}/children`)) {
        const blockId = notionId(raw.id); if (seen.has(blockId) || raw.object !== 'block' || typeof raw.type !== 'string' || typeof raw.has_children !== 'boolean') throw invalid(); seen.add(blockId);
        if (seen.size > 2000) throw new Error('This Notion page exceeds the 2,000-block reading limit.');
        const detail = object(raw[raw.type]); let content: string, unsupported = false, markdown: string | undefined;
        if (Array.isArray(detail.rich_text)) { content = text(detail.rich_text); markdown = notionInlineMarkdown(detail.rich_text); }
        else if (raw.type === 'table_row' && Array.isArray(detail.cells)) content = detail.cells.map(text).join(' | ');
        else if (['child_page', 'child_database'].includes(raw.type) && typeof detail.title === 'string') content = detail.title;
        else if (raw.type === 'equation' && typeof detail.expression === 'string') content = detail.expression;
        else if (['column', 'column_list', 'table', 'synced_block', 'divider'].includes(raw.type)) content = raw.type === 'divider' ? '────────' : '';
        else { content = `[${raw.type} · open in Notion]`; unsupported = true; }
        if (raw.type === 'to_do') content = `${detail.checked === true ? '[x]' : '[ ]'} ${content}`;
        characters += content.length; if (characters > 200_000) throw new Error('This Notion page exceeds the text reading limit.');
        formatted += markdown?.length ?? 0; if (formatted > 400_000) throw new Error('This Notion page exceeds the text reading limit.');
        blocks.push({ id: blockId, type: raw.type, text: content, depth, unsupported, ...(markdown !== undefined ? { markdown } : {}), ...(raw.type === 'to_do' ? { checked: detail.checked === true } : {}), ...(raw.type === 'code' && typeof detail.language === 'string' ? { language: detail.language.slice(0, 40) } : {}) });
        if (raw.has_children) await children(blockId, depth + 1);
      }
    }
    await children(pageId, 0);
    const after = await read(`/v1/pages/${pageId}`); check(after);
    if (after.last_edited_time !== first.last_edited_time || after.archived !== first.archived) throw new Error('The Notion page changed while reading. Refresh for a consistent view.');
    return { id: pageId, title: fullTitle, url: `https://www.notion.so/${pageId}`, archived, editedAt: first.last_edited_time, blocks, incomplete: blocks.some(block => block.unsupported), viewers };
  }
  /** Open comments anchored to one page or block, oldest first. Needs the integration's
   * Read comments capability; a refusal surfaces as the transport's 403. */
  async comments(blockId: string, signal: AbortSignal): Promise<NotionComment[]> {
    const id = notionId(blockId), comments: NotionComment[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 5) throw new Error('This Notion discussion exceeds the 500-comment reading limit.');
      signal.throwIfAborted();
      const result = object(await this.transport.get(`/v1/comments?block_id=${id}&page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`, signal)); signal.throwIfAborted();
      if (result.object !== 'list' || !Array.isArray(result.results) || typeof result.has_more !== 'boolean' || result.results.length > 100) throw invalid();
      for (const raw of result.results.map(object)) {
        if (raw.object !== 'comment' || typeof raw.created_time !== 'string' || Number.isNaN(Date.parse(raw.created_time))) throw invalid();
        const parent = object(raw.parent), parentId = parent.type === 'page_id' ? parent.page_id : parent.type === 'block_id' ? parent.block_id : undefined;
        comments.push({ id: notionId(raw.id), discussionId: notionId(raw.discussion_id), parentId: notionId(parentId), createdAt: new Date(raw.created_time).toISOString(), authorId: notionId(object(raw.created_by).id) });
      }
      if (!result.has_more) return comments;
      if (typeof result.next_cursor !== 'string' || !result.results.length || cursors.has(result.next_cursor)) throw invalid();
      notionId(result.next_cursor); cursors.add(result.next_cursor); cursor = result.next_cursor;
    }
  }
}
