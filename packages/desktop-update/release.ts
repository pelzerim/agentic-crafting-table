import { newestTag, parseVersionTag } from '../core/updates.ts';

/** What `npm run update` is about to do, decided from the checkout alone so it can be shown before anything runs. */
export interface UpdatePlan { tag: string; current?: string; steps: string[] }
export class UpdateRefused extends Error {}

/** `git tag --list` output to the newest release tag, or why there is none. */
export function chooseReleaseTag(tags: readonly string[]): string {
  const tag = newestTag(tags);
  if (!tag) throw new UpdateRefused('No release tag (vX.Y.Z) was found on the remote. Nothing to update to.');
  return tag;
}
/** The plan for a checkout: refuse while there are local changes, do nothing when the newest tag is already checked out. */
export function planUpdate({ status, tags, head, tagsAtHead }: { status: string; tags: readonly string[]; head: string; tagsAtHead: readonly string[] }): UpdatePlan | { unchanged: string } {
  // `XY path` per line; untracked files (`??`) do not stand in the way of a checkout and are left alone.
  const dirty = status.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('??')).map(line => line.replace(/^\S+\s+/, ''));
  if (dirty.length) throw new UpdateRefused(`The checkout has local changes; commit, stash or discard them first:\n  ${dirty.slice(0, 20).join('\n  ')}${dirty.length > 20 ? `\n  … and ${dirty.length - 20} more` : ''}`);
  const tag = chooseReleaseTag(tags);
  const current = newestTag(tagsAtHead.filter(name => parseVersionTag(name)));
  if (current === tag || tagsAtHead.includes(tag)) return { unchanged: tag };
  return { tag, current: current ?? head.slice(0, 8), steps: [`git checkout --detach ${tag}`, 'npm ci', 'npm run package', 'npm run install:local'] };
}
