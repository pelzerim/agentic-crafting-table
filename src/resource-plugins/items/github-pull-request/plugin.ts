import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubPullRequest } from './definition.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [githubPullRequest],
  settings: { typeId: githubPullRequest.id, label: 'Title tags', fields: {
    showShip: { label: 'Show/Ship', kind: 'boolean', default: false, description: 'Tag pull request titles [show] or [ship] from the map menu and the pull request view (the Ship/Show/Ask convention). Retitling on GitHub always asks you first.' },
  } },
};
export default plugin;
