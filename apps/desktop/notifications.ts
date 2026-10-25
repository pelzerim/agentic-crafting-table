import * as z from 'zod/v4';
import { splitAttention } from '../../src/graph/mute.ts';
import { attentionTierInfo, countsAsNeedsMe } from '../../src/graph/attention.ts';
import type { WorkspaceSnapshot } from '../../packages/workspace-service/protocol.ts';
import type { AppSettings } from '../../packages/core/settings.ts';

export const announcementSchema = z.object({ key: z.string().min(1).max(500), title: z.string().min(1).max(250), body: z.string().max(1000).default(''), nodeId: z.string().max(200).optional() }).strict();
export type DesktopAnnouncement = z.infer<typeof announcementSchema>;
export type NotificationPreferences = AppSettings['notifications'];
export interface NotificationTarget { nodeId?: string }
export interface NotificationDelivery { show(notice: DesktopAnnouncement, silent?: boolean): void; close(key: string): void }

/** Main-process observer: attention delivery does not depend on renderer timers.
 * Initial state is a baseline, never a replay of yesterday's unread events. */
export class DesktopNotifications {
  private previous?: WorkspaceSnapshot;
  private delivered = new Set<string>();
  private active = new Map<string, string>();
  preferences?: NotificationPreferences;
  private delivery: NotificationDelivery;
  private focused: () => boolean;
  constructor(delivery: NotificationDelivery, focused: () => boolean) { this.delivery = delivery; this.focused = focused; }
  private allowed() { return this.preferences && this.preferences.mode !== 'off' && (this.preferences.mode === 'always' || !this.focused()); }
  announcement(notice: DesktopAnnouncement, test = false) {
    if (!test && this.delivered.has(notice.key)) return false;
    this.remember(notice.key);
    if (!test && (!this.allowed() || !this.preferences?.announcements)) return false;
    this.delivery.show(notice); return true;
  }
  /** A due reminder (MAP-REMINDERS). Its own preference applies instead of the Needs me mode;
   * the service fires each one once, so a repeat of the key is a snooze ending and shows again. */
  reminder(notice: DesktopAnnouncement) {
    const delivery = this.preferences?.reminders ?? 'sound';
    if (delivery === 'app') return false;
    this.delivery.close(notice.key); this.delivery.show(notice, delivery === 'silent'); return true;
  }
  private remember(key: string) {
    this.delivered.add(key);
    if (this.delivered.size > 2000) this.delivered.delete(this.delivered.values().next().value!);
  }
  snapshot(next: WorkspaceSnapshot) {
    if (this.previous && next.cursor < this.previous.cursor) return;
    const before = this.previous; this.previous = next;
    if (!before) for (const node of next.state.nodes) this.remember(`attention:${node.resourceId ?? node.id}:${node.attentionVersion ?? 0}`);
    const previousVersions = new Map<string, number>();
    for (const node of before?.state.nodes ?? []) {
      const identity = node.resourceId ?? node.id;
      previousVersions.set(identity, Math.max(previousVersions.get(identity) ?? 0, node.attentionVersion ?? 0));
    }
    // A muted project announces nothing (MAP-25); its open banners close with it.
    const saidLast = new Map(next.state.nodes.flatMap(node => node.lastLine ? [[node.id, node.lastLine]] : []));
    const items = splitAttention(next.state.nodes).shown, current = new Set(items.map(item => item.identity));
    for (const [identity, key] of this.active) if (!current.has(identity)) { this.delivery.close(key); this.active.delete(identity); }
    for (const item of items) {
      const version = Math.max(...item.aliases.map(node => node.attentionVersion ?? 0));
      const key = `attention:${item.identity}:${version}`;
      if (!before) { this.remember(key); continue; }
      // Known events are never re-announced merely by restoring an alias or settings.
      if (previousVersions.get(item.identity) === version || this.delivered.has(key)) continue;
      this.remember(key);
      // Finished work raises no banner unless it is counted (Settings → Notifications); the in-app notice still shows.
      const wanted = countsAsNeedsMe(item.tier, this.preferences) && (item.tier === 'finished' ? this.preferences?.needsMe || this.preferences?.announcements : this.preferences?.needsMe);
      if (!this.allowed() || !wanted) continue;
      const old = this.active.get(item.identity); if (old) this.delivery.close(old);
      this.active.set(item.identity, key);
      // An agent's banner quotes the line it ended its turn on, as its Needs me row does.
      this.delivery.show({ key, title: `${attentionTierInfo[item.tier].name} · ${item.node.title}`.slice(0, 250), body: item.aliases.map(alias => saidLast.get(alias.id)).find(Boolean) ?? item.details.join(' · '), nodeId: item.node.id });
    }
  }
  dispose() { for (const key of this.active.values()) this.delivery.close(key); this.active.clear(); }
}
