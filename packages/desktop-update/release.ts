import { APP_REPOSITORY, newestTag, parseVersionTag } from '../core/updates.ts';

/** What `npm run update` is about to do, decided from the checkout alone so it can be shown before anything runs. */
export interface UpdatePlan { tag: string; current?: string; steps: string[] }
export class UpdateRefused extends Error {}

const APP_CLONE_URL = `https://github.com/${APP_REPOSITORY}.git`;
/** `owner/repo` of a GitHub remote URL in any spelling git accepts (https, ssh://, scp-like), lower-cased; undefined for other hosts. */
const githubRepository = (url: string) => /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1]?.toLowerCase();
/** Which remote `npm run update` fetches release tags from, out of `git remote -v`: the one `git config act.updateRemote` names,
 * else one that points at the app repository (origin first), so a checkout whose remotes have other names still updates. */
export function releaseRemote({ remotes, configured }: { remotes: string; configured?: string }): { name: string; url: string } {
  const fetch = new Map<string, string>();
  for (const line of remotes.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match) fetch.set(match[1], match[2]);
  }
  const listed = [...fetch].map(([name, url]) => `  ${name}  ${url}`).join('\n');
  if (configured) {
    const url = fetch.get(configured);
    if (url) return { name: configured, url };
    throw new UpdateRefused(`git config act.updateRemote names "${configured}", which is not a remote of this checkout. Its remotes:\n${listed || '  (none)'}\nSet it to one of them, or unset it with git config --unset act.updateRemote.`);
  }
  const matching = [...fetch].filter(([, url]) => githubRepository(url) === APP_REPOSITORY.toLowerCase());
  const [name, url] = matching.find(([remote]) => remote === 'origin') ?? matching[0] ?? [];
  if (name && url) return { name, url };
  const add = `git remote add upstream ${APP_CLONE_URL}`;
  if (!fetch.size) throw new UpdateRefused(`This checkout has no git remote to fetch releases from. Add one with:\n  ${add}`);
  throw new UpdateRefused(`None of this checkout's remotes points to github.com/${APP_REPOSITORY}, where releases are tagged:\n${listed}\n`
    + `Add it with:\n  ${add}\nor, to fetch releases from one of the remotes above (a mirror, say): git config act.updateRemote <name>`);
}
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

/** Printed by the login shell after its own start-up output, so a chatty profile cannot be mistaken for the answer. */
export const LAUNCHER_MARKER = '__ACT_UPDATE_LAUNCHER__';
export const LAUNCHER_SCRIPT = `printf '\\n%s\\n%s\\n%s' '${LAUNCHER_MARKER}' "$(command -v node)" "$PATH"`;
/** The absolute node and PATH the login shell reported, or undefined when it has no node. */
export function parseLauncher(stdout: string): { node: string; path: string } | undefined {
  const index = stdout.lastIndexOf(`\n${LAUNCHER_MARKER}\n`);
  if (index < 0) return undefined;
  const [node = '', path = ''] = stdout.slice(index + LAUNCHER_MARKER.length + 2).split('\n');
  return node.startsWith('/') && path ? { node, path } : undefined;
}
