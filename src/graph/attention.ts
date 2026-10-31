import type { GraphNode } from './graph.ts';
import { isDrawn } from './archive.ts';

export const attentionReasons = { error: 'Action required', input: 'Waiting for your input', assigned: 'Newly assigned pull request', 'checks-failing': 'Checks failing', validation: 'Validation concerns · hold the release', approved: 'Pull request approved', comment: 'New pull request comments', review: 'Ready for your review', finished: 'Finished · ready to view' } as const;
export type AttentionReason = keyof typeof attentionReasons;
/** Needs me is one list with one Seen (STATE-02). Its reasons fall into three tiers that
 * call for different responses; every surface draws and counts them from here. */
export const attentionTiers = ['asking', 'turn', 'finished'] as const;
export type AttentionTier = typeof attentionTiers[number];
/** The one place a reason gets its tier. Asking me: something is stopped until I act.
 * My turn: work waits on me, nothing is stopped. Finished: for my information. */
export const attentionTierOf: Record<AttentionReason, AttentionTier> = {
  input: 'asking', error: 'asking',
  review: 'turn', assigned: 'turn', 'checks-failing': 'turn', comment: 'turn', validation: 'turn',
  finished: 'finished', approved: 'finished',
};
export const NEEDS_ME = 'Needs me';
/** `name` where a tier is named, `count` after a number ("3 my turn"), `glyph` its 8×8 shape. */
export const attentionTierInfo: Record<AttentionTier, { name: string; count: string; glyph: 'asking' | 'my-turn' | 'finished' }> = {
  asking: { name: 'Asking me', count: 'asking', glyph: 'asking' },
  turn: { name: 'My turn', count: 'my turn', glyph: 'my-turn' },
  finished: { name: 'Finished', count: 'finished', glyph: 'finished' },
};
/** The highest tier among reasons: an item that asks and has finished is Asking me. */
export function attentionTier(reasons: readonly AttentionReason[]): AttentionTier | undefined {
  return attentionTiers.find(tier => reasons.some(reason => attentionTierOf[reason] === tier));
}
/** Finished is listed and marked, not counted, unless the person asks for it (Settings → Notifications). */
export interface AttentionCounting { countFinished?: boolean }
export const countsAsNeedsMe = (tier: AttentionTier, counting: AttentionCounting = {}) => tier !== 'finished' || counting.countFinished === true;
/** `needsMe` is the one number: the rail, Dock, sheet header and dashboards all show it. */
export interface AttentionCounts { asking: number; turn: number; finished: number; needsMe: number; top?: AttentionTier }
export function attentionCounts(items: readonly { tier: AttentionTier }[], counting: AttentionCounting = {}): AttentionCounts {
  const counts: AttentionCounts = { asking: 0, turn: 0, finished: 0, needsMe: 0 };
  for (const item of items) { counts[item.tier]++; if (countsAsNeedsMe(item.tier, counting)) counts.needsMe++; }
  const top = attentionTiers.find(tier => counts[tier] > 0);
  return top ? { ...counts, top } : counts;
}
/** "2 asking · 3 my turn · 1 finished": tiers in order, zeros omitted. */
export function attentionCountText(counts: Pick<AttentionCounts, AttentionTier>, separator = ' · '): string {
  return attentionTiers.filter(tier => counts[tier] > 0).map(tier => `${counts[tier]} ${attentionTierInfo[tier].count}`).join(separator);
}
/** Accessible name of a mark: the tier, then the reason in words ("Asking me: Needs permission"). */
export const attentionLabel = (tier: AttentionTier, detail?: string) => detail ? `${attentionTierInfo[tier].name}: ${detail}` : attentionTierInfo[tier].name;
/** The rail button: `Needs me: N` counts Asking me and My turn; the title spells out every tier. */
export function needsMeButton(counts: AttentionCounts): { label: string; title: string } {
  const text = attentionCountText(counts);
  return { label: counts.needsMe ? `${NEEDS_ME}: ${counts.needsMe}` : NEEDS_ME, title: text ? `${NEEDS_ME} · ${text}` : `${NEEDS_ME} · nothing needs me` };
}
/** How long something has waited, as text only: "now", "4m", "3h", "2d". */
export function attentionAge(since: string | undefined, now: number): string {
  const at = since ? Date.parse(since) : NaN;
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
type AttentionNode = GraphNode & { activity?: string; attention?: string };
/** `notes` are the trigger-supplied reasons; `details` show each signal's note, or
 * its category label when its trigger gave none. */
export interface AttentionItem { identity: string; node: AttentionNode; aliases: AttentionNode[]; reasons: AttentionReason[]; notes: string[]; details: string[];
  /** The highest tier among `reasons`. */
  tier: AttentionTier;
  /** When the oldest unread cycle among the aliases was raised, if recorded. */
  since?: string }
export const ATTENTION_NOTE_LENGTH = 48;
/** One plain line: no control or format characters, collapsed spaces, no
 * trailing period, at most ATTENTION_NOTE_LENGTH code points. */
export function attentionNote(text: string | undefined): string | undefined {
  const value = text?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trimEnd();
  if (!value) return undefined;
  const points = [...value];
  return points.length <= ATTENTION_NOTE_LENGTH ? value : `${points.slice(0, ATTENTION_NOTE_LENGTH - 1).join('').trimEnd()}…`;
}
const unread = (node: AttentionNode) => node.attentionSeenVersion === undefined || node.attentionSeenVersion !== (node.attentionVersion ?? 0);
const isReason = (value: unknown): value is AttentionReason => typeof value === 'string' && Object.hasOwn(attentionReasons, value);
function signals(node: AttentionNode, seen = false) {
  if (!seen && !unread(node)) return [];
  const all = [{ reason: node.attention, note: node.attentionNote }, ...Object.entries(node.attentionSources ?? {}).map(([source, reason]) => ({ reason, note: node.attentionNotes?.[source] }))];
  return all.filter((signal): signal is { reason: AttentionReason; note: string | undefined } => isReason(signal.reason));
}
/** Reasons that keep waiting on the person after their alert was seen: a question, a review, an approval gate, a failure to fix. */
export const WAITING_REASONS: readonly AttentionReason[] = ['input', 'review', 'error', 'checks-failing', 'validation'];
/** What still waits on the person whether or not the alert was seen, with its tier and detail; nothing when only notices remain. */
export function nodeWaitingAttention(node: AttentionNode): { tier: AttentionTier; detail: string; since?: string } | undefined {
  const waiting = signals(node, true).filter(signal => WAITING_REASONS.includes(signal.reason)), tier = attentionTier(waiting.map(signal => signal.reason));
  if (!tier) return undefined;
  const order = Object.keys(attentionReasons) as AttentionReason[], first = waiting.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
  return { tier, detail: first.note ?? attentionReasons[first.reason], ...(node.attentionAt ? { since: node.attentionAt } : {}) };
}
export function nodeAttentionReasons(node: AttentionNode): AttentionReason[] {
  const values = new Set(signals(node).map(signal => signal.reason));
  return (Object.keys(attentionReasons) as AttentionReason[]).filter(reason => values.has(reason));
}
/** Notes and details of unread signals across nodes (aliases), in reason order. */
export function attentionDetails(nodes: readonly AttentionNode[]) {
  const order = Object.keys(attentionReasons) as AttentionReason[];
  const all = nodes.flatMap(node => signals(node)).sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason));
  const noted = new Set(all.filter(signal => signal.note).map(signal => signal.reason));
  return { notes: [...new Set(all.flatMap(signal => signal.note ? [signal.note] : []))],
    details: [...new Set(all.filter(signal => signal.note || !noted.has(signal.reason)).map(signal => signal.note ?? attentionReasons[signal.reason]))] };
}

/** Freeze only the unread cycles actually presented; a newer cycle or a new
 * alias cannot be accidentally dismissed by a delayed UI/MCP acknowledgement. */
export function attentionReceipt(nodes: readonly AttentionNode[], id: string) {
  const target = nodes.find(node => node.id === id);
  return { id, versions: Object.fromEntries(nodes.filter(node => target && (node.id === id || target.resourceId && node.resourceId === target.resourceId))
    .filter(node => nodeAttentionReasons(node).length).map(node => [node.id, node.attentionVersion ?? 0])) };
}

/** The tier a receipt would bring back, while every cycle it names is unchanged and still has a reason;
 * undefined once the item moved on, so an open that was acknowledged cannot be un-seen by mistake. */
export function attentionRestorable(nodes: readonly AttentionNode[], receipt: { id: string; versions: Record<string, number> }): { tier: AttentionTier } | undefined {
  const named = Object.entries(receipt.versions);
  if (!named.length) return undefined;
  const reasons = new Set<AttentionReason>();
  for (const [id, version] of named) {
    const node = nodes.find(node => node.id === id);
    if (!node || (node.attentionVersion ?? 0) !== version) return undefined;
    for (const signal of signals(node, true)) reasons.add(signal.reason);
  }
  const tier = attentionTier([...reasons]);
  return tier ? { tier } : undefined;
}

/** Its process went with a restart: no attention of its own, only resuming brings it back. Only a lost session has
 * ended without a known outcome; an exit leaves the item idle or complete. */
export const sessionLost = (node: { activity?: string; pose?: string }) => node.activity === 'unknown' && node.pose === 'ended';

/** The tier one node shows on its own card, with its reason in words and since when. */
export function nodeAttention(node: AttentionNode): { tier: AttentionTier; reasons: AttentionReason[]; detail: string; details: string[]; since?: string } | undefined {
  const reasons = nodeAttentionReasons(node), tier = attentionTier(reasons);
  if (!tier) return undefined;
  const { details } = attentionDetails([node]);
  return { tier, reasons, detail: details.join(' · '), details, ...(node.attentionAt ? { since: node.attentionAt } : {}) };
}

/** Tier counts over cards as they are drawn, one per node: a plot's members, a selection. */
export function memberAttentionCounts(nodes: readonly AttentionNode[], counting: AttentionCounting = {}): AttentionCounts {
  return attentionCounts(nodes.flatMap(node => { const tier = attentionTier(nodeAttentionReasons(node)); return tier ? [{ tier }] : []; }), counting);
}

/** One resource, one entry; done is independent from new attention. Prefer the
 * actionable alias as the navigation target, never one hidden by its project.
 * Sorted by tier, then the longest wait first, then reason and title. */
export function attentionItems(nodes: readonly AttentionNode[], projectId?: string): AttentionItem[] {
  const groups = new Map<string, AttentionItem>();
  const order = Object.keys(attentionReasons) as AttentionReason[];
  for (const node of nodes) {
    const reasons = nodeAttentionReasons(node);
    if ((projectId && node.projectId !== projectId) || !isDrawn(node, nodes) || !reasons.length) continue;
    const identity = node.resourceId ?? node.id, reason = reasons[0];
    const group: AttentionItem = groups.get(identity) ?? { identity, node, aliases: [], reasons: [], notes: [], details: [], tier: 'finished' };
    group.aliases.push(node);
    if (node.attentionAt && (!group.since || node.attentionAt < group.since)) group.since = node.attentionAt;
    for (const reason of reasons) if (!group.reasons.includes(reason)) group.reasons.push(reason);
    const currentReason = nodeAttentionReasons(group.node)[0];
    if (order.indexOf(reason) < order.indexOf(currentReason)
      || (reason === currentReason && node.id.localeCompare(group.node.id) < 0)) group.node = node;
    group.reasons.sort((a, b) => order.indexOf(a) - order.indexOf(b)); Object.assign(group, attentionDetails(group.aliases)); group.tier = attentionTier(group.reasons)!; groups.set(identity, group);
  }
  const rank = (item: AttentionItem) => attentionTiers.indexOf(item.tier);
  // Undated cycles (saved before ages were recorded) follow the dated ones.
  const waited = (a: AttentionItem, b: AttentionItem) => a.since === b.since ? 0 : !a.since ? 1 : !b.since ? -1 : a.since < b.since ? -1 : 1;
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || waited(a, b) || order.indexOf(a.reasons[0]) - order.indexOf(b.reasons[0]) || a.node.title.localeCompare(b.node.title) || a.identity.localeCompare(b.identity));
}
