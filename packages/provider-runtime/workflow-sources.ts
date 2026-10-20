import type { ResourceRecord, JsonObject } from '../../src/resource-plugins/types.ts';
import type { ProviderConnections } from './connections.ts';
import { GitHubWorkflowClient } from './github-workflow.ts';
import { githubWorkflowTransport } from './github-transport.ts';
import { pullKey } from './github.ts';
import { DEFAULT_WORKFLOW_REVIEW_CONTRACT } from '../../src/pull-requests/workflow-contract.ts';
import type { WorkflowReviewContract } from '../../src/pull-requests/workflow-contract.ts';
import type { PullIdentity } from './github.ts';

/** `contract` is frozen with the request; requests journaled before it existed use the repository's current contract. */
export interface WorkflowBinding { identity: PullIdentity; connectionId: string; account: string; sourceData: JsonObject; contract?: WorkflowReviewContract }
export interface WorkflowSource {
  freeze(resource: ResourceRecord): WorkflowBinding;
  client(binding: WorkflowBinding): GitHubWorkflowClient;
}
export function nativeWorkflowSources(connections: ProviderConnections, contractFor: (repository: string) => WorkflowReviewContract = () => ({ ...DEFAULT_WORKFLOW_REVIEW_CONTRACT })): Record<string, WorkflowSource> {
  return { 'github.pull-request': {
    freeze(resource) {
      const connection = connections.resolve('github', resource.connectionId);
      const identity = { owner: String(resource.data.owner), repo: String(resource.data.repo), number: Number(resource.data.number) }; pullKey(identity);
      return { identity, connectionId: connection.id, account: connection.account, sourceData: structuredClone(resource.data), contract: contractFor(`${identity.owner}/${identity.repo}`) };
    },
    client(binding) {
      const connection = connections.resolve('github', binding.connectionId);
      if (connection.account !== binding.account) throw new Error('The workflow account binding changed. Reconnect the original account to continue.');
      return new GitHubWorkflowClient(githubWorkflowTransport(connection.account), Date.now, binding.contract ?? contractFor(`${binding.identity.owner}/${binding.identity.repo}`));
    },
  } };
}
