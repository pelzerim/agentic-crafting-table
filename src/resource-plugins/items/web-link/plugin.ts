import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { webLink } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [webLink] };
export default plugin;
