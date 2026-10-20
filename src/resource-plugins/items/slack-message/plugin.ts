import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { slackMessage } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [slackMessage] };
export default plugin;
