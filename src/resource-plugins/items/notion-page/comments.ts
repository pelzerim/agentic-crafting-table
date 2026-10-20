import { unreadCommentsIndicator } from '../../indicators.ts';
import type { JsonValue } from '../../types.ts';

/** A comment as saved in the page snapshot: identity, time and author only, never its text. */
export interface SavedComment { id: string; at: string; author: string; parent: string }
export type SavedComments =
  | { available: true; items: SavedComment[]; viewers: string[]; blocks: { total: number; checked: number } }
  | { available: false; reason: string };

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

/** Validated comments from a saved snapshot; undefined for a snapshot saved before comments were read. */
export function savedComments(value: JsonValue | undefined): SavedComments | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.available === false) return { available: false, reason: typeof value.reason === 'string' ? value.reason : 'Comments are unavailable.' };
  if (value.available !== true || !Array.isArray(value.items) || !Array.isArray(value.viewers)) return undefined;
  const blocks = value.blocks && typeof value.blocks === 'object' && !Array.isArray(value.blocks) ? value.blocks : {};
  return {
    available: true,
    items: value.items.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && id(item.id) && id(item.author) && id(item.parent) && typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at))
      ? [{ id: item.id, at: item.at, author: item.author, parent: item.parent }] : []),
    viewers: value.viewers.filter(id),
    blocks: { total: typeof blocks.total === 'number' ? blocks.total : 0, checked: typeof blocks.checked === 'number' ? blocks.checked : 0 },
  };
}

/** "Your Notion user ID" setting: IDs with or without dashes, separated by commas or spaces. */
export function configuredIdentities(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/).map(part => part.replaceAll('-', '').toLowerCase()).filter(part => /^[a-f0-9]{32}$/.test(part));
}

/** The full view's chip says what the map cue says. */
export const unreadLabel = (count: number) => unreadCommentsIndicator(count, 'unread').label;
