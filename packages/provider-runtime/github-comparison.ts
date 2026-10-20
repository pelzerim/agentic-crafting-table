import type { GitHubCredentials } from './github-transport.ts';
import { githubCredentials } from './github-transport.ts';
import type { FetchComparison } from './git-comparison.ts';
import { pullKey } from './github.ts';

/** The header is scoped to https://github.com/, so `remote` (a test seam) never receives it elsewhere. */
export function fetchGitHubComparison(account: string, credentials: GitHubCredentials = githubCredentials(), remote = (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`): FetchComparison {
  return async (git, input, signal) => {
    const [owner, repo] = input.repository.split('/'); pullKey({ owner, repo, number: input.number });
    const token = await credentials.token(account, signal); signal.throwIfAborted();
    // The selected account's temporary header is only in the fetch child's
    // environment: never an argv/URL, git config file, manifest or agent binding.
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
    await git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote(owner, repo), input.baseTipSha, `+refs/pull/${input.number}/head:refs/review/head`], {
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
    });
    if ((await git(['rev-parse', 'refs/review/head'])).trim() !== input.headSha) throw new Error('The PR changed while preparing its review. Start a new review of the latest revision.');
  };
}
