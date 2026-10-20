import type { JsonObject, ResourcePluginConnector, ResourceRecord } from '../../types.ts';
import type { NotionClient, NotionComment, NotionPageContent } from '../../../../packages/provider-runtime/notion.ts';
import type { SavedComments } from './comments.ts';

/** Inline discussions live on blocks, so each read also lists comments of up to
 * DISCUSSIONS blocks known to have them and the next ROTATION blocks of the page in turn,
 * covering at most MAX_BLOCKS blocks over successive reads. */
export const COMMENT_LIMITS = { discussions: 10, rotation: 10, maxBlocks: 500, items: 500, deniedMs: 30 * 60_000 } as const;
const NO_COMMENTS = new Set(['divider', 'column_list', 'column', 'table', 'child_page', 'child_database', 'unsupported']);
export const commentsDenied = 'Notion comments need the integration’s Read comments capability. Enable it for the integration in Notion, then refresh.';

interface Memory { page?: NotionPageContent; blocks: Map<string, NotionComment[]>; checked: Set<string>; cursor: number; deniedUntil?: number }

export function notionPageConnector(clientFor: (resource: ResourceRecord, signal: AbortSignal) => Promise<NotionClient>, options: { now?: () => number } = {}): ResourcePluginConnector {
  const now = options.now ?? Date.now, memory = new Map<string, Memory>();
  const read = async (resource: ResourceRecord, signal: AbortSignal) => (await clientFor(resource, signal)).page(String(resource.data.pageId), signal);
  async function comments(client: NotionClient, page: NotionPageContent, state: Memory, signal: AbortSignal, background: boolean): Promise<SavedComments> {
    if (background && (state.deniedUntil ?? 0) > now()) return { available: false, reason: commentsDenied };
    try {
      const top = await client.comments(page.id, signal);
      const eligible = page.blocks.filter(block => !NO_COMMENTS.has(block.type) && !block.unsupported).map(block => block.id).slice(0, COMMENT_LIMITS.maxBlocks), present = new Set(eligible);
      for (const id of [...state.blocks.keys()]) if (!present.has(id)) state.blocks.delete(id);
      const targets = [...state.blocks.keys()].slice(0, COMMENT_LIMITS.discussions);
      let step = 0;
      while (step < eligible.length && targets.length < COMMENT_LIMITS.discussions + COMMENT_LIMITS.rotation) {
        const id = eligible[(state.cursor + step++) % eligible.length];
        if (!targets.includes(id)) targets.push(id);
      }
      if (eligible.length) state.cursor = (state.cursor + step) % eligible.length;
      for (const id of targets) {
        let found: NotionComment[];
        try { found = await client.comments(id, signal); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; found = []; }
        if (found.length) state.blocks.set(id, found); else state.blocks.delete(id);
        state.checked.add(id);
      }
      state.deniedUntil = undefined;
      const items = [...top, ...[...state.blocks.values()].flat()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-COMMENT_LIMITS.items);
      return { available: true, items: items.map(comment => ({ id: comment.id, at: comment.createdAt, author: comment.authorId, parent: comment.parentId })), viewers: page.viewers,
        blocks: { total: eligible.length, checked: eligible.filter(id => state.checked.has(id)).length } };
    } catch (error) {
      if ((error as { status?: number }).status !== 403) throw error;
      state.deniedUntil = now() + COMMENT_LIMITS.deniedMs;
      return { available: false, reason: commentsDenied };
    }
  }
  return {
    pollIntervalMs: 60_000,
    async load(resource, signal, options) {
      const background = options?.background === true, client = await clientFor(resource, signal), key = JSON.stringify([resource.id, resource.connectionId, resource.data.pageId]);
      const state: Memory = memory.get(key) ?? { blocks: new Map(), checked: new Set(), cursor: 0 };
      const page = await client.page(String(resource.data.pageId), signal, background ? state.page : undefined);
      const discussion = await comments(client, page, state, signal, background);
      state.page = page; memory.set(key, state);
      const { viewers: _viewers, ...content } = page;
      return { title: page.title, activity: page.archived ? 'complete' : 'idle', attention: 'none', connection: 'connected', observedAt: new Date(now()).toISOString(), label: page.archived ? 'Archived in Notion' : page.incomplete ? 'Some blocks require Notion' : 'Notion page',
        detail: { ...content, blocks: page.blocks.map(block => ({ ...block })), comments: discussion as unknown as JsonObject } };
    },
    async getContext(resource, signal) {
      const page = await read(resource, signal), content = [page.title, `Notion · ${page.editedAt}${page.archived ? ' · archived' : ''}`, ...(page.incomplete ? ['Some blocks are unavailable here; open the source in Notion.'] : []), ...page.blocks.map(block => '  '.repeat(block.depth) + block.text)].join('\n');
      return { resourceId: resource.id, title: page.title, sourceUrl: page.url, content: content.length > 32_000 ? content.slice(0, 31_940) + '\n[Context excerpt ends here; open the page for the rest.]' : content };
    },
  };
}
