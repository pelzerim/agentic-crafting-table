import { z } from 'zod';
import type { WorkspaceControl } from '../../../../packages/core/control.ts';
import type { ResourceCoordinator } from '../../../../packages/workspace-service/resources.ts';
import { stableUuid } from '../../../../packages/workspace-service/resources.ts';
export { GITHUB_ISSUE_PULLS_OPERATION } from './definition.ts';

const input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('add'), requestId: z.string().uuid() }).strict(),
]);
const pullsSchema = z.object({ pulls: z.array(z.object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), number: z.number().int().positive() })).max(50) });

/** Add linked pull requests: every pull request GitHub links to an issue (closing it or mentioning it), attached beside it
 * in its project with the issue's own GitHub account and linked from the issue. One already in that project is reused. */
export class GitHubIssuePulls {
  private control: WorkspaceControl; private resources: Pick<ResourceCoordinator, 'execute' | 'attach'>;
  constructor(control: WorkspaceControl, resources: Pick<ResourceCoordinator, 'execute' | 'attach'>) { this.control = control; this.resources = resources; }
  async run(nodeId: string, raw: unknown, signal: AbortSignal) {
    const args = input.parse(raw), state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId);
    const resource = node?.resourceId ? state.resources.find(record => record.id === node.resourceId) : undefined;
    if (!node || resource?.pluginId !== 'github.issue') throw new Error('Choose a GitHub issue on the map.');
    const { pulls } = pullsSchema.parse(await this.resources.execute(nodeId, 'issue.pulls', {}, signal)), name = `#${resource.data.number}`;
    if (args.operation === 'options') return { pulls: pulls.length };
    if (!pulls.length) throw new Error(`GitHub links no pull requests to ${name}. Link one on GitHub, or mention the issue in one.`);
    const added: string[] = [], failed: string[] = [];
    for (const pull of pulls) {
      const label = `${pull.owner}/${pull.repo} #${pull.number}`, seed = `github-issue-pulls:${args.requestId}:${label.toLowerCase()}`;
      try {
        const result = await this.resources.attach({ requestId: stableUuid(`${seed}:request`), nodeId: stableUuid(`${seed}:node`), resourceId: stableUuid(`${seed}:resource`), pluginId: 'github.pull-request', title: label,
          ...(node.projectId ? { projectId: node.projectId } : {}), ...(resource.connectionId ? { connectionId: resource.connectionId } : {}), placedBy: node.id,
          connections: [{ id: stableUuid(`${seed}:link`), otherId: node.id, kind: 'reference', sourceIsNew: false }],
          data: { url: `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}` } }) as { nodeId?: unknown } | undefined;
        added.push(typeof result?.nodeId === 'string' ? result.nodeId : stableUuid(`${seed}:node`));
      } catch (error) { failed.push(`${label}: ${(error as Error).message}`); }
    }
    if (!added.length) throw new Error(failed[0]?.replace(/^[^:]+: /, '') ?? 'No pull request could be added.');
    return { added: added.length, nodeId: added[0], ...(failed.length ? { failed } : {}) };
  }
}
