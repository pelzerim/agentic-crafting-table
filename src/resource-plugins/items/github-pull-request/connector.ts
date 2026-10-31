import { pullDiscussion } from './discussion.ts';
import { mergeOptimism, showShipOptimism, stateOptimism } from './optimistic.ts';
import { showShipChoices, taggedTitle, titleProblem, titleTag } from './show-ship.ts';
import type { ShowShipTag } from './show-ship.ts';
import { PULL_LIFECYCLES, PULL_STATE_CHANGES, PULL_STATE_DONE, pullStateChoices } from './pull-state.ts';
import { pullLifecycle } from '../../../../packages/provider-runtime/github.ts';
import type { PullLifecycle, PullStateChange } from '../../../../packages/provider-runtime/github.ts';
import type { ResourceFields, ResourcePluginConnector, ResourceRecord, JsonValue } from '../../types.ts';
import { mergeChoices, mergeReadiness, pullKey, WHEN_READY_SUFFIX } from '../../../../packages/provider-runtime/github.ts';
import type { GitHubClient, GitHubWorkflowRun, PullIdentity, PullMergeMethod } from '../../../../packages/provider-runtime/github.ts';
import { isDeployRun, MERGE_ROLLOUT_WINDOW_MS, pullStatus, rolloutDiscoveryKey } from '../../../../packages/provider-runtime/github-status.ts';

const MERGE_METHODS = ['SQUASH', 'MERGE', 'REBASE', 'QUEUE'];
const MERGE_CHOICES = [...MERGE_METHODS, ...MERGE_METHODS.map(method => `${method}${WHEN_READY_SUFFIX}`), 'CANCEL_WHEN_READY'];
const STATE_FIELDS: ResourceFields = { ...Object.fromEntries(['value', 'pullRequestId', 'expectedState', 'sourceResourceId', 'requestId'].map(key => [key, { label: key, kind: 'text' as const, required: true }])),
  comment: { label: 'Comment posted before closing', kind: 'text', required: false, multiline: true } };

/** `showShip` reports whether the Show/Ship title actions are switched on; omitted, they are offered.
 * `viewer` names the signed-in login of a resource's account, whose own comments never count as unseen. */
export function githubPullRequestConnector(clientFor: (resource: ResourceRecord) => GitHubClient, options: { showShip?: () => boolean; viewer?: (resource: ResourceRecord) => string | undefined } = {}): ResourcePluginConnector {
  const identity = (resource: ResourceRecord): PullIdentity => ({ owner: String(resource.data.owner), repo: String(resource.data.repo), number: Number(resource.data.number) });
  // A closed-PR event creates all of its head-commit runs at merge, so one read after
  // the merge settles is kept per head; the merge commit keeps being read for later chains.
  const headRuns = new Map<string, { at: number; runs: GitHubWorkflowRun[] }>(), mergeCommits = new Map<string, string>();
  const connector: ResourcePluginConnector = {
    pollIntervalMs: 60_000,
    async load(resource, signal) {
      const client = clientFor(resource), key = identity(resource);
      const pull = await client.pull(key, signal);
      // Sequential reads stop at rate-limit/auth failures; partial collections
      // cannot overwrite the previously complete observation.
      const reviews = await client.reviews(key, signal), comments = await client.comments(key, signal), inline = await client.reviewComments(key, signal);
      const queue = pull.state === 'open' ? await client.mergeQueue(key, signal) : null;
      const status = pullStatus(pull, reviews, comments, inline, queue);
      const discussion = pullDiscussion(comments, inline, reviews);
      const login = options.viewer?.(resource);
      const mergedAt = Date.parse(pull.merged_at ?? ''), now = Date.now(), headKey = `${pullKey(key)}@${pull.head.sha.toLowerCase()}`;
      const recentlyMerged = pull.merged && now - mergedAt < MERGE_ROLLOUT_WINDOW_MS;
      // The REST read may omit the merge commit; it never changes, so one separate read per PR is kept.
      let mergeSha = recentlyMerged ? pull.merge_commit_sha?.toLowerCase() ?? mergeCommits.get(pullKey(key)) : undefined;
      if (recentlyMerged && !mergeSha) {
        mergeSha = await client.mergeCommit(key, signal).catch(error => { signal.throwIfAborted(); void error; return null; }) ?? undefined;
        if (mergeSha) { mergeCommits.set(pullKey(key), mergeSha); if (mergeCommits.size > 200) mergeCommits.delete(mergeCommits.keys().next().value!); }
      }
      const inWindow = recentlyMerged && mergeSha;
      const cached = inWindow && (headRuns.get(headKey)?.at ?? 0) > mergedAt + 60_000 ? headRuns.get(headKey)!.runs : undefined;
      const commits = inWindow ? [...new Set([mergeSha!, ...(cached ? [] : [pull.head.sha])].map(sha => sha.toLowerCase()))] : [];
      const found = new Map((cached ?? []).map(run => [run.id, run]));
      for (const sha of commits) {
        // Rollout discovery is best-effort; it must not make PR status stale.
        const runs = await client.commitRuns(key, sha, signal).catch(error => { signal.throwIfAborted(); void error; return undefined; });
        const deploys = (runs ?? []).filter(run => isDeployRun(run, mergedAt));
        if (runs && sha === pull.head.sha.toLowerCase()) { headRuns.delete(headKey); headRuns.set(headKey, { at: now, runs: deploys }); }
        for (const run of deploys) found.set(run.id, run);
      }
      if (headRuns.size > 200) headRuns.delete(headRuns.keys().next().value!);
      const runs = [...found.values()];
      const discovered = runs.map(run => ({ key: rolloutDiscoveryKey(run.id), pluginId: 'github.rollout', title: run.name ?? 'Rollout', data: { url: `https://github.com/${key.owner}/${key.repo}/actions/runs/${run.id}` } }));
      // Deploys chained after a merge start later; keep looking for them promptly, then less often.
      return { ...(discovered.length ? { discovered } : {}), ...(recentlyMerged ? { pollWithinMs: now - mergedAt < 3_600_000 ? 60_000 : 300_000 } : {}), title: pull.title, activity: pull.state === 'closed' ? 'complete' : 'idle', attention: 'none', connection: 'connected',
        label: status.label, indicators: status.indicators, attentionReason: status.attention, ...(status.attentionNote ? { attentionNote: status.attentionNote } : {}), ...(status.attentionEventId ? { attentionEventId: status.attentionEventId } : {}),
        observedAt: new Date().toISOString(), detail: { pull, status: status.state, ...(queue?.queued ? { queuePosition: queue.position } : {}),
          ...(queue?.mergeWhenReady ? { mergeWhenReady: { ...queue.mergeWhenReady, statusWithout: status.statusWithoutMergeWhenReady ?? status.state } } : {}), ...(status.failingChecks ? { failingChecks: status.failingChecks.slice(0, 20) } : {}), comments: status.comments, ...discussion, ...(login ? { viewer: login } : {}) } };
    },
    actions: () => [
      { id: 'reply', label: 'Reply to comment', readOnly: false, updatesSnapshot: true, inputFields: Object.fromEntries(['kind', 'commentId', 'body', 'sourceResourceId', 'requestId'].map(key => [key, { kind: 'text' as const, label: key, required: true }])) },
      { id: 'files', label: 'Changed files', readOnly: true, inputFields: { head: { kind: 'text', label: 'Head commit', required: true, pattern: '^[a-fA-F0-9]{40,64}$' }, base: { kind: 'text', label: 'Base commit', required: true, pattern: '^[a-fA-F0-9]{40,64}$' } } },
      { id: 'pr.merge.options', label: 'Merge options', readOnly: true, heedsBlockers: true, cacheChoices: true },
      { id: 'pr.mergeReadiness', label: 'Merge readiness', readOnly: true, description: 'GitHub\'s merge state, review decision and head check rollup of the pull request.' },
      { id: 'pr.merge', label: 'Merge pull request', readOnly: false, updatesSnapshot: true, humanOnly: true, heedsBlockers: true, optimistic: mergeOptimism,
        description: 'Merge the pull request or add it to its merge queue on GitHub, now or when ready (auto-merge), or cancel merge when ready. Only a person can confirm this in the app.',
        inputFields: Object.fromEntries(['value', 'pullRequestId', 'expectedHeadOid', 'sourceResourceId', 'requestId'].map(key => [key, { label: key, kind: 'text' as const, required: true }])) },
      { id: 'pr.state.options', label: 'Pull request state options', readOnly: true, cacheChoices: true },
      { id: 'pr.state', label: 'Change pull request state', readOnly: false, updatesSnapshot: true, humanOnly: true, optimistic: stateOptimism,
        description: 'Mark the pull request ready for review, convert it to a draft, close it (posting an optional comment first) or reopen it on GitHub. Only a person can confirm this in the app.',
        inputFields: STATE_FIELDS },
      ...(options.showShip?.() === false ? [] : [{ id: 'pr.showShip.options', label: 'Show/Ship options', readOnly: true, cacheChoices: true },
        { id: 'pr.showShip', label: 'Tag pull request title', readOnly: false, updatesSnapshot: true, humanOnly: true, optimistic: showShipOptimism,
          description: 'Add, switch or remove the [show]/[ship] tag at the start of the pull request title on GitHub. Only a person can confirm this in the app.',
          inputFields: Object.fromEntries(['value', 'expectedTitle', 'sourceResourceId', 'requestId'].map(key => [key, { label: key, kind: 'text' as const, required: true }])) }]),
      { id: 'comments', label: 'Discussion', readOnly: true }, { id: 'reviews', label: 'Reviews', readOnly: true },
    ],
    async execute(resource, action, signal, input): Promise<JsonValue> {
      const client = clientFor(resource), key = identity(resource);
      if (action === 'reply') {
        if (input?.sourceResourceId !== resource.id || !['inline', 'discussion', 'review'].includes(String(input?.kind))) throw new Error('Reply belongs to another comment.');
        await client.reply(key, input!.kind as 'inline' | 'discussion' | 'review', Number(input!.commentId), String(input!.body), signal);
        try { return { snapshot: await connector.load!(resource, signal) } as unknown as JsonValue; }
        catch { throw Object.assign(new Error('Reply sent, but refresh failed. Check GitHub before sending again.'), { outcomeUnknown: true }); }
      }
      if (action === 'pr.merge.options') {
        const state = await client.mergeState(key, signal), choices = mergeChoices(state);
        if ('refusal' in choices) throw new Error(choices.refusal);
        return { current: '', prompt: choices.prompt, context: { sourceResourceId: resource.id, pullRequestId: state.pullRequest.id, expectedHeadOid: state.pullRequest.headRefOid }, options: choices.options };
      }
      if (action === 'pr.mergeReadiness') return mergeReadiness(await client.mergeState(key, signal)) as unknown as JsonValue;
      if (action === 'pr.merge') {
        if (input?.sourceResourceId !== resource.id) throw new Error('This merge belongs to another item. Review the pull request again.');
        const choice = String(input.value), pullRequestId = String(input.pullRequestId), expectedHeadOid = String(input.expectedHeadOid);
        if (!MERGE_CHOICES.includes(choice) || !/^[A-Za-z0-9_=-]{1,200}$/.test(pullRequestId) || !/^[a-f0-9]{40,64}$/i.test(expectedHeadOid)) throw new Error('This merge is incomplete. Review the pull request again.');
        const cancel = choice === 'CANCEL_WHEN_READY', whenReady = !cancel && choice.endsWith(WHEN_READY_SUFFIX), method = (whenReady ? choice.slice(0, -WHEN_READY_SUFFIX.length) : choice) as PullMergeMethod;
        if (cancel) await client.cancelMergeWhenReady(key, pullRequestId, signal);
        else await client.merge(key, { pullRequestId, expectedHeadOid, method, ...(whenReady ? { whenReady: true } : {}) }, signal);
        const done = cancel ? 'Merge when ready cancelled' : whenReady ? 'Merge when ready turned on' : method === 'QUEUE' ? 'Added to the merge queue' : 'Merged';
        try { return { snapshot: await connector.load!(resource, signal) } as unknown as JsonValue; }
        catch { throw Object.assign(new Error(`${done}, but refresh failed. Check GitHub before trying again.`), { outcomeUnknown: true }); }
      }
      if (action === 'pr.state.options') {
        const pull = (await client.mergeState(key, signal)).pullRequest, choices = pullStateChoices(pull);
        if ('refusal' in choices) throw new Error(choices.refusal);
        return { current: '', ...choices, context: { sourceResourceId: resource.id, pullRequestId: pull.id, expectedState: pullLifecycle(pull) } } as unknown as JsonValue;
      }
      if (action === 'pr.state') {
        if (input?.sourceResourceId !== resource.id) throw new Error('This change belongs to another item. Review the pull request again.');
        const change = input.value as PullStateChange, expected = input.expectedState as PullLifecycle, pullRequestId = input.pullRequestId, comment = input.comment;
        if (!PULL_STATE_CHANGES.includes(change) || !PULL_LIFECYCLES.includes(expected) || typeof pullRequestId !== 'string' || !/^[A-Za-z0-9_=-]{1,200}$/.test(pullRequestId) || comment !== undefined && typeof comment !== 'string')
          throw new Error('This change is incomplete. Review the pull request again.');
        await client.changeState(key, { pullRequestId, change, ...(typeof comment === 'string' ? { comment } : {}) }, signal);
        try { return { snapshot: await connector.load!(resource, signal) } as unknown as JsonValue; }
        catch { throw Object.assign(new Error(`${PULL_STATE_DONE[change]}, but refresh failed. Check GitHub before trying again.`), { outcomeUnknown: true }); }
      }
      if (action === 'pr.showShip.options') {
        const pull = await client.pull(key, signal);
        return { ...showShipChoices(pull), context: { sourceResourceId: resource.id, expectedTitle: pull.title } };
      }
      if (action === 'pr.showShip') {
        if (input?.sourceResourceId !== resource.id) throw new Error('This title change belongs to another item. Review the pull request again.');
        const value = String(input.value), expectedTitle = input.expectedTitle;
        if (!['show', 'ship', 'none'].includes(value) || typeof expectedTitle !== 'string' || !expectedTitle.trim()) throw new Error('This title change is incomplete. Review the pull request again.');
        const tag = value === 'none' ? '' : value as ShowShipTag;
        if (titleTag(expectedTitle).tag === tag) return { snapshot: await connector.load!(resource, signal) } as unknown as JsonValue;
        const title = taggedTitle(expectedTitle, tag), problem = titleProblem(title);
        if (problem) throw new Error(problem);
        await client.retitle(key, title, signal);
        try { return { snapshot: await connector.load!(resource, signal) } as unknown as JsonValue; }
        catch { throw Object.assign(new Error('Title updated, but refresh failed. Check GitHub before trying again.'), { outcomeUnknown: true }); }
      }
      if (action === 'files') {
        const check = async () => { const pull = await client.pull(key, signal); if (pull.head.sha !== input?.head || pull.base.sha !== input?.base) throw new Error('This comparison changed. Refresh the pull request before opening its files.'); return pull; };
        const before = await check(), files = await client.files(key, signal); await check();
        if (files.length !== before.changed_files) throw new Error('GitHub returned an incomplete file list. No comparison was saved.');
        return { files, head: before.head.sha, base: before.base.sha };
      }
      if (action === 'comments') return { comments: await client.comments(key, signal) };
      if (action === 'reviews') return { reviews: await client.reviews(key, signal) };
      throw new Error('Unknown pull request action');
    },
    async getContext(resource, signal) {
      const key = identity(resource), pull = await clientFor(resource).pull(key, signal);
      return { resourceId: resource.id, title: pull.title, sourceUrl: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
        content: `${pull.title}\n${pull.state}${pull.merged ? ' (merged)' : ''}\n${pull.base.sha} → ${pull.head.sha}\n${pull.body ?? ''}` };
    },
  };
  return connector;
}
