import * as z from 'zod/v4';
import type { BundleLayout } from './bundle-layout.ts';

/** Updates (UPDATE-01): the app and installed plugin packs follow release tags `vX.Y.Z`. */
export const APP_REPOSITORY = 'pelzerim/agentic-crafting-table';
export const APP_TAGS_URL = `https://api.github.com/repos/${APP_REPOSITORY}/tags?per_page=100`;
export const UPDATE_COMMAND = 'npm run update';

export type Version = readonly number[];
const release = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `v1.2.3` or `1.2.3` as numbers; prereleases, partial numbers and `^{}` peel suffixes are not releases. */
export function parseVersionTag(tag: string): Version | undefined {
  const match = release.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
export function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
/** The highest release tag among names such as `git ls-remote --tags` or the GitHub tags API return. */
export function newestTag(tags: readonly string[]): string | undefined {
  let best: { tag: string; version: Version } | undefined;
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag, version };
  }
  return best?.tag;
}
/** Whether the newest release is worth telling the person about: newer than what runs, and not the one they dismissed. */
export function updateOffers({ current, tags, dismissed }: { current: string; tags: readonly string[]; dismissed?: string }): { latest: string | undefined; available: boolean } {
  const latest = newestTag(tags), running = parseVersionTag(current);
  const newer = Boolean(latest && running && compareVersions(parseVersionTag(latest)!, running) > 0);
  return { latest, available: newer && latest !== dismissed };
}

export const updateCheckSchema = z.object({ now: z.boolean().default(false) }).strict();
export interface UpdateSubject { current: string; latest?: string; available: boolean; checkedAt?: number; error?: string }
export interface PluginUpdate extends UpdateSubject { id: string; name: string; source: string }
/** What the window shows: the app and every git-installed pack, each against its newest tag. */
export interface UpdateStatus { app: UpdateSubject; plugins: PluginUpdate[]; checking: boolean }

export const CHECKOUT_PACKAGE_NAME = 'agent-crafting-table';
/** The checkout an installed app runs from, from its executable path; undefined for any other location. */
export function checkoutOfExecutable(executable: string, layout: BundleLayout): string | undefined {
  const marker = `/${layout.installed}/${layout.executable}`, index = executable.lastIndexOf(marker);
  return index > 0 && index + marker.length === executable.length ? executable.slice(0, index) : undefined;
}
/** A failed Update and restart, written by `scripts/update-restart.mjs` for the next launch to show. */
export const updateFailureSchema = z.object({ at: z.number(), tag: z.string().max(100).optional(), message: z.string().max(4000) });
export type UpdateFailure = z.infer<typeof updateFailureSchema>;
/** Settings → About: Update and restart when a newer release can be built from this checkout; a failed run stays until a later check succeeds. */
export function appUpdateRow({ app, checkout, failure }: { app?: UpdateSubject; checkout: boolean; failure?: UpdateFailure }): { action: 'restart' | 'check'; failure?: UpdateFailure } {
  const cleared = Boolean(failure && app?.checkedAt !== undefined && app.checkedAt > failure.at && !app.error);
  return { action: checkout && app?.available && app.latest ? 'restart' : 'check', failure: cleared ? undefined : failure };
}
