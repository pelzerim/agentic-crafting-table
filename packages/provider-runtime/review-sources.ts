import type { ResourceRecord } from '../../src/resource-plugins/types.ts';
import type { GitComparison, ComparisonInput } from './git-comparison.ts';
import { captureGitComparison } from './git-comparison.ts';
import { fetchGitHubComparison } from './github-comparison.ts';
import { GitHubClient } from './github.ts';
import { githubTransport } from './github-transport.ts';
import type { ProviderConnections } from './connections.ts';

export interface FrozenReviewSource { comparison: ComparisonInput; title: string; description: string; url: string; connectionId?: string; account?: string }
export interface ReviewSource {
  freeze(resource: ResourceRecord, signal: AbortSignal): Promise<FrozenReviewSource>;
  capture(directory: string, requestId: string, source: FrozenReviewSource, signal: AbortSignal): Promise<GitComparison>;
}
export function nativeReviewSources(connections: ProviderConnections): Record<string, ReviewSource> {
  return { 'github.pull-request': {
    async freeze(resource, signal) {
      const connection = connections.resolve('github', resource.connectionId), api = new GitHubClient(githubTransport(connection.account));
      const identity = { owner: String(resource.data.owner), repo: String(resource.data.repo), number: Number(resource.data.number) };
      const pull = await api.pull(identity, signal), repository = `${identity.owner}/${identity.repo}`;
      return { comparison: { repository, number: pull.number, baseTipSha: pull.base.sha, headSha: pull.head.sha }, title: pull.title, description: pull.body ?? '', url: `https://github.com/${repository}/pull/${pull.number}`, connectionId: connection.id, account: connection.account };
    },
    async capture(directory, requestId, source, signal) {
      const connection = connections.resolve('github', source.connectionId);
      if (connection.account !== source.account) throw new Error('Review account binding changed');
      return captureGitComparison(directory, requestId, source.comparison, fetchGitHubComparison(connection.account), signal);
    },
  } };
}
