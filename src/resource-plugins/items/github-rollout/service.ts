import { githubRolloutConnector } from './connector.ts';
import { GitHubRolloutClient } from '../../../../packages/provider-runtime/github-rollout.ts';
import { githubCredentials, githubRolloutApprovalTransport } from '../../../../packages/provider-runtime/github-transport.ts';
import { RolloutValidations } from '../../../../packages/workspace-service/rollout-validation.ts';
import type { PresentationHooks, ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { rolloutCardPips, rolloutIndicators } from './presentation.ts';
import { githubRollout } from './definition.ts';
import { stageRulesSetting } from './stages.ts';
import type { StageRule } from './stages.ts';
import { AutoDeploys, autoDeployArmed } from '../../../../packages/workspace-service/auto-deploy.ts';
import { AUTO_DEPLOY_OPERATION } from './auto-deploy.ts';

/** Validation verdicts and recorded events drawn on the rollout's map card, and its phase pips read with these stage rules. */
export const rolloutPresentationWith = (stageRules: () => readonly StageRule[]): PresentationHooks => ({
  indicators: (resource, snapshot, store) => rolloutIndicators(snapshot, store.rolloutValidations({ rolloutResourceId: resource.id }), store.rolloutEvents(resource.id), Date.now()),
  pips: (resource, snapshot, store) => rolloutCardPips(snapshot, store.rolloutValidations({ rolloutResourceId: resource.id }), store.rolloutEvents(resource.id), stageRules()),
});
export const rolloutPresentation = rolloutPresentationWith(() => []);

const service: ServiceModule = {
  activate(host) {
    host.presentation(githubRollout.id, rolloutPresentationWith(() => stageRulesSetting(host.settings().stageRules)));
    host.onWorkspace(workspace => {
      const validations = new RolloutValidations(workspace.store, workspace.control, workspace.resources, workspace.terminals, workspace.broadcast, { allowed: workspace.allowed, starter: workspace.agents, stageRules: () => stageRulesSetting(host.settings().stageRules), deploying: id => autoDeployArmed(workspace.storage, id) });
      host.runtimeOperation('rollout.validation', context => context.execute(() => validations.run(context.nodeId, context.arguments)));
      const deploys = new AutoDeploys({ storage: workspace.storage, store: workspace.store, control: workspace.control, resources: workspace.resources, validations, changed: workspace.broadcast,
        allowed: workspace.allowed, stageRules: () => stageRulesSetting(host.settings().stageRules), ...(workspace.terminals ? { sessions: workspace.terminals } : {}), ...(workspace.agents ? { starter: workspace.agents } : {}) });
      host.runtimeOperation(AUTO_DEPLOY_OPERATION, context => context.execute(() => deploys.run(context.nodeId, context.arguments)));
      return { observe: () => { validations.observe(); deploys.observe(); }, start: () => { validations.start(); deploys.start(); },
        pause: async () => { await Promise.all([validations.close(), deploys.close()]); }, close: async () => { await Promise.all([validations.close(), deploys.close()]); } };
    });
    const connections = host.connections;
    if (!connections) return;
    const credentials = githubCredentials();
    host.connector(githubRollout.id, githubRolloutConnector(resource => {
      if (!resource.connectionId) throw new Error('Connect this item to a GitHub account first.');
      return new GitHubRolloutClient(githubRolloutApprovalTransport(connections.resolve('github', resource.connectionId).account, credentials));
    }));
  },
};
export default service;
