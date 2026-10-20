import { isAbsolute } from 'node:path';

/** Where a trusted plugin comes from: any remote the user's own git can reach, at a ref. */
export interface GitSource { url: string; ref: string }

const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[A-Za-z0-9._~/+-]+$/;
const ref = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)(?!.*@\{)[A-Za-z0-9._/+-]{1,200}$/;

/** Validates a repository URL and ref before either reaches git. Plaintext and command transports,
 * option-like values and credentials in the URL are refused. */
export function parseGitSource(input: { url: string; ref?: string }): GitSource {
  const url = input.url.trim(), wanted = (input.ref ?? '').trim() || 'HEAD';
  if (!url || url.length > 2048 || /[\s\0-\x1f\x7f]/.test(url)) throw new Error('Enter a git repository URL.');
  if (url.startsWith('-')) throw new Error('A repository URL cannot start with "-".');
  if (!ref.test(wanted)) throw new Error('Enter a branch, tag or commit, such as v1.2.0.');
  if (scpLike.test(url)) return { url, ref: wanted };
  if (isAbsolute(url)) return { url, ref: wanted };
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Use an https://, ssh://, git@host:path or local repository address.'); }
  if (!['https:', 'ssh:', 'file:'].includes(parsed.protocol)) throw new Error(`${parsed.protocol.replace(/:$/, '')} repositories are not supported. Use https://, ssh://, git@host:path or a local path.`);
  if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) throw new Error('Remove credentials from the URL. Git uses your SSH keys or credential helper.');
  if (parsed.protocol === 'file:' && (parsed.host || !parsed.pathname.startsWith('/'))) throw new Error('Use a local path such as file:///Users/me/plugins.git.');
  if (parsed.protocol !== 'file:' && !parsed.hostname) throw new Error('The repository URL needs a host.');
  return { url, ref: wanted };
}

/** A 40-character commit id, as git resolves it. */
export const isCommit = (value: string) => /^[0-9a-f]{40}$/.test(value);
export const shortCommit = (value: string) => isCommit(value) ? value.slice(0, 12) : value;
