import type { ResourcePluginViews, ResourcePreview, ResourceSnapshot } from '../../types.ts';
import type { GitHubPullRequest } from '../../../../packages/provider-runtime/github.ts';

/** Hover facts from the saved snapshot. Unseen comments already reach the item as its comments indicator. */
export function pullPreview(snapshot: ResourceSnapshot | null): ResourcePreview {
  const pull = snapshot?.detail?.pull as unknown as GitHubPullRequest | undefined, facts: ResourcePreview['facts'] = [];
  const failing = Array.isArray(snapshot?.detail?.failingChecks) ? (snapshot.detail.failingChecks as unknown[]).map(String) : [];
  if (failing.length) facts.push({ label: 'Checks', value: `${failing.length} failing · ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? ` +${failing.length - 3}` : ''}`, tone: 'red' });
  return { ...(pull?.user?.login ? { byline: `by ${pull.user.login}` } : {}), ...(pull?.updated_at ? { updatedAt: pull.updated_at } : {}), facts };
}

export const previewPull: NonNullable<ResourcePluginViews['preview']> = async (resource, services) =>
  pullPreview(await services.runAction('resource.read', { cachedOnly: true }) as unknown as ResourceSnapshot | null);
