import { parseGitSource } from '../../packages/workspace-service/plugin-source.ts';

/** The URL scheme the app registers for links that open it. */
export const INSTALL_LINK_SCHEME = 'act';
/** What an install link asks for: a repository and ref to fill into Settings → Plugins. Nothing is installed from it. */
export interface InstallLink { source: string; ref?: string }
/** What the window receives: a link to review, or why a link was refused. */
export type InstallLinkRequest = InstallLink | { error: string };

const MAX_LENGTH = 4096, PARAMETERS = new Set(['source', 'ref']);
const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)/;
const refuse = (reason: string): never => { throw new Error(reason); };

/** Parses `act://plugins/install?source=<git URL>&ref=<tag or commit>`. Throws a readable reason for anything else. */
export function parseInstallLink(input: unknown): InstallLink {
  if (typeof input !== 'string' || !/^act:/i.test(input)) return refuse('This is not an act:// link.');
  if (input.length > MAX_LENGTH) return refuse('This install link is too long.');
  if (/[\s\0-\x1f\x7f]/.test(input)) return refuse('This install link is not valid.');
  let url: URL;
  try { url = new URL(input); } catch { return refuse('This install link is not valid.'); }
  if (url.username || url.password || url.port || url.hash) return refuse('An install link cannot carry a user, port or fragment.');
  if (url.host !== 'plugins' || url.pathname !== '/install') return refuse('Only plugins/install links are supported.');
  const keys = [...url.searchParams.keys()];
  const unknown = keys.find(key => !PARAMETERS.has(key));
  if (unknown) return refuse(`The install link has an unknown parameter ${unknown.slice(0, 40)}.`);
  for (const key of PARAMETERS) if (url.searchParams.getAll(key).length > 1) return refuse(`The install link may name ${key} only once.`);
  const source = url.searchParams.get('source') ?? '', ref = url.searchParams.get('ref');
  if (!source) return refuse('The install link needs a source repository.');
  if (ref !== null && !ref) return refuse('Enter a branch, tag or commit, such as v1.2.0.');
  parseGitSource({ url: source, ...(ref !== null ? { ref } : {}) });
  if (!scpLike.test(source) && !/^(https|ssh):\/\//i.test(source)) return refuse('An install link needs an https://, ssh:// or git@host:path repository.');
  return { source, ...(ref !== null ? { ref } : {}) };
}

/** The install link among command-line arguments, as a second instance receives it on Windows and Linux. */
export function installLinkArgument(argv: readonly string[]): string | undefined {
  return argv.find(argument => argument.toLowerCase().startsWith(`${INSTALL_LINK_SCHEME}://`));
}
