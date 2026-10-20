import type { RelatedResourceItem } from '../../types.ts';
import type { GitHubPullRequest } from '../../../../packages/provider-runtime/github.ts';

export function reviewDeskItem(item: RelatedResourceItem, sourceResourceId: string, pull?: GitHubPullRequest) {
  const resource = item.resource;
  if (!resource || !['code.review', 'github.review-run'].includes(resource.pluginId) || item.parentResourceId !== sourceResourceId) return undefined;
  const data = resource.data, head = typeof data.headSha === 'string' ? data.headSha : undefined;
  const base = typeof data.baseTipSha === 'string' ? data.baseTipSha : undefined;
  const revision = !pull || !head ? 'Revision unverified' : head !== pull.head.sha || base && base !== pull.base.sha ? 'Earlier revision' : base ? 'Current revision' : 'Head current · base unverified';
  const state = item.attention === 'error' ? 'Action required' : item.activity === 'working' ? 'Working' : item.activity === 'complete' ? 'Completed' : item.activity === 'unknown' ? 'State unknown' : 'Idle';
  const provider = data.provider === 'claude' ? 'Claude' : data.provider === 'codex' ? 'Codex' : '/review on GitHub';
  const model = typeof data.model === 'string' ? ({ opus: 'Opus', 'gpt-6-astra': 'Astra', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' } as Record<string, string>)[data.model] ?? data.model : '';
  const rollup = data.findings as { sessionId?: unknown; format?: unknown; mix?: { key: string; count: number; label: string }[]; progress?: string; recipient?: string } | undefined;
  const findings = rollup?.sessionId === data.sessionId && rollup?.format === 'findings' && Array.isArray(rollup.mix)
    ? { mix: rollup.mix, progress: [rollup.progress, rollup.recipient && rollup.progress !== 'None sent yet' ? `to ${rollup.recipient}` : ''].filter(Boolean).join(' · ') } : undefined;
  return { label: provider + (model ? ` · ${model}` : ''), tint: data.provider === 'claude' || data.provider === 'codex' ? data.provider : 'workflow', state, revision, stale: revision === 'Earlier revision', summary: item.summary.trim() || 'No saved summary yet.', ...(findings ? { findings } : {}) };
}
