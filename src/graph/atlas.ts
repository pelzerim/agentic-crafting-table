import type { Point } from './neighborhood.ts';
import { outlineDistance } from './neighborhood.ts';
import { attentionItems, attentionTiers } from './attention.ts';
import type { AttentionTier } from './attention.ts';
import type { GraphNode } from './graph.ts';

/** The Atlas is a semantic minimap: project blobs plus one glyph per item state.
 * Everything here is camera-independent, so the map can reuse it on every frame. */
export interface AtlasRect { x: number; y: number; width: number; height: number }
export interface AtlasProject { id: string; points: readonly Point[]; left: number; top: number; right: number; bottom: number; center: Point }
export interface AtlasItem { id: string; x: number; y: number; width: number; height: number; projectId?: string; resourceId?: string; activity?: string; completedAt?: string }
export type AtlasGlyphKind = 'idle' | 'working' | 'needs';
/** A `needs` glyph carries its tier; a merged one the highest tier of its items. */
export interface AtlasGlyph { kind: AtlasGlyphKind; ids: string[]; projectId?: string; x: number; y: number; count: number; tier?: AttentionTier }
/** Atlas pixel = world * scale + offset. */
export interface AtlasTransform { scale: number; x: number; y: number }
export type AtlasDirection = 'left' | 'right' | 'up' | 'down';

export const ATLAS_MAP = { width: 208, height: 116 } as const;
export const ATLAS_OVERVIEW_MAP = { width: 440, height: 292 } as const;
/** From this many projects, idle dots and per-item badges become noise. */
export const ATLAS_COLLAPSE_PROJECTS = 20;
const MIN_IDLE_SPACING = 3, BADGE_OVERLAP = 5;

export function atlasBounds(projects: readonly AtlasProject[], items: readonly AtlasItem[]): AtlasRect | undefined {
  const boxes = [...projects.map(p => ({ left: p.left, top: p.top, right: p.right, bottom: p.bottom })),
    ...items.filter(item => item.resourceId).map(item => ({ left: item.x - item.width / 2, top: item.y - item.height / 2, right: item.x + item.width / 2, bottom: item.y + item.height / 2 }))];
  if (!boxes.length) return undefined;
  const left = Math.min(...boxes.map(b => b.left)), top = Math.min(...boxes.map(b => b.top));
  const right = Math.max(...boxes.map(b => b.right)), bottom = Math.max(...boxes.map(b => b.bottom));
  const pad = Math.max(right - left, bottom - top) * .04;
  return { x: left - pad, y: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
}

export function atlasTransform(bounds: AtlasRect, size: { width: number; height: number }, inset = 6): AtlasTransform {
  const scale = Math.min((size.width - inset * 2) / bounds.width, (size.height - inset * 2) / bounds.height);
  return { scale, x: size.width / 2 - (bounds.x + bounds.width / 2) * scale, y: size.height / 2 - (bounds.y + bounds.height / 2) * scale };
}

export function atlasGlyphKind(item: AtlasItem, needsMe: ReadonlyMap<string, AttentionTier>): AtlasGlyphKind | undefined {
  if (!item.resourceId) return undefined;
  if (needsMe.has(item.id)) return 'needs';
  if (item.completedAt) return undefined;
  return item.activity === 'working' ? 'working' : 'idle';
}

/** Every card that shows Needs me, with the tier of its resource's entry. */
export function needsMeIds(nodes: readonly (GraphNode & { attention?: string })[]): Map<string, AttentionTier> {
  return new Map(attentionItems(nodes).flatMap(entry => entry.aliases.map(alias => [alias.id, entry.tier] as const)));
}

function medianSpacing(points: readonly { x: number; y: number }[]) {
  if (points.length < 2) return Infinity;
  const sorted = [...points].sort((a, b) => a.x - b.x), nearest = sorted.map(() => Infinity);
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x < Math.max(nearest[i], MIN_IDLE_SPACING * 4); j++) {
    const distance = Math.hypot(sorted[j].x - sorted[i].x, sorted[j].y - sorted[i].y);
    nearest[i] = Math.min(nearest[i], distance); nearest[j] = Math.min(nearest[j], distance);
  }
  return nearest.sort((a, b) => a - b)[Math.floor(nearest.length / 2)];
}

/** Level of detail at the Atlas scale: idle dots go when they would merge or when
 * there are many projects; a project's Asking me and My turn badges collapse into one count,
 * in the shape of the highest tier, when they overlap. Finished dots are never counted: they
 * stay single and go where idle dots go. Items of `muted` projects get no mark at all. */
export function atlasGlyphs(items: readonly AtlasItem[], needsMe: ReadonlyMap<string, AttentionTier>, transform: AtlasTransform, projectCount: number, muted?: ReadonlySet<string>): AtlasGlyph[] {
  const placed = items.flatMap(item => {
    const kind = item.projectId && muted?.has(item.projectId) ? undefined : atlasGlyphKind(item, needsMe);
    return kind ? [{ item, kind, x: item.x * transform.scale + transform.x, y: item.y * transform.scale + transform.y }] : [];
  });
  const many = projectCount >= ATLAS_COLLAPSE_PROJECTS;
  const dropIdle = many || medianSpacing(placed.filter(glyph => glyph.kind !== 'needs')) < MIN_IDLE_SPACING;
  const tierOf = (glyph: typeof placed[number]) => needsMe.get(glyph.item.id)!;
  const single = (glyph: typeof placed[number]): AtlasGlyph => ({ kind: glyph.kind, ids: [glyph.item.id], projectId: glyph.item.projectId, x: glyph.x, y: glyph.y, count: 1, ...(glyph.kind === 'needs' ? { tier: tierOf(glyph) } : {}) });
  const groups = new Map<string, typeof placed>(), badges: AtlasGlyph[] = [];
  const finished = placed.filter(glyph => glyph.kind === 'needs' && tierOf(glyph) === 'finished');
  for (const glyph of placed.filter(glyph => glyph.kind === 'needs' && tierOf(glyph) !== 'finished')) {
    const key = glyph.item.projectId ?? `floating:${glyph.item.id}`, group = groups.get(key);
    if (group) group.push(glyph); else groups.set(key, [glyph]);
  }
  for (const group of groups.values()) {
    const overlap = group.some((a, i) => group.slice(i + 1).some(b => Math.hypot(a.x - b.x, a.y - b.y) < BADGE_OVERLAP));
    if (!group[0].item.projectId || group.length < 2 || !(many || overlap)) { badges.push(...group.map(single)); continue; }
    badges.push({ kind: 'needs', tier: attentionTiers.find(tier => group.some(glyph => tierOf(glyph) === tier)), ids: group.map(glyph => glyph.item.id), projectId: group[0].item.projectId, count: new Set(group.map(glyph => glyph.item.resourceId ?? glyph.item.id)).size,
      x: group.reduce((sum, glyph) => sum + glyph.x, 0) / group.length, y: group.reduce((sum, glyph) => sum + glyph.y, 0) / group.length });
  }
  return [...placed.filter(glyph => glyph.kind === 'idle' && !dropIdle).map(single), ...placed.filter(glyph => glyph.kind === 'working').map(single), ...(many ? [] : finished.map(single)), ...badges];
}

export function atlasProjectAt(point: Point, projects: readonly AtlasProject[]): { id: string; inside: boolean } | undefined {
  let best: { id: string; inside: boolean; distance: number; centre: number } | undefined;
  for (const project of projects) {
    const distance = outlineDistance(point, project.points), centre = Math.hypot(point.x - project.center.x, point.y - project.center.y);
    if (!best || distance < best.distance || distance === best.distance && centre < best.centre) best = { id: project.id, inside: distance === 0, distance, centre };
  }
  return best && { id: best.id, inside: best.inside };
}

export function atlasStep(projects: readonly AtlasProject[], fromId: string, direction: AtlasDirection): string | undefined {
  const from = projects.find(project => project.id === fromId)?.center;
  if (!from) return projects[0]?.id;
  let best: { id: string; score: number } | undefined;
  for (const project of projects) {
    const dx = project.center.x - from.x, dy = project.center.y - from.y;
    const primary = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
    const secondary = Math.abs(direction === 'left' || direction === 'right' ? dy : dx);
    if (project.id === fromId || primary <= 0 || secondary > primary * 2) continue;
    const score = primary + secondary * 2;
    if (!best || score < best.score) best = { id: project.id, score };
  }
  return best?.id;
}
