import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { agentSession } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [agentSession] };
export default plugin;
