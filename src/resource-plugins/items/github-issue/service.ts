import { GitHubClient } from '../../../../packages/provider-runtime/github.ts';
import { githubCredentials, githubIssueTransport } from '../../../../packages/provider-runtime/github-transport.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubIssueConnector } from './connector.ts';
import { githubIssue } from './definition.ts';
import { GITHUB_ISSUE_PULLS_OPERATION, GitHubIssuePulls } from './pulls.ts';

const service: ServiceModule = {
  activate(host) {
    host.onWorkspace(workspace => {
      const pulls = new GitHubIssuePulls(workspace.control, workspace.resources);
      host.runtimeOperation(GITHUB_ISSUE_PULLS_OPERATION, context => context.execute(() => pulls.run(context.nodeId, context.arguments, context.signal)));
    });
    const connections = host.connections;
    if (!connections) return;
    const credentials = githubCredentials();
    host.connector(githubIssue.id, githubIssueConnector(resource => {
      if (!resource.connectionId) throw new Error('Open this item to bind it to a GitHub account first.');
      return new GitHubClient(githubIssueTransport(connections.resolve('github', resource.connectionId).account, credentials));
    }));
  },
};
export default service;
