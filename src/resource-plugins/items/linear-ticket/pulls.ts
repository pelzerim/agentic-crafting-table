import { z } from 'zod';
import type { WorkspaceControl } from '../../../../packages/core/control.ts';
import type { ResourceCoordinator } from '../../../../packages/workspace-service/resources.ts';
import { stableUuid } from '../../../../packages/workspace-service/resources.ts';
export { LINEAR_PULLS_OPERATION } from './definition.ts';

const input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('add'), requestId: z.string().uuid() }).strict(),
]);
const pullsSchema = z.array(z.object({ owner: z.string().min(1).max(39), repo: z.string().min(1).max(100), number: z.number().int().positive() })).max(50);

/** Add linked pull requests: every GitHub pull request Linear lists on a ticket, attached beside it in its project with
 * the default GitHub account and linked from the ticket. One already in that project is reused, not added twice. */
export class LinearPulls {
  private control: WorkspaceControl; private resources: Pick<ResourceCoordinator, 'cached' | 'attach'>;
  constructor(control: WorkspaceControl, resources: Pick<ResourceCoordinator, 'cached' | 'attach'>) { this.control = control; this.resources = resources; }
  async run(nodeId: string, raw: unknown) {
    const args = input.parse(raw), node = (await this.control.read()).nodes.find(candidate => candidate.id === nodeId);
    if (!node?.resourceId) throw new Error('Choose a Linear ticket on the map.');
    const detail = (await this.resources.cached(nodeId))?.detail as { identifier?: unknown; pulls?: unknown } | undefined;
    const pulls = pullsSchema.safeParse(detail?.pulls ?? []).data ?? [], name = typeof detail?.identifier === 'string' ? detail.identifier : 'this ticket';
    if (args.operation === 'options') return { pulls: pulls.length };
    if (!pulls.length) throw new Error(`Linear lists no pull requests on ${name}. Link one in Linear, or wait for the ticket to refresh.`);
    const added: string[] = [], failed: string[] = [];
    for (const pull of pulls) {
      const label = `${pull.owner}/${pull.repo} #${pull.number}`, seed = `linear-pulls:${args.requestId}:${label.toLowerCase()}`;
      try {
        const result = await this.resources.attach({ requestId: stableUuid(`${seed}:request`), nodeId: stableUuid(`${seed}:node`), resourceId: stableUuid(`${seed}:resource`), pluginId: 'github.pull-request', title: label,
          ...(node.projectId ? { projectId: node.projectId } : {}), placedBy: node.id, connections: [{ id: stableUuid(`${seed}:link`), otherId: node.id, kind: 'reference', sourceIsNew: false }],
          data: { url: `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}` } }) as { nodeId?: unknown } | undefined;
        added.push(typeof result?.nodeId === 'string' ? result.nodeId : stableUuid(`${seed}:node`));
      } catch (error) { failed.push(`${label}: ${(error as Error).message}`); }
    }
    if (!added.length) throw new Error(failed[0]?.replace(/^[^:]+: /, '') ?? 'No pull request could be added.');
    return { added: added.length, nodeId: added[0], ...(failed.length ? { failed } : {}) };
  }
}
