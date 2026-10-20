import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { terminalSession } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [terminalSession] };
export default plugin;
