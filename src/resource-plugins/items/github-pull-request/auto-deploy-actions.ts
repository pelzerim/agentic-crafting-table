import type { AutoDeployEvent, AutoDeployEventKind } from '../github-rollout/auto-deploy.ts';
import type { GlyphName } from '../../pixel-glyphs.ts';

/** One action as the auto deploy status returns it: links to what it touched, and for an action on a rollout the run it belongs to. */
export interface ListedAction extends AutoDeployEvent { links?: { label: string; resourceId?: string; url?: string }[]; group?: { label: string; resourceId?: string } }
export type ActionTone = 'blue' | 'claude' | 'mint' | 'amber';
export type ActionRow = { type: 'group'; label: string; resourceId?: string }
  | { type: 'action'; at: number; glyph: GlyphName; tone: ActionTone; text: string; links: NonNullable<ListedAction['links']>; now?: true };

const LOOK: Record<AutoDeployEventKind, [GlyphName, ActionTone]> = {
  armed: ['auto', 'blue'], ready: ['pr', 'blue'], tag: ['pr', 'blue'], update: ['retry', 'blue'], rebase: ['claude', 'claude'], rebased: ['check', 'mint'], findings: ['send', 'claude'], fixed: ['check', 'mint'],
  fix: ['claude', 'claude'], merged: ['git-merge', 'mint'], validate: ['claude', 'claude'], verdict: ['check', 'mint'], approve: ['gate', 'mint'], halted: ['bang', 'amber'], done: ['check', 'mint'], stopped: ['dash', 'blue'],
};
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The rows of the pull request view's action list, oldest first: the pull request's actions, then each run's under its own heading.
 * While auto deploy is armed the newest action is the current step. */
export function actionRows(events: readonly ListedAction[], state: string): ActionRow[] {
  const rows: ActionRow[] = [];
  let group: string | undefined;
  events.forEach((event, index) => {
    if (event.group && event.group.label !== group) { group = event.group.label; rows.push({ type: 'group', label: event.group.label, ...(event.group.resourceId ? { resourceId: event.group.resourceId } : {}) }); }
    const [glyph, tone] = LOOK[event.kind] ?? ['auto', 'blue'], doubt = event.kind === 'verdict' && !/ passed$/.test(event.text);
    rows.push({ type: 'action', at: event.at, glyph: doubt ? 'bang' : glyph, tone: doubt ? 'amber' : tone, text: sentence(event.text), links: event.links ?? [], ...(state === 'armed' && index === events.length - 1 ? { now: true as const } : {}) });
  });
  return rows;
}
