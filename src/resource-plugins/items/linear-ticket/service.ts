import { LinearClient, LinearWorkflowCache, linearTransport } from '../../../../packages/provider-runtime/linear.ts';
import { linearTicketConnector } from './connector.ts';
import { linearConnection } from '../../../../packages/provider-runtime/linear-connection.ts';
import { providerCredential } from '../../../../packages/provider-runtime/keychain.ts';
import { requestBudget } from '../../../../packages/provider-runtime/request-budget.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { linearTicket } from './definition.ts';
import { LINEAR_PULLS_OPERATION, LinearPulls } from './pulls.ts';

const service: ServiceModule = {
  activate(host) {
    host.connectionProvider({ ...linearConnection(), order: 40 });
    host.onWorkspace(workspace => {
      const pulls = new LinearPulls(workspace.control, workspace.resources);
      host.runtimeOperation(LINEAR_PULLS_OPERATION, context => context.execute(() => pulls.run(context.nodeId, context.arguments)));
    });
    const connections = host.connections;
    if (!connections) return;
    const credential = providerCredential('linear'), workflows = new LinearWorkflowCache();
    host.connector(linearTicket.id, linearTicketConnector(async (resource, signal) => {
      if (!resource.connectionId) throw new Error('Open this item to bind it to a Linear account first.');
      const selected = connections.resolve('linear', resource.connectionId);
      return new LinearClient(linearTransport(await credential(signal), fetch, requestBudget('linear', selected.account)), selected.account, workflows);
    }));
  },
};
export default service;
