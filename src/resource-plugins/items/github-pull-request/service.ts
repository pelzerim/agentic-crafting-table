import { GitHubClient } from '../../../../packages/provider-runtime/github.ts';
import { githubCredentials, githubMergeTransport } from '../../../../packages/provider-runtime/github-transport.ts';
import { githubPullRequestConnector } from './connector.ts';
import { pullRequestPresentation } from './presentation.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubPullRequest } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.presentation(githubPullRequest.id, pullRequestPresentation);
    const connections = host.connections;
    if (!connections) return;
    const credentials = githubCredentials();
    host.connector(githubPullRequest.id, githubPullRequestConnector(resource => {
      if (!resource.connectionId) throw new Error('Open this item to bind it to a GitHub account first.');
      return new GitHubClient(githubMergeTransport(connections.resolve('github', resource.connectionId).account, credentials));
    }, { showShip: () => host.settings().showShip === true, viewer: resource => {
      if (!resource.connectionId) return undefined;
      try { return connections.resolve('github', resource.connectionId).account; } catch { return undefined; }
    } }));
  },
};
export default service;
