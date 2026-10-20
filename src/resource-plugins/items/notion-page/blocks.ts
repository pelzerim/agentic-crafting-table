import type { JsonValue } from '../../types.ts';
import { escapeMarkdown } from '../../../../packages/provider-runtime/notion-markdown.ts';

export interface SavedBlock { type: string; text: string; depth: number; unsupported?: boolean; markdown?: string; checked?: boolean; language?: string }
export interface BlockNode { block: SavedBlock; children: BlockNode[] }

export function savedBlocks(value: JsonValue | undefined): SavedBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(block => block && typeof block === 'object' && !Array.isArray(block) && typeof block.text === 'string' && typeof block.type === 'string'
    ? [{ type: block.type, text: block.text, depth: typeof block.depth === 'number' ? Math.max(0, Math.min(16, block.depth)) : 0, unsupported: block.unsupported === true,
      ...(typeof block.markdown === 'string' ? { markdown: block.markdown } : {}), ...(typeof block.checked === 'boolean' ? { checked: block.checked } : {}), ...(typeof block.language === 'string' ? { language: block.language } : {}) }]
    : []);
}

/** Nests each block under the nearest earlier block one level shallower. */
export function blockTree(blocks: readonly SavedBlock[]): BlockNode[] {
  const roots: BlockNode[] = [], stack: { depth: number; node: BlockNode }[] = [];
  for (const block of blocks) {
    const node = { block, children: [] };
    while (stack.length && stack.at(-1)!.depth >= block.depth) stack.pop();
    (stack.at(-1)?.node.children ?? roots).push(node);
    stack.push({ depth: block.depth, node });
  }
  return roots;
}

/** Inline Markdown for a block's text; saved copies from before formatting fall back to escaped plain text. */
export function inlineMarkdown(block: SavedBlock) {
  if (block.markdown !== undefined) return block.markdown;
  return escapeMarkdown(block.type === 'to_do' ? block.text.replace(/^\[[ x]\] /, '') : block.text);
}

/** One block as Markdown for the shared renderer. `ordinal` numbers consecutive numbered items. */
export function blockMarkdown(block: SavedBlock, ordinal = 1): string {
  const inline = inlineMarkdown(block);
  switch (block.type) {
    case 'heading_1': return `## ${inline}`;
    case 'heading_2': return `### ${inline}`;
    case 'heading_3': case 'heading_4': return `#### ${inline}`;
    case 'to_do': return `- [${(block.checked ?? /^\[x\] /.test(block.text)) ? 'x' : ' '}] ${inline}`;
    case 'bulleted_list_item': return `- ${inline}`;
    case 'numbered_list_item': return `${ordinal}. ${inline}`;
    case 'quote': case 'callout': return `> ${inline.replace(/\n/g, '\n> ')}`;
    case 'divider': return '---';
    case 'code': { const fence = '`'.repeat(Math.max(3, ...[...block.text.matchAll(/`+/g)].map(match => match[0].length + 1))); return `${fence}${(block.language ?? '').replace(/[^\w+-]/g, '')}\n${block.text}\n${fence}`; }
    default: return inline;
  }
}
